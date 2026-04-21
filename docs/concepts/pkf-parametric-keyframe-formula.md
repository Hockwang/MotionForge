---
tags: [concepts, pkf, ai]
updated: 2026-04-18
---
# PKF：参数化关键帧公式

## 是什么

PKF（Parametric Keyframe Formula）是 MotionForge 的程序化动画系统，允许用**数学公式**代替手动关键帧来描述运动。它是 AI 生成动作的输出格式，也是用户可以手动编辑的动画描述语言。

## 数据结构

### Parameters（参数声明表）

```js
{
  id: string,       // 唯一标识（如 "pickup_point_x"）
  type: 'number' | 'vec3',
  unit: string,     // "m" / "deg" 等
  desc: string,     // 语义描述
  default: number | [x,y,z],
}
```

### Steps（驱动步骤列表）

```js
{
  id: string,
  joint: string,          // 关节名（按名字找，不用 UUID）
  joint_def_id: string,   // 运行时 UUID（从 joint name 解析而来）
  channel: 'position' | 'rotation',
  axis: 'x' | 'y' | 'z',
  t_start: number,        // 秒
  t_end: number,          // 秒
  value_start: string,    // 公式字符串（可引用 parameters 里的 id）
  value_end: string,      // 公式字符串
  easing: 'linear' | 'ease-in' | 'ease-out' | 'ease-in-out',
}
```

## 求值流程

`evaluatePkfAt(t)` 对每个 step：
- `t < t_start`：跳过（未开始，由上一步或默认值控制）
- `t_start ≤ t ≤ t_end`：`progress = easing((t - t_start) / (t_end - t_start))`，线性插值 `value_start` 到 `value_end`
- `t > t_end`：`progress = 1`（保持末态，不 return）— **重要**：已完成的 step 必须输出结果，否则循环时末态无人维护（bug #31）

公式字符串通过 `new Function` 求值，`parameters` 里的值作为变量注入。

## AI 生成架构（L1 + L2 两层）

PKF 生成有两条路径，底层都是 L2，但 L1 可以先把高级意图拆成时间表：

| 按钮 | 路径 | 说明 |
|------|------|------|
| 🚀 一键生成 | L1 → L2 串联 | 一句话生成完整动画（含 reparent 事件 + PKF + 自动切播放） |
| 🪄 仅拆解 | L1 only | 只生成时间表，用户检查后手动触发 L2 |
| AI 生成动作 | L2 only | 直接把自由文本/时间表发给 L2 生成 PKF |

**L1（`/api/decompose-intent`）**：高级意图（"去 cargo 取货放到 drop"）→ 结构化时间表 `rows[]` + `reparent_events[]`  
**L2（`/api/generate-pkf`）**：时间表每行 → PKF 公式（`parameters[]` + `steps[]`）

## 场景坐标注入

L1 和 L2 都接收 `scene[]`：sceneRoot 下所有命名对象的世界坐标（**已做 Y↔Z swap，Z-up 语义**）。AI 用它把 cargo/drop 的实际坐标注入 PKF 参数的 `default` 值，避免凭空编造距离。

见 [`docs/architecture/ai-pipeline.md`](../architecture/ai-pipeline.md) 了解完整流水线。

`role` 字段是 AI 匹配关节语义的关键：AI 按 role（"门架升降"/"叉齿前伸"）而非 axis 匹配，防止 AI 靠轴向硬猜选错关节（见 bug #29）。

## 相关文件

- [`src/core/KeyframeManager.js`](../../src/core/KeyframeManager.js) — `evaluatePkfAt`、`pkfParameters`、`pkfSteps`
- [`tools/conversion-service.js`](../../tools/conversion-service.js) — AI PKF 后端，`PKF_SYSTEM_PROMPT`
- [`src/main.js`](../../src/main.js) — `applyPkfAtTime`（每帧调用，先归零再应用）
