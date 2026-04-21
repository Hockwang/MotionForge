---
tags: [architecture, export, import, roundtrip]
updated: 2026-04-18
---
# ZIP 导出/导入流水线

## 导出流程（ResultPackageExporter + main.js）

```
用户点"导出 ZIP"
  1. 保存当前关节值和选中状态
  2. clearSelection()                     // 防止 emissive 烘焙进 GLB
  3. 所有关节 currentValue = 0            // 让 GLB 烘焙零位态
  4. applyAllJointDrives()
  try {
    5. serializeSceneToGlb()              // GLTFExporter → children 数组（不传 Scene）
    6. 组装 manifest/joints/motion/pkf JSON
    7. JSZip 打包 → 下载
  } finally {
    8. 恢复关节值 + 恢复选中               // 无论成功失败都执行
  }
```

关键约束：joints.json 里的 `currentValue` 导出时写死为 `0`（与 GLB 零位语义一致），动画数据在 motion.json / pkf.json 里。

## 导入流程（main.js handleImportPackage）

```
用户选择 ZIP 文件
  1. JSZip 解压，读取 manifest / joints / motion / pkf JSON + model.glb
  2. keyframeManager.reset()
  3. GLTFLoader 加载 model.glb → 挂到 sceneRoot
  4. root.name = manifest.source.root_name ?? manifest.source.file_name  // 恢复根节点名
  5. 解析 joints.json → 按 parent_name 查找逻辑父级 → 重建 jointDefinitions
  6. 两阶段应用关节：
     a. 全部 currentValue = 0 → applyAllJointDrives()  // 零位懒捕获 base
     b. 恢复真实 value → applyAllJointDrives()          // 驱动到目标位置
  7. 解析 motion.json → 恢复 globalClips
  8. 解析 pkf.json → 恢复 pkfParameters + pkfSteps（joint 字段按名字解析 UUID）
  9. 解析 sceneMarkers → 重建标记对象
```

## Schema 版本历史

| 版本 | 关键变化 |
|------|---------|
| v1 | joints.json = 空间锚点（已废弃） |
| v2 | joints.json = FK 关节定义；origin 是世界坐标 |
| v3 | origin 改为 parent-local；motion.json 全局关键帧格式 |
| v4 | model.glb 由 GLTFExporter 重新序列化（含 runtime 插入的 group） |
| v5 | motion.json 新增 `reparent_events[]`（取货/放货时切换 scene graph parent）；manifest 新增 `source.root_name` |
| v6 | manifest 新增 `scene_markers[]` metadata；joints 新增 `role` 字段（AI 语义匹配用） |

## 常见 Roundtrip 坑

- **Scene 包层**：见 [gotcha-001](../gotchas/001-gltf-scene-wrapping-roundtrip.md)
- **懒捕获时机**：见 [gotcha-002](../gotchas/002-lazy-base-capture-timing.md)
- **emissive 烘焙**：见 [gotcha-004](../gotchas/004-material-sharing-emissive-bake.md)
- **跨 roundtrip 标识**：见 [decision-004](../decisions/004-name-based-cross-roundtrip-ids.md)
