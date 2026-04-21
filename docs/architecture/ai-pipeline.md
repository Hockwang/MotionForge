---
tags: [architecture, ai, pkf, l1, l2]
updated: 2026-04-18
---
# AI 动作生成流水线

## 两层架构

MotionForge 的 AI 动作生成分两层：

| 层 | 名称 | 输入 | 输出 | API 端点 |
|----|------|------|------|---------|
| L1 | 意图拆解 | 一句自然语言（"去 cargo 取货放到 drop"）+ 关节列表 + 场景坐标 | 时间表 `rows[]` + `reparent_events[]` + `warnings[]` | `/api/decompose-intent` |
| L2 | PKF 生成 | 时间表（表格行：时间区间 + 操作描述）+ 关节列表 + 场景坐标 | `{ parameters[], steps[] }` PKF 格式 | `/api/generate-pkf` |

L1 负责"把人说的话翻译成结构化时间表"，L2 负责"把时间表每行翻译成精确的数学公式驱动"。

## 两条用户路径

### 🚀 一键生成完整动画（`aiOneshotBtn`）

`L1 → 应用 reparent → L2 → 设置 clip duration → 切 PKF 播放模式`

```
用户输入高级意图
  → collectSceneForAi()   // 场景对象世界坐标（Y↔Z swap 后，Z-up）
  → POST /api/decompose-intent { intent, scene, joints }
    ← { rows[], reparent_events[], warnings[] }
  → 应用 reparent_events 到 keyframeManager
  → 填充 AI 时间表（ui.setAiTableRows）
  → POST /api/generate-pkf { prompt: 表格内容, joints, scene }
    ← { parameters[], steps[] }
  → applyAiPkf()         // 写入 pkfParameters + pkfSteps
  → 设 clip duration = max(t_end) + 0.5s
  → pkfPlaybackMode = true
```

见 `src/main.js:1290-1402`。

### 🪄 仅拆解（`aiDecomposeBtn`）

只运行 L1，结果填到时间表，用户手动检查后再点"AI 生成动作"运行 L2。

## 场景坐标注入

AI 收到的 `scene[]` 包含 sceneRoot 下所有命名对象的世界坐标，**已做 Y↔Z swap**（Z-up 语义）：

```js
// src/main.js collectSceneForAi
{ name: o.name, position: { x: wp.x, y: wp.z, z: wp.y } }
```

AI 用这些坐标解析 `"去 cargo"` / `"@cargo_01"` 类引用，把 cargo/drop 的实际世界坐标注入 PKF 参数的 `default` 值，避免 AI 凭空编造距离。

注意：`aiDecomposeBtn` 的旧实现（`src/main.js:1252`）直接传 Y-up 坐标（未 swap），这是一个已知 bug，可能在未来修复。一键生成路径通过 `collectSceneForAi()` 走已修复版本。

## L1 输出格式

```json
{
  "rows": [
    { "time": "0-3s", "action": "门架升到 cargo 高度" },
    { "time": "3-5s", "action": "叉齿前伸插入货物" }
  ],
  "reparent_events": [
    { "t": 5.0, "child_name": "cargo_01", "new_parent_name": "_CS198" },
    { "t": 10.0, "child_name": "cargo_01", "new_parent_name": null }
  ],
  "warnings": ["模型没有'车体前进'关节，无法生成平移"]
}
```

## clip duration 自动设置

AI 生成 PKF 后，clip duration 自动设为 `max(step.t_end) + 0.5`（防止循环边界瞬跳——若 duration 等于 max(t_end)，循环回 t=0 时最后一帧的末态会有一帧暴露）。

见 `src/main.js:1217`（applyAiPkf 调用处）和 oneshot handler。

## 相关文件

- [`src/main.js:1132`](../../src/main.js) — `collectSceneForAi`（坐标采集，含 swap）
- [`src/main.js:1238`](../../src/main.js) — L1 单独拆解按钮
- [`src/main.js:1290`](../../src/main.js) — 🚀 一键生成完整流程
- [`tools/conversion-service.js`](../../tools/conversion-service.js) — `/api/decompose-intent`（L1）和 `/api/generate-pkf`（L2）实现
- [`docs/gotchas/006-coordinate-swap-forgotten.md`](../gotchas/006-coordinate-swap-forgotten.md) — 坐标 swap 漏做的坑
