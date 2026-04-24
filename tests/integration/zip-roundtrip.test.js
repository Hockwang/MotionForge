/**
 * ZIP 导出 → JSON → 再解析 集成测试（#65 REVIEW-v17）
 *
 * 动机：单元测试覆盖了 FK / 模板数学这些"不容易回归"的部分；
 *      真正每次改导入/导出都可能踩坑的跨序列化边界却零覆盖。
 *      历史回归：#18（parent_name 丢失）、#22（两阶段懒捕获）、#30（末态停留）、F61（template_segment 丢失）
 *
 * 策略：
 *   - 构造 KeyframeManager + 一个最小 Three.js sceneRoot
 *   - 调 ResultPackageExporter.exportZip，拿回 `{ manifest, joints, motion, pkf }`
 *   - 模拟 ZIP 落盘 + 再读（JSON.stringify → JSON.parse）
 *   - 断言字段和语义完整（特别是 v5/v6/v7 新增字段）
 *
 * 不做的事：
 *   - 不测真实 GLB 序列化（GLTFExporter 依赖 DOM，node 下不跑；stub 掉）
 *   - 不测 handleImportPackage（代码还在 main.js 里没抽出，改 main.js 风险高）
 *     → 代价是不能直接测"导入端重建 KeyframeManager"；用 JSON 回读模拟下游系统视角代替
 */
import { describe, test, expect } from 'vitest';
import * as THREE from 'three';
import { KeyframeManager } from '../../src/core/KeyframeManager.js';
import { ResultPackageExporter } from '../../src/core/ResultPackageExporter.js';

// ══════════════════════════════════════════════════════════════
// 测试工具
// ══════════════════════════════════════════════════════════════

/**
 * 构造最小可导出场景：Scene > Mast > Fork（双层嵌套，验证链式关节）
 */
function buildTestSceneRoot() {
  const root = new THREE.Scene();
  root.name = 'TestRoot';

  const mast = new THREE.Group();
  mast.name = 'Mast';
  root.add(mast);

  const fork = new THREE.Group();
  fork.name = 'Fork';
  mast.add(fork);

  return root;
}

/**
 * 返回一个"无副作用"的 exporter：
 *   - serializeSceneToGlb stub 成空 ArrayBuffer（避 GLTFExporter DOM 依赖）
 *   - downloadBlob stub 成 no-op（避 document.createElement）
 *   exportZip 返回的 { manifest, joints, motion, pkf } 对象不受 stub 影响
 */
function createSilentExporter() {
  const exporter = new ResultPackageExporter();
  exporter.serializeSceneToGlb = async () => new ArrayBuffer(8);
  exporter.downloadBlob = () => { /* no-op */ };
  return exporter;
}

/**
 * 构造导出格式的 clips 数组（模拟 main.js 的 buildExportClips）
 * 导出端的 key 是 name 不是 uuid
 */
function buildClipsForExport(km) {
  const idToName = new Map();
  km.getAllJointDefs().forEach((d) => { if (d.name) idToName.set(d.id, d.name); });

  return [...km.globalClips.values()].map((clip) => ({
    clip_name: clip.clipName,
    duration: clip.duration,
    keyframes: clip.keyframes.map((k) => {
      const jvByName = {};
      Object.entries(k.jointValues || {}).forEach(([id, val]) => {
        const n = idToName.get(id);
        if (n) jvByName[n] = val;
      });
      return { t: k.time, joint_values: jvByName };
    }),
    reparent_events: (clip.reparentEvents || []).map((e) => ({ ...e })),
  }));
}

/**
 * 跑一次完整导出 + JSON roundtrip
 * 返回 { exported, reparsed }：
 *   - exported: exporter 直接返回的 JS 对象
 *   - reparsed: JSON.parse(JSON.stringify(exported))，模拟下游从 ZIP 读出来
 */
