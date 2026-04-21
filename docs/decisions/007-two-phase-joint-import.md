---
date: 2026-04-18
status: accepted
---
# 导入时两阶段应用关节（先零位捕获 base，再恢复驱动值）

## 背景

导入 ZIP 包后需要恢复关节状态。关节的 `baseTransform`（零位时的 parent-local 变换）依赖懒捕获：第一次 `applyJointDrive` 时如果 base 为 null，从当前状态反算并存储。

## 考虑过的选项

1. **直接用 JSON 里的 currentValue 驱动**：一次性 `applyAllJointDrives`
2. **两阶段**：先全零驱动（让所有节点懒捕获 base），再恢复真实 value 再驱动

## 决定

**两阶段应用**：
1. 把所有关节 `currentValue = 0`
2. `applyAllJointDrives()` → 所有关节在零位状态懒捕获 base
3. 恢复真实 `currentValue`
4. 再次 `applyAllJointDrives()` → 正常驱动到目标位置

## 理由

Bug #22：导入时直接用非零 value 驱动，拓扑排序先驱动父级 → 父级移动 → 子级在父级已驱动态下懒捕获 base。动画把父级改回零位后，子级相对下沉父级的位移量（诊断：4 个节点 Y 变化范围相同，等于父级位移）。

懒捕获 base 必须在"所有父级关节都是零位"时发生，这是整个 FK 系统的核心不变量。

## 后果

- 导入流程有两次全量 `applyAllJointDrives` 调用，性能略有影响（可接受，导入是一次性操作）
- 任何需要重建 base 的场景（reparent / 新关节 / 导入）都需要遵守这个顺序
- `rebindJointBaseTransform` 在 reparent 后清空 base，原理相同

## 相关代码

- [`src/main.js`](../../src/main.js) — `handleImportPackage` 两阶段应用逻辑
- [`src/core/KeyframeManager.js`](../../src/core/KeyframeManager.js) — `applyJointDrive` 懒捕获逻辑
