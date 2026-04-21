---
date: 2026-04-18
status: accepted
---
# 跨 roundtrip 的标识符用 name 而非 UUID

## 背景

关节定义引用场景节点（`parentId`、`childId`）以及 PKF step 引用关节（`joint_def_id`）都需要在导出/导入后保持有效。

## 考虑过的选项

1. **UUID**：运行时唯一，Three.js 自动生成，方便查找
2. **节点/关节 name**：语义稳定，GLB 重新加载后节点名不变

## 决定

跨 roundtrip 的引用一律用 **name**：
- joints.json 新增 `parent_name` 字段（节点名）
- PKF step 只存 `joint`（关节名），不存 UUID
- 导入时按 name 在 `objectsByName` 里查找，重新解析成当前 UUID

## 理由

- Bug #18：`parentId` 在导入后被 `childObj.parent.uuid`（无名包装 Object3D）覆盖，链式关节断开。
- Bug #19：PKF step 存运行时 UUID，roundtrip 后全变，PKF 失效。
- Bug #34：FBX 源根节点名从 "Scene" 被改成文件名，`parent_name: "Scene"` 找不到 → 兜底错误 parent。

UUID 只是运行时分配，GLB 序列化再反序列化后全部刷新，不能作为持久标识。

## 后果

- 节点改名会破坏 joints.json 里的 `parent_name` 引用（已知限制，用户需注意）
- 同名节点场景里只能有一个（按 name 查找取第一个），重名时行为未定义
- 旧版 ZIP 没有 `parent_name`，导入时兜底到 `childObj.parent`（可能引入 bug #18 的旧问题）

## 相关代码

- [`src/core/ResultPackageExporter.js`](../../src/core/ResultPackageExporter.js) — 导出时写 `parent_name`、`root_name`
- [`src/main.js`](../../src/main.js) — `handleImportPackage` 按 name 解析 parentId
- [`src/core/KeyframeManager.js`](../../src/core/KeyframeManager.js) — PKF step `joint` 字段（名字而非 UUID）
