/**
 * 三向车（VNA / trilateral forklift）参数化动画模板
 *
 * 区别于普通叉车模板（ForkliftTemplate.js 17 段）：
 *   - 车体**不做左右横移**（没有 role=车体横移 关节），只沿 y 轴前后移动
 *   - 靠 `_CS198` 门架横移（role=门架横移）把叉齿推到货架侧面
 *   - 靠 `_CS19110` 叉齿旋转（role=叉齿旋转）切换 +x / +y / -x 三个插入方向
 *   - 结果：**真三向可达** —— cargo / drop 可在 +x / -x / +y 任一侧，模板自动组合
 *
 * 工作流程（用户描述整理）：
 *   1. 车体前进到 cargo.y 位（或 cargo.y - safe 如果 +y 取货）
 *   2. 旋转叉齿到 cargoAxis
 *   3. 升到取货高度
 *   4. 门架横移/车体前进 approach → insert → pick → retract → reset
 *   5. 旋转叉齿到 +y 运输姿态，升到运输高度
 *   6. 车体前进到 drop.y
 *   7. 旋转叉齿到 dropAxis
 *   8. mirror 的 drop 过程
 *   9. 旋转归零、门架降、车退回
 *
 * axis 自动识别（decideAxis）：
 *   - |pos.x| > x_axis_threshold（0.3m 默认）→ ±x 轴（pos.x 符号决定）
 *   - 否则 +y 轴（从前方直插）
 *
 * 这样 **cargo 在任何 (x, y) 位置都能被处理**（除了 y < 0 没法倒车插货）：
 *   - diagonal (1.5, 1.5)：先 y 到 1.5 → cargo 变成纯 +x 侧 → `_CS198` 插
 *   - (0.1, 5)：|x|=0.1 < 阈值 → +y 正面插，车体前进到接近 cargo
 *
 * 叉齿朝向约定（用户模型 图 1 = 默认 0° = +x）：
 *   - 0° = +x
 *   - π/2 (90°) = +y
 *   - π (180°) = -x
 *   - 用户"顺时针 90°" = 数学上右手系 +z 轴 CCW +π/2
 *
 * 契约：
 *   - kind: 'threeway'
 *   - canApply(km, root): { ok, data | missing }
 *   - compileTemplate(ctx, rhythm?, forkAnchorZero?): { parameters, steps, reparent_events, meta }
 *   - buildDefaultRhythm(totalSeconds, segCount): { name, segments }
 *   - collectTemplateContext = canApply（兼容 ForkliftTemplate 命名）
 */
import * as THREE from 'three';
import {
  ROLE_CAR_FORWARD,
  ROLE_MAST_LIFT,
  ROLE_CAR_SIDEWAYS_PRIMARY,
  ROLE_CAR_SIDEWAYS_FALLBACK,
  TEMPLATE_PARAMETERS as BASE_TEMPLATE_PARAMETERS,
} from './ForkliftTemplate.js';

export const THREEWAY_TEMPLATE_VERSION = 1;
export const kind = 'threeway'; // 后端 /api/template-rhythm 分支 key

// ── 三向车特有 role（不和 ForkliftTemplate 冲突）──
export const ROLE_MAST_LATERAL = '门架横移';
export const ROLE_FORK_ROTATE = '叉齿旋转';
// 复用：ROLE_CAR_FORWARD / ROLE_MAST_LIFT 从 ForkliftTemplate import

// ── 三向车新增参数（叠加 BASE_TEMPLATE_PARAMETERS）──
// F45：X_AXIS_THRESHOLD_DEFAULT 作为唯一真值；canApply 读当前 pkfParameters 取用户改过的值，
// compileTemplate 再传入 ctx.xAxisThreshold。两处都不要再写死 0.3。
export const X_AXIS_THRESHOLD_DEFAULT = 0.3;
export const FORK_INSERTION_DEPTH_DEFAULT = 0.5;

export const TEMPLATE_PARAMETERS_THREEWAY = [
  {
    id: 'fork_insertion_depth',
    type: 'number',
    unit: 'm',
    desc: 'fork 从 safe 位置插入到 cargo 中心所需位移（经验 0.5m）',
    default: FORK_INSERTION_DEPTH_DEFAULT,
  },
  {
    id: 'x_axis_threshold',
    type: 'number',
    unit: 'm',
    desc: 'decideAxis 判定：|cargo.x| > 此值从 ±x 侧取，否则 +y 正面取',
    default: X_AXIS_THRESHOLD_DEFAULT,
  },
];

