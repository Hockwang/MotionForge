/**
 * AI pipeline 集成测试（#65 REVIEW-v17 T2）
 *
 * 覆盖 [ensurePkfCoversAttachPoint](src/core/aiPipeline/ensurePkfCoversAttachPoint.js)：
 * 🚀 一键流程里最复杂的数据转换逻辑，负责 (1) sanitize AI 违规输出；(2) 自动补 step 防 attach teleport。
 *
 * 策略：纯数据测试。构造 PKF + ctx + stub keyframeManager，断言输出 shape + warnings。
 * 不测 fetch 调用（那是 UI 层接线）；这里只防 **算法层面** 的回归。
 */
import { describe, test, expect } from 'vitest';
import { ensurePkfCoversAttachPoint } from '../../src/core/aiPipeline/ensurePkfCoversAttachPoint.js';

// ══════════════════════════════════════════════════════════════
// 测试工具
// ══════════════════════════════════════════════════════════════

/**
 * Stub keyframeManager：只实现 ensurePkfCoversAttachPoint 用到的两个方法
 */
function stubKeyframeManager({ jointDefs = [], cargoSize = null } = {}) {
  return {
    getAllJointDefs: () => jointDefs,
    getCargoSizeParams: () => cargoSize,
  };
}

/**
 * 构造 attach 事件 + cargo + forkAnchorZero 三件套（绝大多数测试用例都需要）
 */
function buildAttachCtx({
  attachT = 3.5,
  cargoName = 'CargoBox',
  cargoPos = { x: 0, y: 0, z: 0 },
  forkAnchor = { fork_anchor_zero_x: 0, fork_anchor_zero_y: 0, fork_anchor_zero_z: 0 },
} = {}) {
  return {
    sceneList: [{ name: cargoName, position: cargoPos }],
    forkAnchorZero: forkAnchor,
    reparentEvents: [
      { event_id: 'ev1', t: attachT, child_name: cargoName, new_parent_name: 'Fork' },
    ],
  };
}

// ══════════════════════════════════════════════════════════════
// 组 1：sanitize AI 违规输出
// ══════════════════════════════════════════════════════════════

