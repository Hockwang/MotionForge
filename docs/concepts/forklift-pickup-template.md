---
tags: [concepts, pkf, template, forklift]
updated: 2026-04-22
status: approved  # 契约审过（§11），待实现（§10 阶段 A → B）
---
# 叉车取放模板（Forklift Pickup Template）

> **设计目的**：消除 AI 生成 PKF 时的数值误差和视觉瞬移。前端持有"行业标准取放 14 段"模板，AI 只负责节奏和风格，数值由前端按几何推导并注入。
>
> **关键约束（来自中台）**：**输出 ZIP 格式一律不变**。模板是前端编译中间层，编译结果仍是标准 PKF（parameters + steps + reparent_events），中台内部编辑器照常读取。中台感知不到"模板"的存在。
>
> **状态**：契约提案，尚未实现。实现前需用户审过本文档。

---

## 1. 背景：为什么需要模板

### 1.1 痛点

当前 🚀 一键生成的流程是：AI 直接输出 PKF 的 `parameters + steps + reparent_events`。AI 需要同时决定：
- **语义节奏**（几段运动、时长分配、缓动）
- **几何精度**（每段 value_end 的公式，要让 fork 底面在 attach 瞬间精确对齐 cargo 底面）

这两个任务性质不同：节奏是主观判断，几何是客观数学。**LLM 擅长前者、不擅长后者**——反复出现凭空加常数（`- 0.1`）、approach_gap 错设为非零、公式少项漏项等问题（见 bug #47–#52）。

### 1.2 解决思路

**职责拆分**：把"几何精度"从 AI 手里拿走，前端用行业标准 14 段模板 + 几何公式保证精度；AI 只管"节奏和风格"。

真实叉车的作业流程本来就是**离散、定型、仪式化**的（见 [forklift-pickup-model.md](forklift-pickup-model.md)），适合模板化。

---

## 2. 数据流

```
🚀 一键生成触发
  ↓
[前端 · 场景扫描]
  读 cargo marker（cargo_pos_*、cargo size）
  读 drop marker（drop_pos_*，其中 drop_pos_z = 放货面高度）
  读 attach reparent event（fork 对象名）+ 算 fork_anchor_zero_*
  ↓
[前端 · 参数注入]
  组装 7 个参数（见 §3）
  ↓
[AI 调用]
  发送：模板段列表 + 参数 + 总时长预算
  返回：每段时长分配 + easing 选择 + clip 命名
  ↓
[前端 · 模板编译]
  按模板段 + 参数公式 + AI 节奏 → 标准 PKF
  ↓
标准 PKF（parameters + steps + reparent_events）
  ↓
导出 ZIP（schema v6，格式与今天完全一致）
  ↓
中台内部编辑器读入
```

**中台不变量**：pkf.json 的 schema、参数引用语法、公式求值规则、reparent_events 格式**全部不变**。中台只会看到参数列表里多了几个标准名字（`safe_distance` 等），公式形态不变。

---

## 3. 参数契约（7 个）

### 3.1 清单（新增 4 个模板专属参数 + 复用现有 PKF 约定）

为了不和现有 PKF 约定撕裂，**cargo / drop 位置沿用现有命名**：`cargo_pos_*` / `drop_pos_*`（不引入 `pickup_point_*` / `place_point_*`）。中台看到的还是一套命名。

**新增的 4 个参数**（模板专属）：

| 参数 id | 类型 | default | 来源 | UI 可调 |
|---|---|---|---|---|
| `cargo_fork_height` | number | `0` | cargo marker 属性 / UI 覆盖 | ✓ |
| `safe_distance` | number | `0.8` | 默认 / UI 覆盖 | ✓ |
| `lift_clearance` | number | `0.1` | 默认 / UI 覆盖 | ✓ |
| `transport_height` | number | `0.2` | 默认 / UI 覆盖 | ✓ |

**复用的现有参数**（模板公式直接引用）：

| 参数 id | 来源 | 备注 |
|---|---|---|
| `cargo_pos_x/y/z` | cargo marker 位置，场景扫描 | 和现有 AI 管道同名 |
| `drop_pos_x/y/z` | drop marker 位置，场景扫描 | 同上 |
| `cargo_width/height/depth` | cargo marker size（schema v6）| `getCargoSizeParams` 自动注入 |
| `fork_anchor_zero_x/y/z` | `computeForkAnchorZero` 缓存 | 在关节零位算的叉齿承载面世界坐标 |