export const TEMPLATE_PARAMETERS = [
  ...BASE_TEMPLATE_PARAMETERS,
  ...TEMPLATE_PARAMETERS_THREEWAY,
];

// ══════════════════════════════════════════════════════════════
//  轴 / 角度工具
// ══════════════════════════════════════════════════════════════

/**
 * 按 cargo/drop 位置决定从哪一轴插入。
 * 规则：|x| > threshold → 从 ±x 侧；否则 +y 正面。
 * 不考虑 -y（车体倒车插货不符物理）。
 * @param {{x:number, y:number, z:number}} pos UI Z-up 坐标
 * @param {number} threshold x 轴阈值（米）
 * @returns {'+x' | '-x' | '+y'}
 */
export function decideAxis(pos, threshold = 0.3) {
  if (Math.abs(pos?.x ?? 0) > threshold) return pos.x > 0 ? '+x' : '-x';
  return '+y';
}

/** 轴向对应的叉齿旋转角（**度数**，和 KeyframeManager.applyJointDrive 约定一致）。
 *  0°=+x 为默认。
 *
 *  ⚠️ 符号说明：UI Z-up ↔ Three.js Y-up 的轴映射（UI z → Three.js y）在几何上是
 *  左手系映射，导致 CCW/CW 方向反转。本模板按**用户视角（UI 俯视视图）**定义角度：
 *    +90° = 用户视角"顺时针"（从 +x 转到 +y）
 *    +180° = 用户视角半圈（从 +x 转到 -x）
 *  apply 到 revolute joint 时要取负，才能产生用户期望的视觉旋转。
 */
export function axisToAngle(axis) {
  if (axis === '+x') return 0;
  if (axis === '+y') return -90;
  if (axis === '-x') return -180;  // 或 +180 同等视觉，取负保持"顺时针"语义一致
  return 0;
}

// ══════════════════════════════════════════════════════════════
//  canApply / collectTemplateContext
// ══════════════════════════════════════════════════════════════

/**
 * 判断当前场景是否适用三向车模板。
 *
 * 命中规则：
 *   ✓ 有 cargo marker + drop marker
 *   ✓ 有 role=车体前进 关节
 *   ✓ 有 role=门架升降 关节（用 findPrimaryByRole 处理双段门架）
 *   ✓ 有 role=门架横移 关节
 *   ✓ 有 role=叉齿旋转 关节
 *   ✗ **没有** role=车体横移 关节（否则是普通三向车走 ForkliftTemplate 17 段）
 *
 * @param {KeyframeManager} keyframeManager
 * @param {THREE.Object3D} sceneRoot
 * @returns {{ok:true, data:Object} | {ok:false, missing:string[]}}
 */
