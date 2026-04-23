/**
 * 叉车取放 17 段模板编译器（Phase A / B）—— 14 必选 + 3 段可选横移（段 1/9/17）
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
export const kind = 'forklift'; // 模板库注册标识，后端 /api/template-rhythm 分支 key

// ── 角色常量（和 keyframeManager.jointDefinitions[].role 对齐）──
export const ROLE_CAR_FORWARD = '车体前进';
export const ROLE_MAST_LIFT = '门架升降';
// 横移 role 有两种同义命名（三向车的整车横移 vs 叉齿侧移机构），
// 模板把它们视为等价——取第一个命中的 joint 驱动 x 对齐段。
export const ROLE_CAR_SIDEWAYS_PRIMARY = '车体横移';
export const ROLE_CAR_SIDEWAYS_FALLBACK = '叉齿侧移';

// ── 段数据（17 段，其中 3 段 optional 依赖横移 role）──
// 每段包含：
//   index:       1-17
//   name:        中文显示名
//   role:        驱动关节 role
//   formula:     value_end 公式字符串（引用 PKF parameters 里的 id）
//   reparent:    'attach' | 'detach' | undefined
//   optional:    true 时若对应 role 关节缺失则编译期跳过（三向车有横移 → 17 段；
//                普通叉车无横移 → 自动降级 14 段）
// 公式约定（UI Z-up）：
//   cargo_bottom_z = cargo_pos_z - cargo_height / 2      （cargo 底面绝对高度）
//   cargo_fork_z   = cargo_bottom_z + cargo_fork_height  （cargo 上叉齿承载面应对齐的高度）
// 公式直接展开，不引入中间派生量——中台不用支持额外语法。
//
// 历史：原 14 段只驱动前进 + 升降，三向车场景 cargo 在 x 方向偏移时 fork 永远对不齐，
//      attach 被老 snap-attach 强拽出瞬移。加入 x 对齐段后 cargo 可在任意平面位置。
export const FORKLIFT_TEMPLATE = [
  { index: 1,  name: '横移对齐 cargo x',
    role: ROLE_CAR_SIDEWAYS_PRIMARY,
    formula: 'cargo_pos_x - fork_anchor_zero_x',
    optional: true },
  { index: 2,  name: '接近',
    role: ROLE_CAR_FORWARD,
    formula: 'cargo_pos_y - fork_anchor_zero_y - safe_distance' },
  { index: 3,  name: '抬叉到 cargo 叉取面（低 clearance）',
    role: ROLE_MAST_LIFT,
    formula: 'cargo_pos_z - cargo_height / 2 + cargo_fork_height - lift_clearance - fork_anchor_zero_z' },
  { index: 4,  name: '前进插齿',
    role: ROLE_CAR_FORWARD,
    formula: 'cargo_pos_y - fork_anchor_zero_y',
    reparent: 'attach' },
  { index: 5,  name: '取货（上顶 lift_clearance）',
    role: ROLE_MAST_LIFT,
    formula: 'cargo_pos_z - cargo_height / 2 + cargo_fork_height - fork_anchor_zero_z' },
  { index: 6,  name: '抬到运输避让高度',
    role: ROLE_MAST_LIFT,
    formula: 'transport_height - fork_anchor_zero_z' },
  { index: 7,  name: '后退到安全距离',
    role: ROLE_CAR_FORWARD,
    formula: 'cargo_pos_y - fork_anchor_zero_y - safe_distance' },
  { index: 8,  name: '叉齿复位（运输姿态）',
    role: ROLE_MAST_LIFT,
    formula: '0' },
  { index: 9,  name: '横移到放货点 x',
    role: ROLE_CAR_SIDEWAYS_PRIMARY,
    formula: 'drop_pos_x - fork_anchor_zero_x',
    optional: true },
  { index: 10, name: '移动到放货点',
    role: ROLE_CAR_FORWARD,
    formula: 'drop_pos_y - fork_anchor_zero_y - safe_distance' },
  { index: 11, name: '抬叉到工作面 + cargo_fork_height',
    role: ROLE_MAST_LIFT,
    formula: 'drop_pos_z + cargo_fork_height - fork_anchor_zero_z' },
  { index: 12, name: '前进到放货点',
    role: ROLE_CAR_FORWARD,
    formula: 'drop_pos_y - fork_anchor_zero_y' },
  { index: 13, name: '放货（下降 lift_clearance）',
    role: ROLE_MAST_LIFT,
    formula: 'drop_pos_z + cargo_fork_height - lift_clearance - fork_anchor_zero_z',
    reparent: 'detach' },
  { index: 14, name: '后退到安全距离',
    role: ROLE_CAR_FORWARD,
    formula: 'drop_pos_y - fork_anchor_zero_y - safe_distance' },
  { index: 15, name: '叉齿复位',
    role: ROLE_MAST_LIFT,
    formula: '0' },
  { index: 16, name: '返回 y=0',
    role: ROLE_CAR_FORWARD,
    formula: '0' },
  { index: 17, name: '返回 x=0',
    role: ROLE_CAR_SIDEWAYS_PRIMARY,
    formula: '0',
    optional: true },
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
 * 默认节奏：17 段均分 12 秒 + 全部 ease-in-out。
 * 供 Phase A（不接 AI）使用；Phase B AI 返回的节奏 JSON 必须遵循同 schema。
 * 场景无横移 role 时编译器跳过 optional 段（1/9/17），只有 14 段生效。
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
 * 自动识别 fork 对象名：从合适的关节 childId 定位到场景对象，用它作为 attach 目标。
 *
 * 优先级（越靠前越具体，bbox 越只含叉齿而不含门架/车体）：
 *   1. role 以"叉齿"开头（叉齿旋转/叉齿侧移/叉齿前伸/等）——运动链最深端，childId 指叉齿 mesh
 *   2. role === "门架升降"——兜底，可能把整个门架 bbox 当"叉齿"导致 x 对齐穿帮
 *
 * 没命中或 childId 找不到场景对象 → 返回 null（caller 降级报 missing）。
 *
 * 历史：最初只找门架升降，三向车场景下 bbox 包含整个门架（5.3m 高），
 *      车体横移对到 cargo.x 时把车身穿进 cargo（用户反馈"cargo 到车体里面了"）。
 *      改为优先找"叉齿*" role 后，bbox 只含叉齿 mesh（~1m × 0.5m × 1.6m），几何正确。
 *
 * @returns {string | null} fork 对象的 name，或 null
 */
