/**
 * KeyframeManager 核心单元测试（F4 基建，v14.1）
 *
 * 覆盖 5 个关键路径，都是历史上被 bug 磨过的地方：
 *  1. setJointDef 环检测（bug #33）
 *  2. buildDefaultParamValues 参数注入（cargo_size + fork_anchor_zero）
 *  3. _interpolateJointValueAtTime 关键帧插值（bug #22/#31 语义基础）
 *  4. computeForkAnchorZero（bug #36/#37 的核心）
 *  5. addReparentEvent 排序 + fork_anchor_zero 缓存失效（bug #39）
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { KeyframeManager } from '../../src/core/KeyframeManager.js';

describe('setJointDef 环检测（bug #33）', () => {
  let km;
  beforeEach(() => { km = new KeyframeManager(); });

  it('正常链 A→B→C 不报错', () => {
    km.setJointDef('A', { type: 'prismatic', axis: 'y', parentId: null });
    km.setJointDef('B', { type: 'prismatic', axis: 'y', parentId: 'A' });
    km.setJointDef('C', { type: 'prismatic', axis: 'y', parentId: 'B' });
    expect(km.getJointDef('C').parentId).toBe('B');
  });

  it('拒绝自引用 parent（A 的 parent 是自己）', () => {
    km.setJointDef('A', { type: 'prismatic', axis: 'y', parentId: null });
    km.setJointDef('A', { parentId: 'A' });
    // 环检测拒绝后 parentId 保持原值（null）
    expect(km.getJointDef('A').parentId).toBe(null);
  });

  it('拒绝三节点环（A→B→C→A）', () => {
    km.setJointDef('A', { type: 'prismatic', axis: 'y', parentId: null });
    km.setJointDef('B', { type: 'prismatic', axis: 'y', parentId: 'A' });
    km.setJointDef('C', { type: 'prismatic', axis: 'y', parentId: 'B' });
    // 尝试让 A 的 parent 指回 C → C→B→A→C 成环 → 拒绝
    km.setJointDef('A', { parentId: 'C' });
    expect(km.getJointDef('A').parentId).toBe(null); // 保持原值
  });

  it('允许设 parent 为 null（解除父级）', () => {
    km.setJointDef('A', { type: 'prismatic', axis: 'y', parentId: null });
    km.setJointDef('B', { type: 'prismatic', axis: 'y', parentId: 'A' });
    km.setJointDef('B', { parentId: null });
    expect(km.getJointDef('B').parentId).toBe(null);
  });
});

describe('buildDefaultParamValues 参数注入', () => {
  let km;
  beforeEach(() => { km = new KeyframeManager(); });

  it('PKF 参数被纳入', () => {
    km.addPkfParameter({ id: 'stroke', default: 100 });
    km.addPkfParameter({ id: 'angle', default: 45 });
    const values = km.buildDefaultParamValues();
    expect(values.stroke).toBe(100);
    expect(values.angle).toBe(45);
  });

  it('cargo size 自动注入 cargo_width/height/depth（v6）', () => {
    km.addMarker({ name: 'cargo', type: 'cargo', size: { w: 1.2, h: 0.6, d: 0.8 } });
    const values = km.buildDefaultParamValues();
    expect(values.cargo_width).toBe(1.2);
    expect(values.cargo_height).toBe(0.6);
    expect(values.cargo_depth).toBe(0.8);
  });

  it('无 cargo 时不注入 cargo_* 参数', () => {
    const values = km.buildDefaultParamValues();
    expect(values).not.toHaveProperty('cargo_width');
  });

  it('fork_anchor_zero 从缓存读取（v14.1 #37）', () => {
    // 模拟 computeForkAnchorZero 已跑过的状态
    km._forkAnchorZeroCached = {
      fork_anchor_zero_x: 0.48,
      fork_anchor_zero_y: 2.12,
      fork_anchor_zero_z: 0.32,
    };
    const values = km.buildDefaultParamValues();
    expect(values.fork_anchor_zero_y).toBe(2.12);
  });

  it('未缓存 fork_anchor_zero 时不注入（退化行为）', () => {
    const values = km.buildDefaultParamValues();
    expect(values).not.toHaveProperty('fork_anchor_zero_y');
  });
});

describe('_interpolateJointValueAtTime 关键帧插值', () => {
  let km;
  beforeEach(() => { km = new KeyframeManager(); });

  const kf = (time, values) => ({ time, jointValues: values });

  it('两个关键帧之间线性插值', () => {
    const keyframes = [kf(0, { J1: 0 }), kf(10, { J1: 100 })];
    expect(km._interpolateJointValueAtTime(keyframes, 'J1', 5)).toBe(50);
  });

  it('t 在第一个关键帧之前 → 返回第一个值', () => {
    const keyframes = [kf(2, { J1: 42 }), kf(8, { J1: 100 })];
    expect(km._interpolateJointValueAtTime(keyframes, 'J1', 0)).toBe(42);
  });

  it('t 在最后一个关键帧之后 → 返回最后一个值', () => {
    const keyframes = [kf(0, { J1: 0 }), kf(5, { J1: 100 })];
    expect(km._interpolateJointValueAtTime(keyframes, 'J1', 10)).toBe(100);
  });

  it('空关键帧 → null', () => {
    expect(km._interpolateJointValueAtTime([], 'J1', 0)).toBe(null);
  });

  it('只跳过不包含 joint id 的关键帧', () => {
    // J1 只在第 1 帧和第 3 帧出现，第 2 帧不涉及
    const keyframes = [
      kf(0, { J1: 0 }),
      kf(5, { J2: 50 }),       // 不包含 J1
      kf(10, { J1: 100 }),
    ];
    // t=5 在 J1 的 (0, 10) 区间中点
    expect(km._interpolateJointValueAtTime(keyframes, 'J1', 5)).toBe(50);
  });
});

describe('computeForkAnchorZero（bug #37）', () => {
  let km;
  beforeEach(() => { km = new KeyframeManager(); });

  /** 建一个最小 scene：sceneRoot → fork（Mesh 带 BoxGeometry）→ （可选）cargo sibling */
  function buildMinScene({ forkWorldPos, boxSize = [1, 1, 1], cargoWorldPos = null }) {
    const sceneRoot = new THREE.Group();
    sceneRoot.name = 'sceneRoot';
    const fork = new THREE.Mesh(
      new THREE.BoxGeometry(...boxSize),
      new THREE.MeshBasicMaterial(),
    );
    fork.name = '_CS19110';
    fork.position.set(...forkWorldPos);
    sceneRoot.add(fork);
    let cargo = null;
    if (cargoWorldPos) {
      cargo = new THREE.Object3D();
      cargo.name = 'cargo';
      cargo.position.set(...cargoWorldPos);
      sceneRoot.add(cargo);
    }
    sceneRoot.updateMatrixWorld(true);
    return { sceneRoot, fork, cargo };
  }

  it('没 reparent event → 返回 {}', () => {
    const { sceneRoot } = buildMinScene({ forkWorldPos: [0, 0, 0] });
    const result = km.computeForkAnchorZero(sceneRoot);
    expect(result).toEqual({});
  });

  it('#52：anchor = forkObj bbox 底面中心（和"子对象底部"按钮同公式）', () => {
    const { sceneRoot } = buildMinScene({ forkWorldPos: [0.5, 0.3, 2.1], boxSize: [1, 1, 1] });
    km.addReparentEvent(5, 'cargo', '_CS19110');
    const r = km.computeForkAnchorZero(sceneRoot);
    // bbox (threejs): min (0, -0.2, 1.6), max (1, 0.8, 2.6), center (0.5, 0.3, 2.1)
    // #52 anchor = (center.x, min.y, center.z) = (0.5, -0.2, 2.1)
    // UI Z-up swap: _x=center.x, _y=center.z, _z=min.y
    expect(r.fork_anchor_zero_x).toBeCloseTo(0.5, 3);
    expect(r.fork_anchor_zero_y).toBeCloseTo(2.1, 3);
    expect(r.fork_anchor_zero_z).toBeCloseTo(-0.2, 3);
  });

  it('#52：cargo 位置不影响 anchor（纯 fork 几何，不依赖 cargo 方向）', () => {
    // 验证 #52 回退到纯 bbox center，不再受 cargo 位置影响
    const sceneA = buildMinScene({
      forkWorldPos: [0, 0, 0], boxSize: [1, 1, 1],
      cargoWorldPos: [3, 0, 0],
    });
    km.addReparentEvent(5, 'cargo', '_CS19110');
    const rA = km.computeForkAnchorZero(sceneA.sceneRoot);

    const km2 = new KeyframeManager();
    const sceneB = buildMinScene({
      forkWorldPos: [0, 0, 0], boxSize: [1, 1, 1],
      cargoWorldPos: [3, 0, 3], // 斜对角 cargo
    });
    km2.addReparentEvent(5, 'cargo', '_CS19110');
    const rB = km2.computeForkAnchorZero(sceneB.sceneRoot);

    // A 和 B anchor 应该相同（都是 bbox 中心 + min.y），和 cargo 位置无关
    expect(rA.fork_anchor_zero_x).toBeCloseTo(rB.fork_anchor_zero_x, 3);
    expect(rA.fork_anchor_zero_y).toBeCloseTo(rB.fork_anchor_zero_y, 3);
    expect(rA.fork_anchor_zero_z).toBeCloseTo(rB.fork_anchor_zero_z, 3);
    expect(rA.fork_anchor_zero_x).toBeCloseTo(0, 3);
    expect(rA.fork_anchor_zero_z).toBeCloseTo(-0.5, 3);
  });

  it('computeForkAnchorZero 后 getForkAnchorZero 读到缓存', () => {
    const { sceneRoot } = buildMinScene({ forkWorldPos: [1, 2, 3] });
    km.addReparentEvent(5, 'cargo', '_CS19110');
    km.computeForkAnchorZero(sceneRoot);
    const cached = km.getForkAnchorZero();
    expect(cached.fork_anchor_zero_x).toBeCloseTo(1, 3);
  });

  it('target joint 找不到时返回 {}（F16 防御）', () => {
    const { sceneRoot } = buildMinScene({ forkWorldPos: [0, 0, 0] });
    km.addReparentEvent(5, 'cargo', 'NONEXISTENT_JOINT');
    expect(km.computeForkAnchorZero(sceneRoot)).toEqual({});
  });
});

