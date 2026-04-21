---
tags: [concepts, markers, schema-v6]
updated: 2026-04-18
---
# 场景标记系统（Scene Markers）

## 是什么

场景标记是用户在 3D 视口里放置的**辅助空间对象**，用于标注货物占位、拾取点、放置点等业务语义位置。它们独立于关节系统，但参与场景树（可被 reparent 到关节节点上，从而跟随关节运动）。

## 标记类型

| type | 视觉形状 | 典型用途 |
|------|---------|---------|
| `cargo` | 半透明橙色立方体 | 货物占位（可设 w/h/d 尺寸） |
| `pickup` | 绿色球体 | 拾取点坐标 |
| `dropoff` | 红色球体 | 放置点坐标 |

## 数据结构

```js
// KeyframeManager.sceneMarkers: Map<id, marker>
{
  id: string,
  name: string,        // Three.js 对象名，场景树里用这个名查找
  type: 'cargo' | 'pickup' | 'dropoff',
  size?: { w, h, d }, // cargo 专用
  color?: number,      // hex color
}
```

## 生命周期

1. 用户点"添加标记" → `KeyframeManager.addSceneMarker` 写入元数据
2. `SceneManager.createMarkerObject(marker)` 创建 Three.js 对象（Box/Sphere），name = marker.name
3. 对象加入 `sceneRoot`，参与场景树选中/reparent/编辑流程
4. 导出时序列化进 ZIP（独立于 joints.json，在 manifest 或单独字段里，TODO: 确认具体字段）
5. 导入时按 name 重建对象，`sceneMarkers` 恢复元数据

## Schema 版本

场景标记在 **schema v6** 引入（`ResultPackageExporter.js:97-106`）。metadata 存于 `manifest.scene_markers[]`，位置信息在 GLB 里（markers 是 sceneRoot 的子对象）。

## 相关文件

- [`src/core/KeyframeManager.js`](../../src/core/KeyframeManager.js) — `sceneMarkers` Map、`addSceneMarker`
- [`src/core/SceneManager.js`](../../src/core/SceneManager.js) — `createMarkerObject`
- [`src/main.js`](../../src/main.js) — 标记的导入导出处理
