---
date: 2026-04-18
severity: high
---
# 外部序列化漏做 Y↔Z swap 导致 AI 坐标语义错位

## 症状

AI 生成的动画里高度和距离语义对调——例如：门架升到货物前后距离那么高（10m），但货物的实际高度（0.6m）没被用到。或者 AI 把一个坐标方向当成另一个，生成的 PKF 值数量级完全不对。

## 根因

Three.js 运行时是 Y-up（Y 是高度），但 UI 和 AI 期望 Z-up 语义（Z 是高度、Y 是前后）。  
没有独立的转换工具函数——转换靠 UI 输入框 label 和 Three.js 字段的命名约定（见 `src/ui/EditorUI.js:104-114`）。  
任何直接把 `object.getWorldPosition()` 结果传出系统的代码，如果没做 `{x, y: wp.z, z: wp.y}` swap，外部收到的是 Y-up 原始数值，但 AI / 外部工具按 Z-up 语义解读 → 高度和前后数值对调。

**已修复现场**：`src/main.js` 的 `collectSceneForAi` 函数原先直接传 Three.js 世界坐标，修复后加了 swap：

```js
// threejs (y-up) → ui/AI (z-up)：swap y 和 z
scene.push({ name: o.name, position: { x: wp.x, y: wp.z, z: wp.y } });
```

## 诊断

对比 UI 变换面板显示的坐标值 vs 发送给 AI 的 `scene[]` 数组里的坐标值：
- UI 面板"Z 高度"显示 0.6 → AI 收到的 `position.z` 应该是 0.6
- 如果 AI 收到的 `position.y` 是 0.6 而 `position.z` 是前后距离值 → swap 漏掉了

## 修复

所有把 Three.js 世界坐标传出系统的地方（AI API、日志、外部工具调用），必须手动 swap：

```js
const wp = obj.getWorldPosition(new THREE.Vector3());
const zUpPosition = { x: wp.x, y: wp.z, z: wp.y };  // Y-up → Z-up
```

## 相关代码

- [`src/main.js`](../../src/main.js) — `collectSceneForAi`（已修复，含注释）
- [`src/ui/EditorUI.js:104-114`](../../src/ui/EditorUI.js) — UI label 与 Three.js 字段的约定
