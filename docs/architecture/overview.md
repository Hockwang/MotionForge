---
tags: [architecture, overview]
updated: 2026-04-18
---
# MotionForge 系统架构概览

## 技术栈

- **前端**：Three.js + Vite（纯浏览器，无框架）
- **后端**：Node.js Express（本地可选服务，仅用于 AI PKF 生成和格式转换）
- **输出格式**：ZIP 包（manifest / joints / motion / pkf / model.glb），schema v6

## 模块职责

```
┌─────────────────────────────────────────────────┐
│                   main.js                        │
│  应用编排：事件绑定、导入导出流程、PKF 播放循环   │
└──────┬──────┬──────┬──────┬──────┬──────────────┘
       │      │      │      │      │
  ┌────┴─┐ ┌──┴──┐ ┌─┴──┐ ┌┴───┐ ┌┴──────────────┐
  │Asset │ │Scene│ │Sel.│ │KF  │ │ResultPackage  │
  │Loader│ │Mgr  │ │Mgr │ │Mgr │ │Exporter       │
  └──────┘ └─────┘ └────┘ └────┘ └───────────────┘
              │                        │
         Three.js                   JSZip +
       scene/camera                GLTFExporter
       Gizmo controls
```

| 模块 | 文件 | 职责 |
|------|------|------|
| AssetLoader | `src/core/AssetLoader.js` | GLB/FBX/USD/USDZ 加载分发，FBX/USD 走本地 Blender 转换服务 |
| SceneManager | `src/core/SceneManager.js` | Three.js 场景/相机/灯光/GridHelper/ViewHelper，TransformControls Gizmo |
| SelectionManager | `src/core/SelectionManager.js` | 场景树选中与 emissive 高亮，material clone 防污染 |
| KeyframeManager | `src/core/KeyframeManager.js` | FK 关节定义、全局关键帧、PKF 公式、拓扑排序求解器、场景标记 |
| ResultPackageExporter | `src/core/ResultPackageExporter.js` | ZIP 序列化（GLB + JSON 包），schema v6 |
| EditorUI | `src/ui/EditorUI.js` | 左侧场景树、关节配置面板、时间轴、PKF 编辑器，事件 emit 到 main.js |

## 数据流

```
用户拖拽 Gizmo
  → SceneManager.onChange
    → main.js onJointTagClick
      → KeyframeManager.setJointDef (更新 currentValue)
        → KeyframeManager.applyAllJointDrives (拓扑排序驱动)
          → Three.js 场景更新
            → 渲染帧
```

## 坐标系约定

- **Three.js 运行时**：Y-up（标准 Three.js）
- **UI 显示**：Z-up（工业 CAD 惯例，Z 向上、Y 向前）
- **转换方式**：没有独立转换函数。转换靠 UI 输入框的 label 与 Three.js 字段的命名错位约定实现（见 `src/ui/EditorUI.js:104-114`）：
  - `#ty-input`（label="Z 世界坐标（高度）"）→ 写 `threejs.y`
  - `#tz-input`（label="Y 世界坐标（前后）"）→ 写 `threejs.z`
- **外部序列化必须手动 swap**：任何把 Three.js 世界坐标传出系统的地方（AI API、日志、外部工具）都需要手动做 `{x, y: threejs.z, z: threejs.y}`，否则外部收到的是 Y-up 数值但误以为是 Z-up 语义。见 `src/main.js` 的 `collectSceneForAi`。
- joints.json 导出用 **UI Z-up 坐标系**

## 详细子系统文档

- [`fk-joint-system.md`](fk-joint-system.md) — FK 关节数据结构与求解流程
- [`export-import-roundtrip.md`](export-import-roundtrip.md) — ZIP 导出/导入流水线
- [`ai-pipeline.md`](ai-pipeline.md) — L1/L2 AI 生成流水线（意图拆解 + PKF 生成）
