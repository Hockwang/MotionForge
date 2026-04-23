---
tags: [bugs, history, archive]
updated: 2026-04-22
---
# MotionForge Bug 修复历史

> 按时间顺序记录开发过程中遇到的问题、根因分析和修复方案。从 CLAUDE.md 拆分出来（2026-04-22）—— CLAUDE.md 只保留"每轮都必须生效的规则"，详细 bug 历史放这里按需查阅。
>
> **这是只读历史档案**：新 bug 继续追加，但不要回头改过去的条目（除非事实错误）。

---

## 目录

- [阶段一：关节系统 v1 基础（#1-#8）](#阶段一关节系统-v1-基础)
- [阶段二：架构重构（#9-#11）](#阶段二架构重构)
- [阶段三：导出/导入 Roundtrip（#12-#19）](#阶段三导出--导入-roundtrip)
- [阶段四：归零策略（#20-#22）](#阶段四归零策略)
- [阶段五：Gizmo 交互（#23）](#阶段五gizmo-交互)
- [阶段六：其他细节（#24-#26）](#阶段六其他细节)
- [阶段七：git 仓库维护（#27）](#阶段七git-仓库维护)
- [阶段八：AI PKF 生成（#28-#29）](#阶段八ai-pkf-生成)
- [阶段九：导出导入 + PKF 循环闭环（#30-#37）](#阶段九导出导入--pkf-循环闭环修复v12)
- [阶段十：v14.1 review 批量修复（#38-#46）](#阶段十v141-review-批量修复)
- [阶段十一：承载锚点六轮迭代（#47-#52）](#阶段十一承载锚点六轮迭代)
- [核心经验教训（跨 bug 总结）](#核心经验教训)

---

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

### 阶段八：AI PKF 生成

#### #28 AI 从零写 PKF 公式不稳定
- **症状**：AI 生成的 `value_start`/`value_end` 公式经常写错，动画错位或不动；复杂动作协调差；调 prompt 边际收益低
- **根因**：LLM 不擅长从零生成精确的数学表达式 + 多 step 编排
- **修复**：**few-shot 示例方案**
  - 在 [tools/conversion-service.js](../tools/conversion-service.js) 的 `PKF_SYSTEM_PROMPT` 里内嵌一个完整的 pickup 示例
  - 示例包含：公式引用参数、多步串行、ease-in/ease-out 等
  - AI 不再从零写，照着示例模仿格式
- **路径规划**：初期（1-3 个模式）都放在 prompt；后期（≥4）拆成 `templates/*.json`

#### #29 AI 按轴向硬猜导致选错关节
- **症状**：用户输入"整辆车前进 3 米"，AI 把 `_CS198`（叉齿侧移机构）当成"前进"硬套
- **根因**：AI 只能看到关节的 `{name, type, axis}`，没有语义信息
- **修复**：给关节定义加 `role` 字段（语义角色标签）
  - UI 加下拉（车体前进/门架升降/叉齿侧移/叉齿旋转 等）
  - AI prompt 按 role 优先匹配，匹配不上输出 `{error, available_roles}`
  - 导出/导入保留 role

---

### 阶段九：导出导入 + PKF 循环闭环修复（v12）

#### #30 导出 joints.json 保存了驱动态 currentValue → 导入后停在末态
- **症状**：从 PKF 播放末态点导出 ZIP，导入后模型直接显示动画末态，不是自然零位
- **根因**：导出时 joints.json 的 currentValue 写回了驱动值，但 GLB 已经归零了。语义不一致
- **修复**：导出时 joints.json 的 currentValue 写死 0（GLB 零位 + joints.json 零位一致）
- **经验教训**：GLB 里烘焙的 transform 和 JSON 里的关节值**必须语义一致**

#### #31 PKF 循环播放时关节卡在末态 2 秒后瞬跳回原点
- **症状**：PKF 驱动播放循环到第二遍时，关节在末态停留 2-5 秒，然后瞬间跳回 0
- **根因**：
  1. `evaluatePkfAt` 对已完成 step 不输出结果 → 完成后的关节值无人维护
  2. `applyPkfAtTime` 不重置关节 → 上一轮的末态持续
- **修复**：
  - `evaluatePkfAt`：`t >= t_end` 时 progress=1（hold at value_end），按 t_start 排序
  - `applyPkfAtTime`：每帧先把 PKF 触及的关节 `currentValue = 0`，再应用 results

#### #32 导出 ZIP 异常时卡在零位状态
- **症状**：导出时如果 GLTFExporter 抛异常，模型卡在"全关节归零 + 无选中"
- **根因**：恢复逻辑在 try 块内 `await exportZip()` 之后，异常跳到 catch
- **修复**：把恢复逻辑移到 `finally` 块
- **经验教训**：任何"临时改状态 → 执行操作 → 恢复状态"的流程都必须用 `try/finally`

#### #33 关节链循环依赖静默失效
- **症状**：用户把 A 的父级设成 B、B 的父级又设成 A → 两个关节都不动，无错误提示
- **根因**：Kahn's 拓扑排序遇到环时队列提前清空
- **修复**：`setJointDef` 设 parentId 时沿链向上走，碰到自己就拒绝 + console.warn
- **经验教训**：图算法输入**必须在入口校验**（无环），不能依赖算法"恰好能处理"

#### #34 FBX 源 ZIP roundtrip 后根节点改名导致 parent=root 的关节找不到父级
- **症状**：FBX 源加载后场景根名叫 "Scene"，导出再导入后被改名为文件名 → parent=root 的关节兜底错
- **根因**：`root.name = manifest.source.file_name` 用文件名覆盖根节点名
- **修复**：`manifest.source.root_name` 新增字段保存原始根名；导入优先用 root_name
- **经验教训**：**跨 roundtrip 的标识符必须端到端保存**。不能靠"猜文件名"代替

#### #35 Fixed 类型关节不跟 joint parent 动
- **症状**：fixed 类型关节不跟随 joint parent 运动
- **根因**：`applyJointDrive` 对 fixed 类型 early return，懒捕获都不走
- **修复**：fixed 改为"每帧根据 joint parent 最新世界矩阵 × base 计算 child 世界位置"，符合 URDF 标准
- **经验教训**：**关节类型的语义要一致**。fixed 也是"joint parent 说了算"，不能为了省性能破坏

#### #36 叉齿吸附用整个 `_CS19110` 子树 bbox → cargo 卡在车体内
- **症状**：🚀 一键生成动画，attach 瞬间 cargo 贴在车体内部/门架附近
- **根因**：`Box3().setFromObject(_CS19110)` 把整个子树（叉齿+支架+门架）算一起，bbox 中心被高层 mesh 拉高
- **修复**：加 `_findForkTineMesh(forkObj)` helper —— 找 world bbox `min.y` 最小的 mesh
- **⚠️ 后续被 #52 取代**（min.y 启发式对合并 mesh 失败，见 [gotchas/007](gotchas/007-merged-mesh-bbox-trap.md)）

#### #37 fork_offset（关节间差）语义错位 → AI 把"位移"当"绝对坐标"→ 车体过冲 2.7m
- **症状**：🚀 一键生成后播放到 t=4，cargo 深陷车体内部；车体前进关节停在 world y=7.73
- **根因**：**"绝对世界坐标"和"从零位起的位移"的语义错位**。prismatic `currentValue` 是位移，但 AI 把公式当绝对坐标
- **修复**：
  - 参数换语义：`fork_offset_*`（关节间差）→ `fork_anchor_zero_*`（叉齿零位世界绝对坐标）
  - 公式改：`cargo.y - fork_anchor_zero_y - gap` = "要位移多少让叉齿到 cargo - gap"
  - 加 `snapshotForkAnchorZero()` helper：**临时把所有关节 value=0** → 算 anchor → **恢复**（try/finally）
  - AI prompt 明确提示："prismatic value_end 是位移，不是绝对坐标"
- **经验教训**：**语义必须和 runtime 对齐**。参数语义必须是 runtime 可直接解释的量，不是需要再转换一次的中间量

---

### 阶段十：v14.1 review 批量修复

#### #38 `aiDecomposeBtn`（🪄 仅拆解路径）漏做 Y↔Z swap → 和主路径 AI 空间理解分叉
- **症状**：同一场景，"🪄 仅拆解"和"🚀 一键生成"送进 L1 得到**不同空间理解**
- **根因**：**同一概念两份实现已分叉**。`aiDecomposeBtn` 内联采集 Three.js Y-up，而 `collectSceneForAi()` helper 做了 Y/Z swap
- **修复**：`aiDecomposeBtn` handler 改用 `collectSceneForAi()` — 1 行改动
- **经验教训**：**任何 data-out 到外部系统的点都必须走同一个 helper**。历史留下的双实现是最容易埋 bug 的地方

#### #39 `removeAllReparentEventsForChild` / marker bulk delete 语义漏洞集
- **症状**（两个关联漏洞）：
  - A: 调 `removeAllReparentEventsForChild` 后 `fork_anchor_zero` 缓存不失效
  - B: "清空所有 marker" 触发 N 次独立 undo snapshot → 撤销要点 N 次才回去
- **修复**：
  - A: `removeAllReparentEventsForChild` 删事件后 `this.invalidateForkAnchorZero()`
  - B: `removeMarkerById` 加 `{skipUndoSnapshot}` 选项；bulk 入口外层 push 一次
- **经验教训**：**bulk 操作要显式设计 undo 语义**

#### #40 snap-attach 参考点和 fork_anchor_zero 不一致 → cargo 垂直方向残余 teleport
- **症状**：🚀 一键生成播放 attach 瞬间 cargo 垂直方向明显跳变
- **根因**：**两层参考点不同源**。公式层用 `box.getCenter()`，snap 层用 `(center.x, box.min.y + h/2, center.z)`
- **修复**：snap 层改为 `desiredWorldPos = box.getCenter()`，两层同源
- **经验教训**：**跨层引用同一几何概念时必须用同一个算式**。想要不同行为就显式传参

#### #41 setSceneRoot 切换模型时不 dispose 旧 GPU 资源 → GPU 内存线性涨
- **症状**：用户连续导入多个 GLB/USD，长时间 OOM
- **修复**：`SceneManager.setSceneRoot` 递归 dispose geometry + texture；material 只 dispose `_ownMaterial` 标记的（共享 material 不碰）
- **经验教训**：**Three.js 的 scene.remove 只改层级，不释放 GPU**。长跑/批量换模型的应用必须显式 dispose

#### #42 SelectionManager 选中高亮污染原始 emissiveIntensity + clone material 不 dispose
- **症状**：任何带自定义 `emissiveIntensity` 的材质被选一次 → 永久改成 `0.2`；clone material 和 state Map 无限累积
- **根因**：**状态快照不完整**（只存颜色不存 intensity）+ **资源生命周期缺失**（clone 没配套 dispose）
- **修复**：`originalMaterialState` 存 `{colorHex, intensity}`；`clearHighlight` 完整恢复 + 从 Map delete；加 `disposeHighlightResources` 方法
- **经验教训**：**clone 任何资源时必须设计配对的 dispose**

#### #43 安全加固：CORS 白名单 + AI 接口 rate limit + express.json size limit
- **背景**：v14.1 review F3 识别的**生产前必修**项
- **修复**：CORS 白名单（`CORS_ALLOW` env）+ `aiRateLimit` 中间件（30/分钟，可配）+ `express.json({limit:'500kb'})`
- **经验教训**：**"本地开发够用 ≠ 生产安全"**。开放端口 + 通配 CORS + 无限速 + AI API 付费 = 账单漏油

#### #44 批量清理：AI prompt 对齐 + 测试断言过时 + 代码 dead code + 文档版本漂移
- **内容**：L2 PKF few-shot 更新为位移语义；动作映射改为只看 role 不硬编码 axis；`availableRoles` 去重；测试断言更新；文档版本号批量刷新
- **经验教训**：**doc 漂移会误导维护者**。版本号、脚本数、事实性信息每次大改动后扫一轮

#### #45 vitest 基建 + 23 个核心单元测试（F4 解决）
- **背景**：项目零单元测试，37+ 条已修 bug 没有回归防线
- **修复**：`vitest ^4.1.5` + 5 个 describe × 23 个 test case 覆盖 bug #22/#31/#33/#36/#37/#39 关键路径
- **经验教训**：**有测试就能改得更狠**。bug 回归防线本质是把经验教训变成自动化约束

#### #46 F11 + F13：restoreState 保留 role + fork_anchor_zero hash-based 自动失效
- **F11**（DEBT #3 防御）：`restoreState` 时 snapshot 里 `role` 字段缺失 → 保留当前值（兼容老 snapshot）
- **F13** hash-based cache：`_computeForkAnchorInputsHash` 计算 reparent events + 叉齿子树 mesh uuids 签名，hash 未变才用缓存
- **经验教训**：**hash-based cache 比显式 invalidate 更健壮**。让状态本身自证新鲜（类似 React key / Git content-addressed）

---

### 阶段十一：承载锚点六轮迭代

> **⚠️ 重要**：这六轮迭代是一次**对"合并 mesh 下几何启发式"的完整实验**。推荐配合 [gotchas/007-merged-mesh-bbox-trap](gotchas/007-merged-mesh-bbox-trap.md) 一起读，了解"为什么自动推断子部件位置是有损的"。

#### #47 吸附姿态改为"叉齿顶面托住 cargo 底面" + AI 维度兜底
- **症状**：🚀 一键生成后播放到 t=3.98→4.01，cargo 明显下跳到叉齿上 ~0.3m
- **根因（两个叠加）**：
  1. AI 漏生成维度（门架升降 step 缺）→ attach 时 fork z 还在零位
  2. center-to-center 对齐不符合物理（cargo 陷进 fork）
- **修复**：
  - `computeForkAnchorZero` 改为 `(center.x, box.max.y, center.z)` —— 叉齿顶面中心
  - snap desiredWorldPos 改为 `(center.x, box.max.y + cargoH/2, center.z)`
  - Prompt z 公式加 `- cargo_height/2`
  - **前端兜底**：`ensurePkfCoversAttachPoint` —— AI 漏维度时自动补 step（**这部分独立保留到 #52**）
- **结果**：对三向车.glb 翻车（#48 回退），但前端兜底的设计沿用至今

#### #48 回退 #47 "叉齿顶面"语义 —— 合并 mesh 下 bbox.max.y 指向门架顶
- **症状**：#47 上线后，三向车.glb 🚀 一键生成**叉齿下沉穿地 0.55m，cargo 飘空**
- **排查**：`_CS19110` 子树只有**一个 mesh**（合并建模），bbox：min.y=0.042 / max.y=0.592；`fork_anchor_zero_z = max.y` = **门架顶高度**，不是叉齿顶
- **修复**：`computeForkAnchorZero` + snap 回退到 `box.getCenter()`；prompt 回退不减 cargo_height/2；加"禁止凭空加常数"警告
- **保留** `ensurePkfCoversAttachPoint` 前端兜底
- **经验教训**：
  1. **启发式 = 对部分模型的假设**。`_findForkTineMesh` min.y 挑法只在"叉齿独立 mesh"时有效
  2. **依赖 bbox 分量语义要先验证前提**。改几何语义前必须确认所有输入形态
  3. **AI 在公式里自加常数是隐藏风险**（自己加 `-0.1`）。必须 prompt 显式禁止
  4. **回退不等于失败**。分层回退比全部回退更稳

#### #49 fork_anchor_zero 改用 bbox.min.y（叉齿底面）
- **动机**（用户 insight）：UI "子对象底部"按钮基于 bbox.min.y，直接复用心智一致
- **修复**：锚点 y 从 `center.y` 改为 `min.y`；snap `desiredWorldPos.y = min.y + cargoH/2`
- **已知局限**：极薄叉齿视觉可接受；合并 mesh 下 fork 结构会穿进 cargo（但 z 方向正确）

#### #50 fork_anchor_zero 水平位置改用"朝 cargo 方向的 bbox 前端极值"
- **症状**：#49 修好 z 后，水平方向仍有偏差 —— cargo 在叉车前方 ~0.9m
- **根因**：合并 mesh 的 `bbox.center.x/z` = 整车几何中心，不是叉齿尖
- **修复**：用 cargo 位置相对 fork bbox 中心的方向作 forward，取 bbox 沿 forward 方向的前端极值
- **#50 经过三次修正**：
  - `#50b` sanitize：强制覆盖 AI 设置的 `approach_gap=1` 为 0；正则清洗公式末尾裸常数
  - `#50c` 数学 bug 修：投影公式（extent = |hx·dx| + |hz·dz|）让 anchor 飞出 bbox → 改为射线-bbox 相交（`extent = min(hx/|dx|, hz/|dz|)`）
  - `#50d` 时序 bug 修：`Box3.setFromObject` 在 attach 后调用会包含 cargo mesh → bbox 扩大 0.5m → cargo 瞬移。改为 attach 前算 bbox

#### #51 误入歧途：读 joint.origin 当承载锚点（已回退）
- **意图**：让用户通过"子对象底部"按钮 / 手动 X/Y/Z 输入直接控制 fork_anchor_zero 位置
- **致命错误**：`def.origin` 是**关节的旋转/平移支点**（URDF `<origin>`），不是"cargo 吸附点"。点"子对象底部"按钮**同时**改了这两件事，破坏关节旋转行为
- **回退**：#52 改为"自动走按钮同公式 + 不写 origin"，解耦两个概念
- **经验教训**：**复用 UI 概念时要区分数据来源 vs 数据用途**。想复用按钮算法 → 直接抄公式，别抄存储位置

#### #52 终局：自动算 bbox 底面中心（= "子对象底部"按钮公式，但不写 def.origin）
- **用户洞察**：既然按钮算法能算出好位置，自动走一遍即可，不要写进 def.origin
- **修复**：
  - `computeForkAnchorZero`：直接 `Box3().setFromObject(forkObj)` + `anchor = (center.x, min.y, center.z)`
  - snap：同逻辑，`desiredWorldPos = (center.x, min.y + cargoH/2, center.z)`
  - 删 3 个不再用的 helpers：`_findForkTineMesh` / `_computeForkForwardExtreme` / `_computeJointOriginWorld`
- **经验教训（六轮迭代总结）**：
  1. **承载锚点 ≠ 关节原点**。两个概念得分开，即使物理上可能在同一位置
  2. **UI 按钮的算法就是好的自动化起点**。用户心智和代码行为一致，不需要学新概念
  3. **合并 mesh 下 bbox 不代表"叉齿几何"**。但对 demo 用途够用；真要精准 → UI 手动指定承载点（未实施的 C 方案）

---

### mvp3 修复（17 段模板扩展期间）

#### #53 autoDetectForkName 优先"叉齿*" role（修 cargo 穿车体）
- **症状**：三向车场景 🚀 模板路径生成后，cargo 被 attach 到整个门架 bbox 中心，车体横移到 `cargo.x - 门架中部.x` 时车身穿进 cargo。用户反馈"cargo 又到车体里面了"
- **排查**：`__mf.keyframeManager.getReparentEvents()` 指向 `_____10`（整个门架对象，bbox 5.3m 高），对比 `_CS19110`（叉齿旋转 joint 的 childId，bbox 1.2 × 0.55 × 1.6m 就是叉齿本体）
- **根因**：`autoDetectForkName`（[ForkliftTemplate.js:154](../src/core/ForkliftTemplate.js#L154)）之前只找 `门架升降` role → 拿到整个门架节点 → `computeForkAnchorZero` 取 bbox 中部（= 门架几何中部）
- **修复**：优先级改为 `role.startsWith('叉齿')`（叉齿旋转/叉齿侧移/叉齿前伸），`门架升降` 作为兜底。**运动链越深、bbox 越只含叉齿**
- **验证**：17 段轨迹正确，cargo 从 cargo_pos 到 drop_pos 误差 < 0.01m。commit `ee55716`

#### #54 导出前暂停播放 + 重置时间轴（修 cargo 变巨大）
- **症状**：播放动画中途点"导出 ZIP" → 导入后 cargo 变成 **原尺寸 × 3-5 倍的巨型箱子**，看起来像 cargo 吃了 fork 的 scale
- **排查**：diag `__mf.sceneManager.sceneRoot.getObjectByName('cargo_name').getWorldScale(...)` 显示异常 scale
- **根因**：导出流程是 async，GLTFExporter 序列化需要 I/O 时间。导出期间 requestAnimationFrame 循环每帧继续跑，`applyReparentEventsAtTime(currentTime)` 把 cargo 重新 attach 到 fork 下（fork 有 scale 补偿逻辑），于是 GLB 烘焙了一个 attach 到 fork 且 scale 非 1 的 cargo
- **修复**（[main.js:2323-2405](../src/main.js#L2323)）：导出 handler 开头保存 `savedIsPlaying` + `savedTime`，然后 `isPlaying=false; currentTime=0; applyReparentEventsAtTime(0)`，finally 恢复
- **经验教训**：**async 操作期间的 runtime loop 是隐藏污染源**。对任何"快照"语义的动作都要先冻结时间线。commit `4cb90e7`

#### #55 序列化 _pkfTemplateMeta 到 pkf.json（修导入后 attach 瞬移）
- **症状**：模板路径生成的 ZIP 导出再导入，播放到 attach 点 cargo 下跳 ~0.3m（模板路径号称"零瞬移"）
- **排查**：`__diagTpl.postImportCheck()` 显示 `_pkfTemplateMeta: null`——导入后这个字段是空的
- **根因**：`_pkfTemplateMeta` 是 runtime 状态（标识当前 PKF 是否由模板生成），之前没有序列化到 `pkf.json`。导入后 `applyReparentEventsAtTime` 检查 `!this._pkfTemplateMeta` → 重新走 snap-attach 路径 → cargo 被强拽到 bbox 底面中心
- **修复**：
  - [ResultPackageExporter.js](../src/core/ResultPackageExporter.js)：`pkf.json` 加 `template_meta` 字段，接收 caller 传的 `pkfTemplateMeta`
  - [main.js](../src/main.js) 导出：`pkfTemplateMeta: keyframeManager._pkfTemplateMeta || null`
  - [main.js](../src/main.js) 导入：`keyframeManager._pkfTemplateMeta = pkfData.template_meta || null`
- commit `95f4c65`

#### #56 isV2 检测放宽（修 PKF-only clip 导入 duration/reparent_events 丢失）
- **症状**：模板路径生成的动画导出后导入，clip.duration 被重置为默认 10 秒（应该是 20.3 秒），reparent_events 丢空 → 播放不 attach
- **排查**：`__diagTpl.postImportCheck()` 显示 `clip.duration=10`、`reparent_events: 0`，但 `pkf_steps` 完整
- **根因**：main.js 导入逻辑原本判断 `isV2 = clipsArr[0].keyframes.length > 0`。模板路径生成的 clip 只有 PKF 没关键帧（keyframes 空）→ 判成非 v2 → 整块 clip 恢复代码跳过 → duration 和 reparent_events 都丢
- **修复**（[main.js:780-785](../src/main.js#L780)）：`isV2` 放宽为"有 keyframes 数组 OR 有 duration OR 有 reparent_events"
- **经验教训**：**导入的格式检测不要用"单一必需字段"判断**。mvp3 引入 PKF-only clip 后老判断失效，应按语义等价（任一结构性字段出现）识别
- commit `41f914c`

### GPT review 回合（REVIEW-v15 F1/F4）

#### #57 marker rename undo 后 reparent 静默失效（REVIEW-v15 F1）
- **症状**（待用户复现）：重命名 cargo marker → 做任何改动 → Ctrl+Z → 🚀 播放到 attach 点 → cargo 不 attach（reparent 静默失效）
- **排查**（GPT review 提出 + 代码静态分析验证）：
  - `captureHierarchySnapshot` 只存 position/quaternion/scale/parentId，**不存 obj.name**
  - marker rename 路径同时改 metadata / scene.obj.name / reparent_events.child_name / originalParentMap
  - undo：metadata 和 reparent_events 由 restoreState 还原回老名；但 Three.js 对象 name 停在新名
  - `applyReparentEventsAtTime` 按 `scene.obj.name` 索引的 `nameMap.get(child_name)` 查找 → 查不到（老名） → 静默跳过
- **修复**：
  - [main.js:74-87](../src/main.js#L74) `captureHierarchySnapshot`：加 `name: obj.name || ''`
  - [main.js:89-103](../src/main.js#L89) `restoreHierarchySnapshot`：`if (item.name !== obj.name) obj.name = item.name`
  - [main.js:119-135](../src/main.js#L119) `undoLastChange`：补 `snapshotOriginalParents(sceneRoot)`——name 变了后 originalParentMap 的 key 也要跟着重建
- **经验教训**：**任何"跨多个数据源"的用户操作，undo snapshot 必须覆盖全部数据源**。这次是 metadata + scene-graph name + reparent events + originalParentMap 四处同步，captureHierarchySnapshot 漏了 name 一处
- 单元测试：暂未加（需构造 THREE scene，集成难度高；已加 REVIEW-v15 F36 待补）

#### #58 PKF 参数 ID 格式未校验 → 改名可能抛异常 + 公式永远失败（REVIEW-v15 F4）
- **症状**（潜在）：
  1. AI 或手工 ZIP 里塞进带空格的参数 id（如 `"my param"`）→ 公式求值器按 `/[a-zA-Z_]\w*/g` 拆 token，`my` 和 `param` 会被判未知标识符 → 公式永远报错
  2. 用户在 UI 输入带正则元字符的 id（如 `"*"`、`"[abc"`）→ `updatePkfParameter` 内 `new RegExp(\\b${id}\\b)` 抛 SyntaxError → 状态半修改（Map.delete 已执行但 set 没 → Map 里没这条记录了）→ UI 变空
- **排查**（GPT review 提出 + 代码静态分析验证）：
  - `addPkfParameter` [KeyframeManager.js:1031](../src/core/KeyframeManager.js#L1031) 只查空和重名
  - `updatePkfParameter` [:1066-1067](../src/core/KeyframeManager.js#L1066) 用 `new RegExp(...)` 无转义
  - 公式求值器 [:1355](../src/core/KeyframeManager.js#L1355) 只认合法 JS 标识符
  - `main.js:1919` 的 onUpdate handler 只处理 `return false`，**未 try/catch**
- **修复**：
  - [KeyframeManager.js:3-11](../src/core/KeyframeManager.js#L3) 新增常量 `PKF_ID_VALID_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/`
  - `addPkfParameter` + `updatePkfParameter`（改名分支）都走这条校验，非法返回 null/false
  - [main.js:1919-1933](../src/main.js#L1919) onUpdate 加 try/catch 兜意外异常
  - [EditorUI.js:740-748](../src/ui/EditorUI.js#L740) `idInput.pattern` 加 HTML5 原生校验，浏览器阻止非法输入
- **经验教训**：
  1. **校验放在"最早接受用户输入"处**，不是等公式求值时才发现（fail-fast 原则）
  2. **任何把用户输入塞进 `new RegExp()` 的代码都要转义或校验**——要么白名单（现在选的），要么 `escapeRegExp` helper
- 单元测试：12 个新 case（`tests/unit/keyframe-manager.test.js` F4 block），覆盖合法/非法/改名冲突/公式替换等场景

#### #59 内外双段门架 lift 没法联动（三向车 / 前移式叉车）

- **症状**（用户观察）：
  - 三向车场景里有两个 z 方向 prismatic 关节：cAR201（内门架）和 _____10（外门架），parent 关系是 cAR201 ⊂ _____10
  - 现有模板/公式只能把"门架升降"绑到**一个**关节，选谁都不对：
    - 绑 cAR201 → 高度超过内门架自由升降时外门架不动 → 叉不到高架货
    - 绑 _____10 → 即使只抬 0.5m 也要整个外门架框架一起上推 → 视觉 + 物理都不对
  - 真实叉车的 free-lift 机制：内门架先在外门架框架里自由升降，升到顶（limit_upper）后外门架才开始整体上推
- **排查**（用户对话 + 架构分析）：
  - `setJointDef` 原本只支持"1 role = 1 joint"，没有表达"溢出联动"的语义
  - `applyAllJointDrives` 单纯按拓扑顺序驱动，无法跨关节分摊
  - 用户模型很多都是双段门架（三向车、前移式），临时往 PKF 公式里写分段逻辑会把模板锁死到特定车型
- **修复**（架构级，见 [src/core/KeyframeManager.js:557-563](../src/core/KeyframeManager.js#L557)）：
  - `jointDef` 加两个可选字段：
    - `limit_upper`（number|null）—— 触发溢出的上限值
    - `overflow_to`（string|null）—— 溢出目标关节的 **name**（跨 ZIP roundtrip 稳定）
  - 新增 `_redistributeOverflows()` 私有方法（[:848](../src/core/KeyframeManager.js#L848)）：
    - target ≤ limit_upper：self=target，overflow 关节归零（防上一帧残留）
    - target > limit_upper：self=limit_upper，overflow 关节 = target - limit
    - 负值不触发溢出（直接透传给 self）
    - overflow 关节找不到时静默跳过（demo 级，不炸告警）
  - `applyAllJointDrives` 在驱动前调用 `_redistributeOverflows()`（[:912](../src/core/KeyframeManager.js#L912)）—— 溢出后的 value 再走原来的拓扑排序驱动
  - `setJointValue` 在 overflow 启用时不夹上限（[:658-663](../src/core/KeyframeManager.js#L658)），否则溢出量会被提前砍掉
  - 父子嵌套（cAR201 parent = _____10）天然帮我们在视觉空间合成总 lift（外门架升 1m，内门架自动跟随 1m via parent transform）
  - UI：关节配置面板加"运动上限" + "溢出到" 两栏（[EditorUI.js:1250-1263](../src/ui/EditorUI.js#L1250)）
  - ZIP schema bump v6 → v7，`joints.json.definitions[]` 加 `limit_upper` + `overflow_to` 字段
  - `serializeState` / `restoreState` / `exporter` / `loader` 四处同步新字段，老 ZIP 没字段 → null 兜底
  - **模板 / AI prompt 完全没动**：`门架升降` role 还是绑 cAR201；target 公式照旧；溢出全在 runtime 处理，AI 根本不知道有两段门架
- **下降方向天然对称**（不需要写镜像逻辑）：
  - 上升：target 从 0 涨到 max → inner 先填到 limit → outer 开始涨
  - 下降：target 从 max 跌到 0 → outer 先归零（因为 target 仍 > limit，inner 被夹住不变）→ target < limit 时 inner 才开始降
  - 一个正向公式覆盖两个方向
- **经验教训**：
  1. 当某个假设（"1 role = 1 joint"）撞到第一个反例（双段门架）时，权衡"是否会出现更多反例"：用户说有多个双段车型 → 走架构级修复而不是特例打补丁
  2. **父子嵌套的关节链是 overflow 最自然的载体**：分摊在数值层做，视觉合成由 Three.js 的 matrixWorld 自动完成
  3. **demo 级不追求物理真实**：简单 clamp + 余量分摊即可，不必做动力学仿真。一个正向公式能对称处理上升/下降，就不用写反向
- 单元测试：12 个新 case（`tests/unit/keyframe-manager.test.js` "双段门架 overflow 分摊" block），覆盖 limit 内/正好/超限/负值/下降穿越/未启用/目标缺失/setJointValue 夹值/序列化往返等边界

**UX 后续补丁（同 #59，追加 commit）**：

- **症状**：主 commit a558925 推上去后用户发现要让 overflow 生效**必须清空其中一个门架的 role**（cAR201 保留门架升降、`_____10` 改成"未设置"），这反直觉——两个关节明明都是"门架"
- **根因**：模板 [ForkliftTemplate.js:224](../src/core/ForkliftTemplate.js#L224) 的 `allDefs.find(d => d.role === "门架升降")` 命中顺序不稳定。如果模板绑到外门架（`_____10`）而 overflow 配置在内门架（cAR201）上 → cAR201.currentValue=0（没 PKF 目标）→ `_redistributeOverflows` 在 else 分支**强制把 `_____10` 归零** → fork 永不抬
- **修复**（[KeyframeManager.js:657-686](../src/core/KeyframeManager.js#L657)）：
  - 新增 `findPrimaryByRole(role)` helper：按 role 命中时**自动跳过被别人 `overflow_to` 指向的关节**（slave）
  - 规则由 `overflow_to` 字段隐式推导，用户无需额外 UI 操作
  - 单 role 关节 / 无 overflow 配置 → slave 集合空 → 等价于原 find（100% 向后兼容）
  - fallback：若 role 下全是 slave，仍返回第一个（保底不 null，避免破坏单段场景的误配）
  - [ForkliftTemplate.js:165](../src/core/ForkliftTemplate.js#L165) + [:224](../src/core/ForkliftTemplate.js#L224) 改用这个 helper
- **效果**：用户现在可以把 role="门架升降" 贴给**全部**门架段（语义真实），primary 由 `overflow_to` 自动锁定
- **经验教训**：**含歧义的 role 匹配应该集中在一个 helper 里**而不是每处 `find(role === x)` 散落。以后加新 role 查找自动享受"跳过 slave"规则，无需每次 code review 想特殊 case
- 单元测试：+8 case（KeyframeManager `findPrimaryByRole` block 7 个 + ForkliftTemplate `collectTemplateContext` 双段门架 1 个），覆盖单关节/多关节同 role/双段/三段嵌套/空 role/fallback slave 兜底

---

## 核心经验教训（跨 bug 总结）

1. **懒捕获 base 的时机很重要**：必须在"所有父级关节都是零位"的状态下捕获，不能在驱动态下捕获（bug #2/#3/#22）
2. **GLTFExporter/Loader 不是无损 roundtrip**：Scene 会变成 AuxScene、无名节点保留但身份变了、节点名可能丢失后缀（bug #12-#16）
3. **四元数 vs Euler**：涉及旋转的状态一律用四元数存，Euler 只做 UI 展示（bug #7/#23）
4. **跨导入稳定的标识符**：UUID 是运行时的，导出到 JSON 要用**名字**或**路径**，导入时重新解析成当前 UUID（bug #18/#19/#34）
5. **double-apply 的根因几乎都是"状态被烘焙在两个地方"**：GLB 里烘焙了 transform + 关节 def 里又有 value → 施加两次（bug #20/#30）
6. **链式关节的 base 有顺序依赖**：父级 base 先确定，子级 base 才能正确捕获（bug #8/#22）
7. **大二进制文件别进 git**：导出产物、模型文件都应该 `.gitignore`（bug #27）
8. **写诊断脚本比瞎改代码强**：多数 bug 是通过先写诊断脚本定位根因再改代码解决的（见 [docs/diagnostics.md](diagnostics.md)）
9. **合并 mesh 下 bbox ≠ 子部件几何**：启发式注定在某些模型失败，最终需要用户手动指定（承载锚点六轮迭代 #47-#52，详见 [gotchas/007](gotchas/007-merged-mesh-bbox-trap.md)）
10. **任何 data-out 到外部系统的点都必须走同一个 helper**：历史留下的双实现是最容易埋 bug 的地方（bug #38）

---

## 相关文档

- [CLAUDE.md](../CLAUDE.md) — 协作手册（架构红线 + 协作规则 + 调试钩子索引）
- [docs/diagnostics.md](diagnostics.md) — 诊断脚本完整指南（7 个脚本 + 6 个场景 + 单行命令）
- [docs/gotchas/](gotchas/) — 按主题分类的深度踩坑档案
- [docs/REVIEW-v14.md](REVIEW-v14.md) — v14.1 全仓 review（F1-F27 findings + 行动路线）
