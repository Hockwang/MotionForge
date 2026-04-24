---
tags: [concepts, schema, export]
updated: 2026-04-18
---
# ZIP 输出包 Schema

当前版本：**schema_version = 6**（见 `src/core/ResultPackageExporter.js:109`）

## 包结构

```
motionforge_YYYYMMDD_HHMMSS.zip
├── manifest.json    # 元数据：工具版本、源文件信息、schema 版本、scene_markers metadata
├── joints.json      # FK 关节定义数组
├── motion.json      # 全局关键帧动画数据（含 reparent_events）
├── pkf.json         # 参数化公式动画数据（可选）
└── model.glb        # 当前场景的 GLB 序列化（零位态，含 scene marker 对象）
```

## manifest.json（v6）

```json
{
  "schema_version": 6,
  "generator": "MotionForge",
  "exported_at": "ISO8601",
  "source": {
    "file_name": "agv.fbx",
    "format": "fbx",
    "root_name": "Scene",
    "up_axis": "Z",
    "units_in_meters": 1.0,
    "fps": 30
  },
  "scene_markers": [
    {
      "id": "marker_abc123",
      "name": "cargo_01",
      "type": "cargo",
      "size": { "w": 0.6, "h": 0.4, "d": 0.4 },
      "color": null
    },
    {
      "id": "marker_def456",
      "name": "pickup_01",
      "type": "pickup",
      "size": null,
      "color": null
    }
  ],
  "files": {
    "manifest": "manifest-20260418-120000.json",
    "model": "model-20260418-120000.glb",
    "joints": "joints-20260418-120000.json",
    "motion": "motion-20260418-120000.json",
    "pkf": "pkf-20260418-120000.json"
  }
}
```

**v5 新增**：`source.root_name`（场景根节点名，导入时恢复用，防止 FBX roundtrip 改名失效）  
**v6 新增**：`scene_markers[]`（场景标记 metadata；位置信息在 GLB 里，按 `name` 关联）

## joints.json

```json
{
  "definitions": [{
    "name": "_CS198",
    "type": "prismatic",
    "axis": "x",
    "limits": { "min": -1, "max": 1 },
    "parent_name": "AGV_Body",
    "child_id": "uuid...",
    "current_value": 0,
    "role": "叉齿侧移",
    "origin": { "x": 0, "y": 0, "z": 0 },
    "base_transform": {
      "tx": 0, "ty": 0, "tz": 0,
      "qx": 0, "qy": 0, "qz": 0, "qw": 1
    }
  }]
}
```

## motion.json（v5：含 reparent_events）

```json
{
  "clips": [{
    "clip_name": "pickup",
    "duration": 12,
    "keyframes": [
      { "t": 0, "joint_values": { "_CS198": 0, "_____10": 0 } },
      { "t": 5, "joint_values": { "_CS198": 0.5, "_____10": 1.5 } }
    ],
    "reparent_events": [
      {
        "event_id": "evt_001",
        "t": 5.0,
        "child_name": "cargo_01",
        "new_parent_name": "_CS198"
      },
      {
        "event_id": "evt_002",
        "t": 10.0,
        "child_name": "cargo_01",
        "new_parent_name": null
      }
    ]
  }]
}
```

**v5 新增**：`clips[].reparent_events[]`，在指定时间点切换对象的 scene graph parent（取货 = attach 到叉齿；放货 = `new_parent_name: null` 挂回世界根）。`child_name` / `new_parent_name` 用名字，跨 roundtrip 稳定。

## pkf.json

```json
{
  "parameters": [{ "id": "dist", "type": "number", "unit": "m", "default": 1 }],
  "steps": [{
    "joint": "_CS198",
    "channel": "position",
    "axis": "x",
    "t_start": 0, "t_end": 3,
    "value_start": "0",
    "value_end": "dist",
    "easing": "ease-in-out"
  }]
}
```

## Schema 版本历史

| 版本 | 关键变化 |
|------|---------|
| v1 | joints.json = 空间锚点（已废弃） |
| v2 | joints.json = FK 关节定义；origin 是世界坐标 |
| v3 | origin 改为 parent-local；motion.json 全局关键帧格式 |
| v4 | model.glb 由 GLTFExporter 重新序列化（含 runtime 插入的 group） |
| v5 | motion.json 新增 `reparent_events[]`；manifest 新增 `source.root_name` |
| v6 | manifest 新增 `scene_markers[]`；joints 新增 `role` 字段；pkf.json 可选文件 + `template_meta` |
| v7 | joints 新增 `limit_upper` + `overflow_to`（双段门架 overflow，bugfix #59）；pkf steps 新增 `template_segment` + `template_segment_name`（模板段诊断元数据） |

## 重要约束

- `model.glb` 烘焙零位态，`joints.json` 的 `current_value` 也必须是 0（两者语义必须一致，否则导入 double-apply）
- `parent_name` / `child_name` / `new_parent_name` 是跨 roundtrip 的稳定引用，不要用 UUID
- 详细 schema 定义见 [`docs/schema/v7.md`](../schema/v7.md)（当前版本，含 v5/v6/v7 全部字段）
- 历史版本字段参考见 [`docs/schema/v4.md`](../schema/v4.md)

## 相关文件

- [`src/core/ResultPackageExporter.js`](../../src/core/ResultPackageExporter.js) — 导出实现
- [`src/main.js`](../../src/main.js) — `handleImportPackage` 导入实现
