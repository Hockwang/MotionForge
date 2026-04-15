import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import multer from 'multer';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';

const app = express();
app.use(express.json());
const upload = multer({ dest: path.join(os.tmpdir(), 'motionforge-uploads') });
const PORT = Number(process.env.CONVERTER_PORT || 8091);
const AI_BASE_URL = process.env.AI_BASE_URL || 'https://coding.qunhequnhe.com';
const AI_API_KEY = process.env.AI_API_KEY || '';
const AI_MODEL = process.env.AI_MODEL || 'gemini-3-flash-thinking';

const DEFAULT_BLENDER_PATH = 'C:\\Program Files\\Blender Foundation\\Blender 5.1\\blender.exe';
const blenderPath = process.env.BLENDER_PATH || DEFAULT_BLENDER_PATH;
const converterScript = path.resolve(process.cwd(), 'tools', 'convert_usd_to_glb.py');
const WORK_DIR = path.resolve(process.cwd(), '.converter-temp');

app.use(cors());

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

app.post('/api/understand-task', async (req, res) => {
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

**学习下面的完整示例**（叉车取货动作 — 前进 → 下降 → 插入 → 抬升）：

示例输入：
- 关节列表：cAR201(prismatic, axis=x)，mast_lift(prismatic, axis=z)，fork_tilt(revolute, axis=z)
- 用户描述：叉车前进 2 米取货，货物高度 0.5 米，抬升 0.3 米

示例输出：
{
  "parameters": [
    { "id": "pickup_point_x", "type": "number", "unit": "m", "desc": "取货点前进距离", "default": 2.0 },
    { "id": "cargo_height", "type": "number", "unit": "m", "desc": "货物底部高度", "default": 0.5 },
    { "id": "insert_depth", "type": "number", "unit": "m", "desc": "叉齿插入深度", "default": 0.8 },
    { "id": "lift_clearance", "type": "number", "unit": "m", "desc": "抬升安全高度", "default": 0.3 },
    { "id": "safe_distance", "type": "number", "unit": "m", "desc": "接近安全停距", "default": 0.1 }
  ],
  "steps": [
    { "joint": "cAR201", "channel": "translate", "axis": "x",
      "t_start": 0.0, "t_end": 2.0,
      "value_start": "0", "value_end": "pickup_point_x - safe_distance",
      "easing": "ease-in-out" },
    { "joint": "mast_lift", "channel": "translate", "axis": "z",
      "t_start": 2.0, "t_end": 3.5,
      "value_start": "0", "value_end": "cargo_height",
      "easing": "ease-in-out" },
    { "joint": "cAR201", "channel": "translate", "axis": "x",
      "t_start": 3.5, "t_end": 4.5,
      "value_start": "pickup_point_x - safe_distance", "value_end": "pickup_point_x + insert_depth",
      "easing": "ease-in" },
    { "joint": "mast_lift", "channel": "translate", "axis": "z",
      "t_start": 4.5, "t_end": 6.0,
      "value_start": "cargo_height", "value_end": "cargo_height + lift_clearance",
      "easing": "ease-out" }
  ]
}

**重要**：示例里的关节名（cAR201/mast_lift/fork_tilt）仅为参考，**你必须使用用户当前提供的关节列表里的实际关节名**。参考示例学习的是：公式如何引用参数、多步骤如何编排、并行/串行时序如何安排。

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

app.post('/api/generate-pkf', async (req, res) => {
  const { prompt, joints } = req.body || {};
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
    const availableRoles = (joints || []).map((j) => j.role).filter(Boolean);
    const rolesNote = availableRoles.length
      ? `\n当前模型已有的角色：${availableRoles.join('、')}`
      : '\n（注意：当前模型未给关节标注 role，请仅凭 type/axis 推测，不准确时返回 error）';
    const userMessage = `可用关节:\n${jointsSummary || '（无）'}${rolesNote}\n\n用户指令: ${prompt}`;

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

app.listen(PORT, () => {
  console.log(`[MotionForge] Conversion service running on http://localhost:${PORT}`);
  console.log(`[MotionForge] Blender path: ${blenderPath}`);
  console.log(`[MotionForge] Converter script: ${converterScript}`);
  console.log(`[MotionForge] Work dir: ${WORK_DIR}`);
  console.log(`[MotionForge] AI base URL: ${AI_BASE_URL}`);
  console.log(`[MotionForge] AI model: ${AI_MODEL}`);
});
