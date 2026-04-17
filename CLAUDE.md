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

本目录包含 5 个浏览器 Console 诊断脚本，用于定位关节系统、导出导入 roundtrip、动画播放相关问题。

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
