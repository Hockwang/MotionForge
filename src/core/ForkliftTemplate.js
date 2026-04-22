/**
 * 叉车取放 14 段模板编译器（Phase A / B）
 *
 * 契约见 docs/concepts/forklift-pickup-template.md。
 *
 * 入口：
 *   - collectTemplateContext(keyframeManager, sceneRoot) → ctx | null
 *       采集模板所需的场景信息（cargo/drop marker、fork 对象名、role 关节）。
 *       缺要素时返回 null 并用 missing 字段列出缺的东西（给 UI 用）。
 *   - compileTemplate(ctx, rhythm?) → { parameters, steps, reparent_events, meta }
 *       把模板展开成标准 PKF。rhythm 缺省用 buildDefaultRhythm() 生成匀速 ease-in-out。
 *   - FORKLIFT_TEMPLATE_VERSION: 写入 PKF meta，供 runtime（KeyframeManager.applyReparentEventsAtTime）
 *       识别"模板路径 PKF"并禁用 snap-attach 强制位置对齐（见 §5.4）。
 *
 * 语义复用：参数名复用现有 PKF 约定（cargo_pos_*、drop_pos_*、cargo_{width,height,depth}、
 * fork_anchor_zero_*），仅新增 4 个：cargo_fork_height / safe_distance / lift_clearance / transport_height。
 * 中台接收方只看到 parameters 数组多了 4 条，公式形态不变。
 */
import * as THREE from 'three';

export const FORKLIFT_TEMPLATE_VERSION = 1;

// ── 角色常量（和 keyframeManager.jointDefinitions[].role 对齐）──
export const ROLE_CAR_FORWARD = '车体前进';
export const ROLE_MAST_LIFT = '门架升降';

// ── 段数据 ──
// 每段包含：
//   index:       1-14
//   name:        中文显示名
//   role:        驱动关节 role
//   formula:     value_end 公式字符串（引用 PKF parameters 里的 id）
//   reparent:    'attach' | 'detach' | undefined
// 公式约定（UI Z-up）：
//   cargo_bottom_z = cargo_pos_z - cargo_height / 2      （cargo 底面绝对高度）
//   cargo_fork_z   = cargo_bottom_z + cargo_fork_height  （cargo 上叉齿承载面应对齐的高度）
// 公式直接展开，不引入中间派生量——中台不用支持额外语法。
export const FORKLIFT_TEMPLATE = [
  { index: 1,  name: '接近',
    role: ROLE_CAR_FORWARD,
    formula: 'cargo_pos_y - fork_anchor_zero_y - safe_distance' },
  { index: 2,  name: '抬叉到 cargo 叉取面（低 clearance）',
    role: ROLE_MAST_LIFT,
    formula: 'cargo_pos_z - cargo_height / 2 + cargo_fork_height - lift_clearance - fork_anchor_zero_z' },
  { index: 3,  name: '前进插齿',
    role: ROLE_CAR_FORWARD,
    formula: 'cargo_pos_y - fork_anchor_zero_y',
    reparent: 'attach' },
  { index: 4,  name: '取货（上顶 lift_clearance）',
    role: ROLE_MAST_LIFT,
    formula: 'cargo_pos_z - cargo_height / 2 + cargo_fork_height - fork_anchor_zero_z' },
  { index: 5,  name: '抬到运输避让高度',
    role: ROLE_MAST_LIFT,
    formula: 'transport_height - fork_anchor_zero_z' },
  { index: 6,  name: '后退到安全距离',
    role: ROLE_CAR_FORWARD,
    formula: 'cargo_pos_y - fork_anchor_zero_y - safe_distance' },
  { index: 7,  name: '叉齿复位（运输姿态）',
    role: ROLE_MAST_LIFT,
    formula: '0' },
  { index: 8,  name: '移动到放货点',
    role: ROLE_CAR_FORWARD,
    formula: 'drop_pos_y - fork_anchor_zero_y - safe_distance' },
  { index: 9,  name: '抬叉到工作面 + cargo_fork_height',
    role: ROLE_MAST_LIFT,
    formula: 'drop_pos_z + cargo_fork_height - fork_anchor_zero_z' },
  { index: 10, name: '前进到放货点',
    role: ROLE_CAR_FORWARD,
    formula: 'drop_pos_y - fork_anchor_zero_y' },
  { index: 11, name: '放货（下降 lift_clearance）',
    role: ROLE_MAST_LIFT,
    formula: 'drop_pos_z + cargo_fork_height - lift_clearance - fork_anchor_zero_z',
    reparent: 'detach' },
  { index: 12, name: '后退到安全距离',
    role: ROLE_CAR_FORWARD,
    formula: 'drop_pos_y - fork_anchor_zero_y - safe_distance' },
  { index: 13, name: '叉齿复位',
    role: ROLE_MAST_LIFT,
    formula: '0' },
  { index: 14, name: '返回起点',
    role: ROLE_CAR_FORWARD,
    formula: '0' },
];

