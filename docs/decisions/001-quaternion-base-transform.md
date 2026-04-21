---
date: 2026-04-18
status: accepted
---
# baseTransform 用四元数而非 Euler 角

## 背景

关节的初始姿态（zero pose）需要以某种旋转表示保存在 `baseTransform` 里，供 `applyJointDrive` 每帧还原到零位后再叠加驱动值。

## 考虑过的选项

1. **Euler 角（rx, ry, rz）**：直观，与 UI 显示对应
2. **四元数（qx, qy, qz, qw）**：无奇点，插值稳定

## 决定

使用四元数存储 `baseTransform`（字段名 `qx/qy/qz/qw`），全程避免 Euler 转换。

## 理由

发现于 bug #7：某些关节旋转到 ~90° 时，`Quaternion → Euler → Quaternion` 在 Y ≈ π/2 附近有万向锁奇点，导致实际旋转少 57°+。Euler 只用于 UI 展示时的临时转换，不做持久化。

## 后果

- `serializeState` / `restoreState` / `joints.json` 导出均带 `qx/qy/qz/qw` 字段
- UI 展示旋转时仍可转为 Euler，但读写 `baseTransform` 必须走四元数路径
- 旧格式（带 `rx/ry/rz`）导入时需兼容转换（见 `KeyframeManager.restoreState`）

## 相关代码

- [`src/core/KeyframeManager.js`](../../src/core/KeyframeManager.js) — `applyJointDrive` 里的 `baseTransform` 读写