export function canApply(keyframeManager, sceneRoot) {
  const missing = [];
  const allDefs = keyframeManager.getAllJointDefs
    ? keyframeManager.getAllJointDefs()
    : [...keyframeManager.jointDefinitions.values()];

  // 排他条件：有 车体横移 → 走 ForkliftTemplate，本模板不命中
  const hasCarSideways = allDefs.some((d) => d.role === ROLE_CAR_SIDEWAYS_PRIMARY);
  if (hasCarSideways) return { ok: false, missing: ['非三向车场景（有 role=车体横移 关节）'] };

  // marker
  let cargoMarker = null;
  let dropMarker = null;
  for (const m of keyframeManager.sceneMarkers.values()) {
    if (m.type === 'cargo') cargoMarker = m;
    else if (m.type === 'drop') dropMarker = m;
  }
  if (!cargoMarker) missing.push('cargo marker（货物占位）');
  if (!dropMarker) missing.push('drop marker（放货点）');

  // 关节
  const carJoint = allDefs.find((d) => d.role === ROLE_CAR_FORWARD);
  const mastJoint = keyframeManager.findPrimaryByRole
    ? keyframeManager.findPrimaryByRole(ROLE_MAST_LIFT)
    : allDefs.find((d) => d.role === ROLE_MAST_LIFT);
  const lateralJoint = allDefs.find((d) => d.role === ROLE_MAST_LATERAL);
  const rotateJoint = allDefs.find((d) => d.role === ROLE_FORK_ROTATE);

  if (!carJoint) missing.push(`role="${ROLE_CAR_FORWARD}" 的关节`);
  if (!mastJoint) missing.push(`role="${ROLE_MAST_LIFT}" 的关节`);
  if (!lateralJoint) missing.push(`role="${ROLE_MAST_LATERAL}" 的关节`);
  if (!rotateJoint) missing.push(`role="${ROLE_FORK_ROTATE}" 的关节`);

  if (missing.length > 0) return { ok: false, missing };

  // 找 fork 对象：先 attach event，再从 rotateJoint.childId 回溯
  const events = keyframeManager.getReparentEvents?.() || [];
  const attachEvent = events.find((e) => e.new_parent_name);
  let forkName = attachEvent?.new_parent_name || null;
  let forkSource = 'existing_attach_event';
  if (!forkName && rotateJoint?.childId) {
    // 三向车的 fork mesh 挂在 rotateJoint 下（fork 跟着叉齿旋转而动）
    if (sceneRoot) {
      let forkObj = null;
      sceneRoot.traverse((o) => {
        if (!forkObj && o.uuid === rotateJoint.childId) forkObj = o;
      });
      if (forkObj) {
        forkName = forkObj.name || null;
        if (!forkName) {
          // 往下找第一个有 name 的后代
          forkObj.traverse((o) => {
            if (!forkName && o !== forkObj && o.name) forkName = o.name;
          });
        }
        forkSource = 'auto_from_rotate_joint';
      }
    }
  }
  if (!forkName) {
    return {
      ok: false,
      missing: ['fork 对象（需 role="叉齿旋转" 关节绑定到叉齿对象，或预配 attach reparent event）'],
    };
  }

  // 读 cargo/drop 世界坐标（UI Z-up）
  const cargoObj = sceneRoot?.getObjectByName(cargoMarker.name);
  const dropObj = sceneRoot?.getObjectByName(dropMarker.name);
  if (!cargoObj) return { ok: false, missing: [`场景里找不到 cargo 对象 "${cargoMarker.name}"`] };
  if (!dropObj) return { ok: false, missing: [`场景里找不到 drop 对象 "${dropMarker.name}"`] };

  sceneRoot.updateMatrixWorld(true);
  const cwp = cargoObj.getWorldPosition(new THREE.Vector3());
  const dwp = dropObj.getWorldPosition(new THREE.Vector3());
  // swap y↔z: Three.js y = UI z, Three.js z = UI y
  const cargoPosUi = { x: cwp.x, y: cwp.z, z: cwp.y };
  const dropPosUi = { x: dwp.x, y: dwp.z, z: dwp.y };

  // F45：若用户在上一轮 🚀 后改过 x_axis_threshold / fork_insertion_depth（PKF 参数面板里可编辑），
  // 这里读当前值；否则 fallback 到模板默认。保证"面板里改的值"下一次 🚀 能真的生效。
  const readParamDefault = (id, fallback) => {
    const p = keyframeManager.pkfParameters?.get?.(id);
    const v = p && Number.isFinite(Number(p.default)) ? Number(p.default) : null;
    return v ?? fallback;
  };
  const xAxisThreshold = readParamDefault('x_axis_threshold', X_AXIS_THRESHOLD_DEFAULT);
  const forkInsertionDepth = readParamDefault('fork_insertion_depth', FORK_INSERTION_DEPTH_DEFAULT);

  return {
    ok: true,
    data: {
      cargoName: cargoMarker.name,
      dropName: dropMarker.name,
      forkName,
      forkSource,
      cargoSize: cargoMarker.size || { w: 0, h: 0, d: 0 },
      cargoPos: cargoPosUi,
      dropPos: dropPosUi,
      carJoint,
      mastJoint,
      lateralJoint,
      rotateJoint,
      xAxisThreshold,
      forkInsertionDepth,
    },
  };
}

// 兼容 ForkliftTemplate 命名
export const collectTemplateContext = canApply;

// ══════════════════════════════════════════════════════════════
//  buildDefaultRhythm
// ══════════════════════════════════════════════════════════════

/**
 * 三向车段数动态（13~20 浮动），用 segCount 均分 totalSeconds。
 * AI 节奏失败时的 fallback；所有段 ease-in-out。
 *
 * @param {number} [totalSeconds=12]
 * @param {number} [segCount=18] 实际编译出来的段数；compileTemplate 先算再传
 */
