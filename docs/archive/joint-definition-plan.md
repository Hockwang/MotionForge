> ✅ **本计划已实现**（v8-v11 完成）
>
> 当前关节系统架构和约束见：
> - [CLAUDE.md](../../CLAUDE.md) — 架构约束 + bug 历史（#1 - #29）
> - [FLOW.md](../../FLOW.md) — 关节配置在流程中的位置
>
> 本文档保留作历史决策参考，**不再维护**。

---

# 层级树关节定义与驱动预览 — 实施计划（历史存档）

## 修改文件清单

| 文件 | 修改原因 |
|------|---------|
| `src/core/KeyframeManager.js` | 新增 jointDefinitions Map + 关节驱动求解 + 序列化 |
| `src/ui/EditorUI.js` | 场景树关节标签 + 配置面板 + joint value 滑条 |
| `src/main.js` | 事件连接 + undo 集成 + 导入导出连接 |
| `src/style.css` | 关节标签/配置面板/滑条样式 |
| `src/core/ResultPackageExporter.js` | 导出 joint-definitions.json |
| `src/core/SceneManager.js` | M3 gizmo 渲染与交互 |

## M1: 数据与UI

### 数据层 (KeyframeManager.js)
- 新增 `jointDefinitions` Map, key=nodeUuid, value=`{id, name, type, axis, limits:{min,max}, parentId, childId}`
- 新增 `setJointDef(nodeId, def)` / `getJointDef(nodeId)` / `removeJointDef(nodeId)` / `getAllJointDefs()`
- `serializeState()` / `restoreState()` 包含 jointDefinitions

### UI层 (EditorUI.js)
- `renderNode()` 中 label 右侧追加关节标签 span: 无 / 🔄R / ↕P / 🔗F
- 点击标签触发 `handlers.onJointTagClick(node)`
- 新增 `renderJointConfigPanel(def, handlers)` — type/axis/limits 配置
- fixed 类型时隐藏 axis 和 limits

### 连接层 (main.js)
- `refreshObjectTree()` handlers 新增 `onJointTagClick`
- 点击标签 → 弹出配置面板 → 修改后调用 `keyframeManager.setJointDef()`
- parent 自动取 Three.js parent uuid, child 为节点自身 uuid

### 样式 (style.css)
- `.tree-joint-tag` 小圆角标签样式
- `.joint-config-panel` 弹出面板样式

### 验证
1. 加载 GLB, 非根节点右侧显示"无"标签
2. 点击标签弹出配置面板
3. 选 revolute → 🔄R, prismatic → ↕P, fixed → 🔗F
4. fixed 时 axis/limits 隐藏

---

## M2: 驱动预览

### 数据层 (KeyframeManager.js)
- jointDef 新增 `currentValue` 字段
- `setJointValue(nodeId, value)` — clamp to limits
- `applyJointDrive(nodeId, sceneRoot)`:
  - revolute: child 围绕 axis 旋转 currentValue 度 (relative to parent)
  - prismatic: child 沿 axis 平移 currentValue
  - fixed: 不动

### UI层 (EditorUI.js)
- 配置面板下方新增 Joint Value 滑条 + 数字输入框
- 范围由 limits 决定 (默认 revolute: -180~180, prismatic: -10~10)

### 连接层 (main.js)
- 滑条 input → setJointValue() → applyJointDrive() → 刷新视口
- 选中节点时同步显示 currentValue

### 验证
1. revolute + Y轴 → 拖滑条 → child 围绕 Y 旋转
2. limits min=-45 max=45 → 超出被 clamp
3. prismatic → 拖滑条 → child 沿轴平移
4. fixed → 滑条禁用

---

## M3: Gizmo

### 场景层 (SceneManager.js)
- 引入 TransformControls
- `showJointGizmo(object, mode, axis)`: revolute→rotate, prismatic→translate
- `hideJointGizmo()`
- gizmo change 事件回调更新 joint value

### 连接层 (main.js)
- 选中有关节定义节点 → 显示 gizmo
- gizmo 拖拽 → 实时更新 currentValue + UI 滑条
- 取消选择 → 隐藏 gizmo

### 验证
1. revolute + Z → 选中 → 出现旋转 gizmo (仅 Z 轴)
2. 拖拽 gizmo → 模型旋转 + 滑条同步
3. prismatic → gizmo 变平移模式

---

## M4: Undo/Export

### Undo (main.js)
- pushUndoSnapshot() 已通过 serializeState() 包含 jointDefinitions (M1已处理)
- 确认 currentValue 也被序列化恢复

### Export (ResultPackageExporter.js)
- exportZip() 新增 jointDefinitions 参数
- ZIP 新增 `joint-definitions-{timestamp}.json`
- manifest.files 新增 joint_definitions 字段

### Import (main.js)
- handleImportPackage() 读取 joint-definitions.json 恢复到 keyframeManager

### 验证
1. 配置关节 + 调整 value → Ctrl+Z → 回退
2. 导出 ZIP → 解压检查 joint-definitions.json
3. 重新导入 ZIP → 关节定义和 value 恢复
