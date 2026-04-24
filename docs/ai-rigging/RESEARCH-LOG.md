# AI 打关节研究对话记录

> 记录时间：2026-04-15
> 范围：MotionForge 方和研究方（另一个 chat）关于 AI 自动打关节的讨论脉络
> 目的：保留思考演进过程，防止下次讨论从零开始

---

## 阶段 1：概念对齐

### 起点

发现另一个 chat 里讨论的"AI 打关节"和 MotionForge 已有的"AI 生 PKF"其实是**同一个愿景的两半**：

```
用户加载模型 → 【AI 打关节】（本轮调研中）
            → 用户确认
            → 【AI 生 PKF】（MotionForge 已完成）
            → 模型动起来
```

MotionForge 的后半段已经做完，只缺前半段（AI 自动识别哪些零件能动、怎么动）。

### 产品目标

**让不懂机械结构的人也能让 3D 模型动起来。**

现状门槛：配关节要懂运动学（知道铰链 vs 滑轨、选对轴向、定旋转中心）。  
目标：用户点一个按钮，AI 自动打好关节，用户一次确认，其他流程不动。

产出文档：[AI-RIGGING-PLAN.md](../archive/AI-RIGGING-PLAN.md)、[HANDOFF.md](HANDOFF.md)

---

## 阶段 2：Mentor 提出"只找旋转关节就行"

### Mentor 原话

> "针对我这个编辑器，其实只要找到旋转关节就行，剩下的事情就是子关节自动找到父关节。"

### 第一反应：字面理解不对

用三向叉车反推：5 个关节里只有 1 个是 revolute（叉齿旋转），其他 4 个是 prismatic（门架升降 / 车体前进 / 叉齿侧移 / 门架升降）。如果 AI 只打 revolute，用户还是得手配 4/5 的关节——门槛没降下来。

### 关键洞察：不是"关节类型"的问题，是"精度"的问题

MotionForge 的关节驱动数学暴露了重要差异：

**Revolute（旋转）**：
```
child 位置 = origin + Rotation(axis, value) · (baseTransform.position - origin)
                ↑ origin 是旋转中心，必须精确
```
origin 偏一毫米 → 零件扫出错误弧线 → 视觉明显不对（像门铰链装歪了）。

**Prismatic（平移）**：
```
child 位置 = baseTransform.position + axis · value
                                        ↑ 只看方向
```
**origin 完全不参与计算**。prismatic 的 origin 写 (0,0,0) 都能跑，只要 axis 方向对。

### 由此推出 AI 打关节的难度地图

| 要算什么 | 难度 | 精度要求 |
|---|---|---|
| **revolute 的 origin（铰链位置）** | ⭐⭐⭐⭐ | 必须精确 |
| revolute 的 axis | ⭐⭐⭐ | 偏几度能接受 |
| prismatic 的 axis | ⭐⭐ | 方向对就行 |
| prismatic 的 origin | ⭐ | 写死 (0,0,0) 也能跑 |
| **父子拓扑** | ⭐⭐⭐⭐ | 错了链式动画断 |

### 重新理解 Mentor 的意思

Mentor 说"找到旋转关节就行"的**真正含义**：
- 几何精度要求最高的是 revolute 的 origin
- 这是 AI 打关节的技术重心
- 其他（prismatic 方向、父子拓扑）是工程问题，规则/几何算法就能搞定

不是"只处理 revolute 类型"，而是"把几何精度最高的那类关节处理掉"。

---

## 阶段 3：用户接管决策

### 用户表态

> "Mentor 的话不重要，这一块我主要我在主导。"

决策权回到用户。用户初步判断："只需要自动标注旋转关节就行，平移关节精确度不重要"。

### 追问：prismatic 怎么办？

把"精确度不重要"拆成三种可能：

| 方案 | 含义 | 影响 |
|---|---|---|
| A | AI 不管 prismatic，用户手配 | ⚠️ 叉车 4/5 关节还得手配，产品目标没达成 |
| B | AI 用简单规则给默认值 | ✅ 用户只检查不配置 |
| C | AI 也负责 prismatic，允许低精度 | ⚠️ 用户还是得会判断轴向 |

按产品愿景应选 B：AI 只啃硬骨头（revolute origin），prismatic 用规则兜底。

---

## 阶段 4：研究方的响应 + 方法论批评

### 研究方给的回答

针对 Q1-Q5 列了方案、引用了 Articulate AnyMesh、胖饼加权融合（几何 30% + 物理 25% + 视觉 15%）、父子关系 v1 实验的准确率（策略 A 25% / 策略 E 100%）。

### 方法论批评

