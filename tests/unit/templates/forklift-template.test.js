/**
 * 叉车取放 14/17 段模板编译器测试（mvp3）
 *
 * 覆盖契约（docs/concepts/forklift-pickup-template.md）：
 *  1. buildDefaultRhythm 17 段均分
 *  2. autoDetectForkName（mast joint.childId → 对象 name）
 *  3. collectTemplateContext 缺要素报错 + lateralJoint 探测
 *  4. compileTemplate 结构：普通叉车 14 步 / 三向车 17 步；2 个 reparent 事件
 *  5. compileTemplate 参数注入
 *  6. compileTemplate 关键段公式正确
 *  7. compileTemplate value_start 从上一段同 role 的 value_end 级联（跨 optional 段也要级联）
 *  8. FORKLIFT_TEMPLATE 数据一致性
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { KeyframeManager } from '../../../src/core/KeyframeManager.js';
import {
  FORKLIFT_TEMPLATE,
  FORKLIFT_TEMPLATE_VERSION,
  TEMPLATE_PARAMETERS,
  buildDefaultRhythm,
  collectTemplateContext,
  autoDetectForkName,
  compileTemplate,
  ROLE_CAR_FORWARD,
  ROLE_MAST_LIFT,
  ROLE_CAR_SIDEWAYS_PRIMARY,
  ROLE_CAR_SIDEWAYS_FALLBACK,
} from '../../../src/core/templates/ForkliftTemplate.js';

// ── 辅助：构造模板编译所需的最小可行 KeyframeManager + sceneRoot ──
// withLateralJoint: 'none' | 'primary' | 'fallback' —— 分别对应无横移 / 车体横移 / 叉齿侧移
function setupScene({
  cargoPos = [0, 0, 0.5],
  dropPos = [0, 5, 0],
  withAttachEvent = true,
  withLateralJoint = 'none',
} = {}) {
  const km = new KeyframeManager();

  km.addMarker({ name: 'cargo', type: 'cargo', size: { w: 0.8, h: 0.6, d: 0.8 } });
  km.addMarker({ name: 'drop', type: 'drop' });

  const sceneRoot = new THREE.Object3D();
  sceneRoot.name = 'root';

  const cargoObj = new THREE.Object3D();
  cargoObj.name = 'cargo';
  cargoObj.position.set(cargoPos[0], cargoPos[2], cargoPos[1]);
  sceneRoot.add(cargoObj);

  const dropObj = new THREE.Object3D();
  dropObj.name = 'drop';
  dropObj.position.set(dropPos[0], dropPos[2], dropPos[1]);
  sceneRoot.add(dropObj);

  const forkObj = new THREE.Object3D();
  forkObj.name = 'fork_tine';
  sceneRoot.add(forkObj);

  km.setJointDef('car_joint_id', {
    name: 'car_forward',
    type: 'prismatic',
    axis: 'y',
    role: ROLE_CAR_FORWARD,
  });
  km.setJointDef('mast_joint_id', {
    name: 'mast_lift',
    type: 'prismatic',
    axis: 'z',
    role: ROLE_MAST_LIFT,
    childId: forkObj.uuid,
  });

  if (withLateralJoint === 'primary' || withLateralJoint === 'fallback') {
    km.setJointDef('lat_joint_id', {
      name: 'car_sideways',
      type: 'prismatic',
      axis: 'x',
      role: withLateralJoint === 'primary' ? ROLE_CAR_SIDEWAYS_PRIMARY : ROLE_CAR_SIDEWAYS_FALLBACK,
    });
  }

  if (withAttachEvent) {
    km.addReparentEvent(2.0, 'cargo', 'fork_tine');
  }

  sceneRoot.updateMatrixWorld(true);
  return { km, sceneRoot, forkObj };
}

// 找段 helper
function segByIndex(compiled, idx) {
  return compiled.steps.find((s) => s.template_segment === idx);
}

// ═══════════════════════════════════════════════════════════════
describe('buildDefaultRhythm', () => {
  it('返回 17 段均分节奏，总时长匹配参数', () => {
    const rhythm = buildDefaultRhythm(17);
    expect(rhythm.segments.length).toBe(17);
    expect(rhythm.segments[0].duration).toBeCloseTo(1, 3);
    const total = rhythm.segments.reduce((s, seg) => s + seg.duration, 0);
    expect(total).toBeCloseTo(17, 2);
  });

  it('所有段都是 ease-in-out', () => {
    const rhythm = buildDefaultRhythm();
    rhythm.segments.forEach((s) => {
      expect(s.easing).toBe('ease-in-out');
    });
  });

  it('段 index 覆盖 1–17', () => {
    const rhythm = buildDefaultRhythm();
    const indices = rhythm.segments.map((s) => s.index).sort((a, b) => a - b);
    expect(indices).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
  });
});

// ═══════════════════════════════════════════════════════════════
describe('autoDetectForkName', () => {
  it('mast joint childId 指向有名字对象 → 返回该对象名字', () => {
    const { km, sceneRoot } = setupScene();
    const name = autoDetectForkName(km, sceneRoot);
    expect(name).toBe('fork_tine');
  });

  it('mast joint childId 指向无名对象，但有命名后代 → 返回后代名字', () => {
    const km = new KeyframeManager();
    const sceneRoot = new THREE.Object3D();
    sceneRoot.name = 'root';
    const wrapper = new THREE.Object3D();
    const deepChild = new THREE.Object3D();
    deepChild.name = 'deep_fork';
    wrapper.add(deepChild);
    sceneRoot.add(wrapper);
    km.setJointDef('m', { type: 'prismatic', axis: 'z', role: ROLE_MAST_LIFT, childId: wrapper.uuid });
    expect(autoDetectForkName(km, sceneRoot)).toBe('deep_fork');
  });

  it('无 mast joint → null', () => {
    const km = new KeyframeManager();
    const sceneRoot = new THREE.Object3D();
    expect(autoDetectForkName(km, sceneRoot)).toBe(null);
  });

  it('mast joint childId 在场景里找不到 → null', () => {
    const km = new KeyframeManager();
    const sceneRoot = new THREE.Object3D();
    km.setJointDef('m', { type: 'prismatic', axis: 'z', role: ROLE_MAST_LIFT, childId: 'nonexistent_uuid' });
    expect(autoDetectForkName(km, sceneRoot)).toBe(null);
  });

  it('有 "叉齿*" role 关节时优先用它（而不是门架升降）', () => {
    const km = new KeyframeManager();
    const sceneRoot = new THREE.Object3D();
    // 建两个场景对象，分别代表 门架 和 叉齿
    const mastMesh = new THREE.Object3D();
    mastMesh.name = 'mast_mesh';
    sceneRoot.add(mastMesh);
    const forkMesh = new THREE.Object3D();
    forkMesh.name = 'fork_tines';
    sceneRoot.add(forkMesh);
    // 两个关节都给：门架升降 指向 mast，叉齿旋转 指向 fork
    km.setJointDef('mast_id', {
      type: 'prismatic', axis: 'z', role: ROLE_MAST_LIFT, childId: mastMesh.uuid,
    });
    km.setJointDef('fork_rot_id', {
      type: 'revolute', axis: 'z', role: '叉齿旋转', childId: forkMesh.uuid,
    });
    expect(autoDetectForkName(km, sceneRoot)).toBe('fork_tines');
  });

  it('"叉齿侧移" / "叉齿前伸" 等其他叉齿 role 也被识别', () => {
    const km = new KeyframeManager();
    const sceneRoot = new THREE.Object3D();
    const mastMesh = new THREE.Object3D();
    mastMesh.name = 'mast_mesh';
    sceneRoot.add(mastMesh);
    const forkMesh = new THREE.Object3D();
    forkMesh.name = 'fork_side';
    sceneRoot.add(forkMesh);
    km.setJointDef('mast_id', {
      type: 'prismatic', axis: 'z', role: ROLE_MAST_LIFT, childId: mastMesh.uuid,
    });
    km.setJointDef('fork_side_id', {
      type: 'prismatic', axis: 'x', role: '叉齿侧移', childId: forkMesh.uuid,
    });
    expect(autoDetectForkName(km, sceneRoot)).toBe('fork_side');
  });

  it('无叉齿 role 时退化用门架升降', () => {
    const { km, sceneRoot } = setupScene();
    const name = autoDetectForkName(km, sceneRoot);
    expect(name).toBe('fork_tine'); // 来自 setupScene 的 mast joint childId
  });
});

// ═══════════════════════════════════════════════════════════════
describe('collectTemplateContext 要素缺失检测', () => {
  it('空场景 → 缺所有要素', () => {
    const km = new KeyframeManager();
    const sceneRoot = new THREE.Object3D();
    const r = collectTemplateContext(km, sceneRoot);
    expect(r.ok).toBe(false);
    expect(r.missing).toContain('cargo marker（货物占位）');
    expect(r.missing).toContain('drop marker（放货点）');
    expect(r.missing.some((m) => m.includes(ROLE_CAR_FORWARD))).toBe(true);
    expect(r.missing.some((m) => m.includes(ROLE_MAST_LIFT))).toBe(true);
  });

  it('缺 cargo marker', () => {
    const { km, sceneRoot } = setupScene();
    const ids = [...km.sceneMarkers.entries()]
      .filter(([, m]) => m.type === 'cargo')
      .map(([id]) => id);
    ids.forEach((id) => km.removeMarker(id));
    const r = collectTemplateContext(km, sceneRoot);
    expect(r.ok).toBe(false);
    expect(r.missing).toContain('cargo marker（货物占位）');
  });

  it('无 attach 事件也 ok —— 自动从 mast joint childId 识别 fork', () => {
    const { km, sceneRoot } = setupScene({ withAttachEvent: false });
    const r = collectTemplateContext(km, sceneRoot);
    expect(r.ok).toBe(true);
    expect(r.data.forkName).toBe('fork_tine');
    expect(r.data.forkSource).toBe('auto_from_mast_joint');
  });

  it('已有 attach 事件 → 用事件里的 fork 名字', () => {
    const { km, sceneRoot } = setupScene({ withAttachEvent: false });
    const customFork = new THREE.Object3D();
    customFork.name = 'custom_fork';
    sceneRoot.add(customFork);
    km.addReparentEvent(1.5, 'cargo', 'custom_fork');
    const r = collectTemplateContext(km, sceneRoot);
    expect(r.ok).toBe(true);
    expect(r.data.forkName).toBe('custom_fork');
    expect(r.data.forkSource).toBe('existing_attach_event');
  });

  it('无 attach 事件且 mast joint 无 childId → 报 fork 对象缺失', () => {
    const { km, sceneRoot } = setupScene({ withAttachEvent: false });
    km.jointDefinitions.get('mast_joint_id').childId = null;
    const r = collectTemplateContext(km, sceneRoot);
    expect(r.ok).toBe(false);
    expect(r.missing.some((m) => m.includes('fork'))).toBe(true);
  });

  it('缺 role=门架升降 关节', () => {
    const { km, sceneRoot } = setupScene();
    km.jointDefinitions.delete('mast_joint_id');
    const r = collectTemplateContext(km, sceneRoot);
    expect(r.ok).toBe(false);
    expect(r.missing.some((m) => m.includes(ROLE_MAST_LIFT))).toBe(true);
  });

  it('无横移关节 → ctx.lateralJoint = null（14 段降级）', () => {
    const { km, sceneRoot } = setupScene({ withLateralJoint: 'none' });
    const r = collectTemplateContext(km, sceneRoot);
    expect(r.ok).toBe(true);
    expect(r.data.lateralJoint).toBe(null);
  });

  it('车体横移 role 存在 → ctx.lateralJoint 命中', () => {
    const { km, sceneRoot } = setupScene({ withLateralJoint: 'primary' });
    const r = collectTemplateContext(km, sceneRoot);
    expect(r.ok).toBe(true);
    expect(r.data.lateralJoint?.role).toBe(ROLE_CAR_SIDEWAYS_PRIMARY);
  });

  it('叉齿侧移 role fallback → ctx.lateralJoint 命中', () => {
    const { km, sceneRoot } = setupScene({ withLateralJoint: 'fallback' });
    const r = collectTemplateContext(km, sceneRoot);
    expect(r.ok).toBe(true);
    expect(r.data.lateralJoint?.role).toBe(ROLE_CAR_SIDEWAYS_FALLBACK);
  });

  it('完整场景 → ok=true 且带全部字段', () => {
    const { km, sceneRoot } = setupScene({ cargoPos: [1, 5, 0.6], dropPos: [2, 10, 0.3] });
    const r = collectTemplateContext(km, sceneRoot);
    expect(r.ok).toBe(true);
    expect(r.data.cargoName).toBe('cargo');
    expect(r.data.dropName).toBe('drop');
    expect(r.data.forkName).toBe('fork_tine');
    expect(r.data.forkSource).toBe('existing_attach_event');
    expect(r.data.cargoPos.x).toBeCloseTo(1, 3);
    expect(r.data.cargoPos.y).toBeCloseTo(5, 3);
    expect(r.data.cargoPos.z).toBeCloseTo(0.6, 3);
    expect(r.data.dropPos.x).toBeCloseTo(2, 3);
    expect(r.data.dropPos.y).toBeCloseTo(10, 3);
    expect(r.data.dropPos.z).toBeCloseTo(0.3, 3);
    expect(r.data.cargoSize.w).toBe(0.8);
    expect(r.data.cargoSize.h).toBe(0.6);
    expect(r.data.carJoint.name).toBe('car_forward');
    expect(r.data.mastJoint.name).toBe('mast_lift');
  });

  // #59 UX：双段门架用户倾向于把 role="门架升降" 贴给**所有**门架段（语义真实）。
  // findPrimaryByRole 根据 overflow_to 自动跳过 slave，collectTemplateContext 因此挑到 inner。
  it('双段门架：内外都 role=门架升降，自动挑 inner（有 overflow_to）为 primary', () => {
    const { km, sceneRoot } = setupScene();
    // 把原来的 mast_lift 改造成外门架；新增 inner_lift 作为内门架（overflow 到外）
    km.setJointDef('mast_joint_id', { name: 'outer_lift' }); // rename only
    km.setJointDef('inner_joint_id', {
      name: 'inner_lift',
      type: 'prismatic',
      axis: 'z',
      role: ROLE_MAST_LIFT,
      limit_upper: 4,
      overflow_to: 'outer_lift',
      childId: km.jointDefinitions.get('mast_joint_id').childId, // 内门架挂 fork
    });
    // 确保 outer 也是 role=门架升降（默认 setupScene 已设）
    const r = collectTemplateContext(km, sceneRoot);
    expect(r.ok).toBe(true);
    // primary 应该是 inner_lift（outer 是 slave 被跳过）
    expect(r.data.mastJoint.name).toBe('inner_lift');
  });
});

// ═══════════════════════════════════════════════════════════════
describe('compileTemplate 结构', () => {
  describe('普通叉车（无横移）→ 14 步', () => {
    let ctx;
    beforeEach(() => {
      const { km, sceneRoot } = setupScene({ cargoPos: [0, 5, 0.6], dropPos: [0, 10, 0.5] });
      ctx = collectTemplateContext(km, sceneRoot).data;
    });

    it('生成 14 步 + 2 个 reparent 事件（跳过 3 段 optional）', () => {
      const compiled = compileTemplate(ctx);
      expect(compiled.steps.length).toBe(14);
      expect(compiled.reparent_events.length).toBe(2);
    });

    it('optional 段（1/9/17）被跳过', () => {
      const compiled = compileTemplate(ctx);
      const segs = compiled.steps.map((s) => s.template_segment);
      expect(segs).not.toContain(1);
      expect(segs).not.toContain(9);
      expect(segs).not.toContain(17);
    });
  });

  describe('三向车（有横移）→ 17 步', () => {
    let ctx;
    beforeEach(() => {
      const { km, sceneRoot } = setupScene({
        cargoPos: [3, 5, 0.6],
        dropPos: [-2, 10, 0.5],
        withLateralJoint: 'primary',
      });
      ctx = collectTemplateContext(km, sceneRoot).data;
    });

    it('生成 17 步 + 2 个 reparent 事件', () => {
      const compiled = compileTemplate(ctx);
      expect(compiled.steps.length).toBe(17);
      expect(compiled.reparent_events.length).toBe(2);
    });

    it('段 1/9/17 都存在且驱动横移关节', () => {
      const compiled = compileTemplate(ctx);
      expect(segByIndex(compiled, 1)?.joint).toBe('car_sideways');
      expect(segByIndex(compiled, 9)?.joint).toBe('car_sideways');
      expect(segByIndex(compiled, 17)?.joint).toBe('car_sideways');
    });

    it('叉齿侧移 role（fallback）也能命中', () => {
      const { km, sceneRoot } = setupScene({
        cargoPos: [3, 5, 0.6],
        dropPos: [-2, 10, 0.5],
        withLateralJoint: 'fallback',
      });
      const ctx2 = collectTemplateContext(km, sceneRoot).data;
      const compiled = compileTemplate(ctx2);
      expect(compiled.steps.length).toBe(17);
      expect(segByIndex(compiled, 1)?.joint).toBe('car_sideways');
    });
  });

  describe('通用结构', () => {
    let ctx;
    beforeEach(() => {
      const { km, sceneRoot } = setupScene({ cargoPos: [0, 5, 0.6], dropPos: [0, 10, 0.5] });
      ctx = collectTemplateContext(km, sceneRoot).data;
    });

    it('meta.template_version 正确写入', () => {
      const compiled = compileTemplate(ctx);
      expect(compiled.meta.template_version).toBe(FORKLIFT_TEMPLATE_VERSION);
    });

    it('attach 在段 4 t_end，detach 在段 13 t_end', () => {
      const compiled = compileTemplate(ctx, buildDefaultRhythm(17));
      const attach = compiled.reparent_events.find((e) => e.new_parent_name);
      const detach = compiled.reparent_events.find((e) => e.new_parent_name === null);
      expect(attach.t).toBeCloseTo(segByIndex(compiled, 4).t_end, 3);
      expect(detach.t).toBeCloseTo(segByIndex(compiled, 13).t_end, 3);
      expect(attach.child_name).toBe('cargo');
      expect(attach.new_parent_name).toBe('fork_tine');
      expect(detach.new_parent_name).toBe(null);
    });

    it('段 t_start 严格串行等于前段 t_end', () => {
      const compiled = compileTemplate(ctx);
      for (let i = 1; i < compiled.steps.length; i++) {
        expect(compiled.steps[i].t_start).toBeCloseTo(compiled.steps[i - 1].t_end, 3);
      }
    });
  });
});

// ═══════════════════════════════════════════════════════════════
describe('compileTemplate 参数注入', () => {
  let ctx;
  beforeEach(() => {
    const { km, sceneRoot } = setupScene({ cargoPos: [1.5, 5.2, 0.6], dropPos: [3.0, 10.5, 0.3] });
    ctx = collectTemplateContext(km, sceneRoot).data;
  });

  it('cargo_pos/drop_pos 用 marker 实际坐标做 default', () => {
    const compiled = compileTemplate(ctx);
    const get = (id) => compiled.parameters.find((p) => p.id === id);
    expect(get('cargo_pos_x').default).toBeCloseTo(1.5, 3);
    expect(get('cargo_pos_y').default).toBeCloseTo(5.2, 3);
    expect(get('cargo_pos_z').default).toBeCloseTo(0.6, 3);
    expect(get('drop_pos_x').default).toBeCloseTo(3.0, 3);
    expect(get('drop_pos_y').default).toBeCloseTo(10.5, 3);
    expect(get('drop_pos_z').default).toBeCloseTo(0.3, 3);
  });

  it('fork_anchor_zero 用传入值做 default', () => {
    const compiled = compileTemplate(ctx, undefined, {
      fork_anchor_zero_x: 0.48,
      fork_anchor_zero_y: 2.12,
      fork_anchor_zero_z: 0.32,
    });
    const get = (id) => compiled.parameters.find((p) => p.id === id);
    expect(get('fork_anchor_zero_x').default).toBeCloseTo(0.48, 3);
    expect(get('fork_anchor_zero_y').default).toBeCloseTo(2.12, 3);
    expect(get('fork_anchor_zero_z').default).toBeCloseTo(0.32, 3);
  });

  it('cargo 尺寸写入 default', () => {
    const compiled = compileTemplate(ctx);
    const get = (id) => compiled.parameters.find((p) => p.id === id);
    expect(get('cargo_width').default).toBe(0.8);
    expect(get('cargo_height').default).toBe(0.6);
    expect(get('cargo_depth').default).toBe(0.8);
  });

  it('4 个新模板参数带默认值', () => {
    const compiled = compileTemplate(ctx);
    const get = (id) => compiled.parameters.find((p) => p.id === id);
    expect(get('cargo_fork_height').default).toBe(0);
    expect(get('safe_distance').default).toBe(0.8);
    expect(get('lift_clearance').default).toBe(0.1);
    expect(get('transport_height').default).toBe(0.2);
  });

  it('TEMPLATE_PARAMETERS 全部被写入 parameters 数组', () => {
    const compiled = compileTemplate(ctx);
    const paramIds = new Set(compiled.parameters.map((p) => p.id));
    TEMPLATE_PARAMETERS.forEach((p) => expect(paramIds.has(p.id)).toBe(true));
  });
});

// ═══════════════════════════════════════════════════════════════
describe('compileTemplate 公式正确', () => {
  let ctx;
  beforeEach(() => {
    const { km, sceneRoot } = setupScene({
      cargoPos: [3, 5, 0.6],
      dropPos: [-2, 10, 0.3],
      withLateralJoint: 'primary',
    });
    ctx = collectTemplateContext(km, sceneRoot).data;
  });

  it('段 1 横移对齐 cargo x：公式 = cargo_pos_x - fork_anchor_zero_x', () => {
    const compiled = compileTemplate(ctx);
    expect(segByIndex(compiled, 1).value_end).toBe('cargo_pos_x - fork_anchor_zero_x');
  });

  it('段 2 接近：公式 = cargo_pos_y - anchor - safe_distance', () => {
    const compiled = compileTemplate(ctx);
    expect(segByIndex(compiled, 2).value_end).toBe('cargo_pos_y - fork_anchor_zero_y - safe_distance');
  });

  it('段 3 抬叉：公式 = cargo_bottom + fork_offset - clearance - anchor', () => {
    const compiled = compileTemplate(ctx);
    expect(segByIndex(compiled, 3).value_end).toBe('cargo_pos_z - cargo_height / 2 + cargo_fork_height - lift_clearance - fork_anchor_zero_z');
  });

  it('段 4 插齿：attach 触发段；公式 = cargo_pos_y - anchor', () => {
    const compiled = compileTemplate(ctx);
    expect(segByIndex(compiled, 4).value_end).toBe('cargo_pos_y - fork_anchor_zero_y');
    expect(segByIndex(compiled, 4).joint).toBe('car_forward');
  });

  it('段 5 取货：公式 = 段 3 去掉 -lift_clearance', () => {
    const compiled = compileTemplate(ctx);
    expect(segByIndex(compiled, 5).value_end).toBe('cargo_pos_z - cargo_height / 2 + cargo_fork_height - fork_anchor_zero_z');
  });

  it('段 9 横移到 drop x：公式 = drop_pos_x - fork_anchor_zero_x', () => {
    const compiled = compileTemplate(ctx);
    expect(segByIndex(compiled, 9).value_end).toBe('drop_pos_x - fork_anchor_zero_x');
  });

  it('段 11 放货前抬叉：公式 = drop_pos_z + cargo_fork_height - anchor', () => {
    const compiled = compileTemplate(ctx);
    expect(segByIndex(compiled, 11).value_end).toBe('drop_pos_z + cargo_fork_height - fork_anchor_zero_z');
  });

  it('段 13 放货：detach 触发段；公式 = 段 11 - lift_clearance', () => {
    const compiled = compileTemplate(ctx);
    expect(segByIndex(compiled, 13).value_end).toBe('drop_pos_z + cargo_fork_height - lift_clearance - fork_anchor_zero_z');
    expect(segByIndex(compiled, 13).joint).toBe('mast_lift');
  });

  it('段 15/16/17 复位：公式 = 0', () => {
    const compiled = compileTemplate(ctx);
    expect(segByIndex(compiled, 15).value_end).toBe('0');
    expect(segByIndex(compiled, 16).value_end).toBe('0');
    expect(segByIndex(compiled, 17).value_end).toBe('0');
  });
});

// ═══════════════════════════════════════════════════════════════
describe('compileTemplate value_start 级联', () => {
  describe('无横移（14 段）', () => {
    let ctx;
    beforeEach(() => {
      const { km, sceneRoot } = setupScene();
      ctx = collectTemplateContext(km, sceneRoot).data;
    });

    it('第一段 value_start = "0"', () => {
      const compiled = compileTemplate(ctx);
      expect(compiled.steps[0].value_start).toBe('0');
    });

    it('车体前进与门架升降各自独立级联（不会串扰）', () => {
      const compiled = compileTemplate(ctx);
      // 段 2（车体前进首段）value_start = '0'，value_end 是公式
      // 段 4（车体前进插齿）value_start 应等于段 2 value_end
      const seg2 = segByIndex(compiled, 2);
      const seg4 = segByIndex(compiled, 4);
      expect(seg4.value_start).toBe(seg2.value_end);

      // 段 5（门架升降取货）value_start 应等于段 3（门架升降抬叉）value_end
      const seg3 = segByIndex(compiled, 3);
      const seg5 = segByIndex(compiled, 5);
      expect(seg5.value_start).toBe(seg3.value_end);
    });
  });

  describe('有横移（17 段）', () => {
    let ctx;
    beforeEach(() => {
      const { km, sceneRoot } = setupScene({ withLateralJoint: 'primary' });
      ctx = collectTemplateContext(km, sceneRoot).data;
    });

    it('段 9 横移 value_start = 段 1 横移 value_end（跨中间段级联）', () => {
      const compiled = compileTemplate(ctx);
      const seg1 = segByIndex(compiled, 1);
      const seg9 = segByIndex(compiled, 9);
      expect(seg9.value_start).toBe(seg1.value_end);
    });

    it('段 17 横移 value_start = 段 9 横移 value_end', () => {
      const compiled = compileTemplate(ctx);
      const seg9 = segByIndex(compiled, 9);
      const seg17 = segByIndex(compiled, 17);
      expect(seg17.value_start).toBe(seg9.value_end);
    });

    it('叉齿侧移 role（fallback）也能正常级联', () => {
      const { km, sceneRoot } = setupScene({ withLateralJoint: 'fallback' });
      const ctx2 = collectTemplateContext(km, sceneRoot).data;
      const compiled = compileTemplate(ctx2);
      const seg1 = segByIndex(compiled, 1);
      const seg9 = segByIndex(compiled, 9);
      expect(seg9.value_start).toBe(seg1.value_end);
    });
  });
});

// ═══════════════════════════════════════════════════════════════
describe('FORKLIFT_TEMPLATE 数据一致性', () => {
  it('index 严格递增 1–17', () => {
    FORKLIFT_TEMPLATE.forEach((seg, i) => {
      expect(seg.index).toBe(i + 1);
    });
    expect(FORKLIFT_TEMPLATE.length).toBe(17);
  });

  it('role 只使用定义的三种角色', () => {
    FORKLIFT_TEMPLATE.forEach((seg) => {
      expect([
        ROLE_CAR_FORWARD,
        ROLE_MAST_LIFT,
        ROLE_CAR_SIDEWAYS_PRIMARY,
      ]).toContain(seg.role);
    });
  });

  it('optional 段恰好 3 段（1/9/17，都是横移）', () => {
    const optional = FORKLIFT_TEMPLATE.filter((s) => s.optional);
    expect(optional.map((s) => s.index).sort((a, b) => a - b)).toEqual([1, 9, 17]);
    optional.forEach((s) => expect(s.role).toBe(ROLE_CAR_SIDEWAYS_PRIMARY));
  });

  it('reparent 事件恰好在段 4 attach 和段 13 detach', () => {
    const reparents = FORKLIFT_TEMPLATE.filter((s) => s.reparent);
    expect(reparents.length).toBe(2);
    expect(reparents.find((s) => s.reparent === 'attach').index).toBe(4);
    expect(reparents.find((s) => s.reparent === 'detach').index).toBe(13);
  });

  it('公式字符串非空', () => {
    FORKLIFT_TEMPLATE.forEach((seg) => {
      expect(typeof seg.formula).toBe('string');
      expect(seg.formula.length).toBeGreaterThan(0);
    });
  });
});
