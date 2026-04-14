# MotionForge Bug 修复日志

按时间顺序记录开发过程中遇到的问题、根因分析和修复方案。每条形如：**症状 → 排查 → 根因 → 修复**。

---

## 阶段一：关节系统 v1 基础

### #1 Gizmo 拖动时视口卡死

- **症状**：选中对象后 gizmo 出现，但拖动时整个视口冻结，鼠标事件无响应
- **排查**：OrbitControls 和 TransformControls 都在监听 pointer 事件，互相抢
- **根因**：`SelectionManager` 和 `jointMarker` 的 capture listener 劫持了事件
- **修复**：鼠标 hover 到 gizmo handle 时跳过场景选择 — `if (this.sceneManager.jointGizmo?.axis) return;`

### #2 配置关节后对象瞬间"飞走"

- **症状**：刚给对象加上关节，对象就从原位置跳到另一个位置
- **根因**：`baseTransform` 缺失，`applyJointDrive` 把 value=0 当成"需要还原到未定义的零位"
- **修复**：`applyJointDrive` 里加**懒捕获**—— base 为 null 时，从当前 world 状态反算并存储；onChange 里也立刻捕获一次

### #3 reparent（insertGroup）后对象飞走

- **症状**：把对象插入新 group 做父级包装后，对象再次飞走
- **根因**：baseTransform 是相对**旧父级**捕获的，换父级后坐标系不同
- **修复**：`rebindJointBaseTransform(obj)` 在任何 reparent 后清空 `def.baseTransform = null`，让下一帧懒捕获重建

### #4 Gizmo 平移（prismatic）瞬间弹回

- **症状**：拖动 prismatic gizmo 时对象跟随一段后"弹回"原位
- **根因**：delta 用 `object.position`（局部空间）计算，当父节点有旋转时，世界 Y 方向的拖拽在局部空间会分散到 XYZ，局部 Y 分量很小
- **修复**：Gizmo delta 和 `applyJointDrive` 的 prismatic 都改用**世界空间**计算，投影到关节的世界轴方向

### #5 Gizmo 旋转围绕错误中心

- **症状**：绕 origin 旋转变成绕对象自身 pivot 旋转
- **根因**：origin 存的是世界坐标，代码按 parent-local 解读
- **修复**：改为 **URDF 风格**—— origin 存**关节父级 local** 空间。父节点动，origin 自动跟。

### #6 Gizmo 旋转离散跳变

- **症状**：rotate gizmo 拖动时对象不是平滑旋转，而是跳跃式离散变化
- **根因**：TransformControls 围绕对象 pivot 旋转，不是围绕 def.origin
- **修复**：onChange 回调里 `applyJointDrive(force=true)` 强制用我们自己的 origin-based 旋转公式重写 transform

### #7 万向锁（Gimbal Lock）旋转丢失 57°

- **症状**：某些关节旋转到 ~90° 时 Euler 分解失真，实际旋转少 57°+
- **根因**：`baseTransform` 用 Euler (rx, ry, rz) 存储，`Quaternion → Euler → Quaternion` 在 Y ≈ π/2 附近有奇点
- **修复**：`baseTransform` 改存**四元数** (qx, qy, qz, qw)，全程避免 Euler 转换

### #8 拓扑排序：关节链驱动顺序错误

- **症状**：父关节和子关节同时驱动，但渲染先后顺序错，导致子关节计算用的是父关节旧状态
- **根因**：按场景树深度排序，但关节链可能跨越兄弟节点（e.g. 门架和叉齿平级）
- **修复**：`applyAllJointDrives` 改用 **Kahn's 拓扑排序**，按 `jointA.childId === jointB.parentId` 关系决定顺序

---

## 阶段二：架构重构

### #9 per-object 关键帧混乱

- **症状**：用户选中对象 A 添加关键帧，切到对象 B 再添加，两个 clip 互相看不见
- **根因**：关键帧是 per-object 的，每个对象独立的 clip
- **修复**：重构为**全局关键帧** —— 项目级 `globalClips`，每个 keyframe 字典捕获**所有**关节当前 value

### #10 FK 求解器依赖场景树层级

- **症状**：场景树 reparent 后，关节链驱动关系就断了
- **根因**：`applyJointDrive` 用 `childObj.parent` 作为"关节父级"
- **修复**：关节定义独立存 `parentId`，应用时 `nodeMap.get(def.parentId)` 查找——与场景树层级解耦

