---
tags: [architecture, fk, joints]
updated: 2026-04-18
---
# FK 关节系统

## 数据结构

每个关节定义（`jointDefinition`）存在 `KeyframeManager.jointDefinitions`（`Map<nodeUuid, def>`）：

```js
{
  id: string,           // nodeUuid（运行时 Three.js UUID）
  name: string,         // 关节名（跨 roundtrip 的稳定标识）
  type: 'revolute' | 'prismatic' | 'fixed' | 'none',
  axis: 'x' | 'y' | 'z',  // UI Z-up 坐标系
  limits: { min, max },
  parentId: string,     // joint parent 的 Three.js UUID（≠ scene graph parent）
  childId: string,      // 被驱动节点的 UUID
  currentValue: number, // 当前驱动值（角度°或米）
  role: string,         // 语义角色（"门架升降"/"叉齿前伸"等），供 AI PKF 用
  baseTransform: {      // 零位姿态，parent-local 空间，四元数旋转
    tx, ty, tz,         // position（parent-local）
    qx, qy, qz, qw,    // quaternion（parent-local）
    sx, sy, sz,         // scale
  } | null,             // null 时触发懒捕获
  origin: { x, y, z }, // 关节旋转/平移中心，parent-local 空间（UI Z-up）
}
```

## 求解流程

每帧调用 `applyAllJointDrives()`：

1. **拓扑排序**（Kahn's algorithm）：按 `parentId → childId` 依赖关系，确保父关节先于子关节更新
2. 对每个关节按序调用 `applyJointDrive(def)`：
   - 如果 `def.baseTransform === null`：**懒捕获**——从当前 child world transform 反算 parent-local base，存入 def（必须在零位态触发，见 [gotcha-002](../gotchas/002-lazy-base-capture-timing.md)）
   - 根据 `type` 计算新的 child world transform：
     - `revolute`：base 四元数 × 绕轴旋转 value°
     - `prismatic`：base 位置 + 沿轴方向位移 value 米（世界空间计算）
     - `fixed`：直接用 base（跟随 joint parent，无自由度）
   - 把新 world transform 写回 Three.js 节点

## 环检测

`setJointDef` 设 `parentId` 时，从目标 parent 沿链向上遍历，若碰到自身则拒绝并 `console.warn`。防止 Kahn's 算法因成环而静默失效（bug #33）。

## 相关文件

- [`src/core/KeyframeManager.js`](../../src/core/KeyframeManager.js) — 全部实现
- [`docs/decisions/003-topology-sorted-fk-solver.md`](../decisions/003-topology-sorted-fk-solver.md)
- [`docs/decisions/001-quaternion-base-transform.md`](../decisions/001-quaternion-base-transform.md)
- [`docs/decisions/002-parent-local-origin.md`](../decisions/002-parent-local-origin.md)
