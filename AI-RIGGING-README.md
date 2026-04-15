# AI 打关节研究 — 总览（新 chat 先看这个）

> **2 分钟读完**。看完还想了解细节 → 看末尾的文档索引。
> 最后更新：2026-04-15

---

## 📍 当前状态快照（关键：这是整个项目的上限）

**战略定位**：AI 打关节能做到多自动，决定产品能不能给**不懂机械的人**用。这一步不通，MotionForge 就永远是"懂机械工程师的工具"。

**已定的技术路线**（经多轮讨论 + 与研究方对齐，详见 [RESEARCH-LOG.md](docs/ai-rigging/RESEARCH-LOG.md)）：
- **模型分布决定一切**：目标场景 80%+ 是 prismatic（平移）关节，revolute 少
- **真正瓶颈是父子拓扑**（不是原以为的 revolute origin 精度）
- **分工**：LLM 负责语义判断（type / axis / role），几何算法负责精度（父子拓扑、revolute origin）
- **GT 策略**：用 approximate 级 origin（肉眼拖，不追求毫米精度），evaluator 对应支持 `origin_mode = approximate`

**正在等（阻塞项）**：
- ⏳ 研究方给 evaluator 加 `origin_mode` 开关
- ⏳ 用户标 3-5 个车型的人工 GT（每关节 4 字段：child / parent / type / axis）

**下一个里程碑**：GT 到位 → 研究方跑 v2 实验 → 评估当前 AI 能力能否产品化

**不要再讨论的问题**（已定，避免新 chat 反复）：
- 不要建议"只找 revolute"（已反驳，因为模型 80%+ 是 prismatic）
- 不要建议"AI 精确算 prismatic origin"（数学上不参与计算，不需要算）
- 不要建议用 v1 实验数据做决策（GT 是 AI 自己生成的，方法论上不可信）

---

## 一句话总结

**把 MotionForge 的"手动配关节"这步换成 AI 自动打关节**，让不懂机械的人也能让 3D 模型动起来。后半段（自然语言 → 动画）已 work，只缺前半段。

---

## 当前状态

| 模块 | 状态 |
|---|---|
| MotionForge 手动配关节 → 自然语言 → 动画 | ✅ 端到端 work（v11 演示稳定） |
| AI 自动打关节 | 🟡 调研中（另一个 chat 在做） |
| 人工 GT 标注 | 🟡 方案定了，即将开标 |
| evaluator（对比 AI 输出 vs GT） | ⏳ 待研究方实现 |

---

## 核心技术判断（决定研究方向的 3 条）

### 1. 模型分布决定一切
目标场景是**工业 AGV / 叉车**，**80%+ 是 prismatic（平移）关节**，revolute（旋转）很少。这推翻了"revolute origin 是核心硬骨头"的假设。

### 2. 真正瓶颈是父子拓扑
每个关节都要父子关系，错了链式动画直接断。MotionForge 历史上栽过 3 次（bug [#10](CLAUDE.md) [#18](CLAUDE.md) [#22](CLAUDE.md)）。

### 3. origin 精度要求分层
- **prismatic origin**：数学上不参与计算，写 (0,0,0) 都能跑
- **revolute origin**：必须精确，偏一点旋转就扫错弧线（像门铰链装歪）
- **结论**：AI 算 prismatic origin 没意义，revolute origin 是长期研究课题

---

## 技术分工

```
LLM 负责（语义层）：
  - 识别哪些零件可动
  - 判断 type（revolute / prismatic / fixed）
  - 推断 role（车体前进 / 门架升降 ...）

几何算法负责（精度层）：
  - 父子拓扑（bbox 包含 / 距离，跳过 GLTFLoader 插的无名 Object3D）
  - prismatic axis 方向（主惯性轴 / 父级朝向）
  - revolute origin 精确定位（圆柱面拟合 / 接触面检测）—— 基础研究

用户负责：
  - 一次性确认 UI
  - 手动调不满意的单个关节
```

---

## 优先级（按当前模型分布加权）

| 优先级 | 问题 | 原因 |
|---|---|---|
| 🔴 最高 | 父子拓扑自动推算 | 每个关节都要，错了链式动画断 |
| 🔴 高 | prismatic axis 判断 | 覆盖 80%+ 关节，决定动画方向 |
| 🟡 中 | type 分类 | 大部分是 prismatic，规则能兜底 |
| 🟢 基础 | revolute origin 几何算法 | 长期重要但非当前瓶颈 |
| ⬜ 无 | prismatic origin | 数学上不参与，不用算 |

---

## GT 标注方案（用户这边做）

**4 个必填字段**：`child / parent / type / axis`  
**可选**：`role / origin / limits`  
**origin 策略**：prismatic 全部 (0,0,0)；revolute 肉眼拖到预览动画正确即可（approximate 级）

**工作量**：每个关节 ~30 秒，5 个车型 × 5 关节 ≈ 15-25 分钟。

**重要**：evaluator 必须支持 `origin_mode = approximate`，跳过 origin 精度评分，不然肉眼拖的 origin 会被错误地当作精度 GT 打分。

---

## JSON schema 契约（AI 打关节的输出格式）

AI 打关节吐出这个格式的数组，MotionForge 直接消费，**不需要改代码**：

```json
[
  {
    "name": "_CS19110",                    // 场景树里的零件名
    "type": "revolute | prismatic | fixed",
    "axis": "x | y | z",                    // parent-local
    "origin": { "x": 0, "y": 0, "z": 0 },   // parent-local，revolute 必须精确
    "parent_name": "门架组件",              // 逻辑父级（跳过无名包装）
    "role": "叉齿旋转"                      // 语义角色（可选）
  }
]
```

---

## 方法论纪律

1. **v1 实验数字不引用**（GT 是 AI 自己生成的，不算对错，只算两个 AI 一致性）
2. 所有"精度"类声明都要等人工 GT 到位再说
3. 做决策时明确区分"已验证 / 推测 / 设计稿"三档

---

## 待办

### 用户（MotionForge 侧）
- [ ] 按轻量 GT 方案标 3-5 个车型
- [ ] 回复研究方确认 `origin_mode = approximate`

### 研究方
- [ ] evaluator 加 `origin_mode` 参数（precise / approximate / skip）
- [ ] 搭几何 origin baseline（不依赖 GT 可以先做）
- [ ] 研究重心前移到**父子拓扑 + prismatic axis**
- [ ] GT 到位后跑 v2 实验

### MotionForge 接入（未来）
- [ ] AI 打关节模块接入前端 UI
- [ ] 设计用户确认 UX
- [ ] 失败回退路径

---

## 文档索引

**先读这份** → 你现在看的这个文件（README 总览）

**按需深入**：
- [HANDOFF.md](docs/ai-rigging/HANDOFF.md) — 给研究方的 context 包，包含完整 context（独立于对话历史）
- [AI-RIGGING-PLAN.md](docs/archive/AI-RIGGING-PLAN.md) — 内部技术方案思考稿（早期，部分已废弃）
- [RESEARCH-LOG.md](docs/ai-rigging/RESEARCH-LOG.md) — 对话演进历史（7 阶段，回溯用）

**MotionForge 本体文档**：
- [CLAUDE.md](CLAUDE.md) — 架构约束 + 29 条 bug 历史（含父子拓扑相关 bug）
- [FLOW.md](FLOW.md) — 端到端流程 + 故障定位决策树
- [README.md](README.md) — 安装运行