// 新增的 4 个参数（现有 cargo_pos_*、drop_pos_*、cargo_*、fork_anchor_zero_* 复用 PKF 约定）
export const TEMPLATE_PARAMETERS = [
  { id: 'cargo_fork_height', type: 'number', unit: 'm',
    desc: '叉齿承载面相对 cargo 底面的偏移（简单箱子=0，托盘货物=-托盘厚度）',
    default: 0 },
  { id: 'safe_distance', type: 'number', unit: 'm',
    desc: '接近/后退时沿车体前进轴保持的安全距离',
    default: 0.8 },
  { id: 'lift_clearance', type: 'number', unit: 'm',
    desc: '取货/放货时叉齿微抬/微降的距离',
    default: 0.1 },
  { id: 'transport_height', type: 'number', unit: 'm',
    desc: '运输避让时叉齿承载面离地高度',
    default: 0.2 },
];

/**
 * 默认节奏：14 段均分 12 秒 + 全部 ease-in-out。
 * 供 Phase A（不接 AI）使用；Phase B AI 返回的节奏 JSON 必须遵循同 schema。
 */
export function buildDefaultRhythm(totalSeconds = 12) {
  const n = FORKLIFT_TEMPLATE.length;
  const perSeg = totalSeconds / n;
  return {
    name: '叉车取放标准动作',
    segments: FORKLIFT_TEMPLATE.map((seg) => ({
      index: seg.index,
      duration: +perSeg.toFixed(3),
      easing: 'ease-in-out',
    })),
  };
}

/**
 * 采集模板编译所需的上下文；缺要素时返回 { ok: false, missing: [...] }。
 *
 * 先决条件（§8.1）：
 *   - 存在 cargo marker → 提供 cargo size + cargo_pos_*
 *   - 存在 drop marker → 提供 drop_pos_*
 *   - 存在 role="车体前进" 关节
 *   - 存在 role="门架升降" 关节
 *   - 存在 attach 型 reparent event → 指明 cargo 名字 + fork 对象名字
 *     （此事件的时间由模板覆写，但 child/parent 名字沿用）
 *
 * @param {KeyframeManager} keyframeManager
 * @param {THREE.Object3D} sceneRoot
 * @returns {{ok:true, data:object} | {ok:false, missing:string[]}}
 */