**语义**：
- `cargo_pos` / `drop_pos`：UI Z-up 世界坐标
- `cargo_fork_height`：**cargo 自身属性**——叉齿承载面相对于 cargo 底面的偏移，m
  - 简单箱子（直接从底部托起，叉齿贴 cargo 底面）：`0`
  - 带托盘的货物（叉齿插入托盘底部，cargo 主体在托盘顶）：`-(托盘厚度)`，负值
  - 语义：**叉齿承载面 = cargo 底面 + cargo_fork_height**（取货时 attach 瞬间两者关系）
- `safe_distance`：沿车体前进轴（UI y）的距离，m
- `lift_clearance`：取货/放货时叉齿微抬/微降的距离（托离地面、落到工作面），m
- `transport_height`：**叉齿承载面离地高度**（更精确的机械量，不用 cargo 底面——不同货物底部结构不同），m

### 3.2 派生量（文档内部简写，不出现在 pkf.json）

文档公式里会用两个"派生量"提升可读性，它们**不是**独立 PKF parameter：

- `cargo_bottom` = `cargo_pos_z - cargo_height / 2`（cargo 底面绝对高度）
- `place_surface` = `drop_pos_z`（放货面高度 = drop marker 的 z 坐标）

模板编译时**直接展开为基础参数**（例如段 2 的 value_end 编译后是 `cargo_pos_z - cargo_height / 2 + cargo_fork_height - lift_clearance - fork_anchor_zero_z`，没有 `cargo_bottom` 字样）。中台只需支持基础 PKF 参数引用，不需要任何派生量语法。

### 3.3 坐标约定

全部参数用 **UI Z-up 空间**（x 左右、y 前后、z 高度）。这和当前 `cargo_pos_x/y/z`、`fork_anchor_zero_x/y/z` 一致，中台接收方无需做坐标转换。

---

## 4. 14 段模板

**约定**：
- 下表"目标位移"= 该段末尾 joint 的 `currentValue`（相对零位的位移，prismatic 的现有 PKF 语义）
- `cargo_bottom` 是派生量（= `cargo_pos_z - cargo_height/2`），实际公式里展开为基础参数
- `fork_anchor_zero_y` 作为车体前进轴的"零位世界 y"，displacement = target - fork_anchor_zero_y
  （`cargo_pos_y - fork_anchor_zero_y` 的物理含义 = 车体需要前进多少使叉齿到 cargo_y）

### 4.1 取货阶段（段 1–7）

| # | 名称 | 角色关节（role）| 目标位移（公式） | reparent |
|---|---|---|---|---|
| 1 | 接近 | 车体前进 | `cargo_pos_y - fork_anchor_zero_y - safe_distance` | — |
| 2 | 抬叉到 cargo 叉取面（低 clearance） | 门架升降 | `cargo_pos_z - cargo_height / 2 + cargo_fork_height - lift_clearance - fork_anchor_zero_z` | — |
| 3 | 前进插齿 | 车体前进 | `cargo_pos_y - fork_anchor_zero_y` | **attach 在此段末尾** |
| 4 | 取货（上顶 lift_clearance）| 门架升降 | `cargo_pos_z - cargo_height / 2 + cargo_fork_height - fork_anchor_zero_z` | — |
| 5 | 抬到运输避让高度 | 门架升降 | `transport_height - fork_anchor_zero_z` | — |
| 6 | 后退到安全距离 | 车体前进 | `cargo_pos_y - fork_anchor_zero_y - safe_distance` | — |
| 7 | 叉齿复位（运输姿态） | 门架升降 | `0` | — |

### 4.2 运输阶段（段 8）

| # | 名称 | 角色关节 | 目标位移 |
|---|---|---|---|
| 8 | 移动到放货点 | 车体前进 | `drop_pos_y - fork_anchor_zero_y - safe_distance` |

### 4.3 放货阶段（段 9–14，取货的逆过程）

