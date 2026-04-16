# MotionForge 全流程 & 故障定位手册

> 这份文档回答三件事：
> 1. **这个工具怎么用**（端到端流程）
> 2. **出问题先看哪里**（症状 → 诊断脚本 → bug 编号）
> 3. **改代码前先读什么**（架构约束 + 历史踩坑）
>
> 其他文档：
> - [CLAUDE.md](CLAUDE.md) — 架构约束 + 29 条 bug 修复历史（权威来源）
> - [README.md](README.md) — 安装运行
> - [tests/](tests/) — 5 个浏览器 Console 诊断脚本

---

## 一、端到端流程

```
┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐
│ 1. 加载  │ -> │ 2. 配关节 │ -> │ 3. 关键帧 │ -> │ 4. AI 生 │ -> │ 5. 导出  │ -> │ 6. 导入  │
│  模型    │    │  + role  │    │  (可选)  │    │  PKF     │    │  ZIP    │    │  ZIP    │
└──────────┘    └──────────┘    └──────────┘    └──────────┘    └──────────┘    └──────────┘
   GLB/USD/       FK revolute/    全局 clips     自然语言 +      schema v4      两阶段应用
   FBX 自动       prismatic        所有关节       关节 chips      含归零的      关节（避免
   转成 GLB       + origin +       同步捕获       → 参数+步骤     model.glb     链式下沉）
                  role 标签                       + 公式
```

### 1. 加载模型
- 支持：`.glb` / `.gltf` / `.usdz` 直接加载；`.usd/.usda/.usdc/.fbx` 需转换服务（`npm run converter` 启动 Blender 后端）
- 代码入口：[src/core/AssetLoader.js](src/core/AssetLoader.js)