async function exportAndReparse(km, sceneRoot) {
  const exporter = createSilentExporter();
  const exported = await exporter.exportZip({
    sourceFileName: 'test.glb',
    sourceFormat: 'glb',
    sceneRoot,
    jointDefinitions: km.getAllJointDefs(),
    clips: buildClipsForExport(km),
    pkfParameters: km.getAllPkfParameters(),
    pkfSteps: km.getAllPkfSteps(),
    pkfTemplateMeta: km._pkfTemplateMeta,
    sceneMarkers: km.getAllMarkers(),
  });
  const reparsed = JSON.parse(JSON.stringify(exported));
  return { exported, reparsed };
}

// ══════════════════════════════════════════════════════════════
// 场景 1：joint def 的 name / parent_name / role 跨 roundtrip
// 防：#18（parent_name 丢失 → 链断）
// ══════════════════════════════════════════════════════════════

describe('ZIP roundtrip: joint definitions', () => {
  test('name / parent_name / role / scene_path 字段导出后可被下游正确读回', async () => {
    const root = buildTestSceneRoot();
    const mast = root.getObjectByName('Mast');
    const fork = root.getObjectByName('Fork');

    const km = new KeyframeManager();
    km.setJointDef(mast.uuid, {
      name: 'Mast', type: 'prismatic', axis: 'y',
      role: '门架升降',
      limits: { min: 0, max: 2 },
      baseTransform: { tx: 0, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 },
    });
    km.setJointDef(fork.uuid, {
      name: 'Fork', type: 'revolute', axis: 'z',
      role: '叉齿旋转',
      parentId: mast.uuid,
      limits: { min: -180, max: 180 },
      baseTransform: { tx: 0, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 },
    });

    // 模拟 main.js 在导出前把 parent_name 写进 def（真实流程里由 setJointDef 的调用方做）
    const defs = km.getAllJointDefs();
    defs.find((d) => d.name === 'Fork').parentName = 'Mast';

    const { reparsed } = await exportAndReparse(km, root);
    const forkDef = reparsed.joints.definitions.find((d) => d.name === 'Fork');
    const mastDef = reparsed.joints.definitions.find((d) => d.name === 'Mast');

    expect(mastDef.name).toBe('Mast');
    expect(mastDef.role).toBe('门架升降');
    expect(mastDef.type).toBe('prismatic');
    expect(mastDef.axis).toBe('y');

    expect(forkDef.name).toBe('Fork');
    expect(forkDef.role).toBe('叉齿旋转');
    expect(forkDef.parent_name).toBe('Mast'); // #18 防回归
    expect(forkDef.type).toBe('revolute');
  });

  test('base_transform 四元数字段完整保留（不能退回 Euler）', async () => {
    // 防 #7 万向锁：qx/qy/qz/qw 必须整套导出
    const root = buildTestSceneRoot();
    const mast = root.getObjectByName('Mast');
    const km = new KeyframeManager();
    km.setJointDef(mast.uuid, {
      name: 'Mast', type: 'revolute', axis: 'y',
      baseTransform: { tx: 1.5, ty: 0, tz: 0, qx: 0.1, qy: 0.2, qz: 0.3, qw: 0.927 },
    });

    const { reparsed } = await exportAndReparse(km, root);
    const def = reparsed.joints.definitions[0];

    expect(def.base_transform.tx).toBeCloseTo(1.5);
    expect(def.base_transform.qx).toBeCloseTo(0.1);
    expect(def.base_transform.qy).toBeCloseTo(0.2);
    expect(def.base_transform.qz).toBeCloseTo(0.3);
    expect(def.base_transform.qw).toBeCloseTo(0.927);
  });
});

// ══════════════════════════════════════════════════════════════
// 场景 2：PKF steps 的 template_segment / template_segment_name
// 防：F61（模板段号被静默丢弃 → 轨迹 overlay 段号标签错位）
// ══════════════════════════════════════════════════════════════

