---
date: 2026-04-18
severity: high
---
# GLTFExporter/Loader Scene 包层不对称（roundtrip 层级错位）

## 症状

模型导出为 GLB 再导入后，场景树多了一层或少了几个节点（如 19 vs 23 个），零件位置错乱，整体下沉或层级压扁。根节点被重命名为 "AuxScene"。

## 根因

`GLTFExporter` 对 `THREE.Scene` 类型节点处理与 `GLTFLoader` 不对称：
- `GLTFLoader` 始终在外面包一层新的 `THREE.Scene`
- 如果传入 `THREE.Scene` 导出，再导入就多了一层嵌套
- 同时 `GLTFExporter` 不保留 Scene 的 `name`，导致根节点被改为 "AuxScene"

## 解决方案

导出时**不传 Scene 对象**，改传过滤后的 `sceneRoot.children` 数组（跳过灯光/相机/Helper）。导入后根节点名用 `manifest.source.root_name` 恢复（见 decision-004）。

见 [`docs/decisions/005-glb-export-children-not-scene.md`](../decisions/005-glb-export-children-not-scene.md)。

## 相关代码

- [`src/core/ResultPackageExporter.js`](../../src/core/ResultPackageExporter.js) — `serializeSceneToGlb`
- [`src/main.js`](../../src/main.js) — `handleImportPackage` 根节点名恢复

## 相关 bug

#12（层级压扁）、#13（节点丢失）、#15（根节点改名）、#34（FBX 根节点名跨 roundtrip 失效）