export function buildDefaultRhythm(totalSeconds = 12, segCount = 18) {
  const n = Math.max(1, Number(segCount) || 18);
  const perSeg = totalSeconds / n;
  return {
    name: '三向车默认匀速',
    segments: Array.from({ length: n }, (_, i) => ({
      index: i + 1,
      duration: +perSeg.toFixed(3),
      easing: 'ease-in-out',
    })),
  };
}

// ══════════════════════════════════════════════════════════════
//  compileTemplate
// ══════════════════════════════════════════════════════════════

/**
 * 动态生成 PKF steps，按 (cargoAxis, dropAxis) 组合组装。
 *
 * @param {Object} ctx canApply().data
 * @param {Object} [rhythm] { name, segments:[{index,duration,easing}] }
 * @param {Object} [forkAnchorZero] { fork_anchor_zero_x/y/z } - 默认 +x 朝向下的承载点
 * @param {Object} [forkAnchorByAxis] { '+x':{...}, '+y':{...}, '-x':{...} } - 各 axis 旋转姿态下承载点
 *   fork 旋转后承载点相对 rotation pivot 会偏移，每个 axis 需要各自的锚点才能把承载点对准 cargo/drop
 * @returns {{parameters, steps, reparent_events, meta}}
 */
export function compileTemplate(ctx, rhythm, forkAnchorZero = {}, forkAnchorByAxis = null) {
  if (!ctx) throw new Error('compileTemplate(threeway): ctx required');
  const { carJoint, mastJoint, lateralJoint, rotateJoint, cargoName, forkName } = ctx;

  // F45：阈值从 ctx 读（canApply 已从当前 pkfParameters 拿到用户改过的值；首次 🚀 拿 default）。
  // 不再写死 0.3 —— 面板里改阈值，下一次 🚀 就生效。
  const threshold = Number.isFinite(Number(ctx.xAxisThreshold))
    ? Number(ctx.xAxisThreshold)
    : X_AXIS_THRESHOLD_DEFAULT;
  const cargoAxis = decideAxis(ctx.cargoPos, threshold);
  const dropAxis = decideAxis(ctx.dropPos, threshold);

  // 承载点 per axis：缺省 fallback 到 forkAnchorZero（相当于所有 axis 共享 +x 锚点，老行为）
  const anchorByAxis = {
    '+x': (forkAnchorByAxis && forkAnchorByAxis['+x']) || forkAnchorZero,
    '+y': (forkAnchorByAxis && forkAnchorByAxis['+y']) || forkAnchorZero,
    '-x': (forkAnchorByAxis && forkAnchorByAxis['-x']) || forkAnchorZero,
  };
  // 辅助：给定 axis 和 coord，返回 PKF 参数 id
  // 保留 'fork_anchor_zero_*' 命名给 +x 轴（向后兼容）；+y/-x 加 axis 后缀
  const anchorParamId = (axis, coord) => {
    if (axis === '+x') return `fork_anchor_zero_${coord}`;
    if (axis === '+y') return `fork_anchor_py_${coord}`;
    if (axis === '-x') return `fork_anchor_nx_${coord}`;
    return `fork_anchor_zero_${coord}`;
  };

  // ── parameters：复用 ForkliftTemplate 的约定 + 三向车新参 + axis 专属 anchor ──
  const parameters = [
    { id: 'cargo_pos_x', type: 'number', unit: 'm', desc: '货物 X', default: +ctx.cargoPos.x.toFixed(3) },
    { id: 'cargo_pos_y', type: 'number', unit: 'm', desc: '货物 Y', default: +ctx.cargoPos.y.toFixed(3) },
    { id: 'cargo_pos_z', type: 'number', unit: 'm', desc: '货物 Z', default: +ctx.cargoPos.z.toFixed(3) },
    { id: 'drop_pos_x', type: 'number', unit: 'm', desc: '放货点 X', default: +ctx.dropPos.x.toFixed(3) },
    { id: 'drop_pos_y', type: 'number', unit: 'm', desc: '放货点 Y', default: +ctx.dropPos.y.toFixed(3) },
    { id: 'drop_pos_z', type: 'number', unit: 'm', desc: '放货面高度', default: +ctx.dropPos.z.toFixed(3) },
    // +x 朝向承载点（默认 axis）
    { id: 'fork_anchor_zero_x', type: 'number', unit: 'm', desc: '叉齿承载点 +x 朝向 X', default: +((anchorByAxis['+x'].fork_anchor_zero_x ?? 0)).toFixed(3) },
    { id: 'fork_anchor_zero_y', type: 'number', unit: 'm', desc: '叉齿承载点 +x 朝向 Y', default: +((anchorByAxis['+x'].fork_anchor_zero_y ?? 0)).toFixed(3) },
    { id: 'fork_anchor_zero_z', type: 'number', unit: 'm', desc: '叉齿承载点 +x 朝向 Z', default: +((anchorByAxis['+x'].fork_anchor_zero_z ?? 0)).toFixed(3) },
    // +y 朝向承载点（cargo 或 drop 在正前方时用）
    { id: 'fork_anchor_py_x', type: 'number', unit: 'm', desc: '叉齿承载点 +y 朝向 X', default: +((anchorByAxis['+y'].fork_anchor_zero_x ?? 0)).toFixed(3) },
    { id: 'fork_anchor_py_y', type: 'number', unit: 'm', desc: '叉齿承载点 +y 朝向 Y', default: +((anchorByAxis['+y'].fork_anchor_zero_y ?? 0)).toFixed(3) },
    { id: 'fork_anchor_py_z', type: 'number', unit: 'm', desc: '叉齿承载点 +y 朝向 Z', default: +((anchorByAxis['+y'].fork_anchor_zero_z ?? 0)).toFixed(3) },
    // -x 朝向承载点（cargo 或 drop 在 -x 侧时用）
    { id: 'fork_anchor_nx_x', type: 'number', unit: 'm', desc: '叉齿承载点 -x 朝向 X', default: +((anchorByAxis['-x'].fork_anchor_zero_x ?? 0)).toFixed(3) },
    { id: 'fork_anchor_nx_y', type: 'number', unit: 'm', desc: '叉齿承载点 -x 朝向 Y', default: +((anchorByAxis['-x'].fork_anchor_zero_y ?? 0)).toFixed(3) },
    { id: 'fork_anchor_nx_z', type: 'number', unit: 'm', desc: '叉齿承载点 -x 朝向 Z', default: +((anchorByAxis['-x'].fork_anchor_zero_z ?? 0)).toFixed(3) },
    { id: 'cargo_width',  type: 'number', unit: 'm', desc: 'cargo 宽', default: +(ctx.cargoSize.w || 0).toFixed(3) },
    { id: 'cargo_height', type: 'number', unit: 'm', desc: 'cargo 高', default: +(ctx.cargoSize.h || 0).toFixed(3) },
    { id: 'cargo_depth',  type: 'number', unit: 'm', desc: 'cargo 深', default: +(ctx.cargoSize.d || 0).toFixed(3) },
    // F45：把 TEMPLATE_PARAMETERS 里的 threeway 两参 default 用 ctx 当前值覆盖，
    // 避免二次 🚀 时用户改过的值被重置回硬编码 default
    ...TEMPLATE_PARAMETERS.map((p) => {
      if (p.id === 'x_axis_threshold') return { ...p, default: threshold };
      if (p.id === 'fork_insertion_depth') {
        const v = Number.isFinite(Number(ctx.forkInsertionDepth))
          ? Number(ctx.forkInsertionDepth)
          : FORK_INSERTION_DEPTH_DEFAULT;
        return { ...p, default: v };
      }
      return p;
    }),
  ];

  // ── 动态生成段描述（先不定 t_start/t_end，rhythm 应用在后）──
  /** @type {Array<{name:string, role:string, joint:Object, formula:string, reparent?:string}>} */
  const segDescs = [];
  let forkAngle = 0; // 当前叉齿朝向（弧度）；默认 0 = +x

  const emit = (name, role, joint, formula, opts = {}) => {
    segDescs.push({ name, role, joint, formula, reparent: opts.reparent || null });
  };

  const rotateToAngle = (targetAngleDeg, label) => {
    if (Math.abs(forkAngle - targetAngleDeg) < 1e-4) return; // 已到位，跳过
    emit(label, ROLE_FORK_ROTATE, rotateJoint, String(+targetAngleDeg.toFixed(3)));
    forkAngle = targetAngleDeg;
  };

  // 当前 fork 朝向的 axis（跟随 rotateToAngle 更新），决定 anchor 参数用哪套
  let currentAxis = '+x'; // 初始 fork 朝 +x
  const ax = (coord) => anchorParamId(currentAxis, coord); // anchor 参数名 shortcut

  // ══════════════ PICKUP ══════════════
  // 1. 车体前进到 cargo.y（+y 取货时止于 safe 距离）—— 此时 fork 还未旋转，用 +x anchor
  const carYCargo = (cargoAxis === '+y')
    ? `cargo_pos_y - ${ax('y')} - fork_insertion_depth`
    : `cargo_pos_y - ${ax('y')}`;
  emit('车体前进到 cargo.y', ROLE_CAR_FORWARD, carJoint, carYCargo);

  // 2. 旋转到 cargoAxis（更新 currentAxis）
  rotateToAngle(axisToAngle(cargoAxis), `叉齿旋转到取货朝向 (${cargoAxis})`);
  currentAxis = cargoAxis;

  // 3. 升到取货高度（低 clearance）—— 用 cargoAxis anchor
  emit('门架升到取货高度', ROLE_MAST_LIFT, mastJoint,
    `cargo_pos_z - cargo_height / 2 + cargo_fork_height - lift_clearance - ${ax('z')}`);

  // 4. approach safe（仅 ±x 需要，+y 已在 step 1 止于 safe）
  if (cargoAxis === '+x') {
    emit('门架横移到 cargo 前 safe', ROLE_MAST_LATERAL, lateralJoint,
      `cargo_pos_x - fork_insertion_depth - ${ax('x')}`);
  } else if (cargoAxis === '-x') {
    emit('门架横移到 cargo 前 safe', ROLE_MAST_LATERAL, lateralJoint,
      `cargo_pos_x + fork_insertion_depth - ${ax('x')}`);
  }

  // 5. insert（attach 触发段）
  if (cargoAxis === '+x' || cargoAxis === '-x') {
    emit('门架横移插入 cargo', ROLE_MAST_LATERAL, lateralJoint,
      `cargo_pos_x - ${ax('x')}`,
      { reparent: 'attach' });
  } else {
    emit('车体前进插入 cargo', ROLE_CAR_FORWARD, carJoint,
      `cargo_pos_y - ${ax('y')}`,
      { reparent: 'attach' });
  }

  // 6. 取货上顶 lift_clearance
  emit('取货（上顶 lift_clearance）', ROLE_MAST_LIFT, mastJoint,
    `cargo_pos_z - cargo_height / 2 + cargo_fork_height - ${ax('z')}`);

  // 7. retract
  if (cargoAxis === '+x') {
    emit('门架横移退回 safe', ROLE_MAST_LATERAL, lateralJoint,
      `cargo_pos_x - fork_insertion_depth - ${ax('x')}`);
  } else if (cargoAxis === '-x') {
    emit('门架横移退回 safe', ROLE_MAST_LATERAL, lateralJoint,
      `cargo_pos_x + fork_insertion_depth - ${ax('x')}`);
  } else {
    emit('车体后退到 safe', ROLE_CAR_FORWARD, carJoint,
      `cargo_pos_y - ${ax('y')} - fork_insertion_depth`);
  }

  // 8. reset lateral（仅 ±x 用过）
  if (cargoAxis === '+x' || cargoAxis === '-x') {
    emit('门架横移复位', ROLE_MAST_LATERAL, lateralJoint, '0');
  }

  // 9. 抬到运输避让高度
  emit('抬到运输高度', ROLE_MAST_LIFT, mastJoint, `transport_height - ${ax('z')}`);

  // ══════════════ TRAVEL ══════════════
  // 10. 旋转到 +y 运输姿态（更新 currentAxis）
  rotateToAngle(-90, '叉齿旋转到 +y 运输姿态');
  currentAxis = '+y';

  // 11. 车体前进到 drop.y —— 此时 fork 在 +y，用 +y anchor
  const carYDrop = (dropAxis === '+y')
    ? `drop_pos_y - ${ax('y')} - fork_insertion_depth`
    : `drop_pos_y - ${ax('y')}`;
  emit('车体前进到 drop.y', ROLE_CAR_FORWARD, carJoint, carYDrop);

  // ══════════════ DROP ══════════════
  // 12. 旋转到 dropAxis（更新 currentAxis）
  rotateToAngle(axisToAngle(dropAxis), `叉齿旋转到放货朝向 (${dropAxis})`);
  currentAxis = dropAxis;

  // 13. 升到放货工作面
  emit('门架调整到放货工作面', ROLE_MAST_LIFT, mastJoint,
    `drop_pos_z + cargo_fork_height - ${ax('z')}`);

  // 14. approach safe
  if (dropAxis === '+x') {
    emit('门架横移到 drop 前 safe', ROLE_MAST_LATERAL, lateralJoint,
      `drop_pos_x - fork_insertion_depth - ${ax('x')}`);
  } else if (dropAxis === '-x') {
    emit('门架横移到 drop 前 safe', ROLE_MAST_LATERAL, lateralJoint,
      `drop_pos_x + fork_insertion_depth - ${ax('x')}`);
  }

  // 15. 送到 drop
  if (dropAxis === '+x' || dropAxis === '-x') {
    emit('门架横移送到 drop', ROLE_MAST_LATERAL, lateralJoint,
      `drop_pos_x - ${ax('x')}`);
  } else {
    emit('车体前进到 drop', ROLE_CAR_FORWARD, carJoint,
      `drop_pos_y - ${ax('y')}`);
  }

  // 16. 放货下降（detach 触发段）
  emit('放货（下降 lift_clearance）', ROLE_MAST_LIFT, mastJoint,
    `drop_pos_z + cargo_fork_height - lift_clearance - ${ax('z')}`,
    { reparent: 'detach' });

  // 17. retract
  if (dropAxis === '+x') {
    emit('门架横移退回 safe', ROLE_MAST_LATERAL, lateralJoint,
      `drop_pos_x - fork_insertion_depth - ${ax('x')}`);
  } else if (dropAxis === '-x') {
    emit('门架横移退回 safe', ROLE_MAST_LATERAL, lateralJoint,
      `drop_pos_x + fork_insertion_depth - ${ax('x')}`);
  } else {
    emit('车体后退到 safe', ROLE_CAR_FORWARD, carJoint,
      `drop_pos_y - ${ax('y')} - fork_insertion_depth`);
  }

  // 18. reset lateral
  if (dropAxis === '+x' || dropAxis === '-x') {
    emit('门架横移复位', ROLE_MAST_LATERAL, lateralJoint, '0');
  }

  // ══════════════ RETURN ══════════════
  // 19. 旋转归零（回 +x）
  rotateToAngle(0, '叉齿旋转归零');
  currentAxis = '+x';

  // 20. 门架降归零
  emit('门架下降归零', ROLE_MAST_LIFT, mastJoint, '0');

  // 21. 车体退回原位
  emit('车体退回原位', ROLE_CAR_FORWARD, carJoint, '0');

  // ── 应用节奏（rhythm），算 t_start/t_end，同 role 级联 value_start ──
  const actualRhythm = rhythm || buildDefaultRhythm(12, segDescs.length);
  const rhythmSegs = actualRhythm.segments || [];
  const steps = [];
  const reparentEvents = [];
  const prevValueByRole = new Map();
  let cursor = 0;

  for (let i = 0; i < segDescs.length; i++) {
    const d = segDescs[i];
    const r = rhythmSegs[i] || { duration: 1, easing: 'ease-in-out' };
    const duration = Number(r.duration) || 1;
    const easing = r.easing || 'ease-in-out';
    const tStart = +cursor.toFixed(3);
    const tEnd = +(cursor + duration).toFixed(3);
    cursor = tEnd;

    const valueStart = prevValueByRole.get(d.role) ?? '0';
    const step = {
      joint: d.joint.name,
      joint_def_id: d.joint.id,
      channel: d.joint.type === 'revolute' ? 'rotate' : 'translate',
      axis: d.joint.axis || (d.role === ROLE_MAST_LIFT ? 'z' : 'y'),
      t_start: tStart,
      t_end: tEnd,
      value_start: String(valueStart),
      value_end: String(d.formula),
      easing,
      template_segment: i + 1,
      template_segment_name: d.name,
    };
    steps.push(step);
    prevValueByRole.set(d.role, d.formula);

    if (d.reparent === 'attach') {
      reparentEvents.push({ t: tEnd, child_name: cargoName, new_parent_name: forkName });
    } else if (d.reparent === 'detach') {
      reparentEvents.push({ t: tEnd, child_name: cargoName, new_parent_name: null });
    }
  }

  return {
    parameters,
    steps,
    reparent_events: reparentEvents,
    meta: {
      template_version: THREEWAY_TEMPLATE_VERSION,
      template_kind: kind,
      rhythm_name: actualRhythm.name || '',
      total_duration: +cursor.toFixed(3),
      cargo_axis: cargoAxis,
      drop_axis: dropAxis,
      segment_count: segDescs.length,
    },
  };
}
