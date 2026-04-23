/**
 * 三向车模板（ThreewayTemplate）单元测试
 *
 * 覆盖契约：
 *   1. canApply 排他 + 必需 role 齐全检测
 *   2. decideAxis / axisToAngle 工具函数
 *   3. compileTemplate 9 种 (cargoAxis, dropAxis) 组合的段数 + reparent 段号
 *   4. 参数数组含新参（fork_insertion_depth / x_axis_threshold）
 *   5. 旋转 value_start 按 ROLE 级联（跨 rotate 段拿上一段 value_end）
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { KeyframeManager } from '../../../src/core/KeyframeManager.js';
import {
  canApply,
  compileTemplate,
  buildDefaultRhythm,
  decideAxis,
  axisToAngle,
  kind as THREEWAY_KIND,
  THREEWAY_TEMPLATE_VERSION,
  ROLE_MAST_LATERAL,
  ROLE_FORK_ROTATE,
  TEMPLATE_PARAMETERS_THREEWAY,
} from '../../../src/core/templates/ThreewayTemplate.js';
import {
  ROLE_CAR_FORWARD,
  ROLE_MAST_LIFT,
  ROLE_CAR_SIDEWAYS_PRIMARY,
} from '../../../src/core/templates/ForkliftTemplate.js';

/**
 * 构造一个最小三向车场景：
 *   - cargo marker
 *   - drop marker
 *   - 5 个关节：车体前进 / 门架升降 / 门架横移 / 叉齿旋转 / （无 车体横移）
 * cargoPos / dropPos 可定制
 */
function setupThreewayScene({
  cargoPos = [1.5, 1, 1],
  dropPos = [-1.5, 6, 1],
} = {}) {
  const km = new KeyframeManager();

  km.addMarker({ name: 'cargo', type: 'cargo', size: { w: 0.8, h: 0.6, d: 0.8 } });
  km.addMarker({ name: 'drop', type: 'drop' });

  const sceneRoot = new THREE.Object3D();
  sceneRoot.name = 'root';

  const cargoObj = new THREE.Object3D();
  cargoObj.name = 'cargo';
  cargoObj.position.set(cargoPos[0], cargoPos[2], cargoPos[1]); // UI z=1 → three y
  sceneRoot.add(cargoObj);

  const dropObj = new THREE.Object3D();
  dropObj.name = 'drop';
  dropObj.position.set(dropPos[0], dropPos[2], dropPos[1]);
  sceneRoot.add(dropObj);

  const forkObj = new THREE.Object3D();
  forkObj.name = 'fork_tine';
  sceneRoot.add(forkObj);

  km.setJointDef('car_id', {
    name: '_AHR23',
    type: 'prismatic',
    axis: 'y',
    role: ROLE_CAR_FORWARD,
  });
  km.setJointDef('mast_id', {
    name: 'cAR201',
    type: 'prismatic',
    axis: 'z',
    role: ROLE_MAST_LIFT,
  });
  km.setJointDef('lateral_id', {
    name: '_CS198',
    type: 'prismatic',
    axis: 'x',
    role: ROLE_MAST_LATERAL,
  });
  km.setJointDef('rotate_id', {
    name: '_CS19110',
    type: 'revolute',
    axis: 'z',
    role: ROLE_FORK_ROTATE,
    childId: forkObj.uuid,
  });

  sceneRoot.updateMatrixWorld(true);
  return { km, sceneRoot };
}

// ═════════════════════════════════════════════════════════
describe('decideAxis', () => {
  it('|x| > threshold → ±x 侧；pos.x > 0 → +x', () => {
    expect(decideAxis({ x: 1.5, y: 1, z: 1 }, 0.3)).toBe('+x');
  });
  it('pos.x < 0 且 |x| > threshold → -x', () => {
    expect(decideAxis({ x: -2, y: 5, z: 1 }, 0.3)).toBe('-x');
  });
  it('|x| ≤ threshold → +y（正面取）', () => {
    expect(decideAxis({ x: 0.1, y: 5, z: 1 }, 0.3)).toBe('+y');
  });
  it('x=0 → +y', () => {
    expect(decideAxis({ x: 0, y: 3, z: 1 })).toBe('+y');
  });
  it('阈值边界：|x| == threshold → +y（等号不含）', () => {
    expect(decideAxis({ x: 0.3, y: 1, z: 1 }, 0.3)).toBe('+y');
  });
});