对方自己承认：
1. v1 实验的 GT 是 AI 自己生成的 → 绝对数字只能当作"两个 AI 推理一致性"指标，不能当对错
2. Articulate AnyMesh 实际实现未核实，加权融合只是设计稿未跑过
3. Q1（revolute origin）末尾承认"实验没测过 origin 精度，是需要补的"

### 研究方提出的新方向

**让 LLM 只负责语义（判断是不是 revolute），几何算法负责精度（算 origin/axis）**：
- 找 child 与 parent 的接触区域（bbox 距离 < ε 的面）
- 检测圆柱面 / 旋转对称特征（PCA、CGAL、trimesh.curvature）
- 圆柱轴线 = revolute axis，轴线上靠近 child bbox 中心的投影点 = origin
- 无圆柱特征时 fallback 到接触面中心

### 研究方的 offer

"要不要我先把几何 origin 的 baseline 算法搭出来（不依赖 GT，纯几何，可以提前做）？"

### 我的评估

- 方法论批评有效：v1 GT 不靠谱是硬伤
- Q1 重构方向正确：LLM + 几何分工是合理架构
- "亚毫米精度"是预期不是证明：不要在承诺里写死
- 建议接受 offer：几何 baseline 不依赖 GT 可并行

---

## 阶段 5：GT 标准讨论

### 用户的困惑

"我是不是只要在 MotionForge 里标好旋转关节，就算一个好 GT？"

### 研究方的答案

**不够，必须标全（包括 prismatic）**，否则：
- AI 输出的 prismatic 在 GT 里找不到 → 被算作"多输出"
- evaluator 会错误地扣 precision 分

### GT 字段评估维度拆分

| 字段 | 评什么 | 必须标吗 |
|---|---|---|
| type | AI 判断类型对不对 | 必须，且标全 |
| parent_name | AI 选父级对不对 | **必须精确**（用户最关心） |
| axis | AI 选轴向对不对 | 必须 |
| role | 语义角色 | 标了多一维，不标跳过 |
| origin | origin 坐标 | 看是否想评精度 |

### 推荐的"轻量 GT"

必填：`child / parent / type / axis`  
可选：`role / origin / limits`

工作量：每个关节 ~30 秒 × 5 个车型 × 5 个关节 ≈ 15 分钟。

### origin 的特殊说明（重要）

**revolute 的 origin 在 MotionForge 里如果错了，会扫错弧线**——这不是 GT 数据本身问题，是编辑器使用层面的事。

标 GT 时你必须至少把 revolute origin **肉眼拖到大致位置**（否则预览动画会让你怀疑是不是 type/parent/axis 错了，被错误修改）。

---

## 阶段 6：关键发现 — 模型分布改变技术路线

### 用户的观察

> "我们现在带旋转的模型很少，大部分是都是平移关节。我们标记父子拓扑关系是不是更重要？"

### 分析

如果模型是工业 AGV / 叉车 / 物流机器人，关节分布大致是：
- **80%+ prismatic**（门架升降、车体前进、叉齿侧移、前伸……）
- **少量 revolute**（偶尔出现，比如叉齿倾斜）
- **极少 fixed**

### 技术路线重排

**原先的假设**：revolute origin 是硬骨头  
**新的认识**：父子拓扑才是真正瓶颈（每个关节都要，错了链式动画直接断）

| 维度 | 新优先级 |
|---|---|
| 父子拓扑 | 🔴 最高 |
| prismatic axis（3 选 1） | 🔴 高 |
| type 分类 | 🟡 中 |
| revolute origin | 🟢 基础研究，不赶工 |
| prismatic origin | ⬜ 全部 (0,0,0) |

### 研究方向的调整

- **当前阶段核心**：父子拓扑 + prismatic axis，覆盖 80%+ 场景
- **基础研究**：revolute origin 的几何算法继续推进，但不是当前瓶颈
- **不是否定原方向**：revolute origin 研究继续推进，只是优先级后移

这一发现写入了 [HANDOFF.md](HANDOFF.md)（第 1 节新增"模型分布特点"、第 3 节难度地图重排、第 5 节开放问题重排）。

---

## 阶段 7：GT origin 模式讨论

### 研究方提出的 evaluator 开关

为了避免"用户粗标 origin 却被评精度"，evaluator 加 `origin_mode` 参数：

| 模式 | GT origin 精度 | evaluator 行为 |
|---|---|---|
| `precise` | 毫米级（实测/精标） | 评 origin 精度 |
| `approximate` | 厘米级（肉眼拖） | 跳过 origin 精度评分 |
| `skip` | 全部 (0,0,0) | 完全跳过 origin |

### 用户实际状况