| # | 名称 | 角色关节 | 目标位移 | reparent |
|---|---|---|---|---|
| 9 | 抬叉到工作面 + cargo_fork_height | 门架升降 | `drop_pos_z + cargo_fork_height - fork_anchor_zero_z` | — |
| 10 | 前进到放货点 | 车体前进 | `drop_pos_y - fork_anchor_zero_y` | — |
| 11 | 放货（下降 lift_clearance） | 门架升降 | `drop_pos_z + cargo_fork_height - lift_clearance - fork_anchor_zero_z` | **detach 在此段末尾** |
| 12 | 后退到安全距离 | 车体前进 | `drop_pos_y - fork_anchor_zero_y - safe_distance` | — |
| 13 | 叉齿复位 | 门架升降 | `0` | — |
| 14 | 返回起点 | 车体前进 | `0` | — |

### 4.4 段取舍原则

**所有 14 段默认全部保留，由用户在生成后的 PKF 编辑器里手动删除不需要的段。**

设计理由：用户对现场情况的理解比 AI 更准确（例如是否需要"避让抬升"、是否需要"返回起点"）。AI 不做 skip 决策，避免自作主张删除用户本来想要的段。模板编译器也不做"智能跳过"——公式算出 0 位移的段照常生成（value_start = value_end），留给用户决定是否清理。

这和 §7.1 的"AI 任务边界"保持一致：AI 只管节奏和缓动，**结构性决策全部由用户显式控制**。

---

## 5. attach / detach 零瞬移的几何论证

模板的**正确性保证**不是"attach 时 fork 和 cargo 位置重合"，而是 **attach 只改 parent 不改 world transform**（Three.js 原生 `parent.attach(child)` 的默认行为）。整个取放过程中 cargo 的世界坐标曲线**连续**，没有瞬移。

### 5.1 attach 瞬间（段 3 末尾）

状态：
- 段 2 完成 → fork 承载面世界 z = `cargo_bottom + cargo_fork_height - lift_clearance`
- 段 3 完成 → fork 承载面世界 (x, y) = `(cargo_pos_x, cargo_pos_y)`
- cargo 未被动：cargo 底面 = `(cargo_pos_x, cargo_pos_y, cargo_bottom)`

（下文 `cargo_bottom` = `cargo_pos_z - cargo_height / 2` 简写）

此时 fork 承载面和 cargo 底面**故意不重合**（z 差 `lift_clearance - cargo_fork_height`），对应物理现实：叉齿插入孔内但还没托起货物。

**attach 操作**：`tineMesh.attach(cargo)` 只改父子关系，保持 cargo 的世界 transform 不变。cargo 到 fork 的局部偏移量 = `lift_clearance - cargo_fork_height`（z 方向，其他轴 0）。

**零瞬移保证** = attach 后立即求值下一帧 → cargo 位置和 attach 前完全一致 ✓

### 5.2 取货段 4（上顶 lift_clearance）

段 4 完成 → 门架升降 value = `cargo_bottom + cargo_fork_height - fork_anchor_zero_z`
→ fork 承载面世界 z = `cargo_bottom + cargo_fork_height`
→ cargo 底面 = fork 承载面 + 局部偏移 = `cargo_bottom + cargo_fork_height + lift_clearance - cargo_fork_height` = `cargo_bottom + lift_clearance`

cargo 被抬起 `lift_clearance` ✓（符合"取货：托起一小段"语义）

### 5.3 detach 瞬间（段 11 末尾）

状态：
- 段 9 完成 → fork 承载面 z = `drop_pos_z + cargo_fork_height`
- 段 10 完成 → fork 承载面 (x, y) = `(drop_pos_x, drop_pos_y)`
- 段 11 完成 → fork 承载面 z = `drop_pos_z + cargo_fork_height - lift_clearance`
  - cargo 底面 = fork + 局部偏移 = `drop_pos_z + cargo_fork_height - lift_clearance + lift_clearance - cargo_fork_height` = `drop_pos_z`

**cargo 底面 ≡ 工作面** ✓

**detach 操作**：`worldRoot.attach(cargo)` 保持世界 transform，cargo 底面仍在 `drop_pos_z`。detach 后 cargo 脱离 fork 的后续运动（段 12–14 fork 后退 / 复位时，cargo 不再跟随）。

### 5.4 关键实现要求

为保证零瞬移，**模板路径下 snap-attach 的强制位置对齐必须禁用**：

- 模板主路径：reparent 事件只改 parent（`targetParent.attach(child)` 原生行为），**不覆盖 child 的 local transform**
- 非模板路径（手工关键帧、老 AI 管道）：snap-attach 保留强制对齐逻辑做兜底

实现时在 `KeyframeManager.applyReparentEventsAtTime` 里根据 PKF 是否带 `template_version` 字段分流（见 §6 编译规则）。