describe('restoreState role 保留（F11 / DEBT #3）', () => {
  let km;
  beforeEach(() => { km = new KeyframeManager(); });

  it('正常 snapshot 有 role 字段 → 直接恢复', () => {
    km.setJointDef('A', { type: 'prismatic', axis: 'y', role: '车体前进' });
    const snap = km.serializeState();
    const km2 = new KeyframeManager();
    km2.restoreState(snap);
    expect(km2.getJointDef('A').role).toBe('车体前进');
  });

  it('snapshot 里 role 为空字符串 → 接受为空（显式清空 role 的合法场景）', () => {
    km.setJointDef('A', { type: 'prismatic', axis: 'y', role: '车体前进' });
    const snap = km.serializeState();
    // 手动清空 role 模拟用户显式清空后再 push 的 snapshot
    snap.jointDefinitions[0].role = '';
    km.restoreState(snap);
    expect(km.getJointDef('A').role).toBe('');
  });

  it('F11 防御：snapshot 里没 role 字段（旧版本兼容）→ 保留当前 role', () => {
    km.setJointDef('A', { type: 'prismatic', axis: 'y', role: '车体前进' });
    const snap = km.serializeState();
    // 模拟老版本 snapshot：删掉 role 字段
    delete snap.jointDefinitions[0].role;
    km.restoreState(snap);
    expect(km.getJointDef('A').role).toBe('车体前进');
  });
});

