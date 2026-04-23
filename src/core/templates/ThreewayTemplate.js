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
export const TEMPLATE_PARAMETERS_THREEWAY = [
  {
    id: 'fork_insertion_depth',
    type: 'number',
    unit: 'm',
    desc: 'fork 从 safe 位置插入到 cargo 中心所需位移（经验 0.5m）',
    default: 0.5,
  },
  {
    id: 'x_axis_threshold',
    type: 'number',
    unit: 'm',
    desc: 'decideAxis 判定：|cargo.x| > 此值从 ±x 侧取，否则 +y 正面取',
    default: 0.3,
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

/** 轴向对应的叉齿旋转角（**度数**，和 KeyframeManager.applyJointDrive 约定一致：
 *  revolute joint.currentValue 以度数存，内部乘 π/180 转弧度）。0°=+x 为默认。 */
export function axisToAngle(axis) {
  if (axis === '+x') return 0;
  if (axis === '+y') return 90;
  if (axis === '-x') return 180;
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
 * @param {Object} [forkAnchorZero] { fork_anchor_zero_x/y/z }
 * @returns {{parameters, steps, reparent_events, meta}}
 */
export function compileTemplate(ctx, rhythm, forkAnchorZero = {}) {
  if (!ctx) throw new Error('compileTemplate(threeway): ctx required');
  const { carJoint, mastJoint, lateralJoint, rotateJoint, cargoName, forkName } = ctx;

  // 决定 axis（从 rhythm 或默认拿阈值；这里先用 default，future 可从 ctx 或参数传入）
  const threshold = 0.3; // 和 TEMPLATE_PARAMETERS_THREEWAY 的 default 对齐；compile 时读 default
  const cargoAxis = decideAxis(ctx.cargoPos, threshold);
  const dropAxis = decideAxis(ctx.dropPos, threshold);

  // ── parameters：复用 ForkliftTemplate 的约定 + 三向车新参 ──
  const parameters = [
    { id: 'cargo_pos_x', type: 'number', unit: 'm', desc: '货物 X', default: +ctx.cargoPos.x.toFixed(3) },
    { id: 'cargo_pos_y', type: 'number', unit: 'm', desc: '货物 Y', default: +ctx.cargoPos.y.toFixed(3) },
    { id: 'cargo_pos_z', type: 'number', unit: 'm', desc: '货物 Z', default: +ctx.cargoPos.z.toFixed(3) },
    { id: 'drop_pos_x', type: 'number', unit: 'm', desc: '放货点 X', default: +ctx.dropPos.x.toFixed(3) },
    { id: 'drop_pos_y', type: 'number', unit: 'm', desc: '放货点 Y', default: +ctx.dropPos.y.toFixed(3) },
    { id: 'drop_pos_z', type: 'number', unit: 'm', desc: '放货面高度', default: +ctx.dropPos.z.toFixed(3) },
    { id: 'fork_anchor_zero_x', type: 'number', unit: 'm', desc: '叉齿零位锚点 X', default: +((forkAnchorZero.fork_anchor_zero_x ?? 0)).toFixed(3) },
    { id: 'fork_anchor_zero_y', type: 'number', unit: 'm', desc: '叉齿零位锚点 Y', default: +((forkAnchorZero.fork_anchor_zero_y ?? 0)).toFixed(3) },
    { id: 'fork_anchor_zero_z', type: 'number', unit: 'm', desc: '叉齿零位锚点 Z', default: +((forkAnchorZero.fork_anchor_zero_z ?? 0)).toFixed(3) },
    { id: 'cargo_width',  type: 'number', unit: 'm', desc: 'cargo 宽', default: +(ctx.cargoSize.w || 0).toFixed(3) },
    { id: 'cargo_height', type: 'number', unit: 'm', desc: 'cargo 高', default: +(ctx.cargoSize.h || 0).toFixed(3) },
    { id: 'cargo_depth',  type: 'number', unit: 'm', desc: 'cargo 深', default: +(ctx.cargoSize.d || 0).toFixed(3) },
    ...TEMPLATE_PARAMETERS,
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

  // ══════════════ PICKUP ══════════════
  // 1. 车体前进到 cargo.y（+y 取货时止于 safe 距离）
  const carYCargo = (cargoAxis === '+y')
    ? 'cargo_pos_y - fork_anchor_zero_y - fork_insertion_depth'
    : 'cargo_pos_y - fork_anchor_zero_y';
  emit('车体前进到 cargo.y', ROLE_CAR_FORWARD, carJoint, carYCargo);

  // 2. 旋转到 cargoAxis
  rotateToAngle(axisToAngle(cargoAxis), `叉齿旋转到取货朝向 (${cargoAxis})`);

  // 3. 升到取货高度（低 clearance）
  emit('门架升到取货高度', ROLE_MAST_LIFT, mastJoint,
    'cargo_pos_z - cargo_height / 2 + cargo_fork_height - lift_clearance - fork_anchor_zero_z');

  // 4. approach safe（仅 ±x 需要，+y 已在 step 1 止于 safe）
  if (cargoAxis === '+x') {
    emit('门架横移到 cargo 前 safe', ROLE_MAST_LATERAL, lateralJoint,
      'cargo_pos_x - fork_insertion_depth - fork_anchor_zero_x');
  } else if (cargoAxis === '-x') {
    emit('门架横移到 cargo 前 safe', ROLE_MAST_LATERAL, lateralJoint,
      'cargo_pos_x + fork_insertion_depth - fork_anchor_zero_x');
  }

  // 5. insert（attach 触发段）
  if (cargoAxis === '+x' || cargoAxis === '-x') {
    emit('门架横移插入 cargo', ROLE_MAST_LATERAL, lateralJoint,
      'cargo_pos_x - fork_anchor_zero_x',
      { reparent: 'attach' });
  } else {
    // +y: 车体继续前进到 cargo.y
    emit('车体前进插入 cargo', ROLE_CAR_FORWARD, carJoint,
      'cargo_pos_y - fork_anchor_zero_y',
      { reparent: 'attach' });
  }

  // 6. 取货上顶 lift_clearance
  emit('取货（上顶 lift_clearance）', ROLE_MAST_LIFT, mastJoint,
    'cargo_pos_z - cargo_height / 2 + cargo_fork_height - fork_anchor_zero_z');

  // 7. retract
  if (cargoAxis === '+x') {
    emit('门架横移退回 safe', ROLE_MAST_LATERAL, lateralJoint,
      'cargo_pos_x - fork_insertion_depth - fork_anchor_zero_x');
  } else if (cargoAxis === '-x') {
    emit('门架横移退回 safe', ROLE_MAST_LATERAL, lateralJoint,
      'cargo_pos_x + fork_insertion_depth - fork_anchor_zero_x');
  } else {
    emit('车体后退到 safe', ROLE_CAR_FORWARD, carJoint,
      'cargo_pos_y - fork_anchor_zero_y - fork_insertion_depth');
  }

  // 8. reset lateral（仅 ±x 用过）
  if (cargoAxis === '+x' || cargoAxis === '-x') {
    emit('门架横移复位', ROLE_MAST_LATERAL, lateralJoint, '0');
  }

  // 9. 抬到运输避让高度
  emit('抬到运输高度', ROLE_MAST_LIFT, mastJoint, 'transport_height - fork_anchor_zero_z');

  // ══════════════ TRAVEL ══════════════
  // 10. 旋转到 +y 运输姿态
  rotateToAngle(90, '叉齿旋转到 +y 运输姿态');

  // 11. 车体前进到 drop.y
  const carYDrop = (dropAxis === '+y')
    ? 'drop_pos_y - fork_anchor_zero_y - fork_insertion_depth'
    : 'drop_pos_y - fork_anchor_zero_y';
  emit('车体前进到 drop.y', ROLE_CAR_FORWARD, carJoint, carYDrop);

  // ══════════════ DROP ══════════════
  // 12. 旋转到 dropAxis（已 +y 则可能省）
  rotateToAngle(axisToAngle(dropAxis), `叉齿旋转到放货朝向 (${dropAxis})`);

  // 13. 升到放货工作面（drop.z + cargo_fork_height 承载面）
  emit('门架调整到放货工作面', ROLE_MAST_LIFT, mastJoint,
    'drop_pos_z + cargo_fork_height - fork_anchor_zero_z');

  // 14. approach safe
  if (dropAxis === '+x') {
    emit('门架横移到 drop 前 safe', ROLE_MAST_LATERAL, lateralJoint,
      'drop_pos_x - fork_insertion_depth - fork_anchor_zero_x');
  } else if (dropAxis === '-x') {
    emit('门架横移到 drop 前 safe', ROLE_MAST_LATERAL, lateralJoint,
      'drop_pos_x + fork_insertion_depth - fork_anchor_zero_x');
  }

  // 15. 送到 drop
  if (dropAxis === '+x' || dropAxis === '-x') {
    emit('门架横移送到 drop', ROLE_MAST_LATERAL, lateralJoint,
      'drop_pos_x - fork_anchor_zero_x');
  } else {
    emit('车体前进到 drop', ROLE_CAR_FORWARD, carJoint,
      'drop_pos_y - fork_anchor_zero_y',
      { reparent: null }); // 注意：不是 attach，这里是放货定位
  }

  // 16. 放货下降（detach 触发段）
  emit('放货（下降 lift_clearance）', ROLE_MAST_LIFT, mastJoint,
    'drop_pos_z + cargo_fork_height - lift_clearance - fork_anchor_zero_z',
    { reparent: 'detach' });

  // 17. retract
  if (dropAxis === '+x') {
    emit('门架横移退回 safe', ROLE_MAST_LATERAL, lateralJoint,
      'drop_pos_x - fork_insertion_depth - fork_anchor_zero_x');
  } else if (dropAxis === '-x') {
    emit('门架横移退回 safe', ROLE_MAST_LATERAL, lateralJoint,
      'drop_pos_x + fork_insertion_depth - fork_anchor_zero_x');
  } else {
    emit('车体后退到 safe', ROLE_CAR_FORWARD, carJoint,
      'drop_pos_y - fork_anchor_zero_y - fork_insertion_depth');
  }

  // 18. reset lateral
  if (dropAxis === '+x' || dropAxis === '-x') {
    emit('门架横移复位', ROLE_MAST_LATERAL, lateralJoint, '0');
  }

  // ══════════════ RETURN ══════════════
  // 19. 旋转归零
  rotateToAngle(0, '叉齿旋转归零');

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
