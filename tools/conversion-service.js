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
const upload = multer({ dest: path.join(os.tmpdir(), 'motionforge-uploads') });
const PORT = Number(process.env.CONVERTER_PORT || 8091);
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

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      reject(new Error(`Failed to start Blender: ${error.message}`));
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`Blender exited with code ${code}. ${stderr || stdout}`));
    });
  });
}

app.post('/api/convert-to-glb', upload.single('file'), async (req, res) => {
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
      "value_start": "0", "value_end": "cargo_pos_z - fork_anchor_zero_z",
      "easing": "ease-in-out" },
    { "joint": "EXAMPLE_mast_lift", "channel": "translate", "axis": "z",
      "t_start": 4.0, "t_end": 5.0,
      "value_start": "cargo_pos_z - fork_anchor_zero_z",
      "value_end": "cargo_pos_z - fork_anchor_zero_z + lift_height",
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

**fork_anchor_zero 使用规则（组合 approach_gap）**：
- 有"叉齿零位锚点"区块：value_end 应写 \`cargo_pos_y - fork_anchor_zero_y - approach_gap\`
- 横移：\`cargo_pos_x - fork_anchor_zero_x\`（不加 approach_gap）
- 放货段：\`drop_pos_y - fork_anchor_zero_y - approach_gap\`
- **必须声明 approach_gap 参数**：\`{ "id": "approach_gap", "type": "number", "unit": "m", "desc": "叉齿离货物缓冲距离（0=贴合，snap-attach 精准对齐；正值=留安全距离）", "default": 0 }\`
- fork_anchor_zero_* 是自动注入（不用声明），approach_gap 要声明（用户可调）
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
//  L1：高级意图 → 时间表（"去 a 取货" → markdown 表格行）
//  与 /api/generate-pkf 的关系：L1 拆出时间表，用户审核后再调 L2 生成 PKF
// ══════════════════════════════════════════════════════════════

const DECOMPOSE_SYSTEM_PROMPT = `你是 AGV/叉车动作时序拆解助手。把用户的高级意图（"去 cargo 取货"）拆成**一键可执行**的动画规划。

## 输出严格格式（仅 JSON，无任何 markdown 或解释）

\`\`\`json
{
  "rows": [
    { "time": "0-3s", "op": "车体前进到 y=cargo.y - fork_anchor_zero_y - approach_gap, 同时横移到 x=cargo.x - fork_anchor_zero_x（并行）" },
    { "time": "3-4s", "op": "门架下降到 z=cargo.z - fork_anchor_zero_z 对齐 cargo 高度" },
    { "time": "4s",   "op": "cargo 附着到叉齿" },
    { "time": "4-5s", "op": "门架抬升 lift_height（抬离地面）" },
    { "time": "5-8s", "op": "车体继续前进到 y=drop.y - fork_anchor_zero_y - approach_gap, 横移到 x=drop.x - fork_anchor_zero_x" },
    { "time": "8-9s", "op": "门架下降到 z=drop.z - fork_anchor_zero_z" },
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
- ✅ 必须写**字面位移公式**："y=cargo.y - fork_anchor_zero_y - approach_gap"
- 横移："x=cargo.x - fork_anchor_zero_x"（不加 approach_gap）
- 放货同理："y=drop.y - fork_anchor_zero_y - approach_gap"
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

app.listen(PORT, () => {
  console.log(`[MotionForge] Conversion service running on http://localhost:${PORT}`);
  console.log(`[MotionForge] Blender path: ${blenderPath}`);
  console.log(`[MotionForge] Converter script: ${converterScript}`);
  console.log(`[MotionForge] Work dir: ${WORK_DIR}`);
  console.log(`[MotionForge] AI base URL: ${AI_BASE_URL}`);
  console.log(`[MotionForge] AI model: ${AI_MODEL}`);
});
