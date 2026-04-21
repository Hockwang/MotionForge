---
date: 2026-04-18
status: accepted
---
# joint origin 用 parent-local 坐标（URDF 风格）

## 背景

关节的旋转/平移中心（origin）需要存在 `jointDefinition` 里，供 Gizmo 和 `applyJointDrive` 用来定位旋转轴心。

## 考虑过的选项

1. **世界坐标**：Gizmo 拖拽后直接写入，简单
2. **parent-local 坐标（URDF 风格）**：origin 相对于关节父节点，父节点移动时 origin 自动跟随

## 决定

origin 存 **parent-local 空间**（URDF 风格）。

## 理由

发现于 bug #5：origin 若存世界坐标，父节点移动后 origin 不跟随 → Gizmo 旋转中心错位。  
改为 parent-local 后，父节点的 `worldToLocal(origin)` 结果不变，origin 自动跟随父节点运动。

## 后果

- `applyJointDrive` 里每帧都需要先把 `origin` 从 parent-local 转到世界坐标再做运算
- joints.json 导出的 origin 字段语义是 parent-local（UI Z-up 坐标系）
- 读老版本 ZIP（origin 是世界坐标）时需要迁移转换

## 相关代码

- [`src/core/KeyframeManager.js`](../../src/core/KeyframeManager.js) — `applyJointDrive` origin 到世界坐标的转换
- [`src/core/SceneManager.js`](../../src/core/SceneManager.js) — Gizmo onChange 回调写 origin
