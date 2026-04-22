# MotionForge — Claude 协作手册

> 本文档是 AI 协作的**架构权威入口**，融合了架构约束、协作规则、诊断工具、bug 修复历史。所有关于"怎么改代码"的决策都回到这里。
>
> ## 项目文档矩阵
>
> **按角色找入口**：
>
> | 你是谁 / 想做什么 | 先读 |
> |---|---|
> | 新人 / 新 chat 接入项目 | [README.md](README.md)（3 分钟知道项目是什么） |
> | 看完整产品能力和操作流程 | [FLOW.md](FLOW.md) |
> | **改代码 / 定位 bug / 理解架构** | 本文档（CLAUDE.md） |
> | 了解 AI 打关节研究方向 | [AI-RIGGING-README.md](AI-RIGGING-README.md) |
> | 了解当前技术债 | [DEBT.md](DEBT.md) |
> | 看二期路线图（5 个未来方向） | [docs/ROADMAP.md](docs/ROADMAP.md) |
>
> **AI 打关节研究专题（长期课题）**：
> - [AI-RIGGING-README.md](AI-RIGGING-README.md) — 2 分钟总览
> - [HANDOFF.md](docs/ai-rigging/HANDOFF.md) — 给研究方的完整 context 包
> - [RESEARCH-LOG.md](docs/ai-rigging/RESEARCH-LOG.md) — 决策演进记录
> - [AI-RIGGING-PLAN.md](docs/archive/AI-RIGGING-PLAN.md) — 早期草稿（部分已废弃，保留回溯）
>
> **历史文档（不再维护）**：
> - [REQUIREMENTS.md](docs/archive/REQUIREMENTS.md) — 最初需求（March 2026）
> - [joint-definition-plan.md](docs/archive/joint-definition-plan.md) — 早期关节系统设计（已实现）

---

## 目录

