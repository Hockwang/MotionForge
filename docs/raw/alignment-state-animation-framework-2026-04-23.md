# 状态机动画框架对齐文档

> **日期**：2026-04-23
> **作者**：MotionForge 团队
> **对齐对象**：[mentor]《固定资源状态动画》文档（飞书云文档，最近修改 2026-04-23）
> **目的**：确认我们对 mentor 设计意图的理解是否准确，同步 MotionForge 现状，列出落地前待澄清的问题
> **状态**：✅ 已对齐（2026-04-23），不重构

---

## 0. 对齐结论（2026-04-23，和 mentor 当面确认）

**不重构。17 段模板保留，MotionForge 不需要做 5 状态机框架。**

**Mentor 判定**：我们的 17 段模板 ≈ 状态机里 `load + travelLoaded + unload` **三个状态连起来的一个环节**，不是与状态机并列的东西。状态拆分是**更上层**的调度/仿真侧职责，MotionForge 作为编辑器不需要管。

职责边界因此清晰：

| 层 | 谁负责 | 干什么 |
|---|---|---|
| **上层（状态机编排）** | 仿真端 / 调度系统 | 按任务队列决定下一个状态；`idle` / `travelEmpty` / 多次 `load`（拆码垛）/ 充电桩对接等 |
| **中层（单个状态的完整动画）** | MotionForge | 把 "load + travelLoaded + unload" 这种完整搬运环节编译成 PKF 动画（= 我们的 17 段） |
| **下层（关节 / reparent 驱动）** | MotionForge 运行时 | 求值公式、驱动关节、触发 attach/detach |

**因此**：
- 充电 / 巡检 / 拆码垛这些场景，**不是** MotionForge 要解决的问题——是上层把 17 段动画串几次、中间插 idle
- MotionForge 的对外协议（PKF / ZIP）保持当前结构，上层按需要调用多次
- 文档 §5 的 Q1–Q7 大部分已失效（它们是针对"重构成 5 状态"的），只剩 Q7（4 个叉车参数保留方式）仍有意义——结论：保留现状（参数暴露在 PKF 里，用户可调）

**后续行动**：
- ~~重构~~ 不做
- 继续打磨 17 段模板本身的几何精度、AI 节奏 prompt、UI 体验
- 把这份对齐文档保留在 `docs/raw/` 作为决策记录
- **不改**对外 PKF/ZIP 格式

下面第 1–7 章是对齐**过程中**的分析，保留做历史记录。结论以本章为准。

---

## 1. 背景

### 1.1 MotionForge 当前在做什么

Web 端 3D 编辑器，给工业叉车做动画包导出。最近两周（mvp3）从"AI 直接出 PKF"重构到"前端 17 段模板 + AI 出节奏"，几何精度从"靠 prompt 管"升级到"写死在前端公式里"。

### 1.2 为什么需要对齐

mentor 文档提出"**状态拆分 + 姿态继承**"的更抽象框架，我们判断这和 MotionForge 正在走的"原子模板 + 编排"方向**本质同一**，但 mentor 的 formulation 更干净、适用面更广（覆盖升降机/RGV/转台/堆垛机/机械臂五种设备）。

如果我们的理解正确，**MotionForge 的 17 段模板应该重构成 5 个状态动画**，以对齐仿真端的设计语言。重构成本 1–2 周，但重构后的好处是：

- 支持非取放场景（充电、巡检、拆码垛）不用再做"自由模式"或新模板
- 和仿真端的数据协议天然一致，导出包格式可以对齐 mentor 的状态命名
- 跨设备（机械臂/堆垛机）未来扩展有统一骨架

但这是**重构**，不是增量。对齐之前我们不开动。

---

## 2. 我们理解的 mentor 设计

### 2.1 核心两个概念

**状态拆分（State decomposition）**
固定执行器不再只有一个 `handling`（取+放合并动画），而是拆成 5 个原子状态：

| 状态 | 含义 | 输入 |
|---|---|---|
| `travelEmpty` | 空载移动到取货工位 | (当前位姿, 取货工位) |
| `load` | 从货位取出货 | (当前位姿, 货位) |
| `travelLoaded` | 载货移动到放货工位 | (当前位姿, 放货工位) |
| `unload` | 把货放入货位 | (当前位姿, 货位) |
| `idle` | 在当前位姿待命 | (当前位姿) |