export function autoDetectForkName(keyframeManager, sceneRoot) {
  if (!sceneRoot) return null;
  const allDefs = keyframeManager.getAllJointDefs
    ? keyframeManager.getAllJointDefs()
    : [...keyframeManager.jointDefinitions.values()];

  // 优先级 1：role 以"叉齿"开头的任一关节（最深、最具体）
  //         用 .filter 兼容同时有多个叉齿 role 的情况（如 叉齿侧移 + 叉齿旋转），取第一个命中
  const forkSpecificJoint = allDefs.find((d) => typeof d.role === 'string' && d.role.startsWith('叉齿'));
  // 优先级 2：门架升降（兜底）
  // #59 UX：双段门架场景下内外都贴 role="门架升降"，findPrimaryByRole 自动跳过 slave（外门架），
  //        返回内门架（free-lift 主），它的 childId 才挂着 fork mesh。
  const mastJoint = keyframeManager.findPrimaryByRole
    ? keyframeManager.findPrimaryByRole(ROLE_MAST_LIFT)
    : allDefs.find((d) => d.role === ROLE_MAST_LIFT);
  const candidate = forkSpecificJoint || mastJoint;
  if (!candidate?.childId) return null;

  // childId 是 scene node 的 uuid —— 反向查 sceneRoot
  let forkObj = null;
  sceneRoot.traverse((o) => {
    if (!forkObj && o.uuid === candidate.childId) forkObj = o;
  });
  if (!forkObj) return null;
  if (forkObj.name) return forkObj.name;

  // 没 name 的话找第一个有 name 的后代
  let namedChild = null;
  forkObj.traverse((o) => {
    if (!namedChild && o !== forkObj && o.name) namedChild = o;
  });
  return namedChild?.name || null;
}