- prismatic 关节：origin 全部 (0,0,0)（数学上不参与，写死）
- revolute 关节：必须肉眼拖（否则预览动画扫错弧），但不是毫米级精确
- 所以用户 GT 是 **approximate** 模式

### 研究方的初稿回复的矛盾

研究方最后给的总结稿有个内部矛盾：
- A 段说"你标了 origin → 我评 origin 精度"
- B 段说"revolute origin 拖一下让预览对就行（不精确）"

矛盾点：用户必须拖 revolute origin 才能预览，但拖的是 approximate 级。按 A 段逻辑，evaluator 会把它当精确 GT 评精度 → AI 再准也会被打成误差大。

### 修法

用户回研究方时加一段澄清：

> 实际上我的 revolute origin 是肉眼拖的（approximate 级，厘米误差），不是精确标注。
> 请 evaluator 加 `origin_mode` 参数：
> - 当前 GT 标为 `approximate` → 跳过 origin 精度评分，只评其他维度
> - 未来想评 LLM origin 精度时，单独做 precise GT，evaluator 切 precise 模式

---

## 最终对齐的方案

### MotionForge 侧（用户）

1. **标注流程不变**：选零件 → 选 type → 选 parent → 选 axis →（revolute 拖 origin）→ 可选 role
2. **必填 4 字段**：child / parent / type / axis
3. **origin 策略**：prismatic 全部 (0,0,0)；revolute 肉眼拖到预览动画看起来对即可
4. **role**：标了多评一维，不标跳过
5. **工作量**：3-5 个车型起步，每个约 5 分钟

### 研究方（对方）

1. **evaluator 支持三档 origin_mode**：precise / approximate / skip
2. **研究重心调整**：
   - 🔴 父子拓扑自动推算（当前瓶颈）
   - 🔴 prismatic axis 方向判断
   - 🟢 revolute origin 几何算法（基础研究，不赶工）
3. **可并行**：提前搭几何 origin baseline（圆柱面拟合 + 接触面检测），不依赖 GT
4. **方法论纪律**：v1 GT 的绝对数字不再引用，等人工 GT 到位再说

### MotionForge 接入契约（JSON schema 不变）

```json
[
  {
    "name": "_CS19110",
    "type": "revolute | prismatic | fixed",
    "axis": "x | y | z",
    "origin": { "x": 0, "y": 0, "z": 0 },
    "parent_name": "父级名字（逻辑父级，跳过无名包装）",
    "role": "语义角色（可选）"
  }
]
```

AI 打关节只要吐出这个 schema，MotionForge 直接消费，不用改代码。

---

## 待办事项

### 用户侧

- [ ] 按"轻量 GT"方案标 3-5 个车型（必填 4 字段，origin approximate）
- [ ] 回复研究方，明确 `origin_mode = approximate`
- [ ] GT 标好后丢给研究方跑 v2 实验

### 研究方侧

- [ ] evaluator 加 `origin_mode` 参数（precise / approximate / skip）
- [ ] 搭几何 origin baseline（圆柱面检测）
- [ ] 研究重心前移到"父子拓扑 + prismatic axis"
- [ ] v2 实验：人工 GT + 多模型多策略对比

### MotionForge 侧（不在本轮）

- [ ] AI 打关节模块接入前端 UI
- [ ] 设计"用户一次性确认 UI"（全局预览 vs 逐关节）
- [ ] 失败回退路径（AI 打错时的 UX）

---

## 核心决策时间线

| 时间点 | 决策 |
|---|---|
| 发现两半愿景 | AI 打关节 + AI 生 PKF 是同一愿景的两部分，已自然对接 |
| 理解 mentor | "只找旋转关节"≠字面，而是"处理几何精度最高的那类" |
| 用户接管 | 产品决策权回到用户，不唯 mentor 话从 |
| LLM + 几何分工 | LLM 判语义，几何算精度。Q1 重构 |
| 模型分布发现 | 80%+ prismatic → 父子拓扑成为真正瓶颈，技术路线重排 |
| GT 策略 | 轻量 GT（4 必填）+ origin approximate + 15 分钟 5 车型 |
| 方法论纪律 | v1 GT 数字不引用，等人工 GT |

---

## 参考文档

- [AI-RIGGING-PLAN.md](../archive/AI-RIGGING-PLAN.md) — 产品愿景 + 技术判断（早期草稿，部分废弃）
- [HANDOFF.md](HANDOFF.md) — 给研究方的 context 包
- [CLAUDE.md](../../CLAUDE.md) — MotionForge 架构约束 + bug 历史（含父子拓扑相关 #10 #18 #22）
- [FLOW.md](../FLOW.md) — 端到端流程图