### #11 旧关节点系统残留

- **症状**：~300 行浮动面板、红/黄球 gizmo、jointPoints 数组等旧代码杂乱
- **修复**：全部删除，保留 FK 关节定义单一数据源

---

## 阶段三：导出 / 导入 Roundtrip（本轮主战场）

### #12 ZIP 导出后再导入模型变形

- **症状**：模型层级被压扁、零件位置错乱
- **排查**：写诊断脚本 `diag-export-roundtrip.js` 对比导出前后场景树
- **根因**：GLTFExporter 对 `THREE.Scene` 节点的处理和 GLTFLoader 不一致，Loader 总是在外面包一层新 Scene
- **修复**：导出时不传 Scene，传 `sceneRoot.children` 数组（所有有意义的子节点）

### #13 导入后节点数量少 4 个（19 vs 23）

- **症状**：插入的 group 丢失
- **根因**：第一次修 #12 时只导出 `children[0]`，漏掉其他兄弟
- **修复**：导出 **ALL** 有意义子节点（过滤掉灯光/相机/Helper）

### #14 导入后模型整体下沉 1.65 单位

- **症状**：模型陷进网格下面
- **排查**：`diag-roundtrip-transform.js` phaseA/B/C 对比
- **根因**：`alignObjectToGround` 把 Scene.position.y 调整了 1.65，这个偏移被烘焙进 GLB 子节点；导入时 `skipAlign: true` 不再调整，新 Scene position.y = 0，导致整体偏移
- **修复**：移除 `skipAlign`，让 `alignObjectToGround` 正常运行。配合后面 #20 的零位导出，不会再有双重对齐

### #15 导入后根节点被重命名为 "AuxScene"

- **症状**：左侧场景树顶层节点名字变了
- **根因**：GLTFExporter 不保留原始 Scene 的名字
- **修复**：导入后 `root.name = manifest.source.file_name` 恢复

### #16 导入后场景树所有节点整体偏移

- **症状**：所有节点（含没关节的）都有相同偏移
- **根因**：同 #14（对齐偏移被烘焙）
- **修复**：同 #14

### #17 导入后零件高亮不消失

- **症状**：一个零件一直发蓝绿色光
- **排查**：`c.material.emissive` 是蓝绿色（高亮色）
- **根因**：SelectionManager 高亮 clone material 并改 emissive，导出时带高亮 → GLTFExporter 烘焙进 GLB
- **修复**：导出前 `selectionManager.clearSelection()`，导出后恢复

### #18 `parentId` 在导入后被错误覆盖

- **症状**：导入后链式关节变独立 —— _CS19110 不跟随 _CS198 运动
- **排查**：`diag-joint-integrity.js` 显示 `parentId === sceneParent`（无名 Object3D 包装）
- **根因**：导入代码 `parentId: parentObj?.uuid || d.parent_id || null`，其中 `parentObj = childObj?.parent`，总是取 scene parent（无名包装），覆盖了保存的逻辑父级
- **修复**：
  - 导出时 joints.json 新增 `parent_name` 字段
  - 导入时按 `parent_name` 在 `objectsByName` 里查找逻辑父级
  - 找不到再兜底到 `childObj.parent`

### #19 PKF `joint_def_id` 跨导入失效

- **症状**：导入后 PKF 步骤找不到对应关节
- **根因**：PKF step 存的是运行时 UUID（jointDef.id），roundtrip 后 UUID 全变
- **修复**：PKF step 只存 `joint`（关节**名字**），导入时按名字解析回当前 UUID

---

## 阶段四：归零策略（最绕的一节）

### #20 Double-apply：导出的 GLB 烘焙了驱动态

- **症状**：非零 value 的关节导入后位置不对，视觉上叠加了两次驱动
- **排查**：对比 stored base vs 导入后的 should_be
- **根因**：GLTFExporter 烘焙的是**当前驱动后**的 transform，导入后 applyJointDrive 又基于这个 transform 再施加一次 value → double-apply
- **修复方向**：导出前先归零

### #21 第一版零位导出失败（清空 base + value=0）

- **症状**：导入后仍然有漂移，诊断发现 GLB 里的 transform 不是零位
- **排查**：`diag-zero-pose.js` 对比方案 A（保留 base）和方案 B（清空 base）
- **根因**：清空 `baseTransform` 后 `applyAllJointDrives` 懒捕获从**当前驱动态**重建 base → GLB 仍然存驱动态
- **修复**：改为**方案 A** —— 只设 `currentValue=0`，**保留**现有 base。现有 base + value=0 → 正确还原到零位