**姿态继承（Pose inheritance）**
每个状态动画末尾的姿态**自动**成为下一个状态的初始姿态。不再需要显式设计"段间过渡"——链式传递保证连续。

### 2.2 状态图（我们的转述）

```
         ┌── 新任务 ──┐
         │             ↓
   ┌─→ idle ←─无任务─── unload
   │     ↓  新任务         ↑
   │     ↓                 │
   │  travelEmpty          │
   │     ↓                 │
   │   load ─→ travelLoaded
   │
   └ （unload 完后回 idle，等下一个任务）
```

`idle` 是万能待命点，既是起点也是终点。任何状态结束后如果没有后续任务，都进入 `idle` 保持当前姿态。

### 2.3 跨设备抽象

同一状态图适用于五种设备，只有运动 primitive 不同：

| 设备 | load 的 primitive |
|---|---|
| 升降机 | 平移（货物跟随到升降台中间）|
| RGV | 平移（相当于升降机放倒）|
| 转台 | 旋转（货物跟随到转台中间）|
| 堆垛机 | 多部件平移（立柱 XOZ + 平台 YOZ）|
| 机械臂 | 关节正反算（多关节联动）|

这是比我们当前"叉车专用模板"高一个层级的抽象。

### 2.4 关键 test case（我们理解的行为）

- **连续取放**：任务排队 → `unload_1 → travelEmpty → load_2 → ...`，中间无 idle
- **任务稀疏**：`unload` 后新任务没来 → 停在放货工位 `idle`，不强制归零
- **拆码垛**：`travelEmpty → load_1 → travelLoaded → load_2 → travelLoaded → load_3 → ...`（多次 load 换不同货位，不回 idle）

---

## 3. MotionForge 现状

### 3.1 17 段叉车模板

完整结构见 [docs/concepts/forklift-pickup-template.md](../concepts/forklift-pickup-template.md)。概括：

| 段 | 动作 | 对应 mentor 状态 |
|---|---|---|
| 1 | 横移对齐 cargo x | travelEmpty |
| 2 | 前进接近 | travelEmpty |
| 3 | 抬叉到叉取面 | load（准备段）|
| **4** | 前进插齿（**attach**）| load（attach 时刻）|
| 5 | 上顶 lift_clearance | load（承载）|
| 6 | 抬到运输高度 | travelLoaded（准备）|
| 7 | 后退安全距离 | travelLoaded |
| 8 | 叉齿复位 | travelLoaded |
| 9 | 横移到 drop x | travelLoaded |
| 10 | 前进到放货点 | travelLoaded |
| 11 | 抬叉到工作面 | unload（准备）|
| 12 | 前进到放货位 | unload |
| **13** | 下降 lift_clearance（**detach**）| unload（detach 时刻）|
| 14 | 后退安全距离 | unload 或 idle 转场 |
| 15 | 叉齿复位 | idle 准备 |
| 16 | 返回 y=0 | idle（归零）|
| 17 | 返回 x=0 | idle（归零）|

**我们的 17 段 = mentor 状态图的一条固定路径 `idle → travelEmpty → load → travelLoaded → unload → idle`，且尾部强制归零到原点**。

### 3.2 现有限制（mentor 框架可以解决）

- 尾部强制 `归零 x/y`（段 16/17）→ 无法停在"随便某个位置 idle"
- 一次只能 1 次 pickup + 1 次 drop → 拆码垛要多次循环
- 非取放场景（充电、巡检、空跑）只能走"自由模式"（AI 出完整 PKF），精度差
- 叉车专用 → 机械臂/堆垛机要完全重写

### 3.3 现有技术资产（可复用）

- **公式编译器**（`compileTemplate`）：把段数据 + 场景上下文 + 节奏编译成标准 PKF
- **姿态级联**（段级）：每段 `value_start = 上一段同关节 value_end`，已经实现
- **reparent 事件**（attach/detach）：已经支持在任意 t 触发
- **role 识别 + 场景扫描**：`collectTemplateContext` 自动找 cargo marker / drop marker / fork mesh / role 关节
- **PKF 格式**：4 个自动注入参数（cargo_fork_height/safe_distance/lift_clearance/transport_height）+ cargo_pos/drop_pos/fork_anchor_zero

重构成 5 状态后这些资产**全部可以平移**——只是编译器的入口从"17 段写死"改为"5 状态按 script 组合"。

---

## 4. 映射关系（我们的初步设计）

### 4.1 如果采用状态机框架，重构成这样：