### 2. 配关节（FK 定义）
- 在左侧场景树节点右侧点 joint chip → 弹出浮动配置面板
- 必选：`type`（revolute/prismatic）、`axis`、`origin`（URDF 风格 parent-local）
- 关键：**role 语义标签**（车体前进/门架升降/叉齿旋转...）—— AI 按 role 匹配意图，不靠轴向硬猜（见 [CLAUDE.md #29](CLAUDE.md#29-ai-按轴向硬猜导致选错关节)）
- 代码：[src/ui/EditorUI.js](src/ui/EditorUI.js) `showJointConfigPanel` / [src/core/KeyframeManager.js](src/core/KeyframeManager.js) `setJointDef`

### 3. 打关键帧（可选，手动编排动画）
- 全局关键帧：每个 clip 的每一帧捕获**所有**关节的 value（不是 per-object）
- 代码：[src/core/KeyframeManager.js](src/core/KeyframeManager.js) `globalClips` / `captureKeyframe`

### 4. AI 生 PKF（参数化关键帧公式）
- 右侧 AI 面板：
  - 上方 chips 区：列出已配置 role 的关节，点击插入 `@jointName` 到输入框
  - 自然语言描述动作 → 后端调 Gemini → 返回 `{parameters, steps}` JSON
- 后端：[tools/conversion-service.js](tools/conversion-service.js) — few-shot pickup 示例 + role 优先匹配规则
- 后端匹配不到 role 返回 422 + `available_roles`，前端显示拒绝理由
- 代码：[src/main.js](src/main.js) `requestAiGeneratePkf`

### 5. 导出 ZIP（schema v4）
ZIP 内容：
```
manifest-YYYYMMDD-HHMMSS.json    # 版本、源信息、文件索引
joints-YYYYMMDD-HHMMSS.json      # FK 关节定义（含 role、parent_name、baseTransform）
motion-YYYYMMDD-HHMMSS.json      # 全局 clips + 每帧 joint_values 字典
pkf-YYYYMMDD-HHMMSS.json         # PKF 参数和步骤（可选，仅当有数据）
model-YYYYMMDD-HHMMSS.glb        # GLTFExporter 序列化当前 sceneRoot
```

**关键纪律**（出错就 double-apply / 下沉 / 高亮烘焙）：
- 导出前必须 `selectionManager.clearSelection()`（[#17](CLAUDE.md#17-导入后零件高亮不消失)）
- 导出前必须把所有关节 `currentValue = 0`（保留 baseTransform）（[#20/#21](CLAUDE.md#20-double-apply导出的-glb-烘焙了驱动态)）
- 代码：[src/core/ResultPackageExporter.js](src/core/ResultPackageExporter.js) / [src/main.js](src/main.js) `exportResultPackage`

### 6. 导入 ZIP（两阶段应用）
1. 恢复场景 + joint def（按 `parent_name` 解析 parentId，不能用旧 UUID）
2. **阶段 A**：所有关节 `currentValue=0` → `applyAllJointDrives` → 在零位懒捕获 baseTransform
3. **阶段 B**：恢复真实 currentValue → `applyAllJointDrives` → 正常驱动
- 不这样做会链式关节整体下沉（见 [#22](CLAUDE.md#22-链式关节导入后整体下沉)）
- 代码：[src/main.js](src/main.js) `handleImportPackage`

---

## 二、故障定位决策树

**第一步永远是：F12 打开 Console，粘贴 `tests/diag-*.js` 跑诊断，不要盲改代码。**

| 症状 | 先跑哪个诊断 | 调用 | 可能对应 bug |
|---|---|---|---|
| 导入后模型整体下沉 / 偏移 | [diag-roundtrip-transform.js](tests/diag-roundtrip-transform.js) | `__diagT.phaseA/B/C/compare` | [#14](CLAUDE.md#14-导入后模型整体下沉-165-单位) [#20](CLAUDE.md#20-double-apply导出的-glb-烘焙了驱动态) |
| 导入后链式关节断开 / 零件飞走 | [diag-joint-integrity.js](tests/diag-joint-integrity.js) | `__diagJ.check()` | [#18](CLAUDE.md#18-parentid-在导入后被错误覆盖) [#10](CLAUDE.md#10-fk-求解器依赖场景树层级) |
| 播放动画时多零件同步下沉 | [diag-animation.js](tests/diag-animation.js) | `__diagA.scanClip()` | [#22](CLAUDE.md#22-链式关节导入后整体下沉) |
| 改了归零逻辑想验证 | [diag-zero-pose.js](tests/diag-zero-pose.js) | `__diagZ.testZeroPose/compare` | [#21](CLAUDE.md#21-第一版零位导出失败清空-base--value0) |
| 零件一直发光 | 单行命令查 `material.emissive` | 见 [CLAUDE.md:454](CLAUDE.md#L454) | [#17](CLAUDE.md#17-导入后零件高亮不消失) [#25](CLAUDE.md#25-材质高亮影响其他对象) |
| Gizmo 旋转跳 360° | 直接拖拽观察 | - | [#23](CLAUDE.md#23-旋转-gizmo-大角度跳变-360) |
| Gizmo 平移弹回 | - | - | [#4](CLAUDE.md#4-gizmo-平移prismatic瞬间弹回) |
| 选中对象跳位置 | - | - | [#2](CLAUDE.md#2-配置关节后对象瞬间飞走) [#3](CLAUDE.md#3-reparentinsertgroup-后对象飞走) |
| reparent 后关节不动 | `__mf.getJointDefs()` 检查 baseTransform | - | [#3](CLAUDE.md#3-reparentinsertgroup-后对象飞走) |
| 旋转 ~90° 失真 | - | - | [#7](CLAUDE.md#7-万向锁gimbal-lock旋转丢失-57) |
| AI 选错关节 | 检查 joint role 配置 | - | [#29](CLAUDE.md#29-ai-按轴向硬猜导致选错关节) |
| AI 返回公式格式错乱 | 查 `tools/conversion-service.js` prompt | - | [#28](CLAUDE.md#28-ai-从零写-pkf-公式不稳定) |
| 导出的 GLB 层级被压扁 | [diag-export-roundtrip.js](tests/diag-export-roundtrip.js) | `__diagRT.snapshot/diff` | [#12](CLAUDE.md#12-zip-导出后再导入模型变形) [#13](CLAUDE.md#13-导入后节点数量少-4-个19-vs-23) |
| git push 报 corrupt object | - | - | [#27](CLAUDE.md#27-git-push-失败corrupt-loose-object) |
| 导出后模型卡在零位不恢复 | 查 console 有无 GLTFExporter 错误 | - | [#32](CLAUDE.md#32-导出-zip-异常时卡在零位状态) |
| 某些关节配了但播放时不动 | `__mf.getJointDefs()` 检查 parentId 是否成环 | - | [#33](CLAUDE.md#33-关节链循环依赖静默失效) |
| FBX 源 ZIP 导入后顶部名变成文件名 + 关节被错误兜底 | 检查 `__mf.sceneManager.sceneRoot.name` 是否和源文件里一致 | - | [#34](CLAUDE.md#34-fbx-源-zip-roundtrip-后根节点改名导致-parentroot-的关节找不到父级) |

### 诊断脚本使用方式（所有脚本统一）
1. `npm run dev` 启动，加载模型
2. F12 → Console
3. 打开 `tests/diag-XXX.js`，**全选复制**
4. 粘贴到 Console，回车 → 看到 `✅ ... 已加载`
5. 按表格调用 `__diagX.xxx()`

### 浏览器 Console 随时可用的钩子
```js
__mf.THREE              // THREE 命名空间
__mf.sceneManager       // SceneManager 实例
__mf.keyframeManager    // KeyframeManager
__mf.selectionManager   // SelectionManager
__mf.editableObjects()  // 可编辑对象列表
__mf.getJointDefs()     // 关节定义快照
```
单行快检命令见 [CLAUDE.md:432-455](CLAUDE.md#L432-L455)。

---

## 三、改代码前必读

**7 条架构约束**（不可随意改，详见 [CLAUDE.md:57-69](CLAUDE.md#L57-L69)）：

1. `baseTransform` 存四元数，不用 Euler（万向锁 [#7](CLAUDE.md#7-万向锁gimbal-lock旋转丢失-57)）
2. `origin` 是 parent-local 空间，不是世界坐标（[#5](CLAUDE.md#5-gizmo-旋转围绕错误中心)）
3. 关节链用拓扑排序，不用场景树深度（[#8](CLAUDE.md#8-拓扑排序关节链驱动顺序错误) [#10](CLAUDE.md#10-fk-求解器依赖场景树层级)）
4. 跨 roundtrip 用 name 标识，不用 UUID（[#18](CLAUDE.md#18-parentid-在导入后被错误覆盖) [#19](CLAUDE.md#19-pkf-joint_def_id-跨导入失效)）
5. 导出 GLB 前归零 + 清选中（[#17](CLAUDE.md#17-导入后零件高亮不消失) [#20](CLAUDE.md#20-double-apply导出的-glb-烘焙了驱动态)）
6. 导入后两阶段应用关节（[#22](CLAUDE.md#22-链式关节导入后整体下沉)）
7. 懒捕获 base 必须在父级零位时发生（[#22](CLAUDE.md#22-链式关节导入后整体下沉)）

**修完 bug 必须做的事**（见 [CLAUDE.md:75-91](CLAUDE.md#L75-L91)）：
- 在 [CLAUDE.md](CLAUDE.md) "Bug 修复历史" 章节追加一条（症状/排查/根因/修复）
- 新增诊断脚本同步更新 [CLAUDE.md](CLAUDE.md) 诊断脚本指南

---

## 四、常见坑速查

| 想做 | 别踩 | 正确做法 |
|---|---|---|
| 改关节原点 | 不要存世界坐标 | 存 parent-local（URDF） |
| 存旋转 | 不要 Euler | 四元数 `{qx,qy,qz,qw}` |
| 关联父子关节 | 不用 `childObj.parent.uuid` | 存 `parentId` + 导出时额外存 `parent_name`，导入时按 name 解析 |
| 导出前 | 不要直接 GLTFExporter | 先 clearSelection + 所有 joint.currentValue=0 |
| 导入后 | 不要直接用 JSON 里的 value 驱动 | 两阶段：先全 0 驱动一次，再恢复 value 驱动 |
| 高亮选中对象 | 不要改共享 material | `material.clone()` 后改 emissive |
| commit 大文件 | 不要 commit `zip/` | `.gitignore` |
| AI 写公式 | 不要让它从零生成 | few-shot 示例塞 system prompt |
| AI 选关节 | 不要只给 name/type/axis | 加 role 标签让它语义匹配 |
