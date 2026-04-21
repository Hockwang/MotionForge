---
date: 2026-04-18
status: accepted
---
# FK 求解器用拓扑排序而非场景树顺序

## 背景

`applyAllJointDrives` 需要按正确顺序驱动所有关节——父关节必须先于子关节更新，否则子关节的 base 捕获和位置计算会用到父关节的旧状态。

## 考虑过的选项

1. **场景树深度优先**：直接 traverse，顺序由 Three.js 场景图决定
2. **Kahn's 拓扑排序**：按 `jointA.childId === jointB.parentId` 依赖关系排序，与场景树解耦

## 决定

使用 **Kahn's 拓扑排序**，以 jointDefinition 里的 `parentId/childId` 关系构建 DAG，每次 `applyAllJointDrives` 前排序。

## 理由

- Bug #8：门架和叉齿是场景树兄弟节点（平级），但逻辑上叉齿跟随门架。场景树顺序无法保证父先子后。
- Bug #10：场景树 reparent 后 `childObj.parent` 变了，依赖场景树的 FK 链断裂。改为 `nodeMap.get(def.parentId)` 后与场景树解耦。

## 后果

- `setJointDef` 设 `parentId` 时必须做环检测（否则拓扑排序死循环 → 见 bug #33，已加 cycle guard）
- FK 链关系存在 jointDefinition 里，不依赖场景树层级，可独立序列化/恢复
- 新增关节时如果 parentId 指向不存在的节点，拓扑排序结果可能不完整（会有 console.warn）

## 相关代码

- [`src/core/KeyframeManager.js`](../../src/core/KeyframeManager.js) — `applyAllJointDrives`（拓扑排序实现）、`setJointDef`（cycle guard）
