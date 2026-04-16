#!/usr/bin/env node
/**
 * 把 Claude Code 的对话 .jsonl 转成可读 Markdown
 *
 * 用法：
 *   node tools/export-conversation.cjs [session-id] [--out <path>]
 *   node tools/export-conversation.cjs --all [--out-dir <path>]
 *
 * 不指定 session-id 时，默认导出**当前项目**最近修改的会话
 * --all 模式：导出所有会话到一个文件夹（默认 zip/all-conversations/）
 *
 * 例子：
 *   node tools/export-conversation.cjs                        # 最近的会话
 *   node tools/export-conversation.cjs 4757337c               # 按前缀匹配
 *   node tools/export-conversation.cjs --out ./my-chat.md     # 自定义路径
 *   node tools/export-conversation.cjs --all                  # 全部导出到 zip/all-conversations/
 *   node tools/export-conversation.cjs --all --out-dir ./chats
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const os = require('os');

// 项目对话存储路径（Claude Code 约定）
const PROJECT_DIR_NAME = 'c--Users-Administrator-Desktop-cursor-MotionForge';
const CONV_DIR = path.join(os.homedir(), '.claude', 'projects', PROJECT_DIR_NAME);

function parseArgs(argv) {
  const args = { sessionIdPrefix: null, outPath: null, all: false, outDir: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') {
      args.all = true;
    } else if (a === '--out' && argv[i + 1]) {
      args.outPath = argv[++i];
    } else if (a === '--out-dir' && argv[i + 1]) {
      args.outDir = argv[++i];
    } else if (!args.sessionIdPrefix && !a.startsWith('--')) {
      args.sessionIdPrefix = a;
    }
  }
  return args;
}

function findSessionFile(prefix) {
  if (!fs.existsSync(CONV_DIR)) {
    throw new Error(`会话目录不存在: ${CONV_DIR}`);
  }
  const files = fs
    .readdirSync(CONV_DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({
      name: f,
      full: path.join(CONV_DIR, f),
      mtime: fs.statSync(path.join(CONV_DIR, f)).mtimeMs,
    }));
  if (!files.length) throw new Error('未找到任何 .jsonl 会话文件');

  if (prefix) {
    const hit = files.find((f) => f.name.startsWith(prefix));
    if (!hit) throw new Error(`未找到前缀匹配的会话: ${prefix}`);
    return hit;
  }
  // 最近修改
  files.sort((a, b) => b.mtime - a.mtime);
  return files[0];
}

function fmtTimestamp(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

// 提取单条消息里所有文本内容（text / tool_use / tool_result）
function formatContent(content) {
  if (!Array.isArray(content)) {
    return typeof content === 'string' ? content : JSON.stringify(content);
  }
  const parts = [];
  for (const block of content) {
    if (!block) continue;
    if (block.type === 'text' && block.text) {
      parts.push(block.text);
    } else if (block.type === 'tool_use') {
      const input = typeof block.input === 'object' ? JSON.stringify(block.input, null, 2) : String(block.input);
      parts.push(`\n<details><summary>🔧 工具调用: ${block.name}</summary>\n\n\`\`\`json\n${input}\n\`\`\`\n</details>`);
    } else if (block.type === 'tool_result') {
      const c = block.content;
      const text = Array.isArray(c)
        ? c.map((x) => (x?.text || JSON.stringify(x))).join('\n')
        : typeof c === 'string' ? c : JSON.stringify(c);
      // 工具返回太长就折叠
      const preview = text.length > 300 ? text.slice(0, 300) + `\n...(共 ${text.length} 字符)` : text;
      parts.push(`\n<details><summary>📤 工具返回</summary>\n\n\`\`\`\n${preview}\n\`\`\`\n</details>`);
    } else if (block.type === 'thinking' && block.thinking) {
      parts.push(`\n<details><summary>💭 思考</summary>\n\n${block.thinking}\n</details>`);
    }
  }
  return parts.join('\n');
}

async function convert(sessionFile, outPath) {
  const rl = readline.createInterface({
    input: fs.createReadStream(sessionFile),
    crlfDelay: Infinity,
  });

  const outStream = fs.createWriteStream(outPath);
  const sessionId = path.basename(sessionFile, '.jsonl');
  outStream.write(`# Claude Code 对话导出\n\n`);
  outStream.write(`- **Session ID**: \`${sessionId}\`\n`);
  outStream.write(`- **源文件**: \`${sessionFile}\`\n`);
  outStream.write(`- **导出时间**: ${fmtTimestamp(Date.now())}\n\n---\n\n`);

  let count = 0;
  let userCount = 0;
  let assistantCount = 0;

  for await (const line of rl) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const role = entry.type || entry.message?.role || 'unknown';
    const ts = fmtTimestamp(entry.timestamp);

    if (role === 'user' || role === 'assistant') {
      count++;
      if (role === 'user') userCount++;
      else assistantCount++;

      const content = entry.message?.content ?? entry.content ?? '';
      const body = formatContent(content);
      if (!body.trim()) continue;

      const emoji = role === 'user' ? '👤' : '🤖';
      const label = role === 'user' ? 'User' : 'Assistant';
      outStream.write(`## ${emoji} ${label}${ts ? ` · ${ts}` : ''}\n\n`);
      outStream.write(body + '\n\n---\n\n');
    }
    // summary / system / meta 条目跳过
  }

  outStream.end();
  await new Promise((r) => outStream.on('finish', r));

  const stat = fs.statSync(outPath);
  console.log(`✅ 导出完成: ${outPath}`);
  console.log(`   消息数: ${count} (用户 ${userCount} / 助手 ${assistantCount})`);
  console.log(`   文件大小: ${(stat.size / 1024).toFixed(1)} KB`);
}

// 清理用户消息：剥掉 system-reminder / ide tags / local-command-stdout / 上个 session 的 continuation summary
function cleanUserText(raw) {
  if (!raw) return '';
  let s = raw;
  // 去掉各种 XML-like 系统 tag（多行匹配）
  s = s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
  s = s.replace(/<ide_selection>[\s\S]*?<\/ide_selection>/g, '');
  s = s.replace(/<ide_opened_file>[\s\S]*?<\/ide_opened_file>/g, '');
  s = s.replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '');
  s = s.replace(/<local-command-stderr>[\s\S]*?<\/local-command-stderr>/g, '');
  s = s.replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '');
  s = s.replace(/<command-name>[\s\S]*?<\/command-name>/g, '');
  s = s.replace(/<command-message>[\s\S]*?<\/command-message>/g, '');
  s = s.replace(/<command-args>[\s\S]*?<\/command-args>/g, '');
  // 剥掉 session 续接 summary（可能以 "This session is being continued" 开头，到下一个 </...> 或结尾）
  s = s.replace(/This session is being continued from a previous conversation[\s\S]*?(?:<\/local-command-stdout>|<\/local-command-caveat>|$)/g, '');
  // 剥掉单独出现的 "Caveat:" 段（无 tag 包裹的情况）
  s = s.replace(/Caveat:[\s\S]{0,500}?(?=\n\n|$)/g, '');
  // 剥掉 "Compacted" 标记
  s = s.replace(/Compacted\b/gi, '');
  // 剥掉用户级 prompt-submit-hook 前缀（settings.local.json 里配置，每次消息自动加）
  // 这种前缀对所有 continued session 都一样，不是真实用户问题
  s = s.replace(/再详细点[，,]?\s*拆开[，,]?\s*告诉我每一步怎么做以及为什么这样做[。.]?/g, '');
  return s.replace(/\s+/g, ' ').trim();
}

// 提取 session 的第一条"真正"用户消息作为标题（跳过续接 summary / 纯系统 tag）
function extractTitle(sessionFile) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: fs.createReadStream(sessionFile),
      crlfDelay: Infinity,
    });
    let found = null;
    rl.on('line', (line) => {
      if (found) return;
      try {
        const e = JSON.parse(line);
        const role = e.type || e.message?.role;
        if (role !== 'user') return;
        const content = e.message?.content ?? e.content;
        let raw = '';
        if (typeof content === 'string') raw = content;
        else if (Array.isArray(content)) {
          for (const b of content) {
            if (b?.type === 'text' && b.text) { raw = b.text; break; }
            // tool_result 等跳过
          }
        }
        const cleaned = cleanUserText(raw);
        if (cleaned.length >= 5) {
          found = cleaned.slice(0, 50);
          rl.close();
        }
      } catch {}
    });
    rl.on('close', () => resolve(found || '(无标题)'));
  });
}

async function exportAll(outDir) {
  if (!fs.existsSync(CONV_DIR)) {
    throw new Error(`会话目录不存在: ${CONV_DIR}`);
  }
  const files = fs
    .readdirSync(CONV_DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => ({
      name: f,
      full: path.join(CONV_DIR, f),
      mtime: fs.statSync(path.join(CONV_DIR, f)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);

  if (!files.length) throw new Error('未找到任何 .jsonl 会话文件');
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`📥 批量导出 ${files.length} 个会话到: ${outDir}\n`);

  const indexLines = [
    `# 会话索引\n`,
    `- **项目**: MotionForge`,
    `- **总会话数**: ${files.length}`,
    `- **导出时间**: ${fmtTimestamp(Date.now())}`,
    ``,
    `| # | 标题 | 最后修改 | 大小 | 文件 |`,
    `|---|---|---|---|---|`,
  ];

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const shortId = f.name.slice(0, 8);
    const title = await extractTitle(f.full);
    // 安全的文件名：去掉 Windows 不允许的字符
    const safeTitle = title.replace(/[\\/:*?"<>|]/g, '_');
    const mtimeStr = new Date(f.mtime).toISOString().slice(0, 10);
    const outName = `${mtimeStr}__${shortId}__${safeTitle}.md`;
    const outPath = path.join(outDir, outName);

    process.stdout.write(`  [${i + 1}/${files.length}] ${shortId} · ${title.slice(0, 30)}... `);
    try {
      await convert(f.full, outPath);
      const size = (fs.statSync(outPath).size / 1024).toFixed(0);
      indexLines.push(`| ${i + 1} | ${title} | ${mtimeStr} | ${size} KB | [${outName}](${outName}) |`);
    } catch (e) {
      console.log(`❌ ${e.message}`);
      indexLines.push(`| ${i + 1} | ${title} | ${mtimeStr} | — | ❌ 导出失败 |`);
    }
  }

  // 写索引
  const indexPath = path.join(outDir, 'INDEX.md');
  fs.writeFileSync(indexPath, indexLines.join('\n'));
  console.log(`\n✅ 全部完成，索引: ${indexPath}`);
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.all) {
    const outDir = args.outDir || path.join(process.cwd(), 'zip', 'all-conversations');
    await exportAll(outDir);
    return;
  }

  const session = findSessionFile(args.sessionIdPrefix);
  console.log(`📥 导出会话: ${session.name}`);
  console.log(`   最后修改: ${fmtTimestamp(session.mtime)}`);

  const outPath = args.outPath || path.join(
    process.cwd(),
    'zip',
    `conversation-${session.name.slice(0, 8)}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.md`,
  );
  // 确保输出目录存在
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  await convert(session.full, outPath);
}

main().catch((e) => {
  console.error('❌ 失败:', e.message);
  process.exit(1);
});
