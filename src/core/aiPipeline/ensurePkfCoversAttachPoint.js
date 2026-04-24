/**
 * AI 生成 PKF 的兜底处理 —— 负责两件事：
 *   (1) sanitize AI 常见违规：approach_gap.default 强制归 0；清洗 fork_anchor_zero_xyz 公式里
 *       AI 凭空加的裸常数（-0.1 / +0.05 类）
 *   (2) 自动补 step：attach 事件前若 cargo 到 fork_anchor_zero 的偏移在 x/y/z 任一维超阈值
 *       且 AI 没有覆盖该维，自动注入一个 0→offset 的 step，保证 attach 瞬间零 teleport
 *
 * 原本内联在 [main.js] 的 🚀 一键流程里，#65 (REVIEW-v17 #7) 抽成独立模块：
 *   - 纯数据转换逻辑（输入 pkf + ctx + keyframeManager，输出修改后的 pkf）
 *   - 可独立单测，不用走真实 AI + DOM
 *   - keyframeManager 改为显式参数（原来是闭包变量），测试时传 stub 即可
 */

// ── 常量 ──

// 小于这个距离视为已对齐，不注入额外 step（单位：米）
const ATTACH_ALIGN_THRESHOLD = 0.05;

// AI 凭空加的裸常数清洗正则：匹配 `fork_anchor_zero_[xyz] ± <number>` 形式尾巴
//   - 保留 `fork_anchor_zero_x + approach_gap` 这类合法表达式（参数名，不是裸数字）
//   - 剥离 `fork_anchor_zero_x - 0.1` 这类 AI 凭空加的 offset
//   - lookahead `(?=\s*[-+]|\s*$)` 要求匹配后接另一个运算符或结尾，避免误吃中间
const NAKED_CONST_RE = /(fork_anchor_zero_[xyz])\s*[-+]\s*\d+(?:\.\d+)?(?=\s*[-+]|\s*$)/g;

// 各维度对应的 role 候选（找不到时 warning，不报错）
const ROLES_BY_DIMENSION = {
  x: ['车体横移', '叉齿侧移'],
  y: ['车体前进'],
  z: ['门架升降'],
};

/**
 * sanitize + 自动补 step 兜底
 *
 * @param {Object} pkf - AI 返回的 PKF 对象（会被原地修改 + 返回）
 * @param {Object} ctx - 上下文
 * @param {Array}  ctx.sceneList - 场景对象列表（至少含 name + position.{x,y,z}）
 * @param {Object} ctx.forkAnchorZero - `{fork_anchor_zero_x, fork_anchor_zero_y, fork_anchor_zero_z}`
 * @param {Array}  ctx.reparentEvents - L1 返回的 reparent 事件
 * @param {Object} keyframeManager - 至少要能提供 getCargoSizeParams() 和 getAllJointDefs()
 * @returns {Object} 同一个 pkf（原地修改，方便链式）
 */
export function ensurePkfCoversAttachPoint(pkf, ctx, keyframeManager) {
  if (!pkf || typeof pkf !== 'object') return pkf;

  // ── 1. sanitize AI 常见违规 ──
  const warnings = Array.isArray(pkf.warnings) ? pkf.warnings : (pkf.warnings = []);

  // 1a. approach_gap.default 强制归 0
  const apParam = (pkf.parameters || []).find((p) => p.id === 'approach_gap');
  if (apParam && Number(apParam.default) !== 0) {
    const oldDefault = apParam.default;
    apParam.default = 0;
    warnings.push(`🔧 approach_gap.default 强制覆盖 ${oldDefault}→0（AI 违反 prompt）`);
  }

  // 1b. 清洗 fork_anchor_zero_[xyz] 公式里 AI 凭空加的裸常数
  const cleaned = [];
  (pkf.steps || []).forEach((s) => {
    for (const key of ['value_start', 'value_end']) {
      const raw = s?.[key];
      if (typeof raw !== 'string' || !raw.includes('fork_anchor_zero_')) continue;
      const stripped = raw.replace(NAKED_CONST_RE, '$1');
      if (stripped !== raw) {
        cleaned.push(`${s.joint}.${key}`);
        s[key] = stripped;
      }
    }
  });
  if (cleaned.length) {
    warnings.push(
      `🧹 清洗 AI 凭空加的常数（${cleaned.length} 处）：`
      + `${cleaned.slice(0, 3).join(', ')}${cleaned.length > 3 ? '...' : ''}`,
    );
  }

  // ── 2. 自动补 step（attach 点零 teleport 兜底）──

  const events = ctx?.reparentEvents || [];
  const attachEvent = events.find((e) => e.new_parent_name);
  if (!attachEvent) return pkf; // 没 attach event 就无对齐要求

  const tAttach = Number(attachEvent.t) || 0;
  const cargoName = attachEvent.child_name;
  const cargoObj = (ctx?.sceneList || []).find((o) => o.name === cargoName);
  if (!cargoObj) return pkf;

  const faz = ctx?.forkAnchorZero || {};
  const { fork_anchor_zero_x: fax, fork_anchor_zero_y: fay, fork_anchor_zero_z: fazZ } = faz;
  if (fax === undefined || fay === undefined || fazZ === undefined) return pkf;

  // #49：fork_anchor_zero_z 是叉齿底面，z 公式要减 cargo_height/2 让 cargo 底面对齐
  const cargoSize = keyframeManager?.getCargoSizeParams?.() || {};
  const cargoHeight = cargoSize.cargo_height ?? 0;
  const approachGapParam = (pkf.parameters || []).find((p) => p.id === 'approach_gap');
  const approachGap = approachGapParam ? Number(approachGapParam.default) || 0 : 0;

  // attach 前各维目标位移（UI Z-up 世界位移，直接作为 joint value）
  const target = {
    x: cargoObj.position.x - fax,
    y: cargoObj.position.y - fay - approachGap,
    z: cargoObj.position.z - cargoHeight / 2 - fazZ,
  };

  const allDefs = (keyframeManager?.getAllJointDefs?.()) || [];
  if (!Array.isArray(pkf.steps)) pkf.steps = [];

  for (const dim of ['x', 'y', 'z']) {
    if (Math.abs(target[dim]) < ATTACH_ALIGN_THRESHOLD) continue;
    const candidateRoles = ROLES_BY_DIMENSION[dim];
    const joint = allDefs.find((d) => candidateRoles.includes(d.role));
    if (!joint) {
      warnings.push(
        `⚠️ 缺 role=${candidateRoles.join('/')} 的关节，`
        + `attach 时 cargo ${dim} 方向可能跳 ${target[dim].toFixed(2)}m`,
      );
      continue;
    }
    // 如果 AI 已在 tAttach 之前覆盖过同一关节，不重复注入
    const covered = pkf.steps.some((s) => (
      s.joint === joint.name && Number(s.t_end) <= tAttach + 0.01
    ));
    if (covered) continue;

    pkf.steps.push({
      joint: joint.name,
      channel: joint.type === 'revolute' ? 'rotate' : 'translate',
      axis: joint.axis || 'z',
      t_start: 0,
      t_end: tAttach,
      value_start: '0',
      value_end: String(+target[dim].toFixed(3)),
      easing: 'ease-in-out',
    });
    warnings.push(
      `🔧 自动补 ${dim} 方向 step: ${joint.name} 0→${target[dim].toFixed(3)}`
      + `（AI 漏写；attach 前已到位）`,
    );
  }

  return pkf;
}