describe('F13 fork_anchor_zero hash-based 自动失效', () => {
  let km;
  let sceneRoot;
  let fork;
  beforeEach(() => {
    km = new KeyframeManager();
    sceneRoot = new THREE.Group();
    sceneRoot.name = 'sceneRoot';
    fork = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial());
    fork.name = '_CS19110';
    sceneRoot.add(fork);
    sceneRoot.updateMatrixWorld(true);
    km.addReparentEvent(5, 'cargo', '_CS19110');
  });

  it('相同输入连续调 → 第二次走 cache（同一 object reference）', () => {
    const r1 = km.computeForkAnchorZero(sceneRoot);
    const r2 = km.computeForkAnchorZero(sceneRoot);
    expect(r2).toBe(r1); // 同一引用说明走了缓存
  });

  it('新增 reparent event → hash 变 → 重新计算（新 object reference）', () => {
    const r1 = km.computeForkAnchorZero(sceneRoot);
    km.addReparentEvent(9, 'cargo', null); // 新增 event → hash 变
    const r2 = km.computeForkAnchorZero(sceneRoot);
    expect(r2).not.toBe(r1);
    // 数值应该相同（叉齿没动），但是新对象（重新计算过）
    expect(r2.fork_anchor_zero_y).toBe(r1.fork_anchor_zero_y);
  });

  it('叉齿子树增加 mesh → hash 变 → 重新计算', () => {
    const r1 = km.computeForkAnchorZero(sceneRoot);
    // 给 fork 添加一个子 mesh（模拟 GLTFLoader 后 mesh 结构变）
    const child = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), new THREE.MeshBasicMaterial());
    child.position.set(0, -0.5, 0); // 放到下方
    fork.add(child);
    sceneRoot.updateMatrixWorld(true);
    const r2 = km.computeForkAnchorZero(sceneRoot);
    expect(r2).not.toBe(r1);
  });

  it('显式 invalidateForkAnchorZero → 下次 compute 仍走完整路径', () => {
    km.computeForkAnchorZero(sceneRoot);
    km.invalidateForkAnchorZero();
    expect(km._forkAnchorZeroCached).toBe(null);
    expect(km._forkAnchorHash).toBe(null);
    const r = km.computeForkAnchorZero(sceneRoot);
    expect(r.fork_anchor_zero_y).toBeCloseTo(0, 3);
  });
});