---

## 6. 编译规则

### 6.1 PKF step 映射

每个模板段编译成一个 PKF step。段 2 的例子：

```json
{
  "id": "seg_02_抬叉",
  "joint": "<门架升降关节 name>",
  "joint_def_id": "<运行时 UUID>",
  "channel": "position",
  "axis": "<关节主轴，通常 z>",
  "t_start": <前一段 t_end>,
  "t_end": <t_start + 本段时长>,
  "value_start": "0",
  "value_end": "cargo_pos_z - cargo_height / 2 - fork_anchor_zero_z",
  "easing": "<AI 返回的 easing>"
}
```

### 6.2 时序规则

- 串行：`seg[N].t_start = seg[N-1].t_end`
- 总时长 = AI 返回的各段时长之和（或用户指定总时长时按比例缩放）
- `value_start` 的级联：每个 joint 独立追踪"上一段该 joint 的 value_end"作为下一段的 `value_start`（避免公式计算上一段末态）

### 6.3 派生量处理

`cargo_bottom` / `place_surface` 只是文档内部的可读性简写，**不作为独立 parameter 声明**，编译期直接展开为完整公式：

```
文档写：段 2 value_end = "cargo_bottom + cargo_fork_height - lift_clearance - fork_anchor_zero_z"
编译后：value_end = "cargo_pos_z - cargo_height / 2 + cargo_fork_height - lift_clearance - fork_anchor_zero_z"
```

这样中台看到的 PKF 公式引用的都是显式 parameter（cargo_pos_z、cargo_height、cargo_fork_height、lift_clearance、fork_anchor_zero_z），不需要支持派生量语法。

### 6.4 reparent_events 生成

```json
{
  "reparent_events": [
    { "t": <段 3 t_end>, "child_name": "<cargo name>", "new_parent_name": "<fork tine name>" },
    { "t": <段 11 t_end>, "child_name": "<cargo name>", "new_parent_name": null }
  ]
}
```

时间严格等于对应段的 t_end（保证段完成瞬间触发 reparent，位置已对齐）。

### 6.5 关节选择（role 映射）

"车体前进" / "门架升降"是**角色语义**，不是 joint name。模板编译器需要从 `keyframeManager.jointDefinitions` 按 `role` 字段找到对应 joint。role 值用**中文字符串**（和现有 L1/L2 prompt 一致，见 `conversion-service.js:236`）：

- `role === '车体前进'` → 段 1/3/6/8/10/12/14 的驱动关节
- `role === '门架升降'` → 段 2/4/5/7/9/11/13 的驱动关节

如果场景里没有对应 role 的关节，模板编译**失败**并报错给用户（而不是降级生成错误 PKF）。

---

## 7. AI 的任务边界

### 7.1 AI 负责（保留）

- **各段时长分配**（比如"接近" 2s、"抬叉" 1.5s、"前进插齿" 1s...）
- **每段 easing 选择**（linear / ease-in / ease-out / ease-in-out）
- **clip 命名**（"叉车标准取放动作"、"快速作业"、"小心操作"）

### 7.2 AI 不负责（前端接管）

- ❌ 任何 step 的 value_start / value_end 公式
- ❌ parameter 的 default 值（前端场景扫描注入）
- ❌ reparent_events 的时间点（模板结构决定）
- ❌ reparent_events 的 child_name / new_parent_name（前端从 marker 和 role 映射推导）
- ❌ **段取舍判断**：14 段一律生成，用户决定是否手动删除（见 §4.4）

### 7.3 Prompt 简化

新 AI prompt 从"复杂公式生成器"缩减为"节奏编排师"：

```
你是叉车动作节奏编排。前端已经按行业标准 14 段模板生成了完整的运动结构。
你只需要：
1. 决定每段的时长（总预算 X 秒内分配）
2. 每段选一个 easing
3. 给整个 clip 起个名字
返回 JSON：{ name, segments: [{ index, duration, easing }] }
```

LLM 的**几何出错可能性消失**（它不碰公式），**结构删改权归用户**（它不决定 skip）。

---

## 8. 边界条件

### 8.1 场景完整性检查