- [项目背景](#项目背景)
- [核心架构约束（不可随意改动）](#核心架构约束不可随意改动)
- [协作规则](#协作规则)
- [调试惯例](#调试惯例)
- [诊断脚本指南](#诊断脚本指南)
- [Bug 修复历史](#bug-修复历史)
- [核心经验教训](#核心经验教训)
- [附：单行快速检查命令](#附单行快速检查命令)

---

## 项目背景

MotionForge 是 Web 端 3D 模型处理工具，输出标准化的运动资产包（ZIP：manifest / joints / motion / pkf / model.glb）。技术栈：Three.js + Vite。

### 核心系统

- **FK 关节系统**（URDF 风格，四元数 baseTransform，拓扑排序）
- **全局关键帧**（项目级 clips，捕获所有关节 value）
- **PKF 参数化公式**（parameters + steps，支持 AI 生成）
- **GLB ZIP Roundtrip**（schema v4，GLTFExporter 序列化当前场景）

### 关键文件

```
src/
  core/
    AssetLoader.js           # 资产加载分发
    SceneManager.js          # Three.js 场景 / Gizmo
    SelectionManager.js      # 选中与高亮
    KeyframeManager.js       # 关节定义 + 全局关键帧 + FK 求解器 + PKF
    ResultPackageExporter.js # ZIP 结果包导出
  ui/
    EditorUI.js              # 编辑器布局与 UI
  main.js                    # 应用编排（含导入导出流程）
```

---

## 核心架构约束（不可随意改动）

以下设计决定**都是踩过坑换来的**，改动前必须先阅读对应 bug 编号：

1. **`baseTransform` 存四元数**（qx/qy/qz/qw），**不要**改回 Euler — 万向锁（见 [#7](#7-万向锁gimbal-lock旋转丢失-57)）
2. **origin 是 parent-local** 空间（URDF 风格），**不是**世界坐标（见 [#5](#5-gizmo-旋转围绕错误中心)）
3. **关节链驱动用拓扑排序**，不依赖场景树层级（见 [#8](#8-拓扑排序关节链驱动顺序错误), [#10](#10-fk-求解器依赖场景树层级)）
4. **跨 roundtrip 的标识用 name**（joint name / parent_name），**不要**依赖 UUID（见 [#18](#18-parentid-在导入后被错误覆盖), [#19](#19-pkf-joint_def_id-跨导入失效)）
5. **导出 GLB 前必须归零**关节 + 清除选中（避免 emissive 烘焙 / double-apply）（见 [#17](#17-导入后零件高亮不消失), [#20](#20-double-apply导出的-glb-烘焙了驱动态)）
6. **导入后必须两阶段应用**关节（先全零化懒捕获 base，再恢复 value）（见 [#22](#22-链式关节导入后整体下沉)）
7. **懒捕获 base 在 parent=零位时**发生，任何时刻父级驱动态下捕获都是错的（见 [#22](#22-链式关节导入后整体下沉)）
8. **导出前"临时归零 → 导出 → 恢复"必须用 try/finally**，不能把恢复放 try 尾部（见 [#32](#32-导出-zip-异常时卡在零位状态)）
9. **关节链不允许成环**，`setJointDef` 设 parentId 时做环检测（见 [#33](#33-关节链循环依赖静默失效)）

---

## 协作规则

> 完整协作流程（commit / PR / 文档同步 / dev setup）见 [CONTRIBUTING.md](CONTRIBUTING.md)。
> 这里只保留**改本文档**相关的两条红线。

### 1. 修 bug 必须追加 [Bug 修复历史](#bug-修复历史) 条目

编号延续递增（当前最大 #35），格式：

```markdown
### #编号 简短标题

- **症状**：用户看到什么现象
- **排查**：用了什么诊断脚本/方法找到问题
- **根因**：具体是什么代码/机制导致的
- **修复**：改了什么（文件 + 关键变更）
```

### 2. 新增诊断脚本必须更新 [诊断脚本指南](#诊断脚本指南)

- 加到脚本索引表
- 对应新 bug 场景的追加"场景 N"子章节

其余规则（commit message / CHANGELOG / schema 版本 / 文档同步矩阵）见 [CONTRIBUTING.md](CONTRIBUTING.md)。

---

## 调试惯例

### `window.__mf` 钩子

`main.js` 底部注册，浏览器 Console 随时可用：

```js
__mf.THREE              // THREE 命名空间（脚本用它构造 Vector3/Quaternion）
__mf.sceneManager       // SceneManager 实例（sceneRoot / scene / camera / jointGizmo）
__mf.keyframeManager    // KeyframeManager（jointDefinitions / globalClips / applyAllJointDrives / evaluateAllAt）
__mf.selectionManager   // SelectionManager（selectedObject / clearSelection / selectObject）
__mf.editableObjects()  // 当前可编辑对象列表（不含无名 Object3D 包装）
__mf.getJointDefs()     // 所有关节定义的快照
```

### 诊断脚本优先

遇到难定位的 bug，**先写诊断脚本再改代码**。盲改容易引入新 bug。已有脚本见下节。

---

## 诊断脚本指南

本目录包含 7 个浏览器 Console 诊断脚本 + 5 个 PKF 测试脚本，用于定位关节系统、导出导入 roundtrip、动画播放、AI 一键生成相关问题。

### 通用用法

1. 启动 MotionForge (`npm run dev`)，加载模型
2. 按 **F12** 打开 DevTools → **Console**
3. 打开对应 `tests/diag-*.js` 文件，**全选复制**脚本内容
4. 粘贴到 Console，回车 → 看到 `✅ ... 已加载`
5. 按脚本说明调用 `__diagX.xxx()` 方法

所有脚本都通过 `window.__mf` 访问内部状态，只读诊断不修改源代码。

### 脚本索引

| 脚本 | 诊断范围 | 触发命令 |
|------|---------|---------|
| [tests/diag-export-roundtrip.js](tests/diag-export-roundtrip.js) | 导出前/导入后的场景树、关节、动画结构差异 | `__diagRT.snapshot/diff` |
| [tests/diag-roundtrip-transform.js](tests/diag-roundtrip-transform.js) | 节点世界 transform 在 roundtrip 前后的精确差异 | `__diagT.phaseA/B/C/compare` |
| [tests/diag-joint-integrity.js](tests/diag-joint-integrity.js) | 关节定义的 parentId/childId 引用完整性 | `__diagJ.check()` |
| [tests/diag-zero-pose.js](tests/diag-zero-pose.js) | 对比不同"归零策略"的效果 | `__diagZ.testZeroPose/testNaturalPose` |
| [tests/diag-animation.js](tests/diag-animation.js) | 动画播放过程中各时间点的关节状态 | `__diagA.scanClip/at/keyframes` |

---

### 场景 1：导入后模型变形 / 下沉 / 位置错乱

**可能原因**
- GLB roundtrip 层级丢失或根节点被重命名（如 `三向车.glb` → `AuxScene`）
- `alignObjectToGround` 双重对齐或未对齐，导致整体 Y 方向偏移
- 关节 `baseTransform` 在错误时机捕获，造成 double-apply

**检测流程**

```js
// 1. 导出前运行：
__diagT.phaseA()                      // 快照"驱动态"+"零位态"

// 2. 正常导出 ZIP → 导入 ZIP

// 3. 导入后立即运行：
__diagT.phaseB()                      // 快照导入态
__diagT.phaseC()                      // 把关节全部归零，快照导入零位态
__diagT.compare()                     // 输出 4 组对比 + 自动结论
```

**结论对照表**

| 导入态 ≈ 驱动态？ | 导入零位 ≈ 原始零位？ | 结论 |
|---|---|---|
| Yes | Yes | GLB 忠实 + double-apply |
| Yes | No | GLB 忠实 + 零位有偏差 |
| No | Yes | 导入流程改变了 transform |
| No | No | GLB 序列化/反序列化有损 |

---

### 场景 2：关节父级引用丢失 / 零件断开 / 链式关节失效

**典型症状**
- 导入后 `_CS19110 飞出去`
- `_CS198 不跟随运动`
- 关节父级在左侧面板消失

**可能原因**
- 导入时 `parentId` 被错误地覆盖为 `childObj.parent.uuid`（无名 Object3D 包装），而不是按 `parent_name` 解析原始逻辑父级
- `childId`/`parentId` 在 GLB roundtrip 后 UUID 变化，引用断裂

**检测流程**

```js
__diagJ.check()
```

**关注输出**
- **① 场景树结构**：看 `insertedGroup` 是否还在、层级是否正常
- **③ 关节定义完整性**：
  - `parentId === sceneParent? true` + 父级是无名 `Object3D` → **parentId 被错误解析（bug）**
  - `parentId === sceneParent? false` → parentId 指向真实逻辑父级（正确）
- **④ 关节链分析**：有无链式关系（`A ← 依赖 → B`）

---

### 场景 3：导入后播放动画组件整体下沉 / 链式关节错位

**可能原因**
- 导入时 `applyAllJointDrives` 直接用 JSON 里的 `currentValue`（非零）触发拓扑排序
- 父级 joint 先驱动 → 子级 lazy capture 的 base 是父级**驱动态**下的相对位置
- 动画把父级改回零位后，子级相对下沉父级位移量

**检测流程**

```js
__diagA.keyframes()     // 查看关键帧原始数据
__diagA.scanClip()      // 扫描 clip 多个时间点
__diagA.at(2.5)         // 查看指定时间点
```

**关注输出**
- **🔍 检测：哪些节点 Y 方向下降？**：如果多个零件的 Y 变化范围相同 → 整体下沉，说明链式关节 base 错位
- drift warning 里的 `jointParent: XXX` 显示实际链式关系

**修复方向** — 导入时两阶段应用关节（已实现）：
1. 先把所有 `currentValue = 0`
2. `applyAllJointDrives` → 所有关节在零位懒捕获 base
3. 恢复真实 `currentValue`
4. 再 `applyAllJointDrives` → 正常驱动

---

### 场景 4：Gizmo 拖动旋转突然跳变 360°

**原因** — 四元数双重覆盖：`q` 和 `-q` 表示同一旋转，但 `2 * atan2(sinHalf, cosHalf)` 提取的角度会跳 ±2π。TransformControls 大角度时可能把 current quaternion 归一化到"最短路径"表示，触发符号翻转。

**检测方法** — 不需要专门脚本，直接拖动观察。

**修复方向**（已在 [SceneManager.js](src/core/SceneManager.js) 修复）：角度解缠，保持相邻帧 angle 差值 ≤ π，超过就加减 2π 补偿：

```js
if (this._gizmoLastAngle !== undefined) {
  while (angle - this._gizmoLastAngle > Math.PI) angle -= 2 * Math.PI;
  while (angle - this._gizmoLastAngle < -Math.PI) angle += 2 * Math.PI;
}
this._gizmoLastAngle = angle;
```

每次新拖拽时重置 `_gizmoLastAngle = undefined`。

---

### 场景 5：判断"归零策略"是否正确

**用途** — 修改导出流程时，验证 `applyJointDrive(value=0)` 是否真的能把模型还原到自然零位。

**检测流程**

```js
__diagZ.snapshot("before")
__diagZ.testNaturalPose()
__diagZ.testZeroPose()
__diagZ.snapshot("zeroKeepBase")
__diagZ.restore()
__diagZ.testZeroPoseClearBase()
__diagZ.snapshot("zeroClearBase")
__diagZ.restore()
__diagZ.compare()
```

**结论对照**
- **方案A (`before` 和 `zeroKeepBase` 只差有 value 的关节)**：归零生效 ✅
- **方案B (和 `before` 完全一致)**：清空 base → 懒捕获从**驱动态**重建 → 没归零 ❌

---

### 场景 6：模型某片零件一直发光高亮

**原因** — `SelectionManager` 高亮机制 clone material 并修改 `emissive`。导出前没清除选中 → GLTFExporter 把带 emissive 的 material 烘焙进 GLB。

**快速检测**

```js
let c = null;
__mf.sceneManager.sceneRoot.traverse(o => { if (o.name === '_CS19110') c = o; });
console.log('emissive:', c?.material?.emissive);
// 如果 emissive 不是 (0, 0, 0) 就是被烘焙进去了
```

**修复方向**（已实现）— 导出前 `selectionManager.clearSelection()`，导出后 `selectionManager.selectObject(savedSelection)`。

---

## Bug 修复历史

按时间顺序记录开发过程中遇到的问题、根因分析和修复方案。

### 阶段一：关节系统 v1 基础

#### #1 Gizmo 拖动时视口卡死
- **症状**：选中对象后 gizmo 出现，但拖动时整个视口冻结，鼠标事件无响应
- **排查**：OrbitControls 和 TransformControls 都在监听 pointer 事件
- **根因**：SelectionManager 和 jointMarker 的 capture listener 劫持了事件
- **修复**：鼠标 hover 到 gizmo handle 时跳过场景选择 `if (this.sceneManager.jointGizmo?.axis) return;`

#### #2 配置关节后对象瞬间"飞走"
- **症状**：刚给对象加上关节，对象就从原位置跳到另一个位置
- **根因**：`baseTransform` 缺失，`applyJointDrive` 把 value=0 当成"需要还原到未定义的零位"
- **修复**：`applyJointDrive` 里加**懒捕获**—— base 为 null 时，从当前 world 状态反算并存储；onChange 里也立刻捕获一次

#### #3 reparent（insertGroup）后对象飞走
- **症状**：把对象插入新 group 做父级包装后，对象再次飞走
- **根因**：baseTransform 是相对**旧父级**捕获的，换父级后坐标系不同
- **修复**：`rebindJointBaseTransform(obj)` 在任何 reparent 后清空 `def.baseTransform = null`，让下一帧懒捕获重建

#### #4 Gizmo 平移（prismatic）瞬间弹回
- **症状**：拖动 prismatic gizmo 时对象跟随一段后"弹回"原位
- **根因**：delta 用 `object.position`（局部空间）计算，当父节点有旋转时，世界 Y 方向的拖拽在局部空间会分散到 XYZ
- **修复**：Gizmo delta 和 `applyJointDrive` 的 prismatic 都改用**世界空间**计算，投影到关节的世界轴方向

#### #5 Gizmo 旋转围绕错误中心
- **症状**：绕 origin 旋转变成绕对象自身 pivot 旋转
- **根因**：origin 存的是世界坐标，代码按 parent-local 解读
- **修复**：改为 **URDF 风格**—— origin 存**关节父级 local** 空间。父节点动，origin 自动跟

#### #6 Gizmo 旋转离散跳变
- **症状**：rotate gizmo 拖动时对象不是平滑旋转，而是跳跃式离散变化
- **根因**：TransformControls 围绕对象 pivot 旋转，不是围绕 def.origin
- **修复**：onChange 回调里 `applyJointDrive(force=true)` 强制用自己的 origin-based 旋转公式重写 transform

#### #7 万向锁（Gimbal Lock）旋转丢失 57°
- **症状**：某些关节旋转到 ~90° 时 Euler 分解失真，实际旋转少 57°+
- **根因**：`baseTransform` 用 Euler (rx, ry, rz) 存储，`Quaternion → Euler → Quaternion` 在 Y ≈ π/2 附近有奇点
- **修复**：`baseTransform` 改存**四元数** (qx, qy, qz, qw)，全程避免 Euler 转换

#### #8 拓扑排序：关节链驱动顺序错误
- **症状**：父关节和子关节同时驱动，但渲染先后顺序错，导致子关节计算用的是父关节旧状态
- **根因**：按场景树深度排序，但关节链可能跨越兄弟节点（e.g. 门架和叉齿平级）
- **修复**：`applyAllJointDrives` 改用 **Kahn's 拓扑排序**，按 `jointA.childId === jointB.parentId` 关系决定顺序

---

### 阶段二：架构重构

#### #9 per-object 关键帧混乱
- **症状**：用户选中对象 A 添加关键帧，切到对象 B 再添加，两个 clip 互相看不见
- **根因**：关键帧是 per-object 的
- **修复**：重构为**全局关键帧** —— 项目级 `globalClips`，每个 keyframe 字典捕获**所有**关节当前 value

#### #10 FK 求解器依赖场景树层级
- **症状**：场景树 reparent 后，关节链驱动关系就断了
- **根因**：`applyJointDrive` 用 `childObj.parent` 作为"关节父级"
- **修复**：关节定义独立存 `parentId`，应用时 `nodeMap.get(def.parentId)` 查找——与场景树层级解耦

#### #11 旧关节点系统残留
- **症状**：~300 行浮动面板、红/黄球 gizmo、jointPoints 数组等旧代码杂乱
- **修复**：全部删除，保留 FK 关节定义单一数据源

---

### 阶段三：导出 / 导入 Roundtrip

#### #12 ZIP 导出后再导入模型变形
- **症状**：模型层级被压扁、零件位置错乱
- **排查**：`diag-export-roundtrip.js` 对比导出前后场景树
- **根因**：GLTFExporter 对 `THREE.Scene` 节点的处理和 GLTFLoader 不一致，Loader 总是在外面包一层新 Scene
- **修复**：导出时不传 Scene，传 `sceneRoot.children` 数组

#### #13 导入后节点数量少 4 个（19 vs 23）
- **症状**：插入的 group 丢失
- **根因**：第一次修 #12 时只导出 `children[0]`，漏掉其他兄弟
- **修复**：导出 **ALL** 有意义子节点（过滤掉灯光/相机/Helper）

#### #14 导入后模型整体下沉 1.65 单位
- **症状**：模型陷进网格下面
- **排查**：`diag-roundtrip-transform.js` phaseA/B/C 对比
- **根因**：`alignObjectToGround` 把 Scene.position.y 调整了 1.65，这个偏移被烘焙进 GLB 子节点；导入时 `skipAlign: true` 不再调整
- **修复**：移除 `skipAlign`，让 `alignObjectToGround` 正常运行。配合 #20 的零位导出，不会再有双重对齐

#### #15 导入后根节点被重命名为 "AuxScene"
- **症状**：左侧场景树顶层节点名字变了
- **根因**：GLTFExporter 不保留原始 Scene 的名字
- **修复**：导入后 `root.name = manifest.source.file_name` 恢复

#### #16 导入后场景树所有节点整体偏移
- **症状**：所有节点（含没关节的）都有相同偏移
- **根因**：同 #14（对齐偏移被烘焙）
- **修复**：同 #14

#### #17 导入后零件高亮不消失
- **症状**：一个零件一直发蓝绿色光
- **排查**：`c.material.emissive` 是蓝绿色（高亮色）
- **根因**：SelectionManager 高亮 clone material 并改 emissive，导出时带高亮 → GLTFExporter 烘焙进 GLB
- **修复**：导出前 `selectionManager.clearSelection()`，导出后恢复

#### #18 `parentId` 在导入后被错误覆盖
- **症状**：导入后链式关节变独立 —— _CS19110 不跟随 _CS198 运动
- **排查**：`diag-joint-integrity.js` 显示 `parentId === sceneParent`（无名包装）
- **根因**：导入代码 `parentId: parentObj?.uuid || d.parent_id || null`，其中 `parentObj = childObj?.parent`，总是取 scene parent（无名包装），覆盖了保存的逻辑父级
- **修复**：
  - 导出时 joints.json 新增 `parent_name` 字段
  - 导入时按 `parent_name` 在 `objectsByName` 里查找逻辑父级
  - 找不到再兜底到 `childObj.parent`

#### #19 PKF `joint_def_id` 跨导入失效
- **症状**：导入后 PKF 步骤找不到对应关节
- **根因**：PKF step 存的是运行时 UUID，roundtrip 后 UUID 全变
- **修复**：PKF step 只存 `joint`（关节**名字**），导入时按名字解析回当前 UUID

---

### 阶段四：归零策略

#### #20 Double-apply：导出的 GLB 烘焙了驱动态
- **症状**：非零 value 的关节导入后位置不对，视觉上叠加了两次驱动
- **排查**：对比 stored base vs 导入后的 should_be
- **根因**：GLTFExporter 烘焙的是**当前驱动后**的 transform，导入后 applyJointDrive 又基于这个 transform 再施加一次 value → double-apply
- **修复方向**：导出前先归零

#### #21 第一版零位导出失败（清空 base + value=0）
- **症状**：导入后仍然有漂移，诊断发现 GLB 里的 transform 不是零位
- **排查**：`diag-zero-pose.js` 对比方案 A（保留 base）和方案 B（清空 base）
- **根因**：清空 `baseTransform` 后 `applyAllJointDrives` 懒捕获从**当前驱动态**重建 base → GLB 仍然存驱动态
- **修复**：改为**方案 A** —— 只设 `currentValue=0`，**保留**现有 base。现有 base + value=0 → 正确还原到零位

#### #22 链式关节导入后整体下沉
- **症状**：动画播放时所有链式关节零件整体下沉相同距离（例如都下降 1.52 单位）
- **排查**：`diag-animation.js` 扫描 clip 发现 4 个节点 Y 变化范围都等于 `KF0 - KF1` 的 _____10 位移量
- **根因**：导入时直接用 JSON 里的 `currentValue`（非零）触发 `applyAllJointDrives`。拓扑排序先驱动父级 → 父级移动 → 子级懒捕获 base 时捕获的是**父级已驱动态下**的相对位置。动画把父级改回零位后，子级相对下沉父级的位移量
- **修复**：导入时**两阶段应用**：
  1. 先把所有 `currentValue = 0`
  2. `applyAllJointDrives` → 所有关节在零位懒捕获 base
  3. 恢复真实 `currentValue`
  4. 再 `applyAllJointDrives` → 正常驱动

---

### 阶段五：Gizmo 交互

#### #23 旋转 gizmo 大角度跳变 360°
- **症状**：逆时针拖动叉齿到某个角度后继续拖，角度瞬间跳变 360°
- **根因**：**四元数双重覆盖**。`q` 和 `-q` 代表同一旋转，TransformControls 大角度时会把 current quaternion 归一化到"最短路径"表示，触发符号翻转。提取的 `2 * atan2(sinHalf, cosHalf)` 因此跳 ±2π
- **修复**：角度**解缠** —— 保持相邻帧 angle 差值 ≤ π，超过就加减 2π 补偿。每次新拖拽重置 `_gizmoLastAngle`

---

### 阶段六：其他细节

#### #24 GridHelper 颜色警告
- **症状**：Console 一直打印 `THREE.Color does not support alpha` 警告
- **根因**：`GridHelper` 不支持 rgba 颜色
- **修复**：换成预算好的实色 hex（`0x6a6a6a` / `0x626262`，在 `#585858` 背景上视觉等效半透明灰）

#### #25 材质高亮影响其他对象
- **症状**：一个对象被选中，所有共享同一材质的对象也都发光
- **根因**：SelectionManager 直接修改 `material.emissive`，material 是共享引用
- **修复**：修改前 `material.clone()`，只改这个对象自己的拷贝

#### #26 "从关键帧生成"功能失效
- **症状**：全局关键帧重构后，旧的"从选中对象的 channel 生成"函数还在读取 per-object clips
- **修复**：重写该函数用全局 keyframes + joint_values

---

### 阶段七：git 仓库维护

#### #27 git push 失败（corrupt loose object）
- **症状**：`git push` 报 `inflate: data stream error (incorrect data check)` + `corrupt loose object`
- **排查**：`git fsck` 显示损坏的 blob 属于某个 `.zip` 导出包
- **根因**：大二进制 ZIP 被 commit 到 git，对象压缩写入时损坏（常见于磁盘/杀毒软件干扰）
- **修复**：
  - 删除损坏的 `.git/objects/xx/xxxxx` 文件
  - `git reset --soft` 撤回 commit（保留源代码改动）
  - `zip/` 加入 `.gitignore`
  - `git rm --cached -r zip/` 把已提交的 ZIP 移除暂存
  - 重新 commit（只含源代码）
  - `git reflog expire --expire=now --all && git gc --prune=now` 清理悬挂引用
  - 验证 `git fsck` 干净后 push

---

### 阶段九：导出导入 + PKF 循环闭环修复（v12）

#### #31 PKF 循环播放时关节卡在末态 2 秒后瞬跳回原点
- **症状**：PKF 驱动播放一遍正常，循环到第二遍时，关节（尤其 `三向车.glb`）在末态停留 2-5 秒，然后瞬间跳回 0，再开始动画
- **排查**：看 `applyPkfAtTime` + `evaluatePkfAt` 行为：
  - 旧逻辑：`if (t < step.t_start || t > step.t_end) return;` 完成的 step 和未到的 step 都跳过，`currentValue` 保持上次写入值
  - 模拟循环：t 从 duration（如 10）wrap 回 0，`三向车.glb` 的 step 是 t=[5.5, 8]，在 t=0 时不触发 → 关节保留 y=3（上次末态）→ 到 t=5.5 时 step 激活，progress=0 → 值瞬间变 0
- **根因**：两处合成：
  1. `evaluatePkfAt` 对已完成 step 不输出结果 → 完成后的关节值无人维护
  2. `applyPkfAtTime` 不重置关节 → 上一轮的末态持续到下一轮某个 step 激活
- **修复**：
  1. [KeyframeManager.js evaluatePkfAt](src/core/KeyframeManager.js#L903)：`t >= t_end` 时 progress=1（hold at value_end），不再 return；按 t_start 排序确保多步驱动同关节时时间晚的覆盖早的
  2. [main.js applyPkfAtTime](src/main.js#L828)：每帧先把所有 PKF 触及的关节 `currentValue = 0`，再应用 results
- **效果**：循环第二遍回到 t=0，所有关节干净归零再重新开始动画，无卡顿无瞬跳

#### #30 导出 joints.json 保存了驱动态 currentValue → 导入后停在末态
- **症状**：从 PKF 播放末态点导出 ZIP，导入后模型直接显示动画末态（门架抬着、叉齿转着），不是自然零位
- **排查**：看 `exportPackageBtn` 处理逻辑：
  - GLB 确实在零位序列化（savedValues 保存后 `currentValue=0` + `applyAllJointDrives`）
  - **但** joints.json 的 currentValue 又写回了 `saved.currentValue`（用户点导出时的驱动值）
  - 导入时两阶段应用：零位捕获 base → 恢复真实 value → `evaluateAllAt(0)`
  - 如果没有关键帧（纯 PKF 工作流），`evaluateAllAt(0)` 提前 return → currentValue 保持 JSON 里的驱动值 → 视觉上停在末态
- **根因**：导出写 joints.json 时把 "GLB 已归零" 和 "joints.json 值" 两个一致性约束破坏了
- **修复**：[main.js](src/main.js#L1440) 导出时 joints.json 的 currentValue 写死 0（GLB 零位 + joints.json 零位一致）。动画数据在 motion.json 关键帧和 pkf.json 公式里，不受影响
- **经验教训**：GLB 里烘焙的 transform 和 JSON 里的关节值**必须语义一致**，不能一边零位一边驱动态，否则导入后会出现"视觉上和数据层不一致"

#### #35 Fixed 类型关节不跟 joint parent 动
- **症状**：用户把 A 的 joint parent 设成 B、A 的 type 设成 fixed（想让 A 刚性跟随 B），拖动 B 的滑块时 A 不跟随
- **排查**：看 `applyJointDrive` 第 239 行 `if (def.type === 'none' || def.type === 'fixed') return;` — fixed 类型直接 early return，连懒捕获都不走，什么都不写到 child
- **根因**：设计时认为 "fixed = 不动 = 无需 apply"，但这只在 joint parent == scene graph parent 时成立。当两者不同时（我们整个关节系统的核心设计就是两者解耦），fixed 子级完全由 scene graph parent 决定运动 → 不跟 joint parent
- **修复**：[KeyframeManager.js](src/core/KeyframeManager.js) `applyJointDrive` 去掉 fixed 的 early return，加 `else if (def.type === 'fixed')` 分支：`newWorldPos = baseWorldPos; newWorldQuat = baseWorldQuat;`。等价于 prismatic value=0：每帧根据 joint parent 最新世界矩阵 × base 计算 child 世界位置
- **经验教训**：**关节类型的语义要一致**。revolute/prismatic 都是"joint parent 说了算"（URDF 风格），fixed 也应该是。早期为了省一点性能给 fixed 走快捷路径，破坏了这个一致性。现在 fixed 符合 URDF 标准：刚性连接到 joint parent，无自由度但跟随运动

#### #52 fork_anchor_zero 终局：自动算 bbox 底面中心（= "子对象底部"按钮公式，但不写 def.origin）
- **症状**：#51 读 joint.origin 当承载锚点，用户指出 **origin 是旋转支点**（URDF 关节原点），挪它会破坏关节旋转行为
- **用户洞察**：既然"子对象底部"按钮的算法（`bbox.center.x / z + bbox.min.y`）就能算出好位置，**自动走一遍这个算法就行，不要写进 def.origin**
- **修复**：
  - [KeyframeManager.js computeForkAnchorZero](src/core/KeyframeManager.js)：直接 `Box3().setFromObject(forkObj)` + `anchor = (center.x, min.y, center.z)`（和按钮同公式）
  - [KeyframeManager.js applyReparentEventsAtTime](src/core/KeyframeManager.js) snap：同逻辑，`desiredWorldPos = (center.x, min.y + cargoH/2, center.z)`
  - 删 3 个不再用的 helpers：`_findForkTineMesh` / `_computeForkForwardExtreme` / `_computeJointOriginWorld`；删 `_forkForwardDir` 缓存
  - 测试 31/31 通过（#50 的 3 个 forward-extreme case 改写为"cargo 位置不影响 anchor"）
- **经验教训（六轮迭代总结）**：
  1. **承载锚点 ≠ 关节原点**。关节原点有它自己的 URDF 语义（旋转支点 / 自由度参考），不能当"吸附点"复用。两个概念得分开 —— 即使它们**物理上可能在同一位置**
  2. **UI 按钮的算法就是好的自动化起点**。用户在 UI 里已经接受"子对象底部 = bbox.center + bbox.min.y"这个心智模型；我们代码里用同一公式自动算，用户心里的模型和代码行为一致，不需要学新概念
  3. **合并 mesh 下 bbox 不代表"叉齿几何"本身**。但对 "demo 演示" 用途，bbox 底面中心已经足够精确 —— 用户真要极致精准，可以手动挪黄球（#51 走过的死路）或在未来引入"承载点 marker" UI（C 方案）

#### #51 误入歧途：读 joint.origin 当承载锚点（已回退）
- **意图**：让用户通过"子对象底部"按钮 / 手动 X/Y/Z 输入直接控制 fork_anchor_zero 位置
- **实现**：`_computeJointOriginWorld` 读 `_CS19110.origin`（parent-local UI Z-up），swap y/z 后 `applyMatrix4(jointParent.matrixWorld)` 转世界
- **致命错误**：`def.origin` 是**关节的旋转/平移支点**（URDF 里 `<origin>`），不是"cargo 吸附点"。点"子对象底部"按钮**同时**改了这两件事，用户以为在调 cargo 对齐其实挪了旋转轴
- **回退**：#52 改为"自动走按钮同公式 + 不写 origin"，解耦两个概念
- **经验教训**：**复用 UI 概念时要区分数据来源 vs 数据用途**。按钮 → origin 这条数据流合理（关节旋转支点确实放在子对象底部），但"cargo 承载点"不在这条流里。想复用按钮算法 → 直接抄公式，别抄存储位置

#### #50 fork_anchor_zero 水平位置改用"朝 cargo 方向的 bbox 前端极值"（合并 mesh 下近似叉齿尖，已在 #52 被取代）
> **注**：#50 经过 `50b`（sanitize AI 违规）→ `50c`（数学 bug 修）→ `50d`（时序 bug 修）三次修正后，#51/#52 进一步改变了承载锚点策略。以下保留原始设计记录做历史对照。

- **症状**：#49 修好 z 方向后，水平方向仍有偏差 —— 三向车.glb 播放到 attach 时 cargo 在叉车**前方**没贴上（bbox.center.z 被门架往后拉 ~0.9m）
- **根因**：合并 mesh 的 `_CS19110` bbox 覆盖 整车（叉齿+门架+支架），`bbox.center.x/z` = **整车几何中心**，不是叉齿尖位置。PKF 把 bbox.center 对到 cargo → 叉齿尖在 cargo 前方 ~0.9m 处
- **修复思路（A1 方案，和用户讨论后定的）**：
  - 不硬编码"前进轴在 x 还是 y"（不同模型约定不同）
  - 不依赖 role="车体前进" joint axis（避免关节坐标系转换复杂度）
  - **用 cargo 世界位置相对 fork bbox 中心的方向作 forward**：朝哪方向有 cargo，就把 bbox 往哪边推
- **实现**：
  - [KeyframeManager.js](src/core/KeyframeManager.js) 新增 `_computeForkForwardExtreme(box, cargoWorldPos)` helper：
    - forward = `normalize(cargoPos_xz - bboxCenter_xz)`
    - 水平极值点 = `bboxCenter + forward × (|half.x × dir.x| + |half.z × dir.z|)`（投影定理算 bbox 沿任意方向的半长）
    - 返回 `{x, z, forwardDir}`；cargo 缺失或重合时退化到 bbox 中心
  - `computeForkAnchorZero`：x/z 用 forward 极值，y 保持 min.y（#49）；缓存 `_forkForwardDir` 供 snap 复用
  - `applyReparentEventsAtTime` snap-attach：读缓存 `_forkForwardDir`，对**当前** fork bbox（post-motion）算前端极值 → cargo 底中心落在那里
  - `invalidateForkAnchorZero`：一并清 `_forkForwardDir`
  - [tests/unit/keyframe-manager.test.js](tests/unit/keyframe-manager.test.js)：32/32（+2 case：cargo 缺失退化 center、斜对角 cargo 验归一化方向）
- **三向车.glb 验算**：
  - fork bbox center (threejs) = (0.484, ?, 2.125)；size = (1.188, ?, 1.571)
  - cargo (threejs) = (5, ?, 5)（UI Z-up swap 前）
  - forward (xz) = normalize(4.516, 2.875) ≈ (0.843, 0.538)
  - extent = 0.594 × 0.843 + 0.785 × 0.538 ≈ 0.923
  - 新 anchor_x = 0.484 + 0.843 × 0.923 ≈ **1.26**
  - 新 anchor_z = 2.125 + 0.538 × 0.923 ≈ **2.62**（UI y）
  - 相比老 anchor (0.484, 2.125) 往 cargo 方向推进 0.923m → fork 少走 0.92m → 叉齿尖正好到 cargo 位置
- **snap-attach 对应调整**：
  - attach 时 fork 已经到 cargo 附近，此时"从 fork 到 cargo"向量接近 0，方向退化
  - 所以 snap 读的是**生成时缓存的 forward 方向**，配合**当前**（post-motion）fork bbox → 得到 cargo 方向的前端极值
  - 零 teleport 成立的前提：snap 的水平位置算法和 PKF 公式目标同源
- **已知局限**：
  - forward 方向由 cargo 位置决定 → cargo marker 移动后需重新 🚀 生成 PKF（这其实是合理的，移了 cargo 本来就该重新规划）
  - 对 "cargo 在 fork 正上方/正下方"（水平方向完全重合）退化到 bbox.center — 这种场景很少见
  - 不处理"多个 cargo"：`reparentEvents` 里第一个 attach event 的 child 决定 forward 方向
- **下一步**（如果还有偏差，用户已表态偏向 C 方案）：UI 加"承载点标记"让用户在叉齿上拖一个红点，彻底替代所有几何启发式
- **经验教训**：
  1. **纯几何启发式的极限：4 次迭代（#37 center → #47 max → #49 min.y for z → #50 forward extreme for x/z）才摸到能用的形状**。每一次都暴露一种模型建模方式的反例。这说明自动推断"叉齿在哪"本质上是**有损的**，靠假设堆积
  2. **决定让 cargo 参与几何计算的时机**。#50 让 fork_anchor_zero 依赖 cargo 位置（之前是纯 fork 属性）。增加了耦合，但换来对任何模型朝向（x/y/z/斜着）都 work 的鲁棒性。这是合理权衡：生成 PKF 本来就是"为这个 cargo 规划这次动作"，fork anchor 为此 cargo 而定合情合理
  3. **缓存 forward 方向给 snap 用的巧思**。snap 时 cargo 已经被 fork "吸"过去了，方向信息在那个时刻会退化。缓存生成时的方向让 snap 和 PKF 公式层共用同一个"前端"语义

#### #49 fork_anchor_zero 改用 bbox.min.y（叉齿底面）—— 复用 UI "子对象底部" 概念
- **背景**：#47/#48 两次失败后，探索出 bbox.min.y 是比 center.y / max.y 都更稳健的启发式。这是**第三种几何语义尝试**，留作经验档案
- **动机**（用户 insight）：关节配置 UI 里早就有"**子对象底部**"按钮（基于 bbox.min.y），AI 打关节用户已经很习惯这个概念；直接复用，一致性好
- **选型推理**：
  - `bbox.center.y`（v14.1 初版 / #48）：cargo 视觉陷 fork ~h/2 米
  - `bbox.max.y`（#47 尝试）：假设"max.y = 叉齿顶面"；对合并 mesh（三向车）失败，max.y 是**门架顶**
  - `bbox.min.y`（#49 当前）：假设"min.y = 叉齿底面"；对合并 mesh 成立（min.y ≈ 贴地的叉齿底），对标准叉车都对
- **改动**：
  - [KeyframeManager.js computeForkAnchorZero](src/core/KeyframeManager.js)：锚点 y 从 `center.y` 改为 `min.y`
  - [KeyframeManager.js applyReparentEventsAtTime](src/core/KeyframeManager.js)：snap-attach `desiredWorldPos.y = min.y + cargoH/2` → cargo 底面贴叉齿底面
  - [tools/conversion-service.js](tools/conversion-service.js)：L1/L2 prompt 的 z 公式改回 `cargo_pos_z - cargo_height/2 - fork_anchor_zero_z`；说明"fork_anchor_zero_z 是叉齿底面"
  - [src/main.js ensurePkfCoversAttachPoint](src/main.js)：z 目标恢复 `cargoObj.position.z - cargoHeight/2 - faz`
  - [tests/unit/keyframe-manager.test.js](tests/unit/keyframe-manager.test.js)：期望值 `-0.2`（threejs.min.y for box size 1 at y=0.3）
- **三向车.glb 验算**（合并 mesh 模型）：
  - bbox.min.y = 0.042（叉齿底面贴地）
  - PKF value_end = 0.6 - 0.5 - 0.042 = 0.058（门架升降 5.8cm）
  - 运行后叉齿底面到达 cargo 底面高度（0.1m）→ snap-attach 零 teleport
- **已知假设与局限**（遇到失败再升级）：
  - 假设 "叉齿是 fork 子树的最底部 mesh" —— 对标准立式叉车都成立
  - **可能失效场景**：
    1. 关节 parent 包含轮子 / 底盘 mesh → bbox.min.y 是轮底，不是叉齿底
    2. 侧挂叉齿（min.y 不代表承载面）
    3. 倒挂夹爪（min.y 意义完全不同）
  - **极薄叉齿视觉**：bbox.min.y = 叉齿底面，cargo 底贴叉齿底 = 叉齿穿进 cargo 几厘米（≈叉齿厚度）。视觉上叉齿基本看不见（尖端插入 cargo 底部 1-2cm），符合叉车物理
  - **厚叉齿 / 合并 mesh 视觉**：cargo 底贴整个 fork 结构底，fork 上部分（门架）会穿进 cargo 里显形
- **升级路径**（如果遇到不 work 的模型）：
  - 短期：在 `computeForkAnchorZero` 加可配置 `TINE_THICKNESS_OFFSET`（默认 0，需要时调 0.05）
  - 长期：UI 加"承载高度偏移"输入框到 joint 配置面板（就在"子对象底部/中心"按钮旁），让用户显式指定 → 彻底结束猜
- **经验教训**：
  1. **先复用已有 UI 概念，再发明新概念**。"子对象底部"按钮是用户已验证好用的心智模型；fork_anchor_zero 用同源逻辑 → 一致性和可解释性都更强
  2. **启发式要分层**：`bbox.center`（无假设，保守）→ `bbox.min`（假设叉齿在底，标准叉车对）→ `bbox.max`（假设叉齿在顶，特殊场景）。当前选中间偏保守的 min（比 center 更贴近物理，比 max 更稳）
  3. **第三次尝试（#47/#48/#49）教会的**：**几何启发式注定在某些模型失败**。最终解法是 UI 让人做判断 —— 但在做 UI 前，min.y 是三者里最可靠的默认值
  4. **记录失败也是资产**。#47 / #48 / #49 这三轮迭代的 bug log 一起看，就能让未来的我（或另一个 AI）避免再走同样的路

#### #48 回退 #47 "叉齿顶面"语义（保留 AI 维度兜底）—— 合并 mesh 模型下 bbox.max.y 指向门架顶不是叉齿顶
- **症状**：#47 上线后，三向车.glb 🚀 一键生成播放时**叉齿下沉穿地 0.55m，cargo 飘空**
- **排查**（tests/diag-fork-anchor.js + Console 片段）：
  - `_CS19110` 子树只有**一个 mesh**（叉齿+支架+门架合并建模），bbox：min.y=0.042 / max.y=0.592 / size.y=0.549
  - 新语义 `fork_anchor_zero_z = max.y = 0.592` → **是整个门架顶端高度**，不是叉齿顶面
  - PKF 求值：`cargo_pos_z(0.6) - cargo_height/2(0.5) - fork_anchor_zero_z(0.592) - 0.1(AI 自加) = -0.592` → 门架升降关节下降 0.592m → 穿地
- **根因**：`_findForkTineMesh` 的 "min.y 最小 mesh" 启发式在**没拆子 mesh 的模型上无效**（只有一个 mesh 可挑），那个 mesh 的 bbox 覆盖整个叉齿+门架结构，`max.y` 是门架顶不是叉齿顶 → #47 改用 bbox.max.y 当承载面是错的
- **修复**：
  - [KeyframeManager.js](src/core/KeyframeManager.js) `computeForkAnchorZero` + `applyReparentEventsAtTime` snap-attach 回退到 `box.getCenter()`（v14.1 语义）
  - [tools/conversion-service.js](tools/conversion-service.js) L1/L2 prompt 的 z 方向公式回退到 `cargo_pos_z - fork_anchor_zero_z`（不减 cargo_height/2）；加"禁止凭空加常数"警告（AI 这次自己在公式里加了 `- 0.1`，把下沉加剧 10cm）
  - [src/main.js](src/main.js) `ensurePkfCoversAttachPoint` z 目标位移去掉 `- cargoHeight/2`（#47 的偏移）
  - [tests/unit/keyframe-manager.test.js](tests/unit/keyframe-manager.test.js) case #2 期望回退到 `bbox.center.y` —— 30/30 通过
  - **保留** `ensurePkfCoversAttachPoint` 前端兜底（#47 的另一半，不受本回退影响，仍有价值：AI 漏生成维度时自动补）
- **代价**（已接受）：cargo 视觉上 center-to-center 对齐（陷进叉齿 ~cargo_h/2 米），不符合真实叉车托底物理。**彻底解决**需要另一条路径：让用户在 cargo marker 或 joint 配置里直接指定"承载高度偏移"（把物理对齐参数下放到人，而不是从几何启发式猜）
- **经验教训**：
  1. **启发式 = 对部分模型的假设，不是通用方案**。`_findForkTineMesh` 的 min.y 挑法只在"叉齿是独立 mesh"时有效；合并 mesh 的模型上这个挑法退化成"挑唯一那个"
  2. **依赖 bbox 分量语义要先验证前提**。`bbox.max.y = 叉齿顶面` 只有在 mesh 恰好只含叉齿时成立；含了门架就变成门架顶。改几何语义前必须确认所有可能的输入形态
  3. **AI 在公式里自加常数是隐藏风险**。即使 prompt 不提及，AI 会"想当然"地加 `- 0.1` 做"缓冲"。必须在 prompt 里**显式禁止**凭空常数，只留 approach_gap 作为可调缓冲
  4. **回退不等于失败**。#47 的前端兜底（`ensurePkfCoversAttachPoint`）是独立价值的改动，单独保留；只回退几何语义部分。**分层回退**比全部回退更稳

#### #47 吸附姿态改为"叉齿顶面托住 cargo 底面" + AI 维度兜底（消除 attach 瞬间 teleport）
- **症状**：🚀 一键生成后播放到 t=3.98→4.01，cargo 明显下跳到叉齿上。v14.1 已让 approach_gap=0 且 snap-attach 和 fork_anchor_zero 同源，理论上应该零 teleport，但实际仍有 ~0.3m 视觉跳变
- **根因（两个叠加）**：
  1. **AI 漏生成维度**：AI 经常只输出"车体前进"step，漏"门架升降"step → attach 时 fork 水平到位但垂直还在零位 → snap 把 cargo 拽到 fork 中心（UI z 方向 ~0.3m 下跳）
  2. **吸附语义不物理**：center-to-center 对齐（cargo 中心 = fork 中心）让 cargo"陷进"叉齿里，不符合真实叉车"叉齿托底"物理；即使 AI 完整生成 PKF 也有视觉违和
- **修复**：
  - [KeyframeManager.js computeForkAnchorZero](src/core/KeyframeManager.js)：锚点从 `box.getCenter()` 改为 `(center.x, box.max.y, center.z)` —— 叉齿**顶面**中心
  - [KeyframeManager.js applyReparentEventsAtTime](src/core/KeyframeManager.js)：snap desiredWorldPos 改为 `(center.x, box.max.y + cargoH/2, center.z)` —— 让 cargo 底面贴叉齿顶面
  - [conversion-service.js](tools/conversion-service.js) L1/L2 prompt：门架升降公式加 `- cargo_height/2` 偏移；明确要求 attach 前 x/y/z 三维都覆盖
  - [main.js ensurePkfCoversAttachPoint](src/main.js)：前端收到 L2 PKF 后**自动检查** x/y/z 目标位移 >THRESHOLD 是否都有 step 覆盖 attach 前时间；缺的按 role 查关节自动注入 step；找不到 role 关节则加 warning
  - [tests/unit/keyframe-manager.test.js](tests/unit/keyframe-manager.test.js) case #2 期望值从 `bbox.center.y` 改为 `bbox.max.y`
- **经验教训**：
  1. **吸附语义应该符合物理直觉**。center-to-center 是数学上简单但视觉上错 —— 真实叉车是叉齿顶面托底。用户的心智模型 = 物理模型；代码的参考点应该和它对齐
  2. **LLM 输出不能假定完整覆盖**。即使 prompt 里明确要求，AI 仍会偷懒漏某维度。关键数据通路必须有前端兜底（check + auto-fill），不能只靠 prompt 祈祷
  3. **双保险比单保险稳**。本次 prompt 改和前端兜底两边都做；未来 AI 模型变更或 prompt 退化时，兜底层继续托住；如果哪天 AI 特别强可以关掉兜底当降级

#### #46 F11 + F13：restoreState 保留 role + fork_anchor_zero hash-based 自动失效
- **F11（DEBT #3）防御**：[KeyframeManager.js restoreState](src/core/KeyframeManager.js) 恢复 joint 时，如果 snapshot 里 `role` **字段缺失**（`Object.prototype.hasOwnProperty.call(d, 'role') === false`）→ 保留当前值，不清空。显式 `role: ''` 仍接受（合法清空）。场景：很老版本序列化的 snapshot 或外部构造的状态缺 role 字段
- **F13 hash-based cache**：[`_computeForkAnchorInputsHash`](src/core/KeyframeManager.js)（新增私有方法）计算 `reparent events + 叉齿子树 mesh uuids` 的签名。`computeForkAnchorZero` 每次 call 对比 hash——未变直接返回缓存对象；变了才重算。原来 3 处显式 `invalidateForkAnchorZero` 保留作 fallback（兜底 + 清晰）
- **覆盖原来漏的**失效触发点：叉齿子树增删 mesh（roundtrip / insertGroup）、undo 跨步撤销 reparent、场景 reload 后 mesh uuid 变
- **测试**：tests/unit/keyframe-manager.test.js 加 `restoreState role 保留` 3 case + `fork_anchor_zero hash` 4 case。总共 30/30 通过
- **经验教训**：**hash-based cache 比显式 invalidate 更健壮**。显式 invalidate 依赖"每个 mutator 都记得调"，漏一处就 stale。hash 把"脏"的判定移到读侧（每次 compute 都算），代价是每次多算一次 hash（微不足道），换来的是**无法漏**。类似 React 的 `key` prop、Git 的 content-addressed——让状态本身自证新鲜

#### #45 vitest 基建 + 23 个核心单元测试（F4 解决）
- **背景**：review F4 指出项目**零单元测试**，所有 37+ 条已修 bug 没有回归防线；最糟的情况是 `tests/test-pkf-p4.js` 断言已和当前语义相反，如果拿来回归会误导维护者
- **修复**：
  - 加 `vitest ^4.1.5` devDep + `npm test` / `test:watch` 脚本
  - [vitest.config.js](vitest.config.js)：node 环境，只跑 `tests/unit/**/*.test.js`（不碰 `tests/diag-*.js` / `test-pkf-p*.js` 浏览器脚本）
  - [tests/unit/keyframe-manager.test.js](tests/unit/keyframe-manager.test.js) 5 个 describe × 23 个 test case，覆盖：
    - `setJointDef` 环检测（bug #33）— 4 case
    - `buildDefaultParamValues` 参数注入（cargo size + fork_anchor_zero + 退化）— 5 case
    - `_interpolateJointValueAtTime` 关键帧插值（bug #22/#31 语义基础）— 5 case
    - `computeForkAnchorZero`（bug #36/#37，用真 THREE.Mesh+BoxGeometry 构最小 scene）— 4 case
    - `addReparentEvent` / `removeReparentEvent` / `removeAllReparentEventsForChild` 缓存失效（bug #39）— 5 case
  - 全部通过（23/23）；运行 ~300ms
  - CONTRIBUTING.md 加"单元测试"章节 + 冒烟流程前置 `npm test`
- **经验教训**：**有测试就能改得更狠**。之前改 KeyframeManager 每次都要"改→冒烟→祈祷"，现在 `npm test` 11ms 直接验证核心语义没被破坏。5 个 describe 每个都对应一个历史 bug——**bug 回归防线本质是把经验教训变成自动化约束**

#### #44 批量清理：AI prompt v14.1 对齐 + 测试断言过时 + 代码 dead code + 文档版本漂移
- **内容**（v14.1 review F9 / F10 / F12 / F14 / F15 / F16 / F22 / F23 合并条目）：
  - AI prompt：L2 PKF few-shot 旧 `pickup_point_x - safe_distance` 替换为 v14.1 位移语义 `cargo_pos_y - fork_anchor_zero_y - approach_gap`；L1 rows 示例从具体数值替换为字面公式。关节名占位符改成 `EXAMPLE_*` 降低 AI 误用
  - AI prompt：动作映射"前进 / 升 / 横移"改为**只看 role 不硬编码 axis**（支持侧叉等非 y=前进模型）
  - AI prompt：`availableRoles` 去重（`new Set`）— 多关节同 role 不再让 AI 看到重复条目
  - 测试：`tests/test-pkf-p4.js` 第 6.5 条断言 `t=3 results.length === 0` 已和 bug #31 修复（保末态 progress=1）相反 → 更新为 `length === 1 && value === 100`
  - 代码：删 `KeyframeManager.js` 里两处 `this._lastSceneRoot = root` 赋值（dead code，buildDefaultParamValues 已改读缓存）
  - 代码：`rebindJointBaseTransform` 里 `delete def._driftWarned` — base 换了旧 drift 警告失效，允许新 drift 再报
  - 代码：oneshot handler 应用 reparent 事件时同时校验 `new_parent_name` 是场景里真实对象（防 AI 瞎编 parent 名导致 fork_anchor_zero 静默退化）
  - 文档：`v12+` / "5 个诊断脚本" 批量改成 `v14.1` / "7 个脚本"
- **经验教训**：**doc 漂移会误导维护者**。版本号、脚本数、事实性信息应该在每次大改动后一轮扫。LLM 生成的 few-shot 一旦语义更新过就必须同步 — 否则新示例 + 老示例混用，AI 输出质量方差大

#### #43 安全加固：CORS 白名单 + AI 接口 rate limit + express.json size limit
- **症状**：无已触发 bug；是 v14.1 review F3 识别的**生产前必修**项。本地开发无影响，上公网 / LAN 前必须做
- **排查**：[docs/REVIEW-v14.md F3](docs/REVIEW-v14.md)。`app.use(cors())` 通配 → 任意站点可从浏览器调 `/api/generate-pkf` 刷 AI 额度；无 rate limit → 误触连点或脚本可打爆；`express.json()` 无显式 limit → 依赖 express 默认 100kb（未来升级可能静默变大）
- **修复**：[tools/conversion-service.js](tools/conversion-service.js) 引入 `express-rate-limit` 依赖；CORS 走白名单（`CORS_ALLOW` env，默认 `localhost:5173,localhost:4173`）；三个 AI 路由统一挂 `aiRateLimit` 中间件（默认 30/分钟，`AI_RATE_LIMIT_PER_MIN` 可覆盖）；`express.json({ limit: '500kb' })` 显式声明。`.env.example` 加 `CORS_ALLOW` / `AI_RATE_LIMIT_PER_MIN` 两个可选环境变量
- **经验教训**：**"本地开发够用 ≠ 生产安全"**。开放端口 + 通配 CORS + 无限速 + AI API 付费 = 账单漏油。这类"现在不痛但未来出血"的安全默认值应尽早修，不要等上公网前才想起来

#### #42 SelectionManager 选中高亮污染原始 emissiveIntensity + clone material 不 dispose → 资源渐进式泄漏
- **症状**：任何带自定义 `emissiveIntensity` 的材质，被选一次 → 永久改成硬编码 `0.2`；长时间点选不同对象，clone material 和 `originalMaterialState` Map 记录无限累积
- **排查**：Codex 对读 [SelectionManager.js:83-105](src/core/SelectionManager.js)。`applyHighlight` 存状态时只存 `emissive.getHex()`（颜色），丢了 `emissiveIntensity`；`clearHighlight` 恢复时硬编码 `emissiveIntensity = 0.2`。clone material 在 `_ownMaterial` flag 标注后永不 dispose
- **根因**：**状态快照不完整**（只存部分字段，恢复时用常量猜剩余字段）+ **资源生命周期缺失**（clone 没配套 dispose）
- **修复**：[SelectionManager.js](src/core/SelectionManager.js)
  - `originalMaterialState` 存 `{colorHex, intensity}` 对象替代单 hex 值
  - `clearHighlight` 按快照恢复完整状态（兼容老格式）+ 用完立刻从 Map delete
  - 新增 `disposeHighlightResources(object)`：递归 dispose `_ownMaterial` 标记的 material，供 `setSceneRoot` 切换场景时调用
- **经验教训**：**clone 任何资源时，必须设计配对的 dispose**。类似 pattern：FileReader.abort / setTimeout.clearTimeout / Map.set 的配对 delete。没有成对的 allocate/release 最终都会泄漏

#### #41 setSceneRoot 切换模型时不 dispose 旧 GPU 资源 → 反复导入大模型 GPU 内存线性涨
- **症状**：用户连续导入多个 GLB/USD（30MB → 40MB → 50MB），只 `scene.remove()` 旧 root，geometry/material/texture 全留在 GPU，长时间调模型 OOM
- **排查**：DEBT #1 已标，v14.1 review F7 复盘。`SceneManager.setSceneRoot` 只调 `scene.remove(this.sceneRoot)`，没递归释放
- **修复**：[SceneManager.js](src/core/SceneManager.js) 加 `_disposeObjectResources(obj)` 私有方法，`setSceneRoot` 在 `scene.remove` 前递归 dispose geometry + texture。material 只 dispose `_ownMaterial` 标记的（SelectionManager clone 出来的），共享 material 不 dispose（可能被其他 root 持有）
- **经验教训**：**Three.js 的 scene.remove 只改层级，不释放 GPU**。任何长跑 / 批量换模型的应用都必须显式 dispose。material 的 dispose 要谨慎（共享引用）

#### #40 snap-attach 参考点和 fork_anchor_zero 不一致 → cargo 垂直方向残余 teleport
- **症状**：🚀 一键生成后播放，t=attach 瞬间 cargo 在垂直方向有明显跳变。水平方向用 `approach_gap=0` 能对齐，垂直方向不行
- **排查**：gpt5 的 forklift-pickup-model review 指出。PKF 公式层用 `box.getCenter()`（bbox 中心），snap-attach 层用 `(center.x, box.min.y + h/2, center.z)`（bbox 底部 + cargo.h/2）。这两点差 `bbox_height/2 - cargo_h/2`
- **根因**：**两层参考点不同源**。公式层算出的车体目标会让 fork 中心到 cargo 中心，但 snap 硬把 cargo 按 bbox 底部放
- **修复**：[KeyframeManager.js applyReparentEventsAtTime](src/core/KeyframeManager.js) snap 层改为 `desiredWorldPos = box.getCenter()`，和 `computeForkAnchorZero` 同源。垂直 teleport 消失
- **经验教训**：**跨层引用同一几何概念时，必须用同一个算式**。想要不同行为就该显式传参，不要复制粘贴几何逻辑（这次复制时多加了 `min.y + h/2` 导致分叉）

#### #39 `removeAllReparentEventsForChild` / marker bulk delete 语义漏洞集
- **症状**（两个关联漏洞打包修）：
  - A: 调 `removeAllReparentEventsForChild` 后 `fork_anchor_zero` 缓存不失效 → PKF 公式读旧 anchor
  - B: "清空所有 marker" 触发 N 次独立 undo snapshot → 撤销要点 N 次才回去
- **排查**：Codex review 指出；[src/core/KeyframeManager.js:301](src/core/KeyframeManager.js) 漏 `invalidateForkAnchorZero()`；[src/main.js:1920](src/main.js#L1920) 的 `removeAllMarkersBtn` 直接 forEach `removeMarkerById`，每次都 `pushUndoSnapshot`
- **修复**：
  - A: `removeAllReparentEventsForChild` 在真正删事件后 `this.invalidateForkAnchorZero()`
  - B: `removeMarkerById` 加 `{ skipUndoSnapshot }` 选项；bulk 入口**外层 push 一次**，内层都传 `skipUndoSnapshot: true`
- **经验教训**：**bulk 操作要显式设计 undo 语义**。否则单个操作里好的实现反而让 bulk 变糟。类似陷阱：事务 vs 独立操作、批量 API vs 单个 API 循环

#### #38 `aiDecomposeBtn`（🪄 仅拆解路径）漏做 Y↔Z swap → 和主路径 AI 空间理解分叉
- **症状**：同一场景，"🪄 仅拆解"和"🚀 一键生成"送进 L1 得到**不同空间理解**，cargo/drop/marker 方位判断分叉。用户反馈"AI 时好时坏"，难定位是哪条路径的锅
- **排查**：Codex 全仓 review（[docs/raw/codex-full-repo-review-2026-04-21.md](docs/raw/codex-full-repo-review-2026-04-21.md)）对读 [src/main.js:1132-1140](src/main.js#L1132) 的 `collectSceneForAi()` 已做 `{x, y: wp.z, z: wp.y}` swap；而 [src/main.js:1270-1278](src/main.js#L1270) 的 `aiDecomposeBtn` handler 用**独立采集逻辑**发 Three.js Y-up `{x, y: wp.y, z: wp.z}` → AI 看 cargo.y 是 threejs 的 y（高度），把高度当前后距离
- **根因**：**同一概念两份实现已分叉**。历史上先有 `aiDecomposeBtn`（内联 scene 采集），后加 `collectSceneForAi()` helper 做了 Y/Z swap 但没回头统一。[docs/architecture/ai-pipeline.md:49-55](docs/architecture/ai-pipeline.md) 早标了"已知 bug"，没修
- **修复**（v14.1）：[src/main.js:1270-1278](src/main.js#L1270) 删 8 行自有采集逻辑，改用 `collectSceneForAi()` — 1 行改动
- **经验教训**：**任何 data-out 到外部系统的点**（AI / 导出 / 日志 / 外部工具）都必须走**同一个** helper。历史留下的双实现是最容易埋 bug 的地方。见 [docs/REVIEW-v14.md F1](docs/REVIEW-v14.md) 和 [docs/gotchas/006-coordinate-swap-forgotten.md](docs/gotchas/006-coordinate-swap-forgotten.md)

#### #37 fork_offset（关节间差）语义错位 → AI 生成的"位移"被当成"绝对坐标"→ 车体过冲 2.7m
- **症状**：🚀 一键生成后播放到 t=4，cargo 深陷车体内部；车体前进关节停在 world y=7.73，但 cargo 只在 y=5，车体整整过了 2.7m
- **排查**：Codex 对读 [KeyframeManager.js:712](src/core/KeyframeManager.js#L712) 的 prismatic 驱动 —— `newWorldPos = baseWorldPos.clone().add(worldAxisVec.multiplyScalar(def.currentValue))`。这说明 `currentValue` 语义是**从零位开始的位移**（加到 baseWorldPos 上）。但 AI 的 prompt 让它写 `cargo.y - fork_offset_y - gap = 4.8`，AI 以为这是"车体应该到达的世界 y 坐标"。runtime 把 4.8 当位移 → fork.world.y = base(2.93) + 4.8 = 7.73
- **根因**：**"绝对世界坐标"和"从零位起的位移"的语义错位**。fork_offset 这个参数是"两个关节间差"（几何含义模糊），不包含"零位参考点"信息。AI 无从得知它写的数字应该被加到哪个 base 上 → 只能瞎写。
- **修复**（v14.1）：
  - 参数换语义：`fork_offset_*`（关节间差）→ `fork_anchor_zero_*`（叉齿在零位时的**世界绝对坐标**）
  - 公式相应改：`cargo.y - fork_anchor_zero_y - gap` ←这就是"要位移多少才能让叉齿到 cargo - gap"的数学表达
  - 验证（模型数据）：fork_anchor_zero_y=2.13, cargo.y=5, gap=0.3 → displacement = 5 - 2.13 - 0.3 = 2.57（车体前进 2.57m，叉齿落到 y=4.7）
  - [KeyframeManager.js](src/core/KeyframeManager.js) `computeForkOffsetFromReparent` → `computeForkAnchorZero`，内部缓存，`buildDefaultParamValues` 读缓存不实时重算（避免运动中参数漂移）
  - [src/main.js](src/main.js) 加 `snapshotForkAnchorZero()` helper：**临时把所有关节 value=0** → 算 anchor → **恢复关节 value**（try/finally）。保证 anchor 永远是"零位锚点"
  - AI prompt（[tools/conversion-service.js](tools/conversion-service.js)）明确提示："prismatic value_end 是位移，不是绝对坐标" + 提供具体公式模板
- **经验教训**：**语义必须和 runtime 对齐**。如果 runtime 的驱动模型是"base + displacement"，暴露给 AI 的参数就必须让它能直接算位移。之前用"关节间差"相当于让 AI 做两步推理（猜零位 + 算位移）→ AI 第一步就错。推广：任何想让 LLM 写"运行时可执行表达式"的系统，**参数语义必须是 runtime 可直接解释的量**，不是需要再转换一次的中间量。
- **踩过的中间坑**（写出来给未来自己看）：
  1. v14.0 初版只用 approach_gap 常数 → 不懂具体几何，值不对
  2. v14.0.1 加 fork_offset_y（关节间差） → AI 用上了，但公式被当绝对坐标 → 过冲更严重（本 bug）
  3. v14.1 改成 fork_anchor_zero（绝对世界坐标）+ 公式明确标注"这是位移表达式"

#### #36 叉齿吸附用整个 `_CS19110` 子树 bbox → cargo 卡在车体内不在叉齿尖
- **症状**：🚀 一键生成动画，播放到 t=4（attach 瞬间）cargo 视觉上贴在车体内部 / 门架附近，不在叉齿尖上。x/y 方向偏差 ~0.5m
- **排查**：`__mf.keyframeManager.computeForkOffsetFromReparent(sceneRoot)` 返回 `{fork_offset_x: 0.526, fork_offset_y: -0.801, fork_offset_z: 0.373}`。对比 `_CS19110` 整个子树 bbox center y=0.32 vs bbox min.y=0.042 → 中心在门架中部，不是叉齿尖底
- **根因**：`THREE.Box3().setFromObject(_CS19110)` 把整个子树（叉齿尖 + 支架 + 门架 + 内件）算在一起，bbox 中心被高层 mesh "拉高"。把 bbox 中心当"叉齿位置"是错的 —— fork_offset_y 算出的方向和真实叉齿尖位置不符
- **修复**：[KeyframeManager.js](src/core/KeyframeManager.js) 加 `_findForkTineMesh(forkObj)` helper —— 在 `_CS19110` 的所有 mesh 后代里找 world bbox `min.y` **最小**的那个（叉齿尖 = 最贴地）。`computeForkOffsetFromReparent` 和 `applyReparentEventsAtTime` 的 snap-attach 都改用叉齿尖 mesh 的 bbox，不用整个 subtree
- **经验教训**：**"父节点 bbox" 和 "我想定位的子部件" 语义不同**。Forklift 的 `_CS19110` 是关节 group，视觉 mesh 都在它下面但职能不同（升降 / 支撑 / 承载 / 叉齿尖）。用整个 subtree bbox 混了这些语义。启发式"最低 mesh = 叉齿尖"对标准叉车有效，但**不适用所有模型**（倒挂叉齿、侧向叉齿等特殊几何会失效）→ 未来加 UI 让用户手动指定"cargo 吸附 mesh"。**中间踩过的坑**：尝试过"去掉 snap 的 position 逻辑、靠 attach() 保世界"的简化版，但因为 fork_offset_y 本身算错，cargo 落点仍然不对 → 要同时修"位置计算源"和"snap 位置逻辑"

#### #34 FBX 源 ZIP roundtrip 后根节点改名导致 parent=root 的关节找不到父级
- **症状**：FBX 源加载后场景根名叫 "Scene"。如果用户把关节的 parent 设为场景根，导出 ZIP 再导入后，该关节被兜底到错误的 scene graph parent（通常是子级 AGV 或无名包装），视觉上表现为"关节丢失 / 左侧顶部名字改变"
- **排查**：`__mf.sceneManager.sceneRoot.name` 导入前是 "Scene"，导入后变成 `.fbx` 文件名（如 `shuangchaxiaoqianyi.fbx`）；joints.json 里 `parent_name: "Scene"` 在 objectsByName 里找不到
- **根因**：[main.js](src/main.js) 里有段代码 `root.name = manifest.source.file_name`，用文件名强制覆盖根节点名。原来叫 "Scene" 的根在新场景里被改名 → `objectsByName.get("Scene")` 失败 → 兜底到 childObj.parent（scene graph parent，和 joint parent 语义不同）
- **修复**：
  - [ResultPackageExporter.js](src/core/ResultPackageExporter.js)：`manifest.source` 新增 `root_name` 字段，保存导出时的根节点名
  - [main.js handleImportPackage](src/main.js#L564)：恢复根节点名时优先用 `root_name`，兜底到 `file_name`
- **向后兼容**：旧 ZIP 没 `root_name` 字段 → 走 fallback 到文件名（和之前行为一致，旧 bug 还在但不崩）；新 ZIP 正确恢复
- **经验教训**：**跨 roundtrip 的标识符必须端到端保存**。只靠"猜测名字"（用文件名代替根名）会在源格式变化时失败。每新增一种源格式（GLB/USD/FBX），根节点的命名约定都可能不同

#### #32 导出 ZIP 异常时卡在零位状态
- **症状**：导出时如果 GLTFExporter 抛异常（模型太大 / 材质跨域等），模型卡在"全关节归零 + 无选中"，看起来动画配置丢了
- **根因**：恢复 currentValue 和选中状态的代码在 try 块内 `await exportZip()` 之后，异常跳到 catch → 恢复代码不执行
- **修复**：[main.js](src/main.js) 把恢复逻辑从 try 移到 `finally` 块，不管成功失败一定执行
- **经验教训**：任何"临时改状态 → 执行操作 → 恢复状态"的流程都必须用 `try/finally`，不能放在 try 块尾部

#### #33 关节链循环依赖静默失效
- **症状**：用户把 A 的父级设成 B、B 的父级又设成 A → 两个关节都不动，无任何错误提示
- **根因**：Kahn's 拓扑排序遇到环时队列提前清空，环内关节入度永远 > 0，静默跳过
- **修复**：[KeyframeManager.js setJointDef](src/core/KeyframeManager.js) 设 parentId 时从目标沿链向上走，碰到自己就拒绝 + console.warn。在源头堵住，不让循环数据进入系统
- **经验教训**：图算法（拓扑排序）的输入**必须在入口校验**（无环），不能依赖算法本身"恰好能处理"

---

### 阶段八：AI PKF 生成

#### #29 AI 按轴向硬猜导致选错关节
- **症状**：用户输入"整辆车前进 3 米"，AI 把 `_CS198`（叉齿侧移机构）当成"前进"硬套，结果叉齿飞出去、车体不动
- **根因**：AI 只能看到关节的 `{name, type, axis}`，没有语义信息。三向叉车模型本就没有"车体前进"关节，AI 看 `_CS198` 是唯一 prismatic x → 误判为前进
- **修复**：给关节定义加 `role` 字段（语义角色标签）
  - 数据层：[KeyframeManager.js](src/core/KeyframeManager.js) joint def 加 role 字段，`setJointDef` / `serializeState` / `restoreState` 都传递
  - UI：[EditorUI.js](src/ui/EditorUI.js) `showJointConfigPanel` 加下拉（车体前进/车体转向/门架升降/叉齿前伸/叉齿侧移/叉齿旋转/夹爪开合/臂段旋转）+ "其他"自定义文本框
  - 应用：[main.js](src/main.js) `onJointTagClick` onChange 透传 role；`requestAiGeneratePkf` 把 role 附加到 joints 列表
  - 后端：[conversion-service.js](tools/conversion-service.js) user message 里展示 `role="..."`，并列出"当前模型已有的角色"；system prompt 追加"按 role 优先匹配，匹配不上输出 `{error, available_roles}`"
  - 后端收到 `parsed.error` → 返回 422 + reason
  - 持久化：导出 `joints.json` 显式带 `role`，导入 `handleImportPackage` 显式恢复 role
- **效果**：
  - 三向车配好 role 后，"叉齿侧移 0.5 米" 能正确匹配 `_CS198`
  - "整辆车前进 3 米" 因为没有 role="车体前进" 的关节，AI 拒绝并提示可用角色
- **路径规划（不在本轮）**：
  - 方案 A（关键帧导出 PKF 喂 AI 学新动作模式）：等多关节协同复杂动作出现时再加

#### #28 AI 从零写 PKF 公式不稳定
- **症状**：AI 生成的 `value_start`/`value_end` 公式经常写错，动画错位或不动；复杂动作协调差；调 prompt 边际收益低
- **根因**：LLM 不擅长从零生成精确的数学表达式 + 多 step 编排
- **修复**：**few-shot 示例方案**
  - 在 [tools/conversion-service.js](tools/conversion-service.js) 的 `PKF_SYSTEM_PROMPT` 里内嵌一个完整的 pickup 示例（parameters + steps + 公式 + 时序编排）
  - 示例包含：公式引用参数（`pickup_point_x - safe_distance`）、多步串行（前进→下降→插入→抬升）、ease-in/ease-out 等
  - AI 不再从零写，照着示例模仿格式；关节名从用户当前模型列表里挑
  - 后处理保留：joint 名模糊匹配 + channel/type 不匹配时自动换成正确 type 的关节
- **路径规划**：
  - 初期（1-3 个模式）：都放在 system prompt 里当 few-shot
  - 后期（≥4 个模式）：拆成 `templates/*.json`，AI 只看摘要选模板，后端读完整模板填参
- **注意事项**：
  - 之前尝试过"模板库 + role 映射"方案（独立 JSON 文件 + AI 选模板 + 关节映射层），过度设计，已回滚
  - 保持 stage A（few-shot）的关键：模板数量上来之前不要引入额外的基础设施

---

## 核心经验教训

1. **懒捕获 base 的时机很重要**：必须在"所有父级关节都是零位"的状态下捕获，不能在驱动态下捕获
2. **GLTFExporter/Loader 不是无损 roundtrip**：Scene 会变成 AuxScene、无名节点保留但身份变了、节点名可能丢失后缀
3. **四元数 vs Euler**：涉及旋转的状态一律用四元数存，Euler 只做 UI 展示
4. **跨导入稳定的标识符**：UUID 是运行时的，导出到 JSON 要用**名字**或**路径**，导入时重新解析成当前 UUID
5. **double-apply 的根因几乎都是"状态被烘焙在两个地方"**：GLB 里烘焙了 transform + 关节 def 里又有 value → 施加两次
6. **链式关节的 base 有顺序依赖**：父级 base 先确定，子级 base 才能正确捕获
7. **大二进制文件别进 git**：导出产物、模型文件都应该 `.gitignore`
8. **写诊断脚本比瞎改代码强**：多数 bug 是通过先写诊断脚本定位根因再改代码解决的，节省大量反复试错

---

## 附：单行快速检查命令

除了完整诊断脚本，以下单行 Console 命令也常用：

```js
// 查看所有关节定义（含 parentId/childId）
__mf.getJointDefs().map(d => ({ name: d.name, parentId: d.parentId?.slice(0,8), childId: d.childId?.slice(0,8), value: d.currentValue }))

// 检查 parentId 是否能在场景树找到
__mf.getJointDefs().map(d => { let found = null; __mf.sceneManager.sceneRoot.traverse(o => { if(o.uuid === d.parentId) found = o.name || o.type; }); return d.name + ': ' + (found || '❌'); })

// 检查 parentId 是否等于 scene parent（应 false 表示正确的链式关节）
__mf.getJointDefs().map(d => { let c = null; __mf.sceneManager.sceneRoot.traverse(o => { if(o.uuid === d.childId) c = o; }); return d.name + ': parentId===sceneParent? ' + (d.parentId === c?.parent?.uuid); })

// 对比关节的 stored base 和当前 should_be（不一致说明 base 过时）
__mf.getJointDefs().map(d => { let jp = null, c = null; __mf.sceneManager.sceneRoot.traverse(o => { if(o.uuid === d.parentId) jp = o; if(o.uuid === d.childId) c = o; }); if(!jp||!c) return d.name+': NOT FOUND'; jp.updateMatrixWorld(true); c.updateMatrixWorld(true); const cwp = c.getWorldPosition(new __mf.THREE.Vector3()); const correct = jp.worldToLocal(cwp.clone()); return d.name + ': stored=(' + d.baseTransform.tx.toFixed(2) + ',' + d.baseTransform.ty.toFixed(2) + ',' + d.baseTransform.tz.toFixed(2) + ') should_be=(' + correct.x.toFixed(2) + ',' + correct.y.toFixed(2) + ',' + correct.z.toFixed(2) + ')'; })

// 查看 child 的当前 local position
__mf.getJointDefs().map(d => { let c = null; __mf.sceneManager.sceneRoot.traverse(o => { if(o.uuid === d.childId) c = o; }); return d.name + ': pos=(' + c?.position.x.toFixed(2) + ',' + c?.position.y.toFixed(2) + ',' + c?.position.z.toFixed(2) + ')'; })

// 快速检查高亮是否被烘焙进材质
let c = null; __mf.sceneManager.sceneRoot.traverse(o => { if (o.name === '_CS19110') c = o; }); console.log('emissive:', c?.material?.emissive);
```

---

## 当前版本

最新 commit：`f55f549` — 新增 BUGFIX-LOG 和 CLAUDE.md 协作说明

最近 v8 修复：
- 链式关节导入后整体下沉（两阶段应用）— [#22](#22-链式关节导入后整体下沉)
- 导出前清除选中（避免高亮 emissive 烘焙）— [#17](#17-导入后零件高亮不消失)
- Gizmo 旋转角度解缠（避免 360° 跳变）— [#23](#23-旋转-gizmo-大角度跳变-360)

---

## 文档系统

项目在 `docs/` 下维护一套 Karpathy LLM Wiki 风格的结构化文档体系，入口是 [`docs/index.md`](docs/index.md)。

### 目录结构

```
docs/
├── index.md          # 分类导航索引（新 session 从这里开始）
├── log.md            # Append-only 时间线（重要决策/里程碑记录）
├── architecture/     # 系统架构文档（模块职责、数据流、坐标系）
├── concepts/         # 领域概念（PKF、ZIP schema、场景标记等）
├── decisions/        # ADR 架构决策记录（带背景/选项/理由/后果）
├── gotchas/          # 踩坑记录（症状/根因/解决方案）
├── raw/              # 草稿/未整理笔记
├── ai-rigging/       # AI 打关节研究专题（独立维护）
├── archive/          # 历史文档（不再更新）
└── schema/           # ZIP 输出格式规范
```

### 新 session 接手时的阅读顺序

1. [`README.md`](README.md) — 3 分钟了解项目是什么
2. [`docs/index.md`](docs/index.md) — 找到与当前任务相关的文档
3. [`docs/architecture/overview.md`](docs/architecture/overview.md) — 理解模块关系
4. 对应 decision + gotcha — 理解为什么这么做、有哪些坑

### 维护触发条件

| 触发时机 | 写到哪里 |
|---------|---------|
| 做了影响范围 > 1 个文件的架构决策 | `docs/decisions/` 新增 ADR |
| 修了需要诊断脚本才定位的疑难 bug | `docs/gotchas/` 新增条目 |
| 发现新的领域概念需要解释 | `docs/concepts/` 新增文档 |
| 重要里程碑或决策 | 追加到 `docs/log.md` |
| CLAUDE.md 里的 Bug 修复历史 | 照旧追加（两个系统并行，CLAUDE.md 偏运维，docs/ 偏知识库） |

### 维护模型约定

- **日常文档维护**：sonnet 即可
- **schema 变更审核 / 架构重构 ADR**：建议用 opus，确保推理严谨