describe('addReparentEvent / 缓存失效（bug #39）', () => {
  let km;
  beforeEach(() => { km = new KeyframeManager(); });

  it('addReparentEvent 按 t 升序排列', () => {
    km.addReparentEvent(5, 'cargo', 'fork');
    km.addReparentEvent(2, 'cargo', 'fork');
    km.addReparentEvent(9, 'cargo', null);
    const events = km.getReparentEvents();
    expect(events.map((e) => e.t)).toEqual([2, 5, 9]);
  });

  it('addReparentEvent 触发 fork_anchor_zero 缓存失效', () => {
    km._forkAnchorZeroCached = { fork_anchor_zero_y: 2.13 };
    km.addReparentEvent(5, 'cargo', 'fork');
    expect(km._forkAnchorZeroCached).toBe(null);
  });

  it('removeReparentEvent 触发缓存失效', () => {
    const id = km.addReparentEvent(5, 'cargo', 'fork');
    km._forkAnchorZeroCached = { fork_anchor_zero_y: 2.13 };
    km.removeReparentEvent(id);
    expect(km._forkAnchorZeroCached).toBe(null);
  });

  it('removeAllReparentEventsForChild 删除事件并失效缓存（bug #39A）', () => {
    km.addReparentEvent(5, 'cargo', 'fork');
    km.addReparentEvent(9, 'cargo', null);
    km.addReparentEvent(5, 'other', 'fork'); // 不涉及 cargo
    km._forkAnchorZeroCached = { fork_anchor_zero_y: 2.13 };
    const removed = km.removeAllReparentEventsForChild('cargo');
    expect(removed).toBe(2);
    expect(km._forkAnchorZeroCached).toBe(null);
    expect(km.getReparentEvents()).toHaveLength(1);
  });

  it('removeAllReparentEventsForChild 没删到东西时不失效缓存', () => {
    km._forkAnchorZeroCached = { fork_anchor_zero_y: 2.13 };
    const removed = km.removeAllReparentEventsForChild('ghost');
    expect(removed).toBe(0);
    // 没实际改 events → 缓存保留
    expect(km._forkAnchorZeroCached).toEqual({ fork_anchor_zero_y: 2.13 });
  });
});

// REVIEW-v15 F4：PKF 参数 ID 必须是合法 JS 标识符
// 历史：之前 addPkfParameter 只查重不查格式，带空格/正则元字符的 id 能塞进去：
//   1. 公式求值器按 /[a-zA-Z_]\w*/g 提 token → 非标识符 id 在公式里永远是"未知标识符"
//   2. updatePkfParameter 改名时 new RegExp(id) 遇正则元字符抛 SyntaxError，状态半修改
describe('F4 addPkfParameter / updatePkfParameter ID 格式校验', () => {
  let km;
  beforeEach(() => { km = new KeyframeManager(); });

  it('合法标识符（字母/下划线开头）可以 add', () => {
    expect(km.addPkfParameter({ id: 'foo' })).toBeTruthy();
    expect(km.addPkfParameter({ id: '_bar' })).toBeTruthy();
    expect(km.addPkfParameter({ id: 'x_1' })).toBeTruthy();
    expect(km.addPkfParameter({ id: 'cargo_pos_x' })).toBeTruthy();
  });

  it('数字开头非法', () => {
    expect(km.addPkfParameter({ id: '1foo' })).toBeNull();
    expect(km.addPkfParameter({ id: '123' })).toBeNull();
  });

  it('带空格/连字符/点号/正则元字符全拒绝', () => {
    const bad = ['my param', 'my-id', 'foo.bar', 'a+b', 'x*y', '[abc]', '(paren)', 'dot.'];
    for (const id of bad) {
      expect(km.addPkfParameter({ id })).toBeNull();
    }
  });

  it('updatePkfParameter 改名也走格式校验，返回 false', () => {
    km.addPkfParameter({ id: 'foo' });
    expect(km.updatePkfParameter('foo', { id: 'my bad id' })).toBe(false);
    // 状态没被破坏：旧 id 还在
    expect(km.pkfParameters.has('foo')).toBe(true);
    expect(km.pkfParameters.size).toBe(1);
  });

  it('updatePkfParameter 合法改名会替换公式里的引用', () => {
    km.addPkfParameter({ id: 'foo' });
    km.addPkfStep({ value_start: '0', value_end: 'foo + 1', joint: 'j' });
    expect(km.updatePkfParameter('foo', { id: 'bar' })).toBe(true);
    expect(km.pkfSteps[0].value_end).toBe('bar + 1');
  });

  it('空 id 拒绝', () => {
    expect(km.addPkfParameter({ id: '' })).toBeNull();
    expect(km.addPkfParameter({})).toBeNull();
  });
});