模板编译前校验：
- 存在 cargo marker（提供 cargo_pos_*、cargo size）
- 存在 drop marker（提供 drop_pos_*）
- 存在 role="车体前进" 的关节
- 存在 role="门架升降" 的关节
- **fork 对象可识别**——优先级：
  1. 已有 attach 型 reparent event → 用其 `new_parent_name`（用户显式配）
  2. 退化：从 `门架升降` 关节的 `childId` 找对应场景对象 → 用对象 name 自动识别
- 可选 role="叉齿侧移" / "叉齿前伸"（当前模板未用，二期预留）

任一缺失 → 编译失败，UI 提示用户修正场景（返回 `{ ok:false, missing:[...] }`）。

**降级链路**：只要用户正确配了 `门架升降` role 关节（大多数叉车模型必有），就不需要手动加 reparent event——模板可独立工作。刷新浏览器后场景状态丢失时，这条自动识别让🚀 一键生成仍然走模板路径。

### 8.2 关节 limit 冲突

编译时计算每段目标位移，若超出关节 `min/max` limit：
- **抬叉超 limit**（cargo 太高）→ 报错，提示调低 cargo 或增大门架行程
- **前进超 limit**（cargo 太远）→ 报错，提示用户先把叉车挪近
- 不静默钳位（避免"看起来动了实际没到位"的隐式 bug）

### 8.3 只取货 / 只放货场景

未来可扩展 `mode: 'pickup_only' | 'dropoff_only' | 'full'`。当前 MVP 只支持 full（14 段完整流程）。

### 8.4 cargo 和 dropoff 不在同一高度

模板天然支持——段 2（抬叉到 cargo 底面）和段 9（抬叉到工作面+clearance）是独立计算的，高度不一致也能走通。

### 8.5 多个 cargo / dropoff

当前模板只处理一对 (cargo, dropoff)。多对需要用户多次触发或二期扩展（可能需要新模板"多次取放循环"）。

---

## 9. 与现有系统的关系

### 9.1 路由逻辑（模板 vs 老 AI 管道）

**核心原则**：模板**只覆盖"叉车取放"这一类场景**（含 cargo + dropoff + 叉车 role）。其他场景走老 L1/L2 AI 管道，逻辑和今天完全一致。无 UI 开关——全自动按场景判断。

#### 路由流程

```
🚀 一键生成触发
  │
  ├─ 场景扫描（全部满足才走模板）：
  │    ✓ 有 cargo marker
  │    ✓ 有 dropoff marker
  │    ✓ 有 role="车体前进" 关节
  │    ✓ 有 role="门架升降" 关节
  │
  ├─ 四项全满足 → 模板路径
  │    └─ 按 §4 编译 14 段 → 标准 PKF
  │
  └─ 任一缺失 → 老 L1/L2 AI 管道
                （自由生成，行为不变）
```

#### 为什么不在 UI 上分"取货 / 空载"模式

空载不是独立的场景模式，而是取货动画的**内在阶段**：

```
取货动画时间线：
t=0 ──────── t=3 ──── t=4 ──────── t=8 ──── t=9 ──────── end
  空载接近   插齿    满载运输      放货      空载返回
  段 1       段 3    段 4–8        段 11     段 12–14
  ↑                       ↑                       ↑
   都是同一个动画的组成部分，不能拆成"空载模式"+"取货模式"让用户手动串联
```

UI 二分会导致用户做一次完整演示得点 5 次按钮拼接段，反而比一键生成更繁琐。模板内部天然包含"空载 → 满载 → 空载"的状态转换，用户一次 🚀 就能生成完整编排。

#### 想要"空载自由运动"时怎么办

**设计原则**："AI 生成后就是 PKF，用户爱怎么改怎么改"——保持简单，不加模式开关。

| 用户意图 | 操作 |
|---|---|
| 纯空载动作（测试门架、机动性演示） | 场景里不加 cargo/dropoff marker → 自动走老 AI 管道 |
| 场景已布置 cargo+dropoff，但想改局部动作 | 🚀 生成完整 14 段，**在 PKF 编辑器里手动删/改 step** |
| 想对模板生成的结果做微调 | PKF 是标准数据，用户可改 value_end、调时间、增删 step |

这样既保证默认场景的精度（模板路径），也不强迫用户面对额外 UI 概念。PKF 编辑器就是逃生通道。

### 9.2 老 ZIP 向后兼容

- 老 AI 生成的 ZIP 不受影响（它们的 PKF 已经在 ZIP 里固化，不会重新生成）
- 导入老 ZIP 时正常解析 PKF，模板不介入
- 只有"🚀 重新生成"才会走新模板