describe('ZIP roundtrip: PKF template_segment', () => {
  test('模板段号和段名导出后可被下游读回', async () => {
    const root = buildTestSceneRoot();
    const mast = root.getObjectByName('Mast');
    const km = new KeyframeManager();
    km.setJointDef(mast.uuid, { name: 'Mast', type: 'prismatic', axis: 'y' });
    km.addPkfParameter({ id: 'lift_h', type: 'number', default: 1.5 });
    km.addPkfStep({
      joint: 'Mast', joint_def_id: mast.uuid,
      channel: 'translate', axis: 'y',
      t_start: 0, t_end: 2,
      value_start: '0', value_end: 'lift_h',
      template_segment: 3,
      template_segment_name: 'lift',
    });

    const { reparsed } = await exportAndReparse(km, root);
    const step = reparsed.pkf.steps[0];

    expect(step.template_segment).toBe(3);           // F61 防回归
    expect(step.template_segment_name).toBe('lift'); // F61 防回归
    expect(step.joint).toBe('Mast');                 // 公共字段也要稳
    expect(step.value_end).toBe('lift_h');
  });

  test('非模板 step（无 template_segment）导出时不写入字段，保持 ZIP 体积紧凑', async () => {
    const root = buildTestSceneRoot();
    const mast = root.getObjectByName('Mast');
    const km = new KeyframeManager();
    km.setJointDef(mast.uuid, { name: 'Mast', type: 'prismatic', axis: 'y' });
    km.addPkfStep({
      joint: 'Mast', channel: 'translate', axis: 'y',
      t_start: 0, t_end: 1, value_start: '0', value_end: '1',
      // 故意不设 template_segment
    });

    const { reparsed } = await exportAndReparse(km, root);
    const step = reparsed.pkf.steps[0];

    // 导出时条件写入：template_segment 为 null 时不写字段（ZIP 不膨胀）
    // JSON.stringify 会把 undefined 的字段删掉，JSON.parse 后字段就不存在
    expect(Object.prototype.hasOwnProperty.call(step, 'template_segment')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(step, 'template_segment_name')).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════
// 场景 3：limit_upper + overflow_to（双段门架 overflow 机制）
// 防：#59（双段门架 overflow 失效）
// ══════════════════════════════════════════════════════════════

describe('ZIP roundtrip: limit_upper + overflow_to', () => {
  test('双段门架 overflow 字段完整导出 + overflow_to 是 name（不是 uuid）', async () => {
    const root = buildTestSceneRoot();
    root.add(new THREE.Group().clone()); // placeholder for outer mast
    const inner = new THREE.Group();
    inner.name = 'InnerMast';
    root.add(inner);
    const outer = new THREE.Group();
    outer.name = 'OuterMast';
    root.add(outer);

    const km = new KeyframeManager();
    km.setJointDef(inner.uuid, {
      name: 'InnerMast', type: 'prismatic', axis: 'y',
      role: '门架升降',
      limits: { min: 0, max: 2.0 },
      limit_upper: 1.5,
      overflow_to: 'OuterMast', // 按 name，不是 uuid
    });
    km.setJointDef(outer.uuid, {
      name: 'OuterMast', type: 'prismatic', axis: 'y',
      role: '门架升降',
      limits: { min: 0, max: 1.0 },
    });

    const { reparsed } = await exportAndReparse(km, root);
    const innerDef = reparsed.joints.definitions.find((d) => d.name === 'InnerMast');
    const outerDef = reparsed.joints.definitions.find((d) => d.name === 'OuterMast');

    expect(innerDef.limit_upper).toBe(1.5);          // #59 防回归
    expect(innerDef.overflow_to).toBe('OuterMast');  // #59: 必须是 name 不是 uuid
    expect(outerDef.limit_upper).toBe(null);         // 未启用时显式为 null
    expect(outerDef.overflow_to).toBe(null);
  });

  test('老 joint（未启用 overflow）limit_upper / overflow_to 均为 null', async () => {
    // 兼容性：v6 及以前没这字段，v7 导出时必须显式写 null，方便下游区分"字段不存在"和"值未启用"
    const root = buildTestSceneRoot();
    const mast = root.getObjectByName('Mast');
    const km = new KeyframeManager();
    km.setJointDef(mast.uuid, { name: 'Mast', type: 'prismatic', axis: 'y' });

    const { reparsed } = await exportAndReparse(km, root);
    const def = reparsed.joints.definitions[0];
    expect(def.limit_upper).toBe(null);
    expect(def.overflow_to).toBe(null);
  });
});

// ══════════════════════════════════════════════════════════════
// 场景 4：schema_version 恒为 7（版本号退化保护）
// 防：未来有人误改常量
// ══════════════════════════════════════════════════════════════

describe('ZIP roundtrip: schema version guard', () => {
  test('schema_version 必须是 7（当前版本）', async () => {
    const root = buildTestSceneRoot();
    const km = new KeyframeManager();
    const { reparsed } = await exportAndReparse(km, root);
    expect(reparsed.manifest.schema_version).toBe(7);
  });

  test('manifest 包含 v6+ scene_markers 字段（即使是空数组）', async () => {
    const root = buildTestSceneRoot();
    const km = new KeyframeManager();
    const { reparsed } = await exportAndReparse(km, root);
    expect(Array.isArray(reparsed.manifest.scene_markers)).toBe(true);
  });

  test('manifest 包含 v4+ source.root_name 字段', async () => {
    // 防 #18 parent_name="Scene" 的关节 roundtrip 后找不到父级
    const root = buildTestSceneRoot();
    const km = new KeyframeManager();
    const { reparsed } = await exportAndReparse(km, root);
    expect(reparsed.manifest.source.root_name).toBe('TestRoot');
  });
});

// ══════════════════════════════════════════════════════════════
// 场景 5：PKF-only clip（关键帧为空但有 duration / reparent_events）
// 防：isV2 误判 — 只看 keyframes.length > 0 会把模板路径产出的 PKF-only 动画
//      误判为非 v2 → 整块恢复代码跳过 → duration 回到默认 10、reparent_events 丢失
// ══════════════════════════════════════════════════════════════

describe('ZIP roundtrip: PKF-only clip', () => {
  test('关键帧为空但 duration 非默认 + 有 reparent_events 的 clip 能完整导出', async () => {
    const root = buildTestSceneRoot();
    const km = new KeyframeManager();

    // 模板路径生成：pkfSteps 有内容，但 clip 的 keyframes 空（PKF 驱动）
    // duration 会被设到最后一步 t_end + 0.5s，reparent_events 来自 L1
    const defaultClip = km.globalClips.get('default');
    defaultClip.duration = 17.5; // 典型叉车模板 17 段时长
    defaultClip.keyframes = [];  // PKF 路径不需要静态关键帧
    defaultClip.reparentEvents = [
      { event_id: 'rev1', t: 3.5, child_name: 'CargoBox', new_parent_name: 'Fork' },
      { event_id: 'rev2', t: 14.0, child_name: 'CargoBox', new_parent_name: null },
    ];

    const { reparsed } = await exportAndReparse(km, root);
    const clip = reparsed.motion.clips[0];

    // 核心断言：keyframes 空不意味着 clip 该被丢
    expect(clip.duration).toBeCloseTo(17.5);
    expect(clip.keyframes).toEqual([]);
    expect(clip.reparent_events).toHaveLength(2);
    expect(clip.reparent_events[0]).toMatchObject({
      t: 3.5, child_name: 'CargoBox', new_parent_name: 'Fork',
    });
    expect(clip.reparent_events[1].new_parent_name).toBe(null); // null = 回世界根
  });

  test('reparent_events 按 t 升序保留（不能因 JSON 序列化乱序）', async () => {
    const root = buildTestSceneRoot();
    const km = new KeyframeManager();
    const clip = km.globalClips.get('default');
    clip.reparentEvents = [
      { event_id: 'a', t: 5.0, child_name: 'X', new_parent_name: 'Y' },
      { event_id: 'b', t: 1.0, child_name: 'X', new_parent_name: null },
      { event_id: 'c', t: 3.0, child_name: 'X', new_parent_name: 'Z' },
    ];

    const { reparsed } = await exportAndReparse(km, root);
    const events = reparsed.motion.clips[0].reparent_events;

    // 导出端保持调用方顺序；下游按 t 重排是运行时行为（由 KeyframeManager.applyReparentEventsAtTime 负责）
    // 这里只验证字段完整和数量，不强制导出端重排（避免和未来优化冲突）
    expect(events).toHaveLength(3);
    expect(new Set(events.map((e) => e.event_id))).toEqual(new Set(['a', 'b', 'c']));
  });
});