```js
// 原子状态定义
TRAVEL_EMPTY_TEMPLATE = [
  { role: '车体横移', formula: 'target_x - current_x' },
  { role: '车体前进', formula: 'target_y - current_y - safe_distance' },
]

LOAD_TEMPLATE = [
  { role: '门架升降', formula: 'cargo_bottom_z + cargo_fork_height - lift_clearance - anchor_z' },
  { role: '车体前进', formula: 'cargo_pos_y - anchor_y', reparent: 'attach' },
  { role: '门架升降', formula: 'cargo_bottom_z + cargo_fork_height - anchor_z' },
]

TRAVEL_LOADED_TEMPLATE = [
  { role: '门架升降', formula: 'transport_height - anchor_z' },
  { role: '车体前进', formula: 'target_y - current_y - safe_distance' },
  { role: '车体横移', formula: 'target_x - current_x' },
]

UNLOAD_TEMPLATE = [
  { role: '门架升降', formula: 'drop_pos_z + cargo_fork_height - anchor_z' },
  { role: '车体前进', formula: 'drop_pos_y - anchor_y' },
  { role: '门架升降', formula: 'drop_pos_z + cargo_fork_height - lift_clearance - anchor_z', reparent: 'detach' },
]

IDLE_TEMPLATE = []  // 空动画，保持当前姿态
```

### 4.2 编排（script）示例

```js
// 简单取放（= 现在的 17 段）
script = [
  { state: 'travelEmpty',  target: 'cargo_A' },
  { state: 'load',         cargo:  'cargo_A' },
  { state: 'travelLoaded', target: 'drop_A' },
  { state: 'unload',       drop:   'drop_A' },
  { state: 'idle' },
]

// 拆码垛
script = [
  { state: 'travelEmpty',  target: 'cargo_stack_1' },
  { state: 'load',         cargo:  'cargo_stack_1' },
  { state: 'travelLoaded', target: 'drop_A' },
  { state: 'unload',       drop:   'drop_A' },
  { state: 'travelEmpty',  target: 'cargo_stack_2' },
  { state: 'load',         cargo:  'cargo_stack_2' },
  ...
]

// 取货完去充电
script = [
  { state: 'travelEmpty',  target: 'cargo_A' },
  { state: 'load',         cargo:  'cargo_A' },
  { state: 'travelLoaded', target: 'drop_A' },
  { state: 'unload',       drop:   'drop_A' },
  { state: 'travelEmpty',  target: 'charger' },  // 空载移动到充电桩
  { state: 'idle' },                             // 停在充电桩
]
```

### 4.3 姿态继承的实现

每个状态结束时，编排器快照当前所有关节 `currentValue`，作为下一个状态的 `current_pose`。因为所有状态的公式都以 `current_*` 为起点（减法计算位移），姿态自然连续。

---

## 5. 待确认问题（请 mentor 过目）

### Q1. attach/detach 的动画语义

mentor 文档说 `load` 状态里"货物跟随，货物运动到升降台中间"。这是：

- **(a)** 货物从原位置**渐变移动**到升降台中间（一段位置插值动画）
- **(b)** 某个瞬间**瞬发 attach**（货物父节点切换，视觉上货物跟随升降台已有运动）
- **(c)** 两者结合（先渐变对齐、再 attach）

MotionForge 现在是 **(b)**：`applyReparentEventsAtTime` 在指定 t 瞬发父子关系切换，依赖"切换前 fork 已经三维对齐货物"。需要对齐这个语义细节。

### Q2. 姿态继承的存储形式

mentor 文档说"扩展存储每一个状态动画末尾帧的姿态"。这个"末尾帧姿态"的数据形式是：

- **(a)** 所有关节的 value 快照（`{ joint_id: number }`）
- **(b)** 世界坐标快照（`{ position, rotation }`）
- **(c)** 某种混合

MotionForge 目前两种都可以序列化（joint values 在 keyframes 里、世界 transform 在 GLB 里）。mentor 倾向哪种？仿真端落地时更希望用哪种？

### Q3. idle 动画是纯静止还是允许"待命动画"

`idle` 是：

- **(a)** 完全静止（关节 value 不变）
- **(b)** 允许待命动画（例如呼吸、轻微摆动、风扇转动）

影响 MotionForge 的 PKF 设计——如果只是 (a)，`IDLE_TEMPLATE = []`；如果是 (b)，需要支持循环小段。

### Q4. MotionForge 的角色边界