### 9.3 schema v6 兼容

模板不引入新 ZIP 字段，schema 版本不需要升（仍是 v6）。

### 9.4 snap-attach / fork_anchor_zero（保留）

`computeForkAnchorZero` 计算承载锚点的逻辑不变（见 [forklift-pickup-model.md](forklift-pickup-model.md) §2）。snap-attach 作为兜底保留，防止非模板路径的瞬移。

---

## 10. 实现路径建议

两步走（每步独立 commit，可回滚）：

### 阶段 A：模板编译器（不接 AI）

1. 新文件 `src/core/ForkliftTemplate.js`
   - `FORKLIFT_TEMPLATE` 数据常量（14 段结构）
   - `compileTemplate(sceneContext, aiRhythm?) → PKF` 编译函数
2. 集成到 🚀 一键生成路径（`src/main.js`）：场景满足条件时用模板，否则走老管道
3. AI 节奏用固定默认值（总时长 10s，段时长均分，easing ease-in-out）
4. 单元测试覆盖：几何对齐（attach/detach 位置）、段跳过逻辑、limit 冲突报错

**可交付**：🚀 能生成正确的取放动画，不调用 AI（无网络依赖，全确定性）。

### 阶段 B：接 AI 节奏

1. 修改 `tools/conversion-service.js` 的 PKF_SYSTEM_PROMPT 改为节奏编排模式（见 §7.3）
2. 前端把模板段列表发给 AI，接收节奏返回
3. 阶段 A 的编译器接入 AI 节奏（替代固定默认）
4. `ensurePkfCoversAttachPoint` 的功能被模板吸收，可移除（见 bug log #50b）

**可交付**：🚀 回归 AI 节奏 + 模板精度的组合。

---

## 11. 决策记录（2026-04-22 审过）

所有开放问题均已决定，本节留作决策追溯：

| # | 议题 | 决策 | 理由 |
|---|---|---|---|
| 1 | `transport_height` 语义 | **叉齿承载面离地高度** | 机械层精确量；cargo 底部结构（托盘、箱子、带垫板）因货物而异，用"叉齿离地"更通用 |
| 2 | `safe_distance` 默认 `0.8m` | ✅ 保留，用户可覆盖 | 真实叉车工作距离 0.5–1.5m 的中位 |
| 3 | `lift_clearance` 默认 `0.1m` | ✅ 保留，用户可覆盖 | 足够让叉齿脱离地面/工作面，不至于浪费时间 |
| 4 | 14 段取舍 | **全部默认生成，用户手动删** | 用户比 AI 更懂现场；AI 不决定结构，只管节奏（详见 §4.4、§7.2） |
| 5 | role 命名 | **中文**（"车体前进" / "门架升降"） | 扫代码确认：`KeyframeManager.js:532`、`conversion-service.js:236` 都是中文；UI 也是中文 |
| 6 | 多 cargo 场景 | **MVP 只支持单对**（一 cargo + 一 dropoff） | 边界明确，实现简单；多对留给二期 |
| 7 | UI 模式开关 | **不加**，全自动路由 | "AI 生成后就是 PKF，用户爱怎么改怎么改"——保持 UI 简单；想自由运动就不放 cargo marker，或手动改 PKF |
| 8 | `cargo_fork_height` 是否加入 | **✅ 加入，cargo 自身属性** | 不同货物叉齿孔位置不同（托盘、箱子、带垫板货物）；默认 0（直接从底部托起）|

决策后结构：**8 个参数（原 7 + cargo_fork_height），14 段模板，中文 role，无 UI 开关**。契约已冻结，可进入 §10 阶段 A 实现。

---

## 12. 相关文档

- [forklift-pickup-model.md](forklift-pickup-model.md) — 承载锚点（fork_anchor_zero）六轮迭代最终模型
- [pkf-parametric-keyframe-formula.md](pkf-parametric-keyframe-formula.md) — PKF 格式规范
- [scene-marker-system.md](scene-marker-system.md) — cargo / dropoff marker schema
- [zip-output-schema.md](zip-output-schema.md) — ZIP 输出格式（本模板不影响此 schema）
- [../architecture/ai-pipeline.md](../architecture/ai-pipeline.md) — 当前 L1/L2 AI 管道
- [../bugfix-log.md](../bugfix-log.md) #47–#52 — 六轮迭代的教训（本模板的设计动机）
