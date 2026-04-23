import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import multer from 'multer';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import rateLimit from 'express-rate-limit';

const app = express();
// F3 修复：显式 size limit（防未来 express 默认变大）
app.use(express.json({ limit: '500kb' }));
// REVIEW-v15 F3：multer 加 fileSize 限制，防止大文件 OOM
// USD / FBX 模型一般 < 100MB，给 200MB 上限留余量；超过则需换 CONVERTER_UPLOAD_MAX env
const CONVERTER_UPLOAD_MAX = Number(process.env.CONVERTER_UPLOAD_MAX || 200 * 1024 * 1024);
const upload = multer({
  dest: path.join(os.tmpdir(), 'motionforge-uploads'),
  limits: { fileSize: CONVERTER_UPLOAD_MAX },
});
const PORT = Number(process.env.CONVERTER_PORT || 8091);
// REVIEW-v15 F3：默认只监听 loopback，防止本机上别的进程或同 LAN 访问
// 需要跨机器访问请显式设 CONVERTER_HOST=0.0.0.0（生产前应先加 auth 层）
const HOST = process.env.CONVERTER_HOST || '127.0.0.1';
// REVIEW-v15 F3：Blender 子进程超时（避免卡死进程堆积）
const BLENDER_TIMEOUT_MS = Number(process.env.BLENDER_TIMEOUT_MS || 60_000);
const AI_BASE_URL = process.env.AI_BASE_URL || 'https://coding.qunhequnhe.com';
const AI_API_KEY = process.env.AI_API_KEY || '';
const AI_MODEL = process.env.AI_MODEL || 'gemini-3-flash-thinking';

const DEFAULT_BLENDER_PATH = 'C:\\Program Files\\Blender Foundation\\Blender 5.1\\blender.exe';
const blenderPath = process.env.BLENDER_PATH || DEFAULT_BLENDER_PATH;
const converterScript = path.resolve(process.cwd(), 'tools', 'convert_usd_to_glb.py');
const WORK_DIR = path.resolve(process.cwd(), '.converter-temp');

// F3 修复：CORS 白名单（默认只允许本地前端；生产走 env 注入）
// 不再是 `app.use(cors())` 通配 — 避免任意网站盗刷 AI API 额度
const CORS_ALLOW = (process.env.CORS_ALLOW || 'http://localhost:5173,http://localhost:4173').split(',');
app.use(cors({
  origin: (origin, cb) => {
    // 无 origin（同源 / curl 等工具）放行
    if (!origin) return cb(null, true);
    if (CORS_ALLOW.includes(origin)) return cb(null, true);
    cb(new Error(`CORS 拒绝来源：${origin}；允许列表：${CORS_ALLOW.join(', ')}`));
  },
}));

// F3 修复：AI 接口速率限制（每 IP 60 秒 30 次）
// 防误触连点 + 公网场景的脚本刷接口
const aiRateLimit = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.AI_RATE_LIMIT_PER_MIN || 30),
  message: { error: 'AI 请求过于频繁，请稍后再试（默认 30 次/分钟，可改 AI_RATE_LIMIT_PER_MIN）' },
  standardHeaders: true,
  legacyHeaders: false,
});

// REVIEW-v15 F3：转换接口限流（较 AI 接口保守，因 Blender 进程重）
// 10 次/分钟 足够本地开发；公网暴露时 Blender 转换是最重的操作，别让脚本刷
const convertRateLimit = rateLimit({
  windowMs: 60_000,
  max: Number(process.env.CONVERT_RATE_LIMIT_PER_MIN || 10),
  message: { error: '转换请求过于频繁（默认 10 次/分钟，可改 CONVERT_RATE_LIMIT_PER_MIN）' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    blenderPath,
    converterScript,
    workDir: WORK_DIR,
  });
});