export function collectTemplateContext(keyframeManager, sceneRoot) {
  const missing = [];

  // cargo marker
  let cargoMarker = null;
  for (const m of keyframeManager.sceneMarkers.values()) {
    if (m.type === 'cargo') { cargoMarker = m; break; }
  }
  if (!cargoMarker) missing.push('cargo marker（货物占位）');

  // drop marker
  let dropMarker = null;
  for (const m of keyframeManager.sceneMarkers.values()) {
    if (m.type === 'drop') { dropMarker = m; break; }
  }
  if (!dropMarker) missing.push('drop marker（放货点）');

  // role 关节
  const allDefs = keyframeManager.getAllJointDefs
    ? keyframeManager.getAllJointDefs()
    : [...keyframeManager.jointDefinitions.values()];
  const carJoint = allDefs.find((d) => d.role === ROLE_CAR_FORWARD);
  const mastJoint = allDefs.find((d) => d.role === ROLE_MAST_LIFT);
  if (!carJoint) missing.push(`role="${ROLE_CAR_FORWARD}" 的关节`);
  if (!mastJoint) missing.push(`role="${ROLE_MAST_LIFT}" 的关节`);

  // attach reparent event → 找 cargo + fork 名字
  const events = keyframeManager.getReparentEvents?.() || [];
  const attachEvent = events.find((e) => e.new_parent_name);
  if (!attachEvent) missing.push('attach 型 reparent event（至少一条 cargo→fork 的附着事件）');

  if (missing.length > 0) return { ok: false, missing };

  // 读实际世界坐标（UI Z-up；复用 collectSceneForAi 的 swap 规则：UI y = threejs z, UI z = threejs y）
  // 此函数不直接 traverse scene —— 调用方负责传预采集的 sceneList 或让 sceneRoot.getObjectByName 解析
  const cargoObj = sceneRoot?.getObjectByName(cargoMarker.name);
  const dropObj = sceneRoot?.getObjectByName(dropMarker.name);
  if (!cargoObj) missing.push(`场景里找不到 cargo 对象 "${cargoMarker.name}"`);
  if (!dropObj) missing.push(`场景里找不到 drop 对象 "${dropMarker.name}"`);
  if (missing.length > 0) return { ok: false, missing };

  sceneRoot.updateMatrixWorld(true);
  // 读当前世界坐标，swap y↔z 进 UI 空间（UI y = threejs z, UI z = threejs y）
  const cwp = cargoObj.getWorldPosition(new THREE.Vector3());
  const dwp = dropObj.getWorldPosition(new THREE.Vector3());
  const cargoPosUi = { x: cwp.x, y: cwp.z, z: cwp.y };
  const dropPosUi = { x: dwp.x, y: dwp.z, z: dwp.y };

  return {
    ok: true,
    data: {
      cargoName: cargoMarker.name,
      dropName: dropMarker.name,
      forkName: attachEvent.new_parent_name,
      cargoSize: cargoMarker.size || { w: 0, h: 0, d: 0 },
      cargoPos: cargoPosUi,
      dropPos: dropPosUi,
      carJoint,
      mastJoint,
    },
  };
}

/**
 * 把 14 段模板编译成标准 PKF。
 *
 * @param {Object} ctx        collectTemplateContext 返回的 data
 * @param {Object} [rhythm]   { name, segments: [{index, duration, easing}] }，缺省用默认
 * @param {Object} [forkAnchorZero] { fork_anchor_zero_x, fork_anchor_zero_y, fork_anchor_zero_z }
 *                             不传则留空（PKF parameter default=0），中台评估时会报"未注入"
 * @returns {{
 *   parameters: Array,
 *   steps: Array,
 *   reparent_events: Array<{t:number, child_name:string, new_parent_name:string|null}>,
 *   meta: { template_version:number, rhythm_name:string, total_duration:number }
 * }}
 */
