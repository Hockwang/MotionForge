---
date: 2026-04-18
severity: medium
---
# 四元数双重覆盖导致旋转角度跳变 360°

## 症状

拖动旋转 Gizmo 到某个大角度后继续拖，关节角度瞬间跳变 360°（逆时针拖到 ~180° 时突然变成 -180°）。

## 根因

四元数双重覆盖：`q` 和 `-q` 表示同一旋转。`TransformControls` 在大角度时会把当前四元数归一化到"最短路径"表示，触发符号翻转（q → -q）。提取角度时 `2 * atan2(sinHalf, cosHalf)` 因符号翻转而跳变 ±2π。

## 解决方案

角度**解缠（unwrapping）**：保持相邻帧 angle 差值 ≤ π，超过就加减 2π 补偿。每次新拖拽（`mousedown`）时重置 `_gizmoLastAngle = undefined`。

```js
if (this._gizmoLastAngle !== undefined) {
  while (angle - this._gizmoLastAngle > Math.PI) angle -= 2 * Math.PI;
  while (angle - this._gizmoLastAngle < -Math.PI) angle += 2 * Math.PI;
}
this._gizmoLastAngle = angle;
```

## 相关代码

- [`src/core/SceneManager.js`](../../src/core/SceneManager.js) — `initJointGizmo` onChange 回调里的角度解缠逻辑

## 相关 bug

#23（旋转 gizmo 大角度跳变 360°）
