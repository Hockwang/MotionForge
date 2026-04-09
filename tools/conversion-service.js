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

app.listen(PORT, () => {
  console.log(`[MotionForge] Conversion service running on http://localhost:${PORT}`);
  console.log(`[MotionForge] Blender path: ${blenderPath}`);
  console.log(`[MotionForge] Converter script: ${converterScript}`);
  console.log(`[MotionForge] Work dir: ${WORK_DIR}`);
  console.log(`[MotionForge] AI base URL: ${AI_BASE_URL}`);
  console.log(`[MotionForge] AI model: ${AI_MODEL}`);
});