export function compileTemplate(ctx, rhythm, forkAnchorZero = {}) {
  const actualRhythm = rhythm || buildDefaultRhythm();
  if (!ctx) throw new Error('compileTemplate: ctx required');
  const rhythmMap = new Map(
    (actualRhythm.segments || []).map((s) => [s.index, s]),
  );

  // ── 构建 parameters 数组（复用现有约定 + 新增 4 个）──
  const parameters = [
    { id: 'cargo_pos_x', type: 'number', unit: 'm', desc: '货物 X 坐标', default: +ctx.cargoPos.x.toFixed(3) },
    { id: 'cargo_pos_y', type: 'number', unit: 'm', desc: '货物 Y 坐标', default: +ctx.cargoPos.y.toFixed(3) },
    { id: 'cargo_pos_z', type: 'number', unit: 'm', desc: '货物 Z 坐标', default: +ctx.cargoPos.z.toFixed(3) },
    { id: 'drop_pos_x',  type: 'number', unit: 'm', desc: '放货点 X',    default: +ctx.dropPos.x.toFixed(3) },
    { id: 'drop_pos_y',  type: 'number', unit: 'm', desc: '放货点 Y',    default: +ctx.dropPos.y.toFixed(3) },
    { id: 'drop_pos_z',  type: 'number', unit: 'm', desc: '放货面高度',  default: +ctx.dropPos.z.toFixed(3) },
    // 注入 fork_anchor_zero（若没算出来默认 0；runtime buildDefaultParamValues 也会覆盖）
    { id: 'fork_anchor_zero_x', type: 'number', unit: 'm', desc: '叉齿零位锚点 X', default: +((forkAnchorZero.fork_anchor_zero_x ?? 0)).toFixed(3) },
    { id: 'fork_anchor_zero_y', type: 'number', unit: 'm', desc: '叉齿零位锚点 Y', default: +((forkAnchorZero.fork_anchor_zero_y ?? 0)).toFixed(3) },
    { id: 'fork_anchor_zero_z', type: 'number', unit: 'm', desc: '叉齿零位锚点 Z', default: +((forkAnchorZero.fork_anchor_zero_z ?? 0)).toFixed(3) },
    // cargo 尺寸由 getCargoSizeParams 自动注入运行时，但也写入 default 便于离线 eval
    { id: 'cargo_width',  type: 'number', unit: 'm', desc: 'cargo 宽',  default: +(ctx.cargoSize.w || 0).toFixed(3) },
    { id: 'cargo_height', type: 'number', unit: 'm', desc: 'cargo 高',  default: +(ctx.cargoSize.h || 0).toFixed(3) },
    { id: 'cargo_depth',  type: 'number', unit: 'm', desc: 'cargo 深',  default: +(ctx.cargoSize.d || 0).toFixed(3) },
    // 新增 4 个模板参数
    ...TEMPLATE_PARAMETERS,
  ];

  // ── 按段生成 steps ──
  // 每个 role 独立追踪 value_end（下一段同 role 的 value_start）
  const prevValueByRole = new Map();
  const steps = [];
  const reparentEvents = [];
  let cursor = 0;
  for (const seg of FORKLIFT_TEMPLATE) {
    const rSeg = rhythmMap.get(seg.index);
    const duration = Number(rSeg?.duration) || 1;
    const easing = rSeg?.easing || 'ease-in-out';
    const tStart = +cursor.toFixed(3);
    const tEnd = +(cursor + duration).toFixed(3);
    cursor = tEnd;

    const joint = seg.role === ROLE_CAR_FORWARD ? ctx.carJoint : ctx.mastJoint;
    const valueStart = prevValueByRole.get(seg.role) ?? '0';
    const valueEnd = seg.formula;

    steps.push({
      joint: joint.name,
      joint_def_id: joint.id,
      channel: joint.type === 'revolute' ? 'rotate' : 'translate',
      axis: joint.axis || (seg.role === ROLE_MAST_LIFT ? 'z' : 'y'),
      t_start: tStart,
      t_end: tEnd,
      value_start: String(valueStart),
      value_end: String(valueEnd),
      easing,
      // 模板元数据（runtime 识别用，不影响 evaluatePkfAt）
      template_segment: seg.index,
      template_segment_name: seg.name,
    });
    prevValueByRole.set(seg.role, valueEnd);

    // 绑定 reparent 事件（§4.4 attach 在段 3 末尾，detach 在段 11 末尾）
    if (seg.reparent === 'attach') {
      reparentEvents.push({
        t: tEnd,
        child_name: ctx.cargoName,
        new_parent_name: ctx.forkName,
      });
    } else if (seg.reparent === 'detach') {
      reparentEvents.push({
        t: tEnd,
        child_name: ctx.cargoName,
        new_parent_name: null,
      });
    }
  }

  return {
    parameters,
    steps,
    reparent_events: reparentEvents,
    meta: {
      template_version: FORKLIFT_TEMPLATE_VERSION,
      rhythm_name: actualRhythm.name || '',
      total_duration: +cursor.toFixed(3),
    },
  };
}