function runBlenderConvert(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const args = ['--background', '--python', converterScript, '--', inputPath, outputPath];
    const child = spawn(blenderPath, args, { windowsHide: true });

    let stderr = '';
    let stdout = '';
    let timedOut = false;

    // REVIEW-v15 F3：超时保护——Blender 卡住（循环 python 错、hang on IO 等）时杀掉
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
    }, BLENDER_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`Failed to start Blender: ${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`Blender 转换超时（${BLENDER_TIMEOUT_MS}ms），进程已被杀`));
        return;
      }
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`Blender exited with code ${code}. ${stderr || stdout}`));
    });
  });
}

// REVIEW-v15 F3：转换接口加限流中间件（multer 前面，防止先上传大文件再拒绝）
// multer 单独 wrapper：捕获 LIMIT_FILE_SIZE 等错误，以 JSON 返回，不让 Express 吐出默认 500 HTML
function handleUpload(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (err) {
      const code = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      const msg = err.code === 'LIMIT_FILE_SIZE'
        ? `上传文件超过 ${(CONVERTER_UPLOAD_MAX / 1024 / 1024).toFixed(0)}MB 限制`
        : err.message;
      res.status(code).json({ error_code: err.code || 'UPLOAD_ERROR', message: msg });
      return;
    }
    next();
  });
}
app.post('/api/convert-to-glb', convertRateLimit, handleUpload, async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error_code: 'NO_FILE', message: 'Missing uploaded file.' });
    return;
  }

  const originalName = req.file.originalname || '';
  const extension = path.extname(originalName).toLowerCase();
  const supported = ['.usd', '.usda', '.usdc', '.usdz', '.fbx'];
  if (!supported.includes(extension)) {
    await fs.rm(req.file.path, { force: true });
    res.status(400).json({
      error_code: 'UNSUPPORTED_FORMAT',
      message: `Only ${supported.join(', ')} are supported for conversion.`,
    });
    return;
  }

  const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const inputPath = path.join(WORK_DIR, `input-${token}${extension}`);
  const outputPath = path.join(WORK_DIR, `output-${token}.glb`);

  try {
    await fs.mkdir(WORK_DIR, { recursive: true });
    await fs.copyFile(req.file.path, inputPath);
    const blenderLogs = await runBlenderConvert(inputPath, outputPath);

    try {
      await fs.access(outputPath);
    } catch {
      throw new Error(
        `Conversion finished but output GLB is missing. stdout: ${blenderLogs.stdout || '(empty)'} stderr: ${blenderLogs.stderr || '(empty)'}`,
      );
    }
    const bytes = await fs.readFile(outputPath);

    res.setHeader('Content-Type', 'model/gltf-binary');
    res.setHeader('X-Source-File', originalName);
    res.setHeader('X-Source-Format', extension.slice(1));
    res.send(bytes);
  } catch (error) {
    console.error('[MotionForge] Conversion failed:', error.message);
    res.status(500).json({
      error_code: 'CONVERSION_FAILED',
      message: error.message,
      hint: 'Check BLENDER_PATH and conversion script logs.',
    });
  } finally {
    await fs.rm(req.file.path, { force: true });
    await fs.rm(inputPath, { force: true });
    await fs.rm(outputPath, { force: true });
  }
});

const AI_SYSTEM_PROMPT = `你是一个工业机器人运动规划助手。用户会描述动作需求，你要输出结构化 JSON。
只输出 JSON，格式：
{"steps":[{"action":"translate|rotate","part":"对象名","axis":"x|y|z","value":数值,"unit":"mm|deg"}]}`;

app.post('/api/understand-task', aiRateLimit, async (req, res) => {
  const { prompt, objects } = req.body || {};
  if (!prompt) {
    res.status(400).json({ error: '缺少 prompt 字段' });
    return;
  }
  if (!AI_API_KEY) {
    res.status(500).json({ error: 'AI_API_KEY 未配置，请在 .env 文件中设置' });
    return;
  }
  try {
    const userMessage = `可用对象: ${(objects || []).join(', ')}\n用户指令: ${prompt}`;
    const response = await fetch(`${AI_BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${AI_API_KEY}`,
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [
          { role: 'system', content: AI_SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.2,
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      res.status(502).json({ error: `AI API 返回错误 (${response.status})`, detail });
      return;
    }
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) {
      res.status(422).json({ error: 'AI 返回内容中未找到有效 JSON', raw_response: content });
      return;
    }
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed.steps)) {
      res.status(422).json({ error: 'AI 返回 JSON 缺少 steps 数组', raw_response: content });
      return;
    }
    res.json(parsed);
  } catch (error) {
    console.error('[MotionForge] AI understand-task error:', error.message);
    res.status(500).json({ error: `AI 请求失败: ${error.message}` });
  }
});

// ── AI 生成 PKF ──
// 新端点：接收关节定义列表 + 用户自然语言描述，输出 PKF parameters + steps
const PKF_SYSTEM_PROMPT = `你是一个工业设备参数化运动规划助手。你将收到：
1. joints: 设备上所有可动关节的列表，每个关节有 name（名字）、type（revolute 旋转 / prismatic 平移）、axis（轴向 x/y/z，Z-up 约定）
2. 用户的自然语言动作描述

你的任务：根据用户描述，输出一个 PKF (Parameterized Keyframe Formula) JSON。

**只输出 JSON**，不要有多余文字。格式如下：
{
  "parameters": [
    { "id": "参数名（英文标识符，如 stroke/angle/height）", "type": "number", "unit": "单位如 mm/deg", "desc": "中文描述", "default": 默认数值 }
  ],
  "steps": [
    {
      "joint": "关节名字（必须与 joints 列表中的 name 精确匹配）",
      "channel": "translate 或 rotate（必须与该关节的 type 匹配：prismatic→translate, revolute→rotate）",
      "axis": "x/y/z（与关节的 axis 一致）",
      "t_start": 起始时间（秒），
      "t_end": 结束时间（秒），
      "value_start": "起始值公式（可引用 parameters 里声明的参数名，如 '0'）",
      "value_end": "结束值公式（如 'stroke' 或 'angle * 0.5'）",
      "easing": "linear / ease-in / ease-out / ease-in-out"
    }
  ]
}

**规则**：
- 每个 step 的 joint 必须精确匹配 joints 列表中的某个 name
- channel 必须与关节 type 对应（revolute→rotate, prismatic→translate）
- axis 与关节的 axis 保持一致
- 公式中只能引用 parameters 里声明的 id，以及数字、加减乘除、Math 函数
- 多个关节可以在同一时间段同时运动（并行 step）
- 顺序动作用不同的 t_start/t_end 区间表达
- 默认 easing 为 linear
- 参数 id 用英文小写 + 下划线命名

**⚠️ 核心语义（放在示例之前）**：prismatic 关节的 \`value_end\` 是**位移**（从零位开始前进多少米），不是世界绝对坐标。
Runtime：\`newWorldPos = baseWorldPos + axis * currentValue\`。所以公式要算"要位移多少才能让目标点到达 target"：
\`displacement = target_world - anchor_at_zero\`（+ 可选的 approach_gap）

**学习下面的完整示例**（叉车取货动作 — v14.1 位移语义）：

示例输入：
- 关节列表：EXAMPLE_body_forward(prismatic, role="车体前进")，EXAMPLE_mast_lift(prismatic, role="门架升降")
- 场景对象：cargo at (0.00, 5.00, 0.60)
- 叉齿零位锚点：fork_anchor_zero_x=0, fork_anchor_zero_y=2.13, fork_anchor_zero_z=0.32
- 用户描述：车体开到 cargo 前取货，门架升降对齐 cargo 高度

示例输出：
{
  "parameters": [
    { "id": "cargo_pos_x", "type": "number", "unit": "m", "desc": "货物X坐标", "default": 0 },
    { "id": "cargo_pos_y", "type": "number", "unit": "m", "desc": "货物Y坐标", "default": 5.0 },
    { "id": "cargo_pos_z", "type": "number", "unit": "m", "desc": "货物Z坐标", "default": 0.6 },
    { "id": "approach_gap", "type": "number", "unit": "m", "desc": "叉齿离货物缓冲距离（0=贴合，snap-attach 精准对齐）", "default": 0 },
    { "id": "lift_height", "type": "number", "unit": "m", "desc": "取货抬升高度", "default": 0.3 }
  ],
  "steps": [
    { "joint": "EXAMPLE_body_forward", "channel": "translate", "axis": "y",
      "t_start": 0.0, "t_end": 3.0,
      "value_start": "0", "value_end": "cargo_pos_y - fork_anchor_zero_y - approach_gap",
      "easing": "ease-in-out" },
    { "joint": "EXAMPLE_mast_lift", "channel": "translate", "axis": "z",
      "t_start": 3.0, "t_end": 4.0,
      "value_start": "0", "value_end": "cargo_pos_z - cargo_height/2 - fork_anchor_zero_z",
      "easing": "ease-in-out" },
    { "joint": "EXAMPLE_mast_lift", "channel": "translate", "axis": "z",
      "t_start": 4.0, "t_end": 5.0,
      "value_start": "cargo_pos_z - cargo_height/2 - fork_anchor_zero_z",
      "value_end": "cargo_pos_z - cargo_height/2 - fork_anchor_zero_z + lift_height",
      "easing": "ease-out" }
  ]
}

**重要**：示例里的 \`EXAMPLE_*\` 是占位关节名，**你必须使用用户当前提供的关节列表里的实际关节名**。参考示例学习：位移公式 (cargo.y - fork_anchor_zero_y - approach_gap)、多步串行/并行编排、参数声明规范。

**@关节名锚定语法（精确模式）**：
- 用户如果在描述里写 \`@关节名\`（例如 \`@_CS19110 顺时针旋转 90 度\`、\`@_____10 抬升 1 米\`），则：
  - @ 后面到第一个空格/逗号/句号之前的 token 就是**关节名**，必须与 joints 列表精确匹配（包括奇怪字符，如下划线、数字）
  - 不要把奇怪字符误当成格式错误（\`_____10\`、\`cAR201\`、\`_CS19110\` 都是合法名字）
  - 同一个 @关节 后面跟的多个动作（逗号/"然后"分隔）按**先后串行**安排时间，不并行
  - 不同 @ 开头的子句默认**并行**（除非用户写"再/然后/之后"表示串行）
- 动作词到关节匹配（**优先看 role，axis 从 joints 列表读取，不要硬编码轴向**）：
  - "抬升 / 升 / 下降" → 找 role="门架升降" 的 prismatic 关节（下降则 value 为负）
  - "前进 / 后退" → 找 role="车体前进" 的 prismatic 关节（该关节的真 axis 从 joints 列表读，不假定必为 y）
  - "平移 / 横移 / x 方向" → 找 role 含"横移"/"侧移" 的 prismatic 关节
  - "旋转 / 转 / 顺时针 / 逆时针" → revolute（顺时针按右手定则为负，逆时针为正；以关节真 axis 为准）
  - 角度 "90 度" = 90；"米" 保持数值（我们统一米）
- 示例输入：\`@_CS19110 顺时针旋转 90 度，然后抬升 2 米；@_____10 抬升 1 米；车体前进 3 米\`
  - 生成：_CS19110 先 rotate 0→-90（0-2s），再 translate z 0→2（2-4s）；_____10 translate z 0→1（0-4s 并行）；车体前进关节 translate y 0→3（0-4s 并行）

**场景对象坐标注入（重要）**：
- user message 里如果有"场景对象（含世界坐标）"区块，每行 \`- name at (x, y, z)\` 是场景里一个对象的真实世界坐标
- 用户描述里提到对象名（cargo / drop / marker 名 / 零件名），必须把坐标**实际数值**填进参数 default：
  - "走到 cargo 位置" → 新参数 \`cargo_pos_x\`，default = scene 里 cargo 的 x 坐标实际值（例 7.66），不是 2 不是 5
  - "到 drop" → \`drop_pos_x\` default = scene 里 drop 的 x
- **绝对禁止**凭空写 default=2 / default=5 / default=1 这种硬编整数。如果 scene 给了坐标就用坐标
- 取货"前插间距"规则：value_end 公式应写 \`cargo_pos_x - 0.5\`（留 0.5m 不走到货物上），不是 \`cargo_pos_x\`
- 放货时车体继续移动：value_start 接上一段的 end（或新参数 \`cargo_arrival_x\`），value_end = \`drop_pos_x - 0.5\`
- 如果 scene 里找不到用户提的对象名，在输出 JSON 顶层加 \`"warnings": ["场景里没有'cargo'对象"]\` 但仍尝试生成

**自动注入的 PKF 参数（不用你在 parameters 里声明，运行时会自动填）**：
- \`cargo_width\` / \`cargo_height\` / \`cargo_depth\`：cargo marker 的尺寸
- \`fork_anchor_zero_x\` / \`fork_anchor_zero_y\` / \`fork_anchor_zero_z\`：叉齿在零位时的承载点世界坐标（UI Z-up；只有存在 reparent event 时可用）

**⚠️ 关键语义（#37）**：
prismatic 关节的 value_end 写的是**位移**（从零位开始前进多少米），**不是**世界绝对坐标。
所以公式要算"要位移多少才能让叉齿到目标点"：
- 公式：displacement = target_world - anchor_at_zero - gap
- 例：cargo.y=5, fork_anchor_zero_y=2.13, approach_gap=0 → value_end = 5 - 2.13 = 2.87（车体前进 2.87m，叉齿到 cargo 位置，snap-attach 精准对齐）
- Runtime 接着 add 到 baseWorldPos=2.93 → fork 世界 y = 5.0（= cargo.y，无缓冲）

**fork_anchor_zero 使用规则（#49：fork_anchor_zero_z 是叉齿**底面**高度）**：
- **车体前进**（y 方向）：value_end 应写 \`cargo_pos_y - fork_anchor_zero_y - approach_gap\`
- **横移**（x 方向）：\`cargo_pos_x - fork_anchor_zero_x\`（不加 approach_gap）
- **门架升降**（z 方向）：\`cargo_pos_z - cargo_height/2 - fork_anchor_zero_z\`
  （cargo 底面（= cargo_pos_z - cargo_height/2）对齐叉齿底面）
- **放货段 y**：\`drop_pos_y - fork_anchor_zero_y - approach_gap\`
- **放货段 z**：\`drop_pos_z - cargo_height/2 - fork_anchor_zero_z\`
- **⚠️ 必须三个维度都覆盖**（若 cargo 和 fork 不在同一点）：attach 前若 y / x / z 任一维度未到位，snap-attach 会瞬间把 cargo 拉到 fork 位置，造成视觉跳变
- **⛔ 禁止凭空加常数**：不要在公式里加 \`- 0.1\` / \`+ 0.05\` 这种"缓冲"数字 —— approach_gap 是唯一合法的缓冲参数，其他常数会让算出来的位移偏离预期
- **必须声明 approach_gap 参数**：\`{ "id": "approach_gap", "type": "number", "unit": "m", "desc": "叉齿离货物缓冲距离（0=贴合，snap-attach 精准对齐；正值=留安全距离）", "default": 0 }\`
- fork_anchor_zero_* 和 cargo_height 是自动注入（不用声明），approach_gap 要声明（用户可调）
- 没"叉齿零位锚点"区块 → 退化用 \`cargo_pos_y - approach_gap\`（default=1）

**关节角色（role）优先匹配规则**：
- 用户提供的每个关节可能带 \`role\` 字段（语义角色，如"车体前进"、"门架升降"、"叉齿侧移"）
- 解析用户描述时**优先按 role 匹配**关节意图，不要仅凭 type/axis 推测
  - 例：用户说"前进 2 米" → 找 role="车体前进" 的关节
  - 例：用户说"叉齿侧移 0.5 米" → 找 role="叉齿侧移" 的关节
- 如果用户的动作意图在当前模型里**没有对应 role 的关节**，**不要硬套到其他关节**。直接输出错误：

\`\`\`json
{ "error": "当前模型没有'<语义>'角色的关节，无法执行此动作", "available_roles": ["列出当前模型已有的 role"] }
\`\`\`

只有 role 完全匹配（或用户描述明确指定了关节名）才生成 PKF。`;

app.post('/api/generate-pkf', aiRateLimit, async (req, res) => {
  const { prompt, joints, scene, fork_anchor_zero: forkAnchorZero } = req.body || {};
  if (!prompt) {
    res.status(400).json({ error: '缺少 prompt 字段' });
    return;
  }
  if (!AI_API_KEY) {
    res.status(500).json({ error: 'AI_API_KEY 未配置，请在 .env 文件中设置' });
    return;
  }
  try {
    // 把关节定义精简后拼到 user message 里
    // role 字段（如有）会显示给 AI，让它按语义匹配而非靠 axis 猜
    const jointsSummary = (joints || []).map((j) => {
      const roleStr = j.role ? `, role="${j.role}"` : '';
      return `- ${j.name}: type=${j.type}, axis=${j.axis}${roleStr}`;
    }).join('\n');
    // F23：去重，避免 AI 看到重复 role 后疑惑（一个 role 可能对应多个关节，如 2 个门架升降）
    const availableRoles = [...new Set((joints || []).map((j) => j.role).filter(Boolean))];
    const rolesNote = availableRoles.length
      ? `\n当前模型已有的角色：${availableRoles.join('、')}`
      : '\n（注意：当前模型未给关节标注 role，请仅凭 type/axis 推测，不准确时返回 error）';
    // 场景对象世界坐标：让 AI 把"去 cargo 位置" / "@cargo" 解析成实际数值
    // 没有 scene（旧前端）时留空，AI fallback 到"凭经验猜"（旧行为）
    const sceneSummary = (scene || []).map((o) => {
      const p = o.position;
      const pos = p ? ` at (${Number(p.x).toFixed(2)}, ${Number(p.y).toFixed(2)}, ${Number(p.z).toFixed(2)})` : '';
      return `- ${o.name}${pos}`;
    }).join('\n');
    const sceneBlock = sceneSummary ? `\n场景对象（含世界坐标）:\n${sceneSummary}\n` : '';
    // v14.1 (#37): 叉齿零位锚点世界坐标（UI Z-up）
    // 语义：叉齿在"所有关节 value=0"时的承载点世界坐标
    // ⚠️ 关键：runtime 的 prismatic currentValue 是**位移**（加到 baseWorldPos 上），
    //         所以公式必须写 displacement = target - anchor_zero - gap
    const forkAnchorBlock = (forkAnchorZero && Object.keys(forkAnchorZero).length)
      ? `\n叉齿零位锚点（"所有关节 value=0 时"叉齿承载点的世界坐标，UI Z-up）:\n  fork_anchor_zero_x = ${forkAnchorZero.fork_anchor_zero_x}\n  fork_anchor_zero_y = ${forkAnchorZero.fork_anchor_zero_y}（主轴：前后方向）\n  fork_anchor_zero_z = ${forkAnchorZero.fork_anchor_zero_z}\n\n⚠️ 关键：prismatic 关节 value_end 写的是**位移**（从零位开始前进多少），**不是**世界绝对坐标。\n   正确公式：value_end = cargo_pos_y - fork_anchor_zero_y - approach_gap\n   这个公式计算"车体需要前进多少才能让叉齿到 cargo 前 approach_gap 处"。\n`
      : '';
    const userMessage = `可用关节:\n${jointsSummary || '（无）'}${rolesNote}\n${sceneBlock}${forkAnchorBlock}\n用户指令: ${prompt}`;

    const response = await fetch(`${AI_BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${AI_API_KEY}`,
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [
          { role: 'system', content: PKF_SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.2,
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      res.status(502).json({ error: `AI API 返回错误 (${response.status})`, detail });
      return;
    }
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';
    console.log('\n[PKF] ═══ AI 原始返回 ═══\n' + content + '\n═══════════════════\n');
    // 提取 JSON 块
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) {
      res.status(422).json({ error: 'AI 返回内容中未找到有效 JSON', raw_response: content });
      return;
    }
    const parsed = JSON.parse(match[0]);
    // AI 显式拒绝（动作意图与可用 role 不匹配）
    if (parsed.error) {
      res.status(422).json({
        error: parsed.error,
        available_roles: parsed.available_roles || [],
      });
      return;
    }
    // 基础校验
    if (!Array.isArray(parsed.parameters) || !Array.isArray(parsed.steps)) {
      res.status(422).json({ error: 'AI 返回 JSON 缺少 parameters 或 steps 数组', raw_response: content });
      return;
    }
    // ── 后处理1：修正 LLM 可能截断或拼错的 joint 名字 ──
    // 收紧匹配规则：避免 AI 输出截断名（如 "_CS"）误命中多关节 "_CS198"/"_CS19110"
    //   1) 精确匹配（含大小写不敏感）优先
    //   2) 子串匹配仅在 step.joint 长度 > 3 且场景里**唯一**命中时才生效
    //   3) 多命中或太短 → 保持原值，由后续步骤报错（"找不到关节"），而不是静默猜
    const inputJoints = joints || [];
    const inputJointNames = inputJoints.map((j) => j.name);
    if (inputJointNames.length) {
      parsed.steps.forEach((step) => {
        if (!step.joint) return;
        if (inputJointNames.includes(step.joint)) return;
        // 大小写不敏感精确匹配
        const ciExact = inputJointNames.find((n) => n.toLowerCase() === step.joint.toLowerCase());
        if (ciExact) { step.joint = ciExact; return; }
        // 子串匹配只在长度 > 3 时尝试，且要求唯一命中
        if (step.joint.length > 3) {
          const matches = inputJointNames.filter(
            (n) => n.includes(step.joint) || step.joint.includes(n),
          );
          if (matches.length === 1) {
            step.joint = matches[0];
          } else if (matches.length > 1) {
            console.warn(`[PKF] joint "${step.joint}" 模糊匹配命中多个关节（${matches.join(', ')}），保持原值由前端报错`);
          }
        }
      });
    }
    // ── 后处理2：修正 channel/type 不匹配 ──
    // 如果 step.channel=rotate 但 joint 是 prismatic（反之亦然），自动换到正确的 joint
    if (inputJoints.length) {
      parsed.steps.forEach((step) => {
        const expectedType = step.channel === 'rotate' ? 'revolute' : 'prismatic';
        const matchedJoint = inputJoints.find((j) => j.name === step.joint);
        if (matchedJoint && matchedJoint.type !== expectedType) {
          const correctJoints = inputJoints.filter((j) => j.type === expectedType);
          if (correctJoints.length === 1) {
            step.joint = correctJoints[0].name;
          }
        }
      });
    }
    res.json(parsed);
  } catch (error) {
    console.error('[MotionForge] AI generate-pkf error:', error.message);
    res.status(500).json({ error: `AI 请求失败: ${error.message}` });
  }
});

// ══════════════════════════════════════════════════════════════
//  模板节奏编排（mvp3 / Phase B）
//  前端已用"叉车取放 17 段模板"（14 必选 + 3 段可选横移）生成几何结构，后端只负责出节奏（时长 + easing + 命名）。
//  关系：与 /api/generate-pkf 正交——模板路径**不**调 generate-pkf，只调此接口。
//  契约：docs/concepts/forklift-pickup-template.md §7
// ══════════════════════════════════════════════════════════════

const TEMPLATE_RHYTHM_SYSTEM_PROMPT = `你是叉车取放动作的节奏编排师。

前端已按行业标准 17 段模板生成了完整的运动结构——每段的几何目标（位移、方向）和 attach/detach 时机都已定死，你不碰数值，只管节奏。

## 你的任务

1. 为**全部 17 段**每段决定持续时长（秒，> 0.1）
2. 每段选一个 easing：'linear' | 'ease-in' | 'ease-out' | 'ease-in-out'
3. 给整个 clip 起个名字（中文，12 字以内）

即使场景里没有"横移"关节（段 1/9/17 会被前端跳过），你**仍然要返回 17 段完整节奏**——前端编译时会自动跳过用不到的段。

## 17 段语义（固定）

取货阶段：
  1. 横移对齐 cargo x（横移到 cargo 正侧方，三向车专属；普通叉车无此段）
  2. 接近（空载前进到安全距离）
  3. 抬叉到 cargo 叉取面
  4. 前进插齿（叉齿插入 cargo 孔） — attach 在此段结束瞬间
  5. 取货（门架微抬 clearance，把 cargo 顶起）
  6. 抬到运输避让高度
  7. 后退到安全距离
  8. 叉齿复位到运输姿态

运输阶段：
  9. 横移到放货点 x（横移对准放货点，三向车专属）
  10. 移动到放货点附近（前进方向）

放货阶段：
  11. 抬叉到工作面 + fork_height
  12. 前进到放货点
  13. 放货（门架微降 clearance，cargo 落到工作面） — detach 在此段结束瞬间
  14. 后退到安全距离
  15. 叉齿复位
  16. 返回 y=0
  17. 返回 x=0（三向车专属）

## 节奏原则

- 插齿段（4）、取货段（5）、放货段（13）通常**慢**（精细操作，0.8–1.5s）
- 纯移动段（2、7、10、12、14、16）可以**较快**（1–2s，距离远可更长）
- 抬叉段（3、6、11）中等（0.8–1.2s）
- 横移段（1、9、17）一般较快（0.8–1.5s，和前进段类似）
- 复位段（8、15）可以快（0.5–1s）
- 整体总时长建议 **12–20 秒**；用户说"快速"走下限，说"小心" / "慢速"走上限

## 输出格式（严格 JSON，无任何 markdown 或解释文字）

{
  "name": "叉车标准取放",
  "segments": [
    { "index": 1, "duration": 1.0, "easing": "ease-in-out" },
    { "index": 2, "duration": 1.5, "easing": "ease-in-out" },
    { "index": 3, "duration": 1.0, "easing": "ease-in-out" },
    { "index": 4, "duration": 1.2, "easing": "ease-in" },
    { "index": 5, "duration": 1.0, "easing": "ease-out" },
    { "index": 6, "duration": 1.0, "easing": "ease-in-out" },
    { "index": 7, "duration": 1.5, "easing": "ease-in-out" },
    { "index": 8, "duration": 0.8, "easing": "ease-in-out" },
    { "index": 9, "duration": 1.2, "easing": "ease-in-out" },
    { "index": 10, "duration": 2.0, "easing": "ease-in-out" },
    { "index": 11, "duration": 1.0, "easing": "ease-in-out" },
    { "index": 12, "duration": 1.2, "easing": "ease-in" },
    { "index": 13, "duration": 1.0, "easing": "ease-out" },
    { "index": 14, "duration": 1.5, "easing": "ease-in-out" },
    { "index": 15, "duration": 0.8, "easing": "ease-in-out" },
    { "index": 16, "duration": 1.5, "easing": "ease-in-out" },
    { "index": 17, "duration": 1.0, "easing": "ease-in-out" }
  ]
}

## 规则

- 必须返回**全部 17 段**（index 1..17 齐全，不能跳，即使场景无横移也照给）
- 每段 duration ≥ 0.1s
- 不要加其他字段（parameters、steps、reparent_events 都由前端生成，你不管）
- 不要输出解释、不要 markdown 代码块围栏`;

// ── 三向车（VNA）节奏 prompt ──
// 段数动态（13~22 之间，取决于 cargoAxis / dropAxis 组合），前端传 template_segments
// 告诉 AI 本次实际有几段 + 每段名字；AI 根据名字调节奏。
const TEMPLATE_RHYTHM_SYSTEM_PROMPT_THREEWAY = `你是三向车（VNA forklift）取放动作的节奏编排师。

和普通叉车不同：三向车的段序**动态**——根据 cargo / drop 在 ±x / +y 三个轴向的位置，
段数可能在 13~22 之间浮动。前端在 user message 里会告诉你**本次实际有几段 + 每段语义**。
你不管数值，只管节奏。

## 你的任务

1. 为 user message 给定的**每一段**决定持续时长（秒，> 0.1）
2. 每段选一个 easing：'linear' | 'ease-in' | 'ease-out' | 'ease-in-out'
3. 给整个 clip 起个名字（中文，12 字以内）

## 三向车段语义（仅参考，实际段以 user message 为准）

典型段名（非全部）：
  - "车体前进到 cargo.y / drop.y" —— 移动类，1.5-3s
  - "叉齿旋转到取货朝向 / +y / 放货朝向 / 归零" —— 旋转类，0.8-1.5s
  - "门架升到取货高度 / 运输高度 / 放货工作面 / 归零" —— 抬叉类，0.8-1.5s
  - "门架横移到 cargo 前 safe / 插入 / 退回 / 复位" —— 横向类，0.8-2s
  - "车体前进插入 cargo / 车体后退 safe" —— 正面取货插/抽
  - "取货（上顶 lift_clearance）/ 放货（下降 lift_clearance）" —— **慢**（精细），1-1.5s
  - "车体退回原位" —— 长距离回归，2-3s

## 节奏原则

- **attach / detach 相关段**（插入/放货）**慢**（精细操作，1-1.5s）
- **旋转段**中等（0.8-1.2s，太快看着突兀）
- **纯移动段**较快（1-2s，距离远可更长）
- **复位段**可快（0.5-1s）
- 整体总时长建议 **12-20 秒**

## 输出格式（严格 JSON，无任何 markdown）

假设 user message 告诉你有 18 段：

{
  "name": "三向车侧取侧放",
  "segments": [
    { "index": 1, "duration": 1.5, "easing": "ease-in-out" },
    { "index": 2, "duration": 0.8, "easing": "ease-in-out" },
    ...（列完 18 段）
  ]
}

## 规则

- 段数**必须等于 user message 里的 template_segments 长度**（不多不少）
- index 从 1 开始递增至 N（与 user message 里的 index 对齐）
- 每段 duration ≥ 0.1s
- 不要加其他字段
- 不要 markdown 围栏`;

app.post('/api/template-rhythm', aiRateLimit, async (req, res) => {
  const { intent, template_segments: templateSegments, template_kind: templateKind = 'forklift' } = req.body || {};
  if (!intent) {
    res.status(400).json({ error: '缺少 intent 字段' });
    return;
  }
  if (!AI_API_KEY) {
    res.status(500).json({ error: 'AI_API_KEY 未配置，请在 .env 文件中设置' });
    return;
  }

  // 按 template_kind 选 prompt 分支
  //   'forklift' → 17 段固定语义 prompt（老路径）
  //   'threeway' → 动态段数 prompt（段数来自 template_segments 长度）
  //   其他未知 kind → 默认走 forklift，打印警告
  const isThreeway = templateKind === 'threeway';
  const systemPrompt = isThreeway
    ? TEMPLATE_RHYTHM_SYSTEM_PROMPT_THREEWAY
    : TEMPLATE_RHYTHM_SYSTEM_PROMPT;
  if (!['forklift', 'threeway'].includes(templateKind)) {
    console.warn(`[RHYTHM] 未知 template_kind="${templateKind}"，按 forklift 处理`);
  }

  // 预期段数：三向车按 template_segments 长度动态；普通叉车固定 17
  const expectedCount = isThreeway
    ? (Array.isArray(templateSegments) ? templateSegments.length : 18)
    : 17;
  if (isThreeway && expectedCount < 1) {
    res.status(400).json({ error: '三向车模板需传 template_segments 告知实际段数' });
    return;
  }

  try {
    const segmentList = (templateSegments || []).length
      ? (templateSegments || []).map((s) => `  ${s.index}. ${s.name}`).join('\n')
      : (isThreeway
          ? '（前端未传 template_segments——请按 18 段估算）'
          : '（前端未传 template_segments，请按 system prompt 里的 17 段语义）');
    const userMessage = isThreeway
      ? `用户意图：${intent}\n\n本次三向车模板编译出 **${expectedCount} 段**，每段语义：\n${segmentList}\n\n请严格按这 ${expectedCount} 段的 index 返回节奏 JSON。`
      : `用户意图：${intent}\n\n模板段列表（仅作参考，语义以 system prompt 为准）：\n${segmentList}\n\n请返回 17 段的节奏 JSON（即使场景无横移，段 1/9/17 也要给；前端编译时会跳过）。`;

    const response = await fetch(`${AI_BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${AI_API_KEY}`,
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.3,
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      res.status(502).json({ error: `AI API 返回错误 (${response.status})`, detail });
      return;
    }
    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';
    console.log(`\n[RHYTHM/${templateKind}] ═══ AI 原始返回 ═══\n${content}\n═══════════════════\n`);
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) {
      res.status(422).json({ error: 'AI 返回内容中未找到有效 JSON', raw_response: content });
      return;
    }
    const parsed = JSON.parse(match[0]);

    // 基础校验：segments 数组 + 期望段数
    if (!Array.isArray(parsed.segments) || parsed.segments.length !== expectedCount) {
      res.status(422).json({
        error: `AI 返回 segments 必须为 ${expectedCount} 项数组，实际 ${parsed.segments?.length || 0} 项`,
        raw_response: content,
      });
      return;
    }
    // 校验每段 index/duration/easing
    const validEasings = new Set(['linear', 'ease-in', 'ease-out', 'ease-in-out']);
    const indicesSeen = new Set();
    for (const seg of parsed.segments) {
      const idx = Number(seg.index);
      if (!Number.isInteger(idx) || idx < 1 || idx > expectedCount) {
        res.status(422).json({ error: `段 index 不合法：${seg.index}（期望 1..${expectedCount}）`, raw_response: content });
        return;
      }
      if (indicesSeen.has(idx)) {
        res.status(422).json({ error: `段 index 重复：${idx}`, raw_response: content });
        return;
      }
      indicesSeen.add(idx);
      const dur = Number(seg.duration);
      if (!(dur > 0) || !Number.isFinite(dur)) {
        res.status(422).json({ error: `段 ${idx} duration 非法：${seg.duration}`, raw_response: content });
        return;
      }
      if (seg.easing && !validEasings.has(seg.easing)) {
        // 不合法的 easing 默认降级为 ease-in-out（不中断）
        console.warn(`[RHYTHM] 段 ${idx} 未知 easing "${seg.easing}"，降级为 ease-in-out`);
        seg.easing = 'ease-in-out';
      }
      if (!seg.easing) seg.easing = 'ease-in-out';
      seg.duration = +dur.toFixed(3);
    }
    // 检查全部 index 齐全
    if (indicesSeen.size !== expectedCount) {
      const missingIdx = [...Array(expectedCount).keys()].map((i) => i + 1).filter((i) => !indicesSeen.has(i));
      res.status(422).json({ error: `段 index 不全，缺失：${missingIdx}`, raw_response: content });
      return;
    }

    parsed.name = String(parsed.name || (isThreeway ? '三向车取放' : '叉车取放')).trim() || (isThreeway ? '三向车取放' : '叉车取放');
    // 按 index 排序返回（前端也会再 map 一次，但排好序更整齐）
    parsed.segments.sort((a, b) => a.index - b.index);
    res.json(parsed);
  } catch (error) {
    console.error('[MotionForge] AI template-rhythm error:', error.message);
    res.status(500).json({ error: `AI 请求失败: ${error.message}` });
  }
});

// ══════════════════════════════════════════════════════════════
//  L1：高级意图 → 时间表（"去 a 取货" → markdown 表格行）
//  与 /api/generate-pkf 的关系：L1 拆出时间表，用户审核后再调 L2 生成 PKF
// ══════════════════════════════════════════════════════════════

const DECOMPOSE_SYSTEM_PROMPT = `你是 AGV/叉车动作时序拆解助手。把用户的高级意图（"去 cargo 取货"）拆成**一键可执行**的动画规划。

## 输出严格格式（仅 JSON，无任何 markdown 或解释）

\`\`\`json
{
  "rows": [
    { "time": "0-3s", "op": "车体前进到 y=cargo.y - fork_anchor_zero_y - approach_gap, 同时横移到 x=cargo.x - fork_anchor_zero_x（并行）" },
    { "time": "3-4s", "op": "门架下降到 z=cargo.z - cargo_height/2 - fork_anchor_zero_z（cargo 底面对齐叉齿底面）" },
    { "time": "4s",   "op": "cargo 附着到叉齿" },
    { "time": "4-5s", "op": "门架抬升 lift_height（抬离地面）" },
    { "time": "5-8s", "op": "车体继续前进到 y=drop.y - fork_anchor_zero_y - approach_gap, 横移到 x=drop.x - fork_anchor_zero_x" },
    { "time": "8-9s", "op": "门架下降到 z=drop.z - cargo_height/2 - fork_anchor_zero_z" },
    { "time": "9s",   "op": "cargo 脱离" }
  ],
  "reparent_events": [
    { "t": 4, "child_name": "cargo", "new_parent_name": "<叉齿关节名>" },
    { "t": 9, "child_name": "cargo", "new_parent_name": null }
  ],
  "warnings": [
    "车体无横移关节，cargo.x 方向对不齐，叉车只能前进到 y 方向"
  ]
}
\`\`\`

## 车辆动作规则（核心）

用户的模型**只有前后/平移/升降**，**不转弯**，撞了不管。所以：

1. **状态跟踪（重要）**：车在每一段结束后的坐标 = 上一段 end + 本段 delta。
   - t=0 时车体在 (0,0,0)
   - 取货段走到 cargo 附近后，车体就停在那里；下一段 delta 基准是**车体当前位置**，不是 (0,0,0)
2. **按 role 分配 delta 到关节**：
   - \`delta.x\` → role="车体横移" 或 "叉齿侧移"
   - \`delta.y\` → role="车体前进"
   - \`delta.z\` → role="门架升降"
3. **多关节可并行**（同一时间区间）——常见"车体前进 + 横移"同时进行
4. **缺少某轴关节时**：
   - 忽略那个轴的 delta
   - 必须在 \`warnings[]\` 里加一条："车体无横移关节，cargo.x=2 对不齐"
   - 不要 error，继续做能做的

## 取货 / 放货流程

**⚠️ 坐标来源**：cargo.x/cargo.y/cargo.z 的具体数值**必须从 user message 的"场景对象"区块里读**。用户会给你 \`cargo at (7.66, 0.50, 0.10)\` 这种行，你用 7.66 不要用 5，用 0.10 不要用 0.3。下面示例里的 5 只是占位。

**⚠️ 叉齿零位锚点规则（#37，必须遵守）**：
如果 user message 里有"叉齿零位锚点"区块：
- ⛔ **禁止**在 rows 里写 "留 Xm 间距" / 具体数值（y=4.0 那种）
- ✅ 必须写**字面位移公式**：
  - 前进：\`y=cargo.y - fork_anchor_zero_y - approach_gap\`
  - 横移：\`x=cargo.x - fork_anchor_zero_x\`（不加 approach_gap）
  - 升降：\`z=cargo.z - cargo_height/2 - fork_anchor_zero_z\`（cargo 底面对齐叉齿底面）
- 放货同理：\`y=drop.y - fork_anchor_zero_y - approach_gap\` / \`z=drop.z - cargo_height/2 - fork_anchor_zero_z\`
- **⚠️ 必须覆盖 attach 前的三个维度**：x/y/z 任一维度若 attach 时未到位，snap 会瞬间拉 cargo 到 fork 位置，产生视觉跳变。没有对应关节（比如没"车体横移"）必须在 warnings 里声明
- **⛔ 禁止凭空加常数**：只能用 approach_gap 做缓冲；不要自己加 \`- 0.1\` / \`+ 0.05\` 这种数字
- **approach_gap 默认 0**（叉齿直接到 cargo 位置，由 snap-attach 精准对齐；用户可调大到 0.3 / 0.5 留缓冲）
- **关键语义**：这是**位移公式**（prismatic 关节的 value 是从零位开始的位移），**不是绝对坐标**

**示例 rows（有 fork_anchor_zero 时）**：
\`{ "time": "0-3s", "op": "车体前进到 y=cargo.y - fork_anchor_zero_y - approach_gap, 同时横移到 x=cargo.x - fork_anchor_zero_x（并行）" }\`

**反面示例（错！不要这样写）**：
- \`{ "op": "车体前进到 cargo 前方 (y=4.0, 留 1m 间距)" }\`  ← 把位移当成了绝对坐标，还丢了 anchor
- \`{ "op": "车体前进到 y=cargo.y - approach_gap" }\`  ← 漏掉 anchor_zero，把绝对坐标当位移用 → 车会开过头

**取货 X**（X 是 cargo 名字）：
1. 车体移动到**货物前方**（不是货物上），留 ~0.5m 间距给叉齿前插空间。
   - 例：scene 里 cargo at (?, 5, ?) → 车体前进关节 value_end = 5 − 0.5 = **4.5**（用 scene 给的实际 y，不是示例里的 5）
   - 横移 value_end = cargo 的 x 坐标实际值（没有偏移）
2. 门架下降对齐 cargo 高度（cargo 的 z 坐标实际值）
3. reparent：cargo attach 到叉齿（瞬时，写进 reparent_events）
4. 门架抬升（小幅，~0.3m，把货物抬离地面）

**放货到 Y**（Y 是 drop 名字）：
1. 车体从当前位置（cargo 附近）**继续前进/横移到 drop 前方**，再留 0.5m 间距
   - ⚠️ delta 是 drop − cargo，不是 drop − 原点
   - value_end 写绝对位置：drop 的 y 实际值 − 0.5
2. 门架下降到 drop 的 z 实际值
3. reparent：cargo detach（写进 reparent_events）
4. ⚠️ 不要把车体送回原点，停在 drop 附近

## 附着关节选择（reparent 的 new_parent_name）

- 优先找叉齿类关节（role 含"叉齿"字样，或 name 含"CS"/"叉"字样）
- 没有叉齿关节 → 用门架关节
- 还没有 → warnings 加"无合适附着关节"，reparent_events 留空

## 时间格式

- 区间："0-3s"、"4-5s"
- 瞬时："4s"（reparent 事件触发点）
- 总时长 < 15s

## 输出字段

- \`rows\`: 给人看的时间表（用户会审核）
- \`reparent_events\`: **前端自动应用**（不用用户手动加）
- \`warnings\`: 任何信息性提示（缺关节、无法精确到达等）

## 约束

- cargo / drop 名字必须**精确匹配**用户传来的 scene context 里的对象名
- reparent 的 new_parent_name 必须是**场景中存在的关节对应的子对象名**（不是 joint role）
- 操作描述要带具体数值（"y=5" 不是"y 方向"）
- 不要硬加 transformation，model 只支持前后 / 平移 / 升降

**只输出 JSON。**`;

app.post('/api/decompose-intent', aiRateLimit, async (req, res) => {
  const { intent, scene, joints, fork_anchor_zero: forkAnchorZero } = req.body || {};
  if (!intent) {
    res.status(400).json({ error: '缺少 intent 字段' });
    return;
  }
  if (!AI_API_KEY) {
    res.status(500).json({ error: 'AI_API_KEY 未配置' });
    return;
  }
  try {
    // 场景对象列表（带世界坐标）
    const sceneSummary = (scene || []).map((o) => {
      const pos = o.position ? ` at (${o.position.x.toFixed(2)}, ${o.position.y.toFixed(2)}, ${o.position.z.toFixed(2)})` : '';
      return `- ${o.name}${pos}`;
    }).join('\n');

    // 关节列表（含 role）
    const jointsSummary = (joints || []).map((j) => {
      const roleStr = j.role ? `, role="${j.role}"` : '';
      return `- ${j.name}: type=${j.type}, axis=${j.axis}${roleStr}`;
    }).join('\n');

    // v14.1 (#37): 叉齿零位锚点（叉齿在"所有关节 value=0"时的世界坐标，UI Z-up）
    const forkAnchorBlock = (forkAnchorZero && Object.keys(forkAnchorZero).length)
      ? `\n叉齿零位锚点（"所有关节 value=0 时"叉齿承载点的世界坐标，UI Z-up）:
  fork_anchor_zero_x = ${forkAnchorZero.fork_anchor_zero_x}
  fork_anchor_zero_y = ${forkAnchorZero.fork_anchor_zero_y}（主轴：前后方向）
  fork_anchor_zero_z = ${forkAnchorZero.fork_anchor_zero_z}

⚠️ 关键：prismatic 关节的"value"在 runtime 里是**从零位开始的位移**，不是世界绝对坐标。
   所以 PKF 公式里车体前进的 value_end 必须写位移表达式：
   value_end = cargo.y - fork_anchor_zero_y - approach_gap
   这表示"车体需要前进多少米，让叉齿从零位挪到 cargo 前 approach_gap 处"。\n`
      : '';
    const userMessage = `场景对象（含世界坐标）:
${sceneSummary || '（无）'}

可用关节:
${jointsSummary || '（无）'}
${forkAnchorBlock}
用户高级意图: ${intent}`;

    console.log('\n[Decompose] ═══ 用户意图 ═══\n' + intent + '\n═══════════════════\n');
    console.log('[Decompose] ═══ 送给 AI 的完整 user message ═══\n' + userMessage + '\n═══════════════════\n');

    const response = await fetch(`${AI_BASE_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${AI_API_KEY}`,
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [
          { role: 'system', content: DECOMPOSE_SYSTEM_PROMPT },
          { role: 'user', content: userMessage },
        ],
        temperature: 0.3,
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      res.status(502).json({ error: `AI API 错误 (${response.status})`, detail });
      return;
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || '';
    console.log('[Decompose] ═══ AI 返回 ═══\n' + content + '\n═══════════════════\n');

    const match = content.match(/\{[\s\S]*\}/);
    if (!match) {
      res.status(422).json({ error: 'AI 返回中未找到 JSON', raw_response: content });
      return;
    }

    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed.rows)) {
      res.status(422).json({ error: 'AI 返回 JSON 缺少 rows 数组', raw_response: content });
      return;
    }

    // 校验每行格式
    const validRows = parsed.rows.filter((r) => r && typeof r.time === 'string' && typeof r.op === 'string');
    // v14: reparent_events + warnings（AI 可能不输出，容错为空数组）
    const validReparentEvents = Array.isArray(parsed.reparent_events)
      ? parsed.reparent_events.filter(
          (e) => e && typeof e.t !== 'undefined' && typeof e.child_name === 'string',
        ).map((e) => ({
          t: Number(e.t) || 0,
          child_name: e.child_name,
          new_parent_name: e.new_parent_name === undefined ? null : e.new_parent_name,
        }))
      : [];
    const warnings = Array.isArray(parsed.warnings) ? parsed.warnings.filter((w) => typeof w === 'string') : [];
    res.json({ rows: validRows, reparent_events: validReparentEvents, warnings });
  } catch (error) {
    console.error('[MotionForge] decompose-intent error:', error.message);
    res.status(500).json({ error: `AI 请求失败: ${error.message}` });
  }
});

// REVIEW-v15 F3：仅监听 HOST（默认 127.0.0.1），避免默认绑到 0.0.0.0 暴露给 LAN
app.listen(PORT, HOST, () => {
  console.log(`[MotionForge] Conversion service running on http://${HOST}:${PORT}`);
  console.log(`[MotionForge] Blender path: ${blenderPath}`);
  console.log(`[MotionForge] Converter script: ${converterScript}`);
  console.log(`[MotionForge] Work dir: ${WORK_DIR}`);
  console.log(`[MotionForge] AI base URL: ${AI_BASE_URL}`);
  console.log(`[MotionForge] AI model: ${AI_MODEL}`);
  console.log(`[MotionForge] 资源限制: upload=${(CONVERTER_UPLOAD_MAX / 1024 / 1024).toFixed(0)}MB, blender-timeout=${BLENDER_TIMEOUT_MS}ms`);
  if (HOST === '0.0.0.0') {
    console.warn('[MotionForge] ⚠ CONVERTER_HOST=0.0.0.0 监听所有网卡——生产前确保已加 auth 层');
  }
});
