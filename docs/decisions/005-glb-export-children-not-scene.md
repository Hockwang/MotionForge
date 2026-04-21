---
date: 2026-04-18
status: accepted
---
# GLB 导出 children 数组而非 THREE.Scene 对象

## 背景

`ResultPackageExporter.serializeSceneToGlb` 需要把当前场景序列化为 GLB 二进制，供 ZIP 包里的 `model.glb` 使用。

## 考虑过的选项

1. **直接传 `sceneRoot`（THREE.Scene）**：最直观
2. **传 `sceneRoot.children` 数组**（过滤掉灯光/相机/Helper）：只导出有意义的模型节点

## 决定

导出时**不传 Scene，传过滤后的 children 数组**（或单节点时传节点本身）。

## 理由

- Bug #12：GLTFExporter 对 THREE.Scene 节点的处理与 GLTFLoader 不对称。GLTFLoader 始终在外面包一层新 Scene，导致 roundtrip 后场景树多一层嵌套，节点层级变化，零件位置错位。
- Bug #13：第一次修 #12 只导出 `children[0]`，漏掉兄弟节点（19 vs 23 个节点）。改为导出所有有意义子节点。

## 后果

- 灯光、相机、GridHelper、ViewHelper 等不进入 GLB（正确行为）
- 导入后 `gltf.scene.children` 就是导出的节点数组，结构与原始一致
- 如果 sceneRoot 下有多个模型根节点，GLB 会包含多个顶层节点（合法 GLTF）

## 相关代码

- [`src/core/ResultPackageExporter.js`](../../src/core/ResultPackageExporter.js) — `serializeSceneToGlb` 的 `exportTargets` 过滤逻辑
