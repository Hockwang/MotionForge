---
date: 2026-04-18
severity: high
---
# 懒捕获 base 必须在零位态发生，驱动态下捕获导致链式关节整体漂移

## 症状

导入后播放动画，多个链式关节零件整体下沉相同距离（例如都下降 1.52 单位）。诊断脚本 `__diagA.scanClip()` 显示 4 个节点 Y 变化范围完全相同，等于父级关节的位移量。

## 根因

`applyJointDrive` 里的懒捕获逻辑：当 `def.baseTransform === null` 时，从当前节点的 world transform 反算 base 并存储。如果此时父级关节**已处于驱动态**（非零 value），捕获的 base 就包含了父级位移，形成错误的零位参考。

后续动画把父级改回零位 → 子级相对下沉父级的位移量，造成整体漂移。

## 解决方案

任何需要重建 base 的操作前，必须确保所有父级关节已归零：
1. 先把所有 `currentValue = 0`
2. `applyAllJointDrives()` → 懒捕获发生在零位
3. 再恢复真实 value 并重新驱动

见 [`docs/decisions/007-two-phase-joint-import.md`](../decisions/007-two-phase-joint-import.md)。

## 相关代码

- [`src/core/KeyframeManager.js`](../../src/core/KeyframeManager.js) — `applyJointDrive` 懒捕获分支（`if (!def.baseTransform)`）
- [`src/main.js`](../../src/main.js) — `handleImportPackage` 两阶段实现

## 相关 bug

#22（链式关节导入后整体下沉）、#2（新关节飞走）、#3（reparent 后飞走）