### #22 链式关节导入后整体下沉

- **症状**：动画播放时所有链式关节零件整体下沉相同距离（例如都下降 1.52 单位）
- **排查**：`diag-animation.js` 扫描 clip 发现 4 个节点 Y 变化范围都等于 `KF0 - KF1` 的 _____10 位移量
- **根因**：导入时直接用 JSON 里的 `currentValue`（非零）触发 `applyAllJointDrives`。拓扑排序先驱动父级 _____10 → 父级移动 → 子级 cAR201 懒捕获 base 时捕获的是**父级已驱动态下**的相对位置。动画把父级改回零位后，子级相对下沉父级的位移量
- **修复**：导入时**两阶段应用**：
  1. 先把所有 `currentValue = 0`
  2. `applyAllJointDrives` → 所有关节在**零位**懒捕获 base
  3. 恢复真实 `currentValue`
  4. 再 `applyAllJointDrives` → 正常驱动

---

## 阶段五：Gizmo 交互

### #23 旋转 gizmo 大角度跳变 360°

- **症状**：逆时针拖动叉齿到某个角度后继续拖，角度瞬间跳 360°
- **根因**：**四元数双重覆盖**。`q` 和 `-q` 代表同一旋转，TransformControls 大角度时会把 current quaternion 归一化到"最短路径"表示，触发符号翻转。提取的 `2 * atan2(sinHalf, cosHalf)` 因此跳 ±2π
- **修复**：角度**解缠** —— 保持相邻帧 angle 差值 ≤ π，超过就加减 2π 补偿。每次新拖拽重置 `_gizmoLastAngle`

---

## 阶段六：其他细节

### #24 GridHelper 颜色警告

- **症状**：Console 一直打印 `THREE.Color does not support alpha` 警告
- **根因**：代码里给 `GridHelper` 传了 rgba 颜色，`THREE.Color` 只支持 rgb
- **修复**：换成预算好的实色 hex（`0x6a6a6a` / `0x626262`，在 `#585858` 背景上视觉等效半透明灰）

### #25 材质高亮影响其他对象

- **症状**：一个对象被选中，所有共享同一材质的对象也都发光
- **根因**：SelectionManager 直接修改 `material.emissive`，material 是共享引用
- **修复**：修改前 `material.clone()`，只改这个对象自己的拷贝

### #26 "从关键帧生成"功能失效

- **症状**：全局关键帧重构后，旧的"从选中对象的 channel 生成"函数还在读取 per-object clips
- **修复**：重写该函数用全局 keyframes + joint_values

---

## 阶段七：git 仓库维护

### #27 git push 失败（corrupt loose object）

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

## 涉及到的诊断脚本

路径：[tests/](../tests/)

| 脚本 | 主要解决了哪些 bug |
|------|-------------------|
| `diag-export-roundtrip.js` | #12, #13 |
| `diag-roundtrip-transform.js` | #14, #16, #20 |
| `diag-joint-integrity.js` | #18 |
| `diag-zero-pose.js` | #21 |
| `diag-animation.js` | #22 |

详细使用方法见 [tests/DIAGNOSTICS.md](../tests/DIAGNOSTICS.md)。

---

## 核心经验教训

1. **懒捕获 base 的时机很重要**：必须在"所有父级关节都是零位"的状态下捕获，不能在驱动态下捕获。
2. **GLTFExporter/Loader 不是无损 roundtrip**：Scene 会变成 AuxScene、无名节点保留但身份变了、节点名可能丢失后缀。
3. **四元数 vs Euler**：涉及旋转的状态一律用四元数存，Euler 只做 UI 展示。
4. **跨导入稳定的标识符**：UUID 是运行时的，导出到 JSON 要用**名字**（name）或**路径**（scene_path），导入时重新解析成当前 UUID。
5. **double-apply 的根因几乎都是"状态被烘焙在两个地方"**：GLB 里烘焙了 transform + 关节 def 里又有 value → 施加两次。
6. **链式关节的 base 有顺序依赖**：父级 base 先确定，子级 base 才能正确捕获。
7. **大二进制文件别进 git**：导出产物、模型文件都应该 `.gitignore`。
8. **写诊断脚本比瞎改代码强**：多数 bug 是通过先写诊断脚本定位根因再改代码解决的，节省大量反复试错。
