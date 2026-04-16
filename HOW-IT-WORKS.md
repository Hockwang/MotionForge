# MotionForge 技术原理

> 这份文档解释 MotionForge **怎么算的、为什么这么算**。
> 面向：开发者、研究者、未来的自己。
> 配合阅读：[FLOW.md](FLOW.md)（操作流程）、[CLAUDE.md](CLAUDE.md)（架构约束 + bug 历史）

---

## 目录

1. [坐标系约定](#1-坐标系约定)
2. [FK 关节数学](#2-fk-关节数学)
3. [四元数与万向锁](#3-四元数与万向锁)
4. [拓扑排序：关节链驱动顺序](#4-拓扑排序关节链驱动顺序)
5. [PKF 参数化公式求值](#5-pkf-参数化公式求值)
6. [全局关键帧系统](#6-全局关键帧系统)
7. [动画循环](#7-动画循环)
8. [导出/导入 Roundtrip](#8-导出导入-roundtrip)
9. [AI 生成 PKF](#9-ai-生成-pkf)
10. [关键设计决策索引](#10-关键设计决策索引)

---

## 1. 坐标系约定

MotionForge 内部有两套坐标系：

| 坐标系 | 上方向 | 前方向 | 使用场景 |
|---|---|---|---|
| **UI 坐标系** | Z-up | Y-forward | 关节定义面板、origin 输入、axis 选择 |
| **Three.js 坐标系** | Y-up | Z-forward | 场景渲染、世界空间计算 |

**轴映射函数**（[SceneManager.js:13](src/core/SceneManager.js#L13)）：

```
UI axis    →  Three.js world axis
  x        →  X（不变）
  y        →  Z（UI 的 Y-forward = Three.js 的 Z）
  z        →  Y（UI 的 Z-up = Three.js 的 Y-up）
```

所有关节定义存 UI 坐标系的值，运算时转 Three.js 世界空间。

---

## 2. FK 关节数学

### 2.1 关节定义数据结构

每个关节（[KeyframeManager.js:104](src/core/KeyframeManager.js#L104)）包含：

```javascript
{
  id,                          // 子对象的 uuid
  name,                        // 子对象的场景树名字（跨 roundtrip 稳定标识）
  type,                        // 'revolute' | 'prismatic' | 'fixed' | 'none'
  axis,                        // 'x' | 'y' | 'z'（UI 坐标系）
  role,                        // 语义角色标签（'门架升降'、'叉齿旋转'...）
  origin: { x, y, z },        // 旋转中心，关节父级 local 空间（URDF 风格）
  parentId,                    // 关节父级的 uuid（逻辑父级，非场景树 parent）
  childId,                     // 被驱动子对象的 uuid
  currentValue,                // 当前驱动值（角度° 或 米）
  baseTransform: {             // 零点姿态（关节父级 local 空间）
    tx, ty, tz,                // 位置
    qx, qy, qz, qw            // 四元数旋转（不用 Euler，避免万向锁）
  },
  limits: { min, max }         // 值域范围
}
```

### 2.2 两种"父级"

这是初学者最容易混淆的点：

```
场景树父级（Three.js parent）
  ↳ mesh.parent — 由 GLB 加载或 insertGroup 决定
  ↳ 用于坐标系转换（localToWorld / worldToLocal）

关节父级（joint parent）
  ↳ def.parentId — 由用户在配置面板选择
  ↳ 用于运动链传递（父动 → origin 跟着动 → 子自动跟着）
  ↳ base 和 origin 都存在这个坐标系里
```

两者可以不同。关节系统**只看关节父级**来计算运动链，和场景树层级解耦（[CLAUDE.md #10](CLAUDE.md)）。

### 2.3 懒捕获 baseTransform

**时机**：关节的 `baseTransform` 为 null 时，在首次 `applyJointDrive` 时自动捕获（[KeyframeManager.js:233](src/core/KeyframeManager.js#L233)）。

**计算方式**：

```
子对象世界位置 → 转到关节父级的 local 空间 → 存为 base.tx/ty/tz
子对象世界旋转 → 转到关节父级的 local 四元数 → 存为 base.qx/qy/qz/qw
```

**关键约束**：懒捕获**必须在所有父级关节都是零位时**发生。如果父级已经被驱动，子级捕获的 base 包含了父级的驱动偏移，之后父级回零时子级会反向漂移（[CLAUDE.md #22](CLAUDE.md)）。

### 2.4 驱动公式

每次调用 `applyJointDrive`（[KeyframeManager.js:215](src/core/KeyframeManager.js#L215)），执行以下计算：

**Step 1：恢复零点世界位姿**

```
if (有关节父级):
  baseWorldPos  = jointParent.localToWorld(base.tx, base.ty, base.tz)
  baseWorldQuat = jointParent.worldQuat × base.quat
else:
  baseWorldPos  = sceneParent.localToWorld(base.tx, base.ty, base.tz)
  baseWorldQuat = sceneParent.worldQuat × base.quat
```

**Step 2：计算 origin 世界位置**

```
originLocal = (def.origin.x, def.origin.z, def.origin.y)   // UI→Three.js 轴映射
if (有关节父级):
  originWorld = jointParent.localToWorld(originLocal)
else:
  originWorld = originLocal   // 当世界坐标
```

**Step 3：按类型施加增量**

**Revolute（旋转）**：

```
角度 = currentValue × π / 180
世界轴 = mapUiAxisToWorld(def.axis)
旋转四元数 = Quaternion.fromAxisAngle(世界轴, 角度)

偏移 = baseWorldPos - originWorld
旋转后偏移 = rotationQuat.apply(偏移)

newWorldPos  = originWorld + 旋转后偏移
newWorldQuat = rotationQuat × baseWorldQuat
```

数学含义：**把子对象围绕 originWorld 点、沿 axis 旋转 currentValue 度**。origin 偏一点，旋转弧线就错。

**Prismatic（平移）**：

```
世界轴 = mapUiAxisToWorld(def.axis)
newWorldPos  = baseWorldPos + 世界轴 × currentValue
newWorldQuat = baseWorldQuat   // 不变
```

数学含义：**沿 axis 方向平移 currentValue 距离**。origin 不参与计算。

**Step 4：世界 → 场景树 parent local → 写入 child**

```
childObj.position = sceneParent.worldToLocal(newWorldPos)
childObj.quaternion = sceneParent.worldQuat⁻¹ × newWorldQuat
```

### 2.5 父级动，子级怎么自动跟

关键在于 **base 和 origin 都存在关节父级 local 空间**。

```
1. 父级被驱动 → 父级世界位置变化
2. base.localToWorld 使用父级最新的世界矩阵 → baseWorldPos 自动跟着变
3. origin.localToWorld 同理 → originWorld 自动跟着变
4. 子级计算用的是更新后的 baseWorldPos 和 originWorld → 自然跟着
```

不需要任何额外代码处理"子跟父"——URDF local 约定让 Three.js 的 `localToWorld` 自动完成级联。

---

## 3. 四元数与万向锁

### 为什么不用 Euler

Euler 角 (rx, ry, rz) 在 Y ≈ ±90° 附近存在**万向锁（Gimbal Lock）**：两个旋转轴退化为同一方向，丢失一个自由度。

实际症状：用户旋转叉齿到 ~90°，Euler 分解失真，实际旋转少 57°（[CLAUDE.md #7](CLAUDE.md)）。

### 四元数

`baseTransform` 存四元数 `{qx, qy, qz, qw}`：

```
四元数 q = (qx, qy, qz, qw) 表示绕轴 (qx, qy, qz)/sin(θ/2) 旋转 θ
没有奇点，任意旋转都精确表示
```

全流程避免 Euler 中间转换：
- 捕获 base → `getWorldQuaternion` → 存四元数
- 驱动 → 四元数乘法 → 写 `childObj.quaternion`
- **唯一用 Euler 的地方**：UI 展示（`joint value` 输入框显示角度值）

### Gizmo 旋转解缠

四元数有**双重覆盖**问题：`q` 和 `-q` 表示同一旋转。TransformControls 大角度时可能翻转符号，导致提取的角度跳 ±360°（[CLAUDE.md #23](CLAUDE.md)）。

解缠逻辑（[SceneManager.js:230](src/core/SceneManager.js#L230)）：

```javascript
if (this._gizmoLastAngle !== undefined) {
  while (angle - this._gizmoLastAngle > Math.PI)  angle -= 2 * Math.PI;
  while (angle - this._gizmoLastAngle < -Math.PI) angle += 2 * Math.PI;
}
this._gizmoLastAngle = angle;
```

每次新拖拽重置 `_gizmoLastAngle = undefined`。

---

## 4. 拓扑排序：关节链驱动顺序

### 为什么不按场景树深度

场景树的父子关系和关节链的依赖关系不一定一致。例如叉齿和门架可能在场景树里是兄弟节点，但关节链上叉齿依赖门架。按场景树深度排序会先驱动叉齿（和门架同深度），但此时门架还没被驱动——叉齿读到的 `jointParent.localToWorld` 是旧状态。

### Kahn's 拓扑排序

[KeyframeManager.js:359](src/core/KeyframeManager.js#L359)：

```
1. 建图：若 jointA.childId === jointB.parentId → B 依赖 A
2. 计算入度：每个关节统计"有多少其他关节是它的前置"
3. 初始化队列：入度 = 0 的关节入队（根关节）
4. 循环：
   a. 出队一个关节 → 驱动它（applyJointDrive）
   b. 它的所有后继关节入度 -1
   c. 入度变 0 的入队
5. 结束：所有关节都按依赖顺序驱动完毕
```

效果：**父级一定先于子级驱动**。子级读 jointParent.localToWorld 时，父级已经是最新状态。

---

## 5. PKF 参数化公式求值

### 5.1 数据结构

```javascript
pkf = {
  parameters: [
    { id: "lift_height", type: "number", unit: "m", default: 1.0 },
    { id: "rotation_angle", type: "number", unit: "deg", default: 90 },
  ],
  steps: [
    {
      id: "step_001",
      joint: "_____10",           // 关节名字（不是 uuid，跨 roundtrip 稳定）
      channel: "translate",       // rotate | translate
      axis: "z",
      t_start: 0, t_end: 3,      // 时间区间（秒）
      value_start: "0",           // 公式字符串（可引用 parameters）
      value_end: "lift_height",   // 公式字符串
      easing: "ease-in-out",      // linear | ease-in | ease-out | ease-in-out
    },
  ]
}
```

### 5.2 公式安全求值

[KeyframeManager.js:827](src/core/KeyframeManager.js#L827)：

```
1. 白名单检查：提取公式中所有标识符
   - 允许：参数名（lift_height）、Math 函数（PI, sin, cos, abs...）
   - 禁止：; { } [ ] = "  等危险字符
   - 不在白名单 → 返回 error，不执行

2. 沙箱求值：
   new Function(...参数名, `"use strict"; return (${公式})`)
   传入参数值 → 得到数字结果

3. 安全性：无法访问全局变量、无法执行任意代码
```

### 5.3 步骤求值管线

[KeyframeManager.js:902](src/core/KeyframeManager.js#L902)：

```
evaluatePkfAt(t):
  1. 构建参数值字典 { lift_height: 1.0, rotation_angle: 90 }
  2. 按 t_start 排序所有步骤
  3. 对每个步骤：
     if t < t_start → 跳过（还没开始）
     if t >= t_end  → progress = 1.0（保持末值，不回零）
     else           → progress = (t - t_start) / (t_end - t_start)
  4. 应用缓动：
     ease-in:     progress = t²
     ease-out:    progress = 2t - t²
     ease-in-out: progress = 3t² - 2t³ (smoothstep)
  5. 插值：value = start + (end - start) × progress
  6. 输出：[{ joint, value, error }, ...]
```

### 5.4 运行时驱动

[main.js:831](src/main.js#L831)：

```
applyPkfAtTime(t):
  1. 建立 name→def 索引
  2. 求值所有步骤
  3. 逐结果写入 def.currentValue（先按 uuid 查，失败按 name fallback）
  4. 公式错误或关节缺失 → console.warn（去重，不刷屏）
```

---

## 6. 全局关键帧系统

### 设计：全局 vs per-object

早期版本是 per-object 关键帧（每个对象单独的 clip），重构后改为**项目级全局关键帧**（[CLAUDE.md #9](CLAUDE.md)）。

```javascript
globalClips = {
  "default": {
    duration: 10,
    keyframes: [
      { time: 0,   jointValues: { "_____10": 0,   "_CS198": 0,    "_CS19110": 0   } },
      { time: 5,   jointValues: { "_____10": 1.5, "_CS198": 0.3,  "_CS19110": 45  } },
      { time: 10,  jointValues: { "_____10": 0,   "_CS198": 0,    "_CS19110": 0   } },
    ]
  }
}
```

**每个 keyframe 捕获所有关节的 value**。key 是关节 name（不是 uuid）。

### 插值

[KeyframeManager.js:514](src/core/KeyframeManager.js#L514)：

```
给定时间 t：
  找到 t 前后最近的两个关键帧 kA(tA) 和 kB(tB)
  progress = (t - tA) / (tB - tA)
  对每个关节：value = kA.jointValues[name] + (kB - kA) × progress
  t < 第一帧 → 使用第一帧值
  t > 最后一帧 → 使用最后一帧值
```

---

## 7. 动画循环

[main.js:875](src/main.js#L875)：

```
loop(now):
  deltaSeconds = (now - lastFrameTime) / 1000

  if (isPlaying):
    next = (currentTime + delta) % duration     // 环回循环

    if (pkfPlaybackMode):
      applyPkfAtTime(next)                      // PKF 公式 → currentValue
    else:
      evaluateAllAt(next)                        // 关键帧插值 → currentValue

  applyAllJointDrives(root)                      // FK 求解器 → 场景 transform
  sceneManager.render()                          // Three.js 渲染
  requestAnimationFrame(loop)
```

**两种播放模式**：
- **关键帧模式**：`evaluateAllAt` 按时间插值所有关节的 `joint_values`
- **PKF 模式**：`applyPkfAtTime` 按公式计算所有关节的 `currentValue`

两者都最终输出 `def.currentValue`，由同一个 `applyAllJointDrives` 驱动。

---

## 8. 导出/导入 Roundtrip

### 8.1 导出前：零位化

[main.js:1424](src/main.js#L1424)：

```
1. selectionManager.clearSelection()
   ↳ 清除高亮（emissive），防止 GLTFExporter 烘焙发光材质进 GLB

2. 保存所有 currentValue → savedValues[]
3. 设所有 currentValue = 0（保留 baseTransform 不动）
4. applyAllJointDrives → 模型回到零位
5. GLTFExporter.parse(sceneRoot.children) → model.glb（零位态）

6. joints.json 的 currentValue 也写 0（和 GLB 语义一致）
   ↳ 不能写真值！否则导入后 GLB 是零位但 joints 是驱动态 → double-apply

7. 恢复 savedValues + clearSelection 的选中对象
```

### 8.2 导出文件

```
ZIP 包（schema v4）：
├── manifest-{ts}.json   — 版本 + 文件索引
├── model-{ts}.glb       — 零位态的场景（GLTFExporter 输出）
├── joints-{ts}.json     — 关节定义（含 role、parent_name、baseTransform）
├── motion-{ts}.json     — 全局 clips + 每帧 joint_values
└── pkf-{ts}.json        — PKF 参数 + 步骤（可选）
```

### 8.3 导入后：两阶段应用

[main.js:775](src/main.js#L775)：

```
阶段 A：零位捕获 base
  1. 加载 GLB → sceneRoot（零位态）
  2. 重建 joint defs（按 parent_name 解析 parentId，不用旧 uuid）
  3. 保存 JSON 里的 currentValue → savedImportValues
  4. 设所有 currentValue = 0
  5. applyAllJointDrives → 每个关节 base=null → 懒捕获在零位发生

阶段 B：恢复驱动
  6. 恢复 savedImportValues
  7. evaluateAllAt(0) → 如果有关键帧，覆盖为 t=0 的值
  8. applyAllJointDrives → 正常驱动
```

**为什么要两阶段**：如果直接用 JSON 的 currentValue 驱动，拓扑排序会先驱动父级（非零）→ 子级懒捕获 base 时父级已偏移 → 子级的 base 包含了父级的驱动偏移 → 父级回零时子级反向漂移（[CLAUDE.md #22](CLAUDE.md)）。

### 8.4 跨 roundtrip 的标识

| 标识 | 稳定性 | 用途 |
|---|---|---|
| **name** | ✅ 跨 roundtrip 稳定 | joints.json 主键、PKF step.joint、motion keyframe keys |
| **uuid** | ❌ 每次加载重新生成 | 仅运行时引用 |
| **parent_name** | ✅ | 导入时按名字重建关节链 |

永远**导出用 name，导入时重新解析到当前 uuid**（[CLAUDE.md #18, #19](CLAUDE.md)）。

---

## 9. AI 生成 PKF

### 9.1 流程

```
用户输入自然语言（"叉齿旋转 45 度，门架抬升 0.6 米"）
  ↓
前端构造请求：{ prompt, joints: [{name, type, axis, role}, ...] }
  ↓
后端（tools/conversion-service.js）：
  system prompt = PKF 格式说明 + few-shot 示例（叉车取货动作）+ role 匹配规则
  user message = 关节列表（含 role 标签）+ 用户描述
  ↓
LLM 输出 JSON：{ parameters: [...], steps: [...] }
  ↓
后处理：
  1. 关节名修正（精确匹配优先 → 收紧的子串匹配 fallback）
  2. channel/type 修正（rotate ↔ revolute 对不上时自动换关节）
  3. error 检测（role 匹配不上 → 422 + available_roles）
  ↓
前端应用 PKF → 用户预览
```

### 9.2 role 语义匹配

传统做法：AI 只看 `{name, type, axis}` → 凭 axis 猜用途 → 选错关节（[CLAUDE.md #29](CLAUDE.md)）。

改进：每个关节带 `role` 字段（"门架升降"、"叉齿侧移"...），AI 按语义匹配意图。匹配不上不硬猜，返回 error。

### 9.3 few-shot 策略

system prompt 里嵌一个完整的取货动作示例（parameters + steps + 公式 + 时序）。AI 照格式模仿，关节名从用户当前模型列表里挑。

不做模板库（过度设计），不让 AI 从零生成（不稳定），保持 prompt 内的 few-shot 是当前最佳平衡点（[CLAUDE.md #28](CLAUDE.md)）。

---

## 10. 关键设计决策索引

每条都是踩过坑换来的。详见 [CLAUDE.md](CLAUDE.md) 对应 bug 编号。

| 决策 | 原因 | 反例（bug 编号） |
|---|---|---|
| baseTransform 存四元数 | Euler 在 90° 附近有万向锁 | [#7](CLAUDE.md) |
| origin 存关节父级 local | 父动 → origin 自动跟 | [#5](CLAUDE.md) |
| 拓扑排序驱动关节链 | 场景树深度不等于关节依赖 | [#8](CLAUDE.md), [#10](CLAUDE.md) |
| 跨 roundtrip 用 name 不用 uuid | uuid 每次加载重新生成 | [#18](CLAUDE.md), [#19](CLAUDE.md) |
| 导出前归零 + 清选中 | 防止 double-apply + emissive 烘焙 | [#17](CLAUDE.md), [#20](CLAUDE.md) |
| 导入两阶段应用 | 懒捕获必须在零位发生 | [#22](CLAUDE.md) |
| joints.json currentValue 写 0 | GLB 和 JSON 语义必须一致 | [#30](CLAUDE.md) |
| PKF step 用 joint name 不用 uuid | uuid 跨导入失效 | [#19](CLAUDE.md) |
| AI 用 role 匹配不靠 axis 猜 | axis 相同但用途不同 | [#29](CLAUDE.md) |
| Gizmo 角度解缠 | 四元数双重覆盖导致跳变 | [#23](CLAUDE.md) |
| few-shot 不做模板库 | 模板数少时基础设施是浪费 | [#28](CLAUDE.md) |
| 导出归零/恢复用 try/finally | 异常时不能卡在零位 | [#32](CLAUDE.md) |
| 关节链 setJointDef 入口环检测 | 拓扑排序不处理环，源头堵住 | [#33](CLAUDE.md) |

---

## 代码入口索引

| 功能 | 文件 | 关键函数 |
|---|---|---|
| 关节定义 | [KeyframeManager.js](src/core/KeyframeManager.js) | `setJointDef` |
| 单关节驱动 | [KeyframeManager.js](src/core/KeyframeManager.js) | `applyJointDrive` |
| 拓扑排序驱动 | [KeyframeManager.js](src/core/KeyframeManager.js) | `applyAllJointDrives` |
| PKF 公式求值 | [KeyframeManager.js](src/core/KeyframeManager.js) | `evaluatePkfFormula`, `evaluatePkfAt` |
| 关键帧插值 | [KeyframeManager.js](src/core/KeyframeManager.js) | `evaluateAllAt` |
| PKF 运行时驱动 | [main.js](src/main.js) | `applyPkfAtTime` |
| 动画循环 | [main.js](src/main.js) | `updateTimeline`, `loop` |
| 导出 | [main.js](src/main.js) + [ResultPackageExporter.js](src/core/ResultPackageExporter.js) | `exportPackageBtn`, `serializeSceneToGlb` |
| 导入 | [main.js](src/main.js) | `handleImportPackage` |
| AI 请求 | [main.js](src/main.js) | `requestAiGeneratePkf` |
| AI 后端 | [conversion-service.js](tools/conversion-service.js) | `/api/generate-pkf` |
| Gizmo 交互 | [SceneManager.js](src/core/SceneManager.js) | `showJointGizmo`, `onChange` |
| 关节 UI | [EditorUI.js](src/ui/EditorUI.js) | `showJointConfigPanel` |