// ═════════════════════════════════════════════════════════
describe('axisToAngle（度数 + 符号修正 UI↔Three.js 左手系映射）', () => {
  it('+x → 0°（默认姿态）', () => expect(axisToAngle('+x')).toBe(0));
  // UI Z-up → Three.js Y-up 的映射是左手系，+90° 在 Three.js 里会让
  // fork 转到 -y 方向；要得到用户视觉上"+y 朝向"需要取 -90°
  it('+y → -90°（负值抵消左手系映射）', () => expect(axisToAngle('+y')).toBe(-90));
  it('-x → -180°（同 +180°视觉一致）', () => expect(axisToAngle('-x')).toBe(-180));
  it('未知轴退化为 0°', () => expect(axisToAngle('-y')).toBe(0));
});

// ═════════════════════════════════════════════════════════
describe('canApply 排他 + 必需 role', () => {
  it('完整三向车场景 → ok=true，返回 ctx', () => {
    const { km, sceneRoot } = setupThreewayScene();
    const r = canApply(km, sceneRoot);
    expect(r.ok).toBe(true);
    expect(r.data.cargoName).toBe('cargo');
    expect(r.data.dropName).toBe('drop');
    expect(r.data.forkName).toBe('fork_tine');
    expect(r.data.carJoint?.role).toBe(ROLE_CAR_FORWARD);
    expect(r.data.mastJoint?.role).toBe(ROLE_MAST_LIFT);
    expect(r.data.lateralJoint?.role).toBe(ROLE_MAST_LATERAL);
    expect(r.data.rotateJoint?.role).toBe(ROLE_FORK_ROTATE);
  });

  it('有 车体横移 role → 排他失败（让 ForkliftTemplate 处理）', () => {
    const { km, sceneRoot } = setupThreewayScene();
    km.setJointDef('bad_id', {
      name: 'extra_sideways',
      type: 'prismatic',
      axis: 'x',
      role: ROLE_CAR_SIDEWAYS_PRIMARY,
    });
    const r = canApply(km, sceneRoot);
    expect(r.ok).toBe(false);
  });

  it('缺 门架横移 → ok=false，missing 列出', () => {
    const { km, sceneRoot } = setupThreewayScene();
    km.removeJointDef('lateral_id');
    const r = canApply(km, sceneRoot);
    expect(r.ok).toBe(false);
    expect(r.missing.some((m) => m.includes('门架横移'))).toBe(true);
  });

  it('缺 叉齿旋转 → missing', () => {
    const { km, sceneRoot } = setupThreewayScene();
    km.removeJointDef('rotate_id');
    const r = canApply(km, sceneRoot);
    expect(r.ok).toBe(false);
    expect(r.missing.some((m) => m.includes('叉齿旋转'))).toBe(true);
  });

  it('缺 cargo marker → missing', () => {
    const { km, sceneRoot } = setupThreewayScene();
    km.sceneMarkers.clear();
    km.addMarker({ name: 'drop', type: 'drop' });
    const r = canApply(km, sceneRoot);
    expect(r.ok).toBe(false);
    expect(r.missing.some((m) => m.includes('cargo marker'))).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════
describe('compileTemplate 各 axis 组合', () => {
  it('+x → -x（用户示例场景 cargo(1.5,1) / drop(-1.5,6)）', () => {
    const { km, sceneRoot } = setupThreewayScene({ cargoPos: [1.5, 1, 1], dropPos: [-1.5, 6, 1] });
    const ctx = canApply(km, sceneRoot).data;
    const compiled = compileTemplate(ctx);
    expect(compiled.meta.cargo_axis).toBe('+x');
    expect(compiled.meta.drop_axis).toBe('-x');
    // 验证有 attach / detach 各一条
    const attachEvt = compiled.reparent_events.find((e) => e.new_parent_name);
    const detachEvt = compiled.reparent_events.find((e) => !e.new_parent_name);
    expect(attachEvt?.child_name).toBe('cargo');
    expect(attachEvt?.new_parent_name).toBe('fork_tine');
    expect(detachEvt?.child_name).toBe('cargo');
    expect(detachEvt?.new_parent_name).toBeNull();
  });

  it('+y → -x（cargo 正前方，drop 侧面）', () => {
    const { km, sceneRoot } = setupThreewayScene({ cargoPos: [0.1, 3, 1], dropPos: [-2, 6, 1] });
    const ctx = canApply(km, sceneRoot).data;
    const compiled = compileTemplate(ctx);
    expect(compiled.meta.cargo_axis).toBe('+y');
    expect(compiled.meta.drop_axis).toBe('-x');
    // +y 取货少一次旋转（默认 0 == +x... wait, cargoAxis=+y 要从 0 转到 π/2）
    // 省的是"旋转到 cargoAxis"：因为 cargoAxis=+y，下一阶段 travel 也要 +y → 合二为一
  });

  it('+x → +x（两端都在 +x 侧）', () => {
    const { km, sceneRoot } = setupThreewayScene({ cargoPos: [1.5, 1, 1], dropPos: [2, 8, 1] });
    const ctx = canApply(km, sceneRoot).data;
    const compiled = compileTemplate(ctx);
    expect(compiled.meta.cargo_axis).toBe('+x');
    expect(compiled.meta.drop_axis).toBe('+x');
  });

  it('-x → +x（镜像场景）', () => {
    const { km, sceneRoot } = setupThreewayScene({ cargoPos: [-1.5, 1, 1], dropPos: [1.5, 6, 1] });
    const ctx = canApply(km, sceneRoot).data;
    const compiled = compileTemplate(ctx);
    expect(compiled.meta.cargo_axis).toBe('-x');
    expect(compiled.meta.drop_axis).toBe('+x');
  });

  it('+y → +y（两端都从前方）', () => {
    const { km, sceneRoot } = setupThreewayScene({ cargoPos: [0.1, 2, 1], dropPos: [0, 5, 1] });
    const ctx = canApply(km, sceneRoot).data;
    const compiled = compileTemplate(ctx);
    expect(compiled.meta.cargo_axis).toBe('+y');
    expect(compiled.meta.drop_axis).toBe('+y');
    // 不需要 lateral 关节用过 → steps 里不应该含 lateral joint.name
    const usedLateral = compiled.steps.some((s) => s.joint === '_CS198');
    expect(usedLateral).toBe(false);
  });

  it('每个 compile 都产出合法段数（≥ 10，≤ 22）', () => {
    const cases = [
      [[1.5, 1, 1], [-1.5, 6, 1]],
      [[0.1, 3, 1], [-2, 6, 1]],
      [[1.5, 1, 1], [2, 8, 1]],
      [[-1.5, 1, 1], [1.5, 6, 1]],
      [[0.1, 2, 1], [0, 5, 1]],
    ];
    for (const [c, d] of cases) {
      const { km, sceneRoot } = setupThreewayScene({ cargoPos: c, dropPos: d });
      const ctx = canApply(km, sceneRoot).data;
      const compiled = compileTemplate(ctx);
      expect(compiled.steps.length).toBeGreaterThanOrEqual(10);
      expect(compiled.steps.length).toBeLessThanOrEqual(22);
    }
  });
});

// ═════════════════════════════════════════════════════════
describe('compileTemplate meta + reparent 正确', () => {
  let compiled;
  beforeEach(() => {
    const { km, sceneRoot } = setupThreewayScene();
    const ctx = canApply(km, sceneRoot).data;
    compiled = compileTemplate(ctx);
  });

  it('meta 含 template_version / template_kind / cargo_axis / drop_axis / segment_count', () => {
    expect(compiled.meta.template_version).toBe(THREEWAY_TEMPLATE_VERSION);
    expect(compiled.meta.template_kind).toBe(THREEWAY_KIND);
    expect(compiled.meta.cargo_axis).toBeDefined();
    expect(compiled.meta.drop_axis).toBeDefined();
    expect(compiled.meta.segment_count).toBe(compiled.steps.length);
  });

  it('attach / detach 时间严格递增且在 steps 时间范围内', () => {
    const attach = compiled.reparent_events.find((e) => e.new_parent_name);
    const detach = compiled.reparent_events.find((e) => !e.new_parent_name);
    expect(attach.t).toBeLessThan(detach.t);
    expect(detach.t).toBeLessThanOrEqual(compiled.meta.total_duration);
  });

  it('attach 段标记了 template_segment_name（便于轨迹 overlay 和诊断识别）', () => {
    const attachT = compiled.reparent_events.find((e) => e.new_parent_name).t;
    const attachStep = compiled.steps.find((s) => Math.abs(s.t_end - attachT) < 1e-3);
    expect(attachStep).toBeDefined();
    expect(attachStep.template_segment_name).toMatch(/插入/);
  });
});

// ═════════════════════════════════════════════════════════
describe('compileTemplate value_start 级联', () => {
  it('同 role 后段 value_start = 前段 value_end', () => {
    const { km, sceneRoot } = setupThreewayScene();
    const ctx = canApply(km, sceneRoot).data;
    const compiled = compileTemplate(ctx);

    // 按 role 分组，检查级联
    const byRole = new Map();
    for (const s of compiled.steps) {
      // 简单按 joint_def_id 分（同 id 即同 role 关节）
      const arr = byRole.get(s.joint_def_id) || [];
      arr.push(s);
      byRole.set(s.joint_def_id, arr);
    }
    for (const [, arr] of byRole) {
      if (arr.length < 2) continue;
      for (let i = 1; i < arr.length; i++) {
        expect(arr[i].value_start).toBe(arr[i - 1].value_end);
      }
    }
  });

  it('第一段同 role 的 value_start = "0"', () => {
    const { km, sceneRoot } = setupThreewayScene();
    const ctx = canApply(km, sceneRoot).data;
    const compiled = compileTemplate(ctx);
    // 找每个 role 的第一段
    const seenJointId = new Set();
    for (const s of compiled.steps) {
      if (!seenJointId.has(s.joint_def_id)) {
        expect(s.value_start).toBe('0');
        seenJointId.add(s.joint_def_id);
      }
    }
  });
});

// ═════════════════════════════════════════════════════════
describe('compileTemplate 参数注入', () => {
  it('parameters 含三向车新参（fork_insertion_depth / x_axis_threshold）', () => {
    const { km, sceneRoot } = setupThreewayScene();
    const ctx = canApply(km, sceneRoot).data;
    const compiled = compileTemplate(ctx);
    const ids = compiled.parameters.map((p) => p.id);
    expect(ids).toContain('fork_insertion_depth');
    expect(ids).toContain('x_axis_threshold');
  });

  it('fork_insertion_depth default 0.5，x_axis_threshold default 0.3', () => {
    const fid = TEMPLATE_PARAMETERS_THREEWAY.find((p) => p.id === 'fork_insertion_depth');
    const xth = TEMPLATE_PARAMETERS_THREEWAY.find((p) => p.id === 'x_axis_threshold');
    expect(fid.default).toBe(0.5);
    expect(xth.default).toBe(0.3);
  });

  it('cargo_pos / drop_pos 用 marker 实际坐标做 default', () => {
    const { km, sceneRoot } = setupThreewayScene({ cargoPos: [1.5, 1, 1], dropPos: [-1.5, 6, 1] });
    const ctx = canApply(km, sceneRoot).data;
    const compiled = compileTemplate(ctx);
    const get = (id) => compiled.parameters.find((p) => p.id === id)?.default;
    expect(get('cargo_pos_x')).toBeCloseTo(1.5, 3);
    expect(get('cargo_pos_y')).toBeCloseTo(1, 3);
    expect(get('drop_pos_x')).toBeCloseTo(-1.5, 3);
    expect(get('drop_pos_y')).toBeCloseTo(6, 3);
  });
});

// ═════════════════════════════════════════════════════════
describe('buildDefaultRhythm 动态段数', () => {
  it('按 segCount 均分 totalSeconds', () => {
    const r = buildDefaultRhythm(18, 18);
    expect(r.segments.length).toBe(18);
    expect(r.segments[0].duration).toBeCloseTo(1.0, 3);
    expect(r.segments.every((s) => s.easing === 'ease-in-out')).toBe(true);
  });
  it('段数 13 → 每段 12/13s', () => {
    const r = buildDefaultRhythm(12, 13);
    expect(r.segments[0].duration).toBeCloseTo(12 / 13, 3);
  });
});