mentor 文档里的"新任务/无任务"状态切换、任务排队、调度 —— 这些是仿真执行器的职责。MotionForge 是**编辑器**，我们的理解：

- MotionForge **只负责**每个状态动画的生成（编译 → 关节曲线 + reparent 事件）
- MotionForge **不负责**状态切换触发、任务队列、调度逻辑
- 导出包里应该包含"5 个独立状态动画 + 姿态衔接点"，仿真端按任务流自己拼接

对吗？还是 MotionForge 也要导出一条"完整剧本"（script）？

### Q5. 多次 load 连续（拆码垛）时 load 动画是否复用

拆码垛里 `load_1, load_2, load_3` 是：

- **(a)** 同一个 `load` 动画模板，每次只换目标货位参数（`cargo_pos`）
- **(b)** 每次货位 z 高度不同（堆起来越来越高）可能需要不同的"抬叉层级"

如果 (a)，我们的 5 原子模板够用；如果 (b)，`load` 可能需要按层级分亚型。

### Q6. 跨设备抽象是否现在就要做

mentor 文档覆盖 5 种设备。MotionForge 短期是**叉车专用**。我们的规划：

- **Phase 1**：只重构叉车（5 状态版），验证状态机框架
- **Phase 2**：加升降机/RGV（平移类，和叉车几何类似）
- **Phase 3**：堆垛机（多部件）、机械臂（IK）

mentor 是否希望 Phase 1 的重构就直接按跨设备抽象去设计（`currentPose/targetPose` 纯抽象、公式驱动不硬编叉车 role）？还是先叉车专用、后续再抽象？前者设计成本更高但上限更高。

### Q7. MF 现有的 4 个 PKF 参数如何保留

MotionForge 当前 PKF 包含 `cargo_fork_height / safe_distance / lift_clearance / transport_height`，都是叉车特化参数。重构到 5 状态后：

- **(a)** 这些参数下沉到 `load`/`unload` 模板内部（对仿真端不可见）
- **(b)** 继续在 PKF parameters 暴露（可调整）
- **(c)** 用户在 UI 设，编译后常量化

仿真端希望保留可调节能力吗？

---

## 6. 对齐后的采纳建议

根据 mentor 回答，有三条路径：

### 路径 A：完全重构到 5 状态（推荐，如果对齐通过）

- 工作量：1–2 周
- 产出：编排器 + 5 原子状态 + UI 可组合 script + 单元测试覆盖
- 好处：后续加充电/巡检/拆码垛 = 换 script，不用改代码
- 风险：短期没有新功能输出

### 路径 B：17 段保留，尾部可替换

- 工作量：1–2 天
- 产出：`compileTemplate` 支持 `postTemplate` 参数，段 14–17 可替换成 `dock` / `next_pickup`
- 好处：快速覆盖 mentor 的 test case 1–3
- 风险：把 mentor 的抽象框架"降级"到我们的 17 段世界，不对齐

### 路径 C：先做路径 B，预留接口后续演进到 A

- 工作量：3–5 天
- 产出：B 的实现 + 接口设计按 A 的抽象层考虑
- 好处：兼顾短期 + 长期
- 风险：接口设计不好容易两头漏

**我们的倾向**：对齐通过后直接走 **A**。如果时间紧，走 **C**。

---

## 7. 附录

### 7.1 MotionForge 相关文档

- 17 段模板契约：[docs/concepts/forklift-pickup-template.md](../concepts/forklift-pickup-template.md)
- PKF 格式：[docs/concepts/pkf-parametric-keyframe-formula.md](../concepts/pkf-parametric-keyframe-formula.md)
- ZIP 输出 schema：[docs/concepts/zip-output-schema.md](../concepts/zip-output-schema.md)
- Bug 修复历史：[docs/bugfix-log.md](../bugfix-log.md)（#32–#52 是 mvp3 相关）

### 7.2 当前 FORKLIFT_TEMPLATE 源码

[src/core/ForkliftTemplate.js](../../src/core/ForkliftTemplate.js) —— 17 段完整定义 + 编译器。

### 7.3 调试工具

`__diagTpl.drawTrajectory()` —— 3D 视口 + console 表格，复制粘贴到浏览器 Console 即可看到每段 fork/cargo 的坐标轨迹。可以用这个工具验证 5 状态版的输出和 17 段版在"简单取放"场景下一致。

---

## 修订记录

- 2026-04-23：首版草稿，待 mentor 过目确认 Q1–Q7 后敲定采纳路径
