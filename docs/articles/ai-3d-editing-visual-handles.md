# AI 编辑 3D 软件的可能性 —— 从一条轨迹辅助线说起

> 作者：Hockwang  项目：MotionForge
> 时间：2026-04-24（写作当天刚做完轨迹 overlay 的几轮迭代）
> 阅读时间：约 15 分钟
> 适合谁：对 Web 3D 编辑器、LLM 协作、AI agent 基础设施感兴趣的工程师

## TL;DR

3D 编辑走向 AI 化的瓶颈不是"模型不够强"，是**人和 AI 之间没有共享的视觉语言**。文字描述（"叉齿飘在空中 0.5 米"）的信息带宽太低，截图（"你看这里不对"）又缺乏语义锚点。MotionForge 今天实现的**轨迹 overlay**是一个小切口 —— 一条能被 AI 读懂、也能被人眼验证的辅助线，把"动画出没出 bug"从**文字问答**变成**图像对照**。这篇文章把这个具体的基建抽象成一类工程问题：为 AI 编辑 3D 场景构建**可视化握把**（visual handle），并讨论下一步能做什么。

## 起点：一个具体的 bug

这周在调一个三向车（VNA forklift）的 PKF 动画。用户说"放货位偏了"，作为协作者，你能得到的信息只有：

1. 一段自然语言描述（文字）
2. 一张可能偏视角、带透视压缩的截图（图像）
3. PKF 的 JSON（结构化数据，但人看起来像天书）

我（Claude）拿到截图，完全看不出"偏"在哪里。是 x 偏了，y 偏了，还是 z 偏了？偏多少？叉齿实际在哪，货物实际落在哪？**一张截图没有坐标轴、没有刻度、没有参考点**。用户脑海里的 3D 心理模型和我脑海里的 JSON 抽象对不上，来回问"再给张另一个角度的图"是纯粹的沟通浪费。

我们的解法：在 3D 视口里画一条**功能性轨迹线**——采样整个动画 duration 内 fork 和 cargo 的真实世界坐标，串成蓝橙双色折线，叉车运动到哪轨迹线就画到哪。attach 用红球标记、detach 用绿球标记。同时在 Console 打一张 `console.table`，每段 PKF step 的 fork/cargo 世界坐标列表。

```
seg |  name              | fork(x, y, z)        | cargo(x, y, z)       | dy
----+--------------------+----------------------+----------------------+------
 1  | 车体前进到 cargo.y | (0.48, 0.04, 1.00)   | (1.50, 0.50, 1.00)   | 0.46
 2  | 门架升到取货高度    | (0.54, 0.40, 1.00)   | (1.50, 0.50, 1.00)   | 0.10
 ...
12  | 门架调整到放货工作面| (-0.47, 1.00, 5.53)  | (-0.47, 1.10, 5.53)  | 0.10
```

有了这两个东西，协作立刻变成：用户截一张图 + 复制 console.table。我一眼能看到"seg 12 的 cargo 在 z=5.53m 落点"，对照 PKF 里的 `drop_pos_z` 公式一算，偏差 0.3m 来自 `cargo_fork_height` 参数估错。5 分钟解决。没有这条辅助线，同样的诊断要来回 4-5 轮。

## 这一类工具在做什么

抽象一点说，轨迹 overlay 解决的不是"画漂亮的线"，是给 AI 和人之间装**同一套语义读表**。

| 通信方向 | 辅助线能做的事 |
|---------|---------------|
| 人 → AI | 人通过调整参数、观察轨迹是否符合预期，**不用翻译成文字**就能判断对错 |
| AI → 人 | AI 给出 PKF 修改建议，用户一键应用，**立刻用眼睛验证**，不用跑完整 playback |
| 双向校准 | 人说"偏了"时能具体指哪段偏；AI 说"我改了 A 段"时人能看到改没改到点上 |

这是一种非常**低成本**但**高带宽**的界面。代码实现一共约 150 行 JavaScript（[src/core/TrajectoryOverlay.js](../../src/core/TrajectoryOverlay.js)），但它让整个 AI 协作循环的通信效率上了一个档次。

## 可视化握把的四种类别

把这条经验泛化一下。为 AI 编辑 3D 场景服务的可视化，大致分四类：

### 1. 轨迹类（Motion Trace）

**目的**：让时序动作的**空间路径**可见。

