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
  function buildMinScene({ forkWorldPos, boxSize = [1, 1, 1] }) {
    const sceneRoot = new THREE.Group();
    sceneRoot.name = 'sceneRoot';
    const fork = new THREE.Mesh(
      new THREE.BoxGeometry(...boxSize),
      new THREE.MeshBasicMaterial(),
    );
    fork.name = '_CS19110';
    fork.position.set(...forkWorldPos);
    sceneRoot.add(fork);
    sceneRoot.updateMatrixWorld(true);
    return { sceneRoot, fork };
  }

  it('没 reparent event → 返回 {}', () => {
    const { sceneRoot } = buildMinScene({ forkWorldPos: [0, 0, 0] });
    const result = km.computeForkAnchorZero(sceneRoot);
    expect(result).toEqual({});
  });

  it('有 reparent event → 返回叉齿 bbox 中心（threejs → UI Z-up swap）', () => {
    const { sceneRoot } = buildMinScene({ forkWorldPos: [0.5, 0.3, 2.1], boxSize: [1, 1, 1] });
    km.addReparentEvent(5, 'cargo', '_CS19110');
    const r = km.computeForkAnchorZero(sceneRoot);
    // BoxGeometry(1,1,1) 默认以中心 (0,0,0) 为 pivot
    // fork 放在 threejs (0.5, 0.3, 2.1) → bbox.center = (0.5, 0.3, 2.1)
    // UI Z-up swap: UI.x = threejs.x, UI.y = threejs.z, UI.z = threejs.y
    expect(r.fork_anchor_zero_x).toBeCloseTo(0.5, 3);
    expect(r.fork_anchor_zero_y).toBeCloseTo(2.1, 3); // threejs.z
    expect(r.fork_anchor_zero_z).toBeCloseTo(0.3, 3); // threejs.y
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