/**
 * 采集模板编译所需的上下文；缺要素时返回 { ok: false, missing: [...] }。
 *
 * 先决条件（§8.1）：
 *   - 存在 cargo marker → 提供 cargo size + cargo_pos_*
 *   - 存在 drop marker → 提供 drop_pos_*
 *   - 存在 role="车体前进" 关节
 *   - 存在 role="门架升降" 关节 → 同时用它自动识别 fork 对象（mastJoint.childId → 对象 name）
 *
 * fork 对象识别优先级：
 *   1. 已有 attach 型 reparent event 的 new_parent_name（用户显式配过）
 *   2. role="门架升降" 关节的 childId 对应的场景对象（自动识别，无需配 reparent event）
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
  // #59 UX：多段门架共享"门架升降" role 时，自动挑 primary（跳过 slave=被 overflow_to 指向的）
  const mastJoint = keyframeManager.findPrimaryByRole
    ? keyframeManager.findPrimaryByRole(ROLE_MAST_LIFT)
    : allDefs.find((d) => d.role === ROLE_MAST_LIFT);
  if (!carJoint) missing.push(`role="${ROLE_CAR_FORWARD}" 的关节`);
  if (!mastJoint) missing.push(`role="${ROLE_MAST_LIFT}" 的关节`);
  // 横移关节可选：优先车体横移，fallback 叉齿侧移；都没有 → 降级为 14 段无 x 对齐
  const lateralJoint = allDefs.find((d) => d.role === ROLE_CAR_SIDEWAYS_PRIMARY)
    || allDefs.find((d) => d.role === ROLE_CAR_SIDEWAYS_FALLBACK)
    || null;

  // fork 对象识别：优先用已有 attach reparent event；否则从 mast joint childId 自动识别
  const events = keyframeManager.getReparentEvents?.() || [];
  const attachEvent = events.find((e) => e.new_parent_name);
  let forkName = attachEvent?.new_parent_name || null;
  let forkSource = 'existing_attach_event'; // 'existing_attach_event' | 'auto_from_mast_joint'
  if (!forkName) {
    forkName = autoDetectForkName(keyframeManager, sceneRoot);
    forkSource = 'auto_from_mast_joint';
  }
  if (!forkName) {
    missing.push(
      'fork 对象（需 role="门架升降" 关节绑定到叉齿/门架对象，或预先配一条 cargo→fork 的 attach reparent event）',
    );
  }

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
      forkName,
      forkSource, // 'existing_attach_event' | 'auto_from_mast_joint'
      cargoSize: cargoMarker.size || { w: 0, h: 0, d: 0 },
      cargoPos: cargoPosUi,
      dropPos: dropPosUi,
      carJoint,
      mastJoint,
      lateralJoint,  // null 表示场景无横移 → compile 时跳过 optional x 对齐段
    },
  };
}

/**
 * 把 17 段模板编译成标准 PKF（场景无横移 role 时 optional 段 1/9/17 编译期跳过，降级为 14 段）。
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
  const roleToJoint = {
    [ROLE_CAR_FORWARD]: ctx.carJoint,
    [ROLE_MAST_LIFT]: ctx.mastJoint,
    [ROLE_CAR_SIDEWAYS_PRIMARY]: ctx.lateralJoint,
    [ROLE_CAR_SIDEWAYS_FALLBACK]: ctx.lateralJoint,
  };
  for (const seg of FORKLIFT_TEMPLATE) {
    const joint = roleToJoint[seg.role];
    // optional 段：对应 role 关节缺失 → 静默跳过（三向车无横移时降级为 14 段）
    if (seg.optional && !joint) continue;
    if (!joint) continue; // 非 optional 但缺 joint：理论 collectTemplateContext 会拦住，防御式保底
    const rSeg = rhythmMap.get(seg.index);
    const duration = Number(rSeg?.duration) || 1;
    const easing = rSeg?.easing || 'ease-in-out';
    const tStart = +cursor.toFixed(3);
    const tEnd = +(cursor + duration).toFixed(3);
    cursor = tEnd;

    // 横移段用 lateralJoint 实际的 role，这样级联 key 用"真实 role"而不是模板里的 PRIMARY
    // （用户关节可能标 FALLBACK，模板的 PRIMARY 公式照用）
    const cascadeKey = joint === ctx.lateralJoint ? 'lateral' : seg.role;
    const valueStart = prevValueByRole.get(cascadeKey) ?? '0';
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
    prevValueByRole.set(cascadeKey, valueEnd);

    // 绑定 reparent 事件（§4.4 attach 在段 4 末尾，detach 在段 13 末尾；17 段扩展后段号调整）
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