- **例**：fork/cargo 采样轨迹 / 关节 origin 的运动路径 / 相机路径
- **关键**：采样点要落在**功能性锚点**上（tine 承载面 / cargo 底面），不是 Object3D 的 pivot。我们这周就修了一版因为采 pivot 而轨迹飘在小车上方 2m 的 bug —— 数据真实但视觉无用（[bugfix #66](../bugfix-log.md)）
- **技术难点**：跨动画帧保持 local offset，`localToWorld` 处理旋转；采样频率和段表颗粒度的权衡

### 2. 约束类（Constraint Visualization）

**目的**：把**没说出口的约束**显式化，让 AI 可以引用。

- **例**：关节的 `limits.min/max` 可视化为旋转圆弧的扇形 / prismatic 可行区间的双箭头线段 / collision bbox
- **现在**：MotionForge 大多数约束只存在 JSON 里，UI 几乎不显示 —— AI 要靠看 JSON 推约束，出错率很高
- **下一步**：在 gizmo 旁边画约束指示器，用户肉眼能看到"这个关节只能转到这里"，AI 的 system prompt 里也引用同一个数据源

### 3. 语义类（Role / Tag）

**目的**：让"这个关节是做什么的"这类**业务语义**成为可视资产。

- **例**：role=门架升降 的关节染成蓝色 / role=叉齿旋转 的关节染成橙色 / 未配 role 的关节涂红警告
- **价值**：新用户加载模型后一眼就能看到"哪些关节已经有语义 / 哪些还没配"，不用翻面板。AI 也可以从同样的颜色编码里读意图
- **现在**：MotionForge 的 role 系统已经存在（[#57 AI role 匹配](../bugfix-log.md)），但可视化还没接上 —— 是个小投入高回报的改造

### 4. 诊断类（Error Highlight）

**目的**：把"哪里出错"以**场景内标记**的形式表达，而不是 toast 通知。

- **例**：PKF step t_end 处 cargo 和 fork 的 world-y 差 > 阈值 → 那个位置画红色感叹号 / 关节链成环 → 环路上所有关节画红色警告色 / 关节 value 超过 limits → gizmo 变红
- **价值**：错误不再是"某个遥远对话框里的英文报错"，而是**你眼睛直接能看到的场景标记**。对协作的人和 AI 都友好
- **技术难点**：诊断结果的持久化 + 触发时机；哪些问题算"错误"哪些只是"警告"

## AI 协作的完整闭环

有了可视化握把，AI 参与 3D 编辑的闭环能跑起来。以下是 MotionForge 当前的闭环和未来能走的路径：

### 当前（2026-04）

```
用户（自然语言意图）
  ↓
L1 (LLM)：意图 → 分段时间表（20 段左右）
  ↓
L2 (LLM)：时间表 → PKF 参数 + 公式
  ↓
前端 sanitize（ensurePkfCoversAttachPoint）
  ↓
应用到 keyframeManager
  ↓
轨迹 overlay 渲染
  ↓
用户看轨迹 → 反馈问题 → 人工调 PKF 或重跑 AI
```

整个闭环里，**AI 只在前半段出现**。后半段（渲染后的验证、反馈、迭代）全靠人。轨迹 overlay 让人的那半段速度变快，但 AI 依然看不见渲染结果。

### 中期（可做的下一步）

让 AI 也能"看见"：

```
... (同上) ...
  ↓
轨迹 overlay 渲染 + 采样 rows 数据
  ↓
rows → 结构化文本 → 喂给 LLM 做自检
  ↓
"seg 5 期望 cargo.y=0.5，实际 0.6，偏差 0.1m"
  ↓
自动重跑 L2 with feedback
  ↓
迭代直到偏差收敛
```

这条路的核心技术是 **把渲染结果转成 LLM 能读的结构化数据**。轨迹 overlay 的 `console.table` 已经做到一半了 —— 数据表是结构化的。只要把它序列化喂给 LLM，加上"对比期望 / 实际"的校验规则，AI 就能自检。

这比"让 LLM 看截图"便宜得多：
- 截图 → 需要视觉多模态模型（贵）
- 结构化表 → GPT-4 class 文本模型就行（便宜）

**前提**：可视化工具必须既**可看**又**可导出**。UI 渲染和数据采样是同一套逻辑两种输出，这是个刚性要求。我们今天的 `sampleOnly` 就是为这件事预留的接口（虽然目前还没接 AI 自检）。

### 长期（再远一步）

让 AI 主动提交改动：

```
用户 → AI（需要意图）
AI → 前端（需要 API 调原子编辑操作，不是生成 JSON 替换）
  ↓
例如：  addPkfStep({joint: "_____10", t_start: 3, t_end: 5, ...})
        modifyParameter("lift_height", 1.8)
        removeReparentEvent("rev_xyz")
  ↓
每一步操作都可以 undo / 可视化 diff
  ↓
AI 看到错误能一步步改，而不是 all-or-nothing 重写
```

这是最远、但也最有价值的方向。它要求编辑器本身有**良好的原子操作 API + 可观察状态 + undo 栈**。MotionForge 这些基础已经有了（[keyframeManager.undo/redo](../../src/main.js)），但还没暴露成"AI 可调 API"。把现有 UI 操作包装成 agent tool 调用，是实现这一步的最小改动。

## 为什么这件事值得做

几个观察：

### (1) 3D 不是"更难的 2D"，是完全不同的感知通道

2D 里 AI agent 已经能调 Figma、写 CSS、改 slide。那里的语义单位（文字、框、颜色）天然就是符号化的。

3D 里的语义单位是**空间关系**（谁挂谁、谁转谁、相对位置、相对角度），这些在代码里是矩阵、四元数、欧拉角 —— 对 LLM 极不友好。纯文字描述 3D 状态基本等于"用坐标读诗"。

**可视化握把的意义**就是把 3D 空间关系重新符号化（line / dot / color / tag），让 LLM 的模糊推理能力用得上。

### (2) "让 AI 看渲染结果"是个死胡同

近两年的趋势是用多模态模型"直接看截图"。这条路在 2D 任务里有效（Figma 截图 → HTML），但在 3D 上问题严重：

- 视角依赖：同一场景不同角度截图，AI 得出的结论完全不同
- 遮挡：物体被挡住看不见
- 透视压缩：Y 方向 0.5m 变化在相机远景里看起来是 0
- 成本：多模态 token 贵一个数量级

结构化的**轨迹 + 采样表** + 3D 视口里的可视化握把，是远比"看截图"更可靠的 AI 接口。这相当于给 AI 加一套 API，而不是让它猜像素。

### (3) "编辑"比"生成"更工程、也更实用

过去两年 AI + 3D 大量集中在 **生成**（text-to-3D 模型、text-to-animation）。生成场景很炫，但对工业链条意义有限 —— 工厂里的模型是几万人花十年做出来的资产，没人会愿意扔掉重生成。

**编辑**比生成小一个量级，但：
- 单位工作价值高（节省工程师时间，不是替代）
- 可验证（编辑结果可以肉眼对比原资产）
- 可 undo（错了能回）
- 工具链已经有（Three.js / Blender / URDF）

我们押注"AI + 编辑"而不是"AI + 生成"，是基于这种判断。轨迹 overlay 是"编辑路径"上的一个微小基建，但它的方法论可以复制：每遇到一类难以文字描述的 3D 状态，就建一个对应的可视化握把。

## 工程上要做的事

如果接下来要把这条路走深，有几件事值得建：

### 短期（1-2 周可做）

1. **诊断类可视化**：PKF step 预期和实际不一致时，场景里画红色标记。把当前"console.warn 刷屏"的错误变成"场景内指出哪段错了"
2. **role 色标**：关节按 role 染色，gizmo 也跟。用户可视化和 AI prompt 引用同一套
3. **limits 弧线**：revolute 关节的 limits.min/max 画个扇形；prismatic 画双向箭头。非法 value 染红

### 中期（1-2 个月）

4. **sampleOnly → AI feedback loop**：把轨迹采样表喂给 LLM 做自检，自动识别"seg N 偏差过大"
5. **Agent tool API**：把现有 UI 编辑操作（`addPkfStep`、`modifyParameter`、`addReparentEvent` 等）包装成 MCP / function calling 接口，让 AI agent 能分步编辑
6. **原子操作 + 差异 preview**：AI 每次编辑先显示 diff（"准备添加 step: joint=X, t=Y"），用户一键接受/拒绝

### 长期

7. **基准测试**：构建一批"已知 PKF 动画 + 描述"的测试集，评估 AI 修改前后的物理合理性（轨迹平滑度 / attach 瞬移大小 / 关节 value 合法性）
8. **视觉检查 + 结构化采样并用**：多模态模型 + 采样表双通道输入，取长补短
9. **多用户协作**：多个 AI / 多个人同时编辑同一个场景，可视化握把变成协作语言

## 结语

轨迹 overlay 是 150 行代码做完的小功能，但调它的过程让我想通了一件事：**AI 协作 3D 编辑的关键，是给场景装上 AI 能读、人能看、两边共享的可视化语言**。

有了这套语言，工程上接下来该做的事就清楚了 —— 不是追更强的模型，是**把每一个"人靠眼睛看得出，但 AI 没法从 JSON 推出来"的状态都做成 overlay**。

3D 软件的 AI 化，可能从这些小 overlay 开始。每个 overlay 大约 100-300 行代码，独立低耦合，容易验证。做多了，整个 AI-3D 协作栈就变成了一组可视化握把的组合。

---

## 相关代码入口

- [src/core/TrajectoryOverlay.js](../../src/core/TrajectoryOverlay.js) — 轨迹 overlay 实现（300 行）
- [src/core/aiPipeline/ensurePkfCoversAttachPoint.js](../../src/core/aiPipeline/ensurePkfCoversAttachPoint.js) — AI 输出 sanitize（150 行）
- [tools/conversion-service.js](../../tools/conversion-service.js) — AI 后端（L1/L2 + role prompt）

## 参考文档

- [bugfix #66](../bugfix-log.md) — 轨迹 overlay 采样锚点从 pivot 改为 bbox 底面中心
- [docs/concepts/forklift-pickup-model.md](../concepts/forklift-pickup-model.md) — fork_anchor 模型
- [docs/ai-rigging/HANDOFF.md](../ai-rigging/HANDOFF.md) — AI 打关节研究专题入口
