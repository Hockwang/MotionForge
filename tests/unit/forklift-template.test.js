/**
 * 叉车取放 14 段模板编译器测试（mvp3 Phase A）
 *
 * 覆盖契约（docs/concepts/forklift-pickup-template.md）：
 *  1. buildDefaultRhythm 默认节奏形状
 *  2. collectTemplateContext 缺要素报错
 *  3. collectTemplateContext 完整场景返回 ctx
 *  4. compileTemplate 14 段 / 2 个 reparent 事件
 *  5. compileTemplate 参数注入（新 4 个 + 标准 cargo_pos / drop_pos / fork_anchor_zero）
 *  6. compileTemplate reparent 时间和段 3/11 t_end 对齐
 *  7. compileTemplate 关键公式正确（段 2/3/4/9/11）
 *  8. compileTemplate value_start 从上一段同 role 的 value_end 级联
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { KeyframeManager } from '../../src/core/KeyframeManager.js';
import {
  FORKLIFT_TEMPLATE,
  FORKLIFT_TEMPLATE_VERSION,
  TEMPLATE_PARAMETERS,
  buildDefaultRhythm,
  collectTemplateContext,
  compileTemplate,
  ROLE_CAR_FORWARD,
  ROLE_MAST_LIFT,
} from '../../src/core/ForkliftTemplate.js';

// ── 辅助：构造模板编译所需的最小可行 KeyframeManager + sceneRoot ──
function setupScene({ cargoPos = [0, 0, 0.5], dropPos = [0, 5, 0] } = {}) {
  const km = new KeyframeManager();

  // marker
  km.addMarker({ name: 'cargo', type: 'cargo', size: { w: 0.8, h: 0.6, d: 0.8 } });
  km.addMarker({ name: 'drop', type: 'drop' });

  // role 关节
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
  });

  // 预设一条 attach reparent event（给模板提供 fork 名字）
  km.addReparentEvent(2.0, 'cargo', 'fork_tine');

  // scene root：两个命名对象（UI 传的是 UI 空间坐标，内部存 threejs Y-up → 这里坐标约定是 UI）
  // UI (x, y, z) → threejs (x, z, y)
  const sceneRoot = new THREE.Object3D();
  sceneRoot.name = 'root';

  const cargoObj = new THREE.Object3D();
  cargoObj.name = 'cargo';
  cargoObj.position.set(cargoPos[0], cargoPos[2], cargoPos[1]); // UI→threejs swap
  sceneRoot.add(cargoObj);

  const dropObj = new THREE.Object3D();
  dropObj.name = 'drop';
  dropObj.position.set(dropPos[0], dropPos[2], dropPos[1]);
  sceneRoot.add(dropObj);

  // fork_tine 对象也加一个（作为 reparent target 的存在性检查；模板不读其位置）
  const forkObj = new THREE.Object3D();
  forkObj.name = 'fork_tine';
  sceneRoot.add(forkObj);

  sceneRoot.updateMatrixWorld(true);
  return { km, sceneRoot };
}

// ═══════════════════════════════════════════════════════════════
describe('buildDefaultRhythm', () => {
  it('返回 14 段均分节奏，总时长匹配参数', () => {
    const rhythm = buildDefaultRhythm(14); // 14 秒 → 每段 1 秒
    expect(rhythm.segments.length).toBe(14);
    expect(rhythm.segments[0].duration).toBeCloseTo(1, 3);
    const total = rhythm.segments.reduce((s, seg) => s + seg.duration, 0);
    expect(total).toBeCloseTo(14, 2);
  });

  it('所有段都是 ease-in-out', () => {
    const rhythm = buildDefaultRhythm();
    rhythm.segments.forEach((s) => {
      expect(s.easing).toBe('ease-in-out');
    });
  });

  it('段 index 覆盖 1–14', () => {
    const rhythm = buildDefaultRhythm();
    const indices = rhythm.segments.map((s) => s.index).sort((a, b) => a - b);
    expect(indices).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
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
    // 删除 cargo marker
    const ids = [...km.sceneMarkers.entries()]
      .filter(([, m]) => m.type === 'cargo')
      .map(([id]) => id);
    ids.forEach((id) => km.removeMarker(id));
    const r = collectTemplateContext(km, sceneRoot);
    expect(r.ok).toBe(false);
    expect(r.missing).toContain('cargo marker（货物占位）');
  });

  it('缺 attach 事件 → 不通过', () => {
    const { km, sceneRoot } = setupScene();
    // 删掉 attach 事件
    km.getReparentEvents().forEach((e) => km.removeReparentEvent(e.event_id));
    const r = collectTemplateContext(km, sceneRoot);
    expect(r.ok).toBe(false);
    expect(r.missing.some((m) => m.includes('attach'))).toBe(true);
  });

  it('缺 role=门架升降 关节', () => {
    const { km, sceneRoot } = setupScene();
    // 把 mast 关节删掉
    km.jointDefinitions.delete('mast_joint_id');
    const r = collectTemplateContext(km, sceneRoot);
    expect(r.ok).toBe(false);
    expect(r.missing.some((m) => m.includes(ROLE_MAST_LIFT))).toBe(true);
  });

  it('完整场景 → ok=true 且带全部字段', () => {
    const { km, sceneRoot } = setupScene({ cargoPos: [1, 5, 0.6], dropPos: [2, 10, 0.3] });
    const r = collectTemplateContext(km, sceneRoot);
    expect(r.ok).toBe(true);
    expect(r.data.cargoName).toBe('cargo');
    expect(r.data.dropName).toBe('drop');
    expect(r.data.forkName).toBe('fork_tine');
    // UI Z-up：x/y/z 分别是左右 / 前后 / 高度；setupScene 按 UI 坐标喂入
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
});

// ═══════════════════════════════════════════════════════════════
describe('compileTemplate 结构', () => {
  let ctx;
  beforeEach(() => {
    const { km, sceneRoot } = setupScene({ cargoPos: [0, 5, 0.6], dropPos: [0, 10, 0.5] });
    ctx = collectTemplateContext(km, sceneRoot).data;
  });

  it('生成 14 步 + 2 个 reparent 事件', () => {
    const compiled = compileTemplate(ctx);
    expect(compiled.steps.length).toBe(14);
    expect(compiled.reparent_events.length).toBe(2);
  });

  it('meta.template_version 正确写入', () => {
    const compiled = compileTemplate(ctx);
    expect(compiled.meta.template_version).toBe(FORKLIFT_TEMPLATE_VERSION);
  });

  it('attach 事件在段 3 t_end，detach 在段 11 t_end', () => {
    const compiled = compileTemplate(ctx, buildDefaultRhythm(14));
    const attach = compiled.reparent_events.find((e) => e.new_parent_name);
    const detach = compiled.reparent_events.find((e) => e.new_parent_name === null);

    // 均分 14s 每段 1s，段 3 t_end = 3s，段 11 t_end = 11s
    expect(attach.t).toBeCloseTo(3, 2);
    expect(attach.child_name).toBe('cargo');
    expect(attach.new_parent_name).toBe('fork_tine');

    expect(detach.t).toBeCloseTo(11, 2);
    expect(detach.child_name).toBe('cargo');
    expect(detach.new_parent_name).toBe(null);
  });

  it('总时长 = 各段时长之和', () => {
    const rhythm = buildDefaultRhythm(7); // 7 秒 → 每段 0.5s
    const compiled = compileTemplate(ctx, rhythm);
    expect(compiled.meta.total_duration).toBeCloseTo(7, 2);
  });

  it('段 t_start 严格串行等于前段 t_end', () => {
    const compiled = compileTemplate(ctx);
    for (let i = 1; i < compiled.steps.length; i++) {
      expect(compiled.steps[i].t_start).toBeCloseTo(compiled.steps[i - 1].t_end, 3);
    }
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
    const { km, sceneRoot } = setupScene({ cargoPos: [0, 5, 0.6], dropPos: [0, 10, 0.3] });
    ctx = collectTemplateContext(km, sceneRoot).data;
  });

  it('段 2 抬叉：公式 = cargo_bottom + fork_offset - clearance - anchor', () => {
    const compiled = compileTemplate(ctx);
    const seg2 = compiled.steps[1];
    expect(seg2.value_end).toBe('cargo_pos_z - cargo_height / 2 + cargo_fork_height - lift_clearance - fork_anchor_zero_z');
    expect(seg2.joint).toBe('mast_lift');
  });

  it('段 3 插齿：attach 触发段；公式 = cargo_pos_y - anchor', () => {
    const compiled = compileTemplate(ctx);
    const seg3 = compiled.steps[2];
    expect(seg3.value_end).toBe('cargo_pos_y - fork_anchor_zero_y');
    expect(seg3.joint).toBe('car_forward');
  });

  it('段 4 取货：公式 = 段 2 基础上去掉 -lift_clearance（顶起 clearance）', () => {
    const compiled = compileTemplate(ctx);
    const seg4 = compiled.steps[3];
    expect(seg4.value_end).toBe('cargo_pos_z - cargo_height / 2 + cargo_fork_height - fork_anchor_zero_z');
  });

  it('段 9 放货前抬叉：公式 = drop_pos_z + cargo_fork_height - anchor', () => {
    const compiled = compileTemplate(ctx);
    const seg9 = compiled.steps[8];
    expect(seg9.value_end).toBe('drop_pos_z + cargo_fork_height - fork_anchor_zero_z');
  });

  it('段 11 放货：detach 触发段；公式 = 段 9 - lift_clearance', () => {
    const compiled = compileTemplate(ctx);
    const seg11 = compiled.steps[10];
    expect(seg11.value_end).toBe('drop_pos_z + cargo_fork_height - lift_clearance - fork_anchor_zero_z');
    expect(seg11.joint).toBe('mast_lift');
  });

  it('段 1 接近：公式 = cargo_pos_y - anchor - safe_distance', () => {
    const compiled = compileTemplate(ctx);
    const seg1 = compiled.steps[0];
    expect(seg1.value_end).toBe('cargo_pos_y - fork_anchor_zero_y - safe_distance');
  });

  it('段 13/14 复位：公式 = 0', () => {
    const compiled = compileTemplate(ctx);
    expect(compiled.steps[12].value_end).toBe('0'); // 段 13 门架复位
    expect(compiled.steps[13].value_end).toBe('0'); // 段 14 车体返回
  });
});

// ═══════════════════════════════════════════════════════════════
describe('compileTemplate value_start 级联', () => {
  let ctx;
  beforeEach(() => {
    const { km, sceneRoot } = setupScene();
    ctx = collectTemplateContext(km, sceneRoot).data;
  });

  it('第一段 value_start = "0"', () => {
    const compiled = compileTemplate(ctx);
    expect(compiled.steps[0].value_start).toBe('0');
  });

  it('后续段 value_start = 同 role 上一段的 value_end', () => {
    const compiled = compileTemplate(ctx);
    // 段 3（车体前进）value_start 应该等于段 1（车体前进）的 value_end
    const seg1 = compiled.steps[0];
    const seg3 = compiled.steps[2];
    expect(seg3.value_start).toBe(seg1.value_end);

    // 段 4（门架升降）value_start 应该等于段 2（门架升降）的 value_end
    const seg2 = compiled.steps[1];
    const seg4 = compiled.steps[3];
    expect(seg4.value_start).toBe(seg2.value_end);

    // 段 5（门架升降）value_start = 段 4 的 value_end
    const seg5 = compiled.steps[4];
    expect(seg5.value_start).toBe(seg4.value_end);
  });

  it('车体前进与门架升降各自独立级联（不会串扰）', () => {
    const compiled = compileTemplate(ctx);
    // 段 6（车体前进）的 value_start = 段 3 的 value_end（不应该是段 5 门架的 value_end）
    const seg3 = compiled.steps[2];
    const seg6 = compiled.steps[5];
    expect(seg6.value_start).toBe(seg3.value_end);
  });
});

// ═══════════════════════════════════════════════════════════════
describe('FORKLIFT_TEMPLATE 数据一致性', () => {
  it('index 严格递增 1–14', () => {
    FORKLIFT_TEMPLATE.forEach((seg, i) => {
      expect(seg.index).toBe(i + 1);
    });
  });

  it('role 只使用定义的两种角色', () => {
    FORKLIFT_TEMPLATE.forEach((seg) => {
      expect([ROLE_CAR_FORWARD, ROLE_MAST_LIFT]).toContain(seg.role);
    });
  });

  it('reparent 事件恰好在段 3 attach 和段 11 detach', () => {
    const reparents = FORKLIFT_TEMPLATE.filter((s) => s.reparent);
    expect(reparents.length).toBe(2);
    expect(reparents.find((s) => s.reparent === 'attach').index).toBe(3);
    expect(reparents.find((s) => s.reparent === 'detach').index).toBe(11);
  });

  it('公式字符串非空', () => {
    FORKLIFT_TEMPLATE.forEach((seg) => {
      expect(typeof seg.formula).toBe('string');
      expect(seg.formula.length).toBeGreaterThan(0);
    });
  });
});