// REVIEW-v15 F35：_pkfTemplateMeta 进 undo snapshot
// 历史：之前 serialize 不含此字段，undo 后 pkfSteps 回到模板态但 _pkfTemplateMeta=null
//       → applyReparentEventsAtTime 重新启用 snap-attach → cargo 被强拽瞬移
describe('F35 _pkfTemplateMeta undo 往返', () => {
  let km;
  beforeEach(() => { km = new KeyframeManager(); });

  it('serializeState 含 _pkfTemplateMeta，restoreState 恢复', () => {
    km._pkfTemplateMeta = { template_version: 1, total_duration: 12.5 };
    const snap = km.serializeState();
    expect(snap._pkfTemplateMeta).toEqual({ template_version: 1, total_duration: 12.5 });

    const km2 = new KeyframeManager();
    km2.restoreState(snap);
    expect(km2._pkfTemplateMeta).toEqual({ template_version: 1, total_duration: 12.5 });
  });

  it('null meta 可以正确 round-trip', () => {
    km._pkfTemplateMeta = null;
    const snap = km.serializeState();
    expect(snap._pkfTemplateMeta).toBeNull();

    const km2 = new KeyframeManager();
    km2._pkfTemplateMeta = { template_version: 1 }; // 预存一个
    km2.restoreState(snap); // restore 应该覆盖为 null
    expect(km2._pkfTemplateMeta).toBeNull();
  });

  it('老 snapshot（缺 _pkfTemplateMeta 字段）不覆盖当前值', () => {
    // 模拟老版本 serialize 的 state，缺 _pkfTemplateMeta 字段
    const oldSnap = {
      currentTime: 0,
      jointDefinitions: [],
      objects: [],
      globalClips: [],
      pkfParameters: [],
      pkfSteps: [],
      sceneMarkers: [],
      // 注意：没有 _pkfTemplateMeta 字段
    };
    km._pkfTemplateMeta = { template_version: 1 };
    km.restoreState(oldSnap);
    // 老 snapshot 没这字段 → 保留当前值不动
    expect(km._pkfTemplateMeta).toEqual({ template_version: 1 });
  });
});

// REVIEW-v15 F34：addPkfStep 保留 template_segment / template_segment_name
// 历史：之前这两字段在 addPkfStep 构造时被丢，导致轨迹 overlay 段号标签一直走 idx0+1 兜底
describe('F34 addPkfStep 保留模板元数据字段', () => {
  let km;
  beforeEach(() => { km = new KeyframeManager(); });

  it('传入的 template_segment / template_segment_name 被保留', () => {
    const step = km.addPkfStep({
      joint: 'mast',
      value_end: '1',
      template_segment: 5,
      template_segment_name: '取货',
    });
    expect(step.template_segment).toBe(5);
    expect(step.template_segment_name).toBe('取货');
  });

  it('未传入时默认为 null（非模板来源的 step 也能正常用）', () => {
    const step = km.addPkfStep({ joint: 'j', value_end: '0' });
    expect(step.template_segment).toBeNull();
    expect(step.template_segment_name).toBeNull();
  });

  it('serialize/restore 保持模板元数据', () => {
    km.addPkfStep({
      joint: 'mast',
      value_end: '1',
      template_segment: 5,
      template_segment_name: '取货',
    });
    const snap = km.serializeState();
    const km2 = new KeyframeManager();
    km2.restoreState(snap);
    expect(km2.pkfSteps[0].template_segment).toBe(5);
    expect(km2.pkfSteps[0].template_segment_name).toBe('取货');
  });
});