describe('ensurePkfCoversAttachPoint: sanitize 逻辑', () => {
  test('approach_gap.default 非 0 → 强制归 0 + warning', () => {
    const pkf = {
      parameters: [
        { id: 'approach_gap', type: 'number', default: 0.3 }, // AI 违规
        { id: 'lift_h', type: 'number', default: 1.5 },
      ],
      steps: [],
    };
    const result = ensurePkfCoversAttachPoint(pkf, {}, stubKeyframeManager());

    const ap = result.parameters.find((p) => p.id === 'approach_gap');
    expect(ap.default).toBe(0);
    expect(result.warnings.some((w) => /approach_gap/.test(w) && /0\.3.*0/.test(w))).toBe(true);
  });

  test('approach_gap.default 已是 0 → 不动 + 不 warning', () => {
    const pkf = {
      parameters: [{ id: 'approach_gap', default: 0 }],
      steps: [],
    };
    const result = ensurePkfCoversAttachPoint(pkf, {}, stubKeyframeManager());
    expect(result.warnings.some((w) => /approach_gap/.test(w))).toBe(false);
  });

  test('清洗 `fork_anchor_zero_x - 0.1` → `fork_anchor_zero_x`', () => {
    const pkf = {
      parameters: [],
      steps: [
        { joint: 'CarBody', value_start: '0', value_end: 'fork_anchor_zero_x - 0.1' },
      ],
    };
    const result = ensurePkfCoversAttachPoint(pkf, {}, stubKeyframeManager());
    expect(result.steps[0].value_end).toBe('fork_anchor_zero_x');
    expect(result.warnings.some((w) => /清洗/.test(w))).toBe(true);
  });

  test('保留合法 `fork_anchor_zero_x + approach_gap`（参数名不是裸数字）', () => {
    const pkf = {
      parameters: [{ id: 'approach_gap', default: 0 }],
      steps: [
        { joint: 'CarBody', value_start: '0', value_end: 'fork_anchor_zero_x + approach_gap' },
      ],
    };
    const result = ensurePkfCoversAttachPoint(pkf, {}, stubKeyframeManager());
    expect(result.steps[0].value_end).toBe('fork_anchor_zero_x + approach_gap'); // 原样保留
  });

  test('混合情况：`fork_anchor_zero_y - 0.05 + approach_gap` → `fork_anchor_zero_y + approach_gap`', () => {
    const pkf = {
      parameters: [{ id: 'approach_gap', default: 0 }],
      steps: [
        { joint: 'CarBody', value_start: '0', value_end: 'fork_anchor_zero_y - 0.05 + approach_gap' },
      ],
    };
    const result = ensurePkfCoversAttachPoint(pkf, {}, stubKeyframeManager());
    expect(result.steps[0].value_end).toBe('fork_anchor_zero_y + approach_gap');
  });

  test('多处清洗 warning 显示前 3 个 + 省略号', () => {
    const pkf = {
      parameters: [],
      steps: [
        { joint: 'A', value_end: 'fork_anchor_zero_x - 0.1' },
        { joint: 'B', value_end: 'fork_anchor_zero_y - 0.2' },
        { joint: 'C', value_end: 'fork_anchor_zero_z - 0.3' },
        { joint: 'D', value_end: 'fork_anchor_zero_x - 0.4' },
      ],
    };
    const result = ensurePkfCoversAttachPoint(pkf, {}, stubKeyframeManager());
    const w = result.warnings.find((m) => /清洗/.test(m));
    expect(w).toContain('4 处');
    expect(w).toContain('...'); // 超过 3 个显示省略号
  });
});

// ══════════════════════════════════════════════════════════════
// 组 2：自动补 step —— 跳过条件
// ══════════════════════════════════════════════════════════════

describe('ensurePkfCoversAttachPoint: 跳过条件', () => {
  test('无 attach event（reparent 全是 detach=null）→ 不注入', () => {
    const pkf = { parameters: [], steps: [] };
    const ctx = {
      sceneList: [],
      forkAnchorZero: { fork_anchor_zero_x: 0, fork_anchor_zero_y: 0, fork_anchor_zero_z: 0 },
      reparentEvents: [
        { t: 5, child_name: 'Cargo', new_parent_name: null }, // detach only
      ],
    };
    const result = ensurePkfCoversAttachPoint(pkf, ctx, stubKeyframeManager());
    expect(result.steps).toEqual([]);
  });

  test('cargo 在 sceneList 里找不到 → 不注入', () => {
    const pkf = { parameters: [], steps: [] };
    const ctx = buildAttachCtx({ cargoName: 'Missing' });
    ctx.sceneList = [{ name: 'OtherBox', position: { x: 0, y: 0, z: 0 } }];
    const result = ensurePkfCoversAttachPoint(pkf, ctx, stubKeyframeManager());
    expect(result.steps).toEqual([]);
  });

  test('forkAnchorZero 任一轴 undefined → 不注入', () => {
    const pkf = { parameters: [], steps: [] };
    const ctx = buildAttachCtx({ forkAnchor: { fork_anchor_zero_x: 0, fork_anchor_zero_y: 0 } });
    const result = ensurePkfCoversAttachPoint(pkf, ctx, stubKeyframeManager());
    expect(result.steps).toEqual([]);
  });

  test('三维位移都 < 5cm 阈值 → 不注入', () => {
    const pkf = { parameters: [], steps: [] };
    const ctx = buildAttachCtx({
      cargoPos: { x: 0.02, y: 0.03, z: 0.01 }, // 全部 < 0.05
    });
    const jointDefs = [
      { name: 'CarBody', type: 'prismatic', axis: 'y', role: '车体前进' },
      { name: 'Mast', type: 'prismatic', axis: 'z', role: '门架升降' },
    ];
    const result = ensurePkfCoversAttachPoint(pkf, ctx, stubKeyframeManager({ jointDefs }));
    expect(result.steps).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════
// 组 3：自动补 step —— 注入行为
// ══════════════════════════════════════════════════════════════

describe('ensurePkfCoversAttachPoint: 注入 step', () => {
  test('y 方向超阈值 + 有车体前进关节 → 注入 translate step', () => {
    const pkf = { parameters: [], steps: [] };
    const ctx = buildAttachCtx({
      attachT: 3.0,
      cargoPos: { x: 0, y: 2.5, z: 0 },
    });
    const jointDefs = [
      { name: 'CarBody', type: 'prismatic', axis: 'y', role: '车体前进' },
    ];
    const result = ensurePkfCoversAttachPoint(pkf, ctx, stubKeyframeManager({ jointDefs }));

    expect(result.steps).toHaveLength(1);
    const step = result.steps[0];
    expect(step.joint).toBe('CarBody');
    expect(step.channel).toBe('translate');
    expect(step.axis).toBe('y');
    expect(step.t_start).toBe(0);
    expect(step.t_end).toBe(3.0);
    expect(step.value_start).toBe('0');
    expect(Number(step.value_end)).toBeCloseTo(2.5);
  });

  test('三维都超阈值 + 所有 role 齐全 → 注入 3 个 step', () => {
    const pkf = { parameters: [], steps: [] };
    const ctx = buildAttachCtx({
      cargoPos: { x: 1.0, y: 2.0, z: 0.8 },
    });
    const jointDefs = [
      { name: 'CarBody', type: 'prismatic', axis: 'y', role: '车体前进' },
      { name: 'SideShift', type: 'prismatic', axis: 'x', role: '车体横移' },
      { name: 'Mast', type: 'prismatic', axis: 'z', role: '门架升降' },
    ];
    const result = ensurePkfCoversAttachPoint(pkf, ctx, stubKeyframeManager({ jointDefs }));

    expect(result.steps).toHaveLength(3);
    const joints = new Set(result.steps.map((s) => s.joint));
    expect(joints).toEqual(new Set(['CarBody', 'SideShift', 'Mast']));
  });

  test('缺 role 关节 → warning 而非抛错', () => {
    const pkf = { parameters: [], steps: [] };
    const ctx = buildAttachCtx({
      cargoPos: { x: 0, y: 2.0, z: 0 },
    });
    // jointDefs 空 → 找不到 role=车体前进
    const result = ensurePkfCoversAttachPoint(pkf, ctx, stubKeyframeManager({ jointDefs: [] }));

    expect(result.steps).toEqual([]);
    const w = result.warnings.find((m) => m.includes('缺 role=车体前进'));
    expect(w).toBeDefined();
    expect(w).toMatch(/y 方向.*2\.00m/);
  });

  test('AI 已覆盖 y 方向（t_end <= attachT）→ 不重复注入', () => {
    const pkf = {
      parameters: [],
      steps: [
        // AI 自己写了 CarBody 在 attachT 之前到位
        { joint: 'CarBody', channel: 'translate', axis: 'y', t_start: 0, t_end: 2.0, value_start: '0', value_end: '2.5' },
      ],
    };
    const ctx = buildAttachCtx({
      attachT: 3.0,
      cargoPos: { x: 0, y: 2.5, z: 0 },
    });
    const jointDefs = [
      { name: 'CarBody', type: 'prismatic', axis: 'y', role: '车体前进' },
    ];
    const result = ensurePkfCoversAttachPoint(pkf, ctx, stubKeyframeManager({ jointDefs }));

    // 还是只有 1 个 step（AI 自己那个）
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].t_end).toBe(2.0); // AI 的那个没被覆盖
  });

  test('cargo_height 从 cargoSize 读 → z 公式减半高（让 cargo 底面对齐）', () => {
    const pkf = { parameters: [], steps: [] };
    const ctx = buildAttachCtx({
      attachT: 3.0,
      cargoPos: { x: 0, y: 0, z: 1.0 }, // cargo 中心 z=1.0
    });
    const jointDefs = [
      { name: 'Mast', type: 'prismatic', axis: 'z', role: '门架升降' },
    ];
    // cargo 高度 0.6 → 半高 0.3 → target_z = 1.0 - 0.3 - 0 = 0.7
    const km = stubKeyframeManager({ jointDefs, cargoSize: { cargo_height: 0.6 } });
    const result = ensurePkfCoversAttachPoint(pkf, ctx, km);

    expect(result.steps).toHaveLength(1);
    expect(Number(result.steps[0].value_end)).toBeCloseTo(0.7);
  });

  test('approach_gap 非 0 时 y 公式减 gap（但 sanitize 会归零，验证计算用归零后的值）', () => {
    const pkf = {
      parameters: [{ id: 'approach_gap', default: 0.5 }], // 会被 sanitize 归 0
      steps: [],
    };
    const ctx = buildAttachCtx({
      cargoPos: { x: 0, y: 2.0, z: 0 },
    });
    const jointDefs = [
      { name: 'CarBody', type: 'prismatic', axis: 'y', role: '车体前进' },
    ];
    const result = ensurePkfCoversAttachPoint(pkf, ctx, stubKeyframeManager({ jointDefs }));

    // approach_gap 被 sanitize 归 0 → target_y = 2.0 - 0 - 0 = 2.0
    expect(Number(result.steps[0].value_end)).toBeCloseTo(2.0);
  });

  test('revolute 关节 → channel=rotate', () => {
    const pkf = { parameters: [], steps: [] };
    const ctx = buildAttachCtx({
      cargoPos: { x: 0.5, y: 0, z: 0 },
    });
    const jointDefs = [
      { name: 'Turntable', type: 'revolute', axis: 'z', role: '车体横移' },
    ];
    const result = ensurePkfCoversAttachPoint(pkf, ctx, stubKeyframeManager({ jointDefs }));
    expect(result.steps[0].channel).toBe('rotate');
  });
});

// ══════════════════════════════════════════════════════════════
// 组 4：边界输入
// ══════════════════════════════════════════════════════════════

describe('ensurePkfCoversAttachPoint: 边界', () => {
  test('pkf=null 返回 null 不抛', () => {
    expect(ensurePkfCoversAttachPoint(null, {}, stubKeyframeManager())).toBe(null);
  });

  test('pkf=undefined 返回 undefined 不抛', () => {
    expect(ensurePkfCoversAttachPoint(undefined, {}, stubKeyframeManager())).toBe(undefined);
  });

  test('pkf.steps 缺失 → 自动初始化为数组', () => {
    const pkf = { parameters: [] }; // 没有 steps 字段
    const ctx = buildAttachCtx({
      cargoPos: { x: 0, y: 2.0, z: 0 },
    });
    const jointDefs = [
      { name: 'CarBody', type: 'prismatic', axis: 'y', role: '车体前进' },
    ];
    const result = ensurePkfCoversAttachPoint(pkf, ctx, stubKeyframeManager({ jointDefs }));
    expect(Array.isArray(result.steps)).toBe(true);
    expect(result.steps).toHaveLength(1);
  });

  test('keyframeManager=null → 不抛，只是找不到关节时 warning', () => {
    const pkf = { parameters: [], steps: [] };
    const ctx = buildAttachCtx({
      cargoPos: { x: 0, y: 2.0, z: 0 },
    });
    const result = ensurePkfCoversAttachPoint(pkf, ctx, null);
    expect(result.steps).toEqual([]);
    expect(result.warnings.some((w) => /缺 role/.test(w))).toBe(true);
  });
});
