> ⚠️ **本文档已部分被推翻**
>
> 第 2-3 节的"AI 核心硬骨头 = revolute origin"论点**已废弃**。后来发现目标模型 80%+ 是 prismatic，真正瓶颈是**父子拓扑**。
>
> **当前权威方案见**：
> - [AI-RIGGING-README.md](../../AI-RIGGING-README.md) — 2 分钟总览
> - [HANDOFF.md](../ai-rigging/HANDOFF.md) — 给研究方的完整 context
> - [RESEARCH-LOG.md](../ai-rigging/RESEARCH-LOG.md) — 观点演进记录
>
> 本文档保留作为早期思考稿，便于回溯决策是怎么演进的。

---

# AI 打关节 — 技术方案对齐（早期草稿，已部分废弃）

> 这份文档记录目前的思路，带去和 mentor 对一下是否一致。
> 关键技术判断都单独标出来了，便于逐条确认。

---

## 1. 产品目标

**一句话**：让不懂机械结构的人也能让 3D 模型动起来。

### 现状（MotionForge v11，已 work）

端到端流程已经打通，用自然语言能完整生成动画。但**有一步卡门槛**：

```
用户加载模型
   ↓
[手动] 对每个零件配关节：
   - 选类型：旋转（revolute）/ 平移（prismatic）
   - 平移 → 选轴向 x/y/z
   - 旋转 → 选轴向 + 选旋转中心（origin 坐标）
   ↓
[已自动化] 用户输入自然语言 → AI 生 PKF → 动画播放 ✅
```

这一步需要用户懂机械运动学（知道叉车门架和车体之间是 prismatic、叉齿倾斜是 revolute），外行做不了。

### 目标

**唯一要省掉的就是"手动配关节"那一步**，前后都不动：

```
用户加载模型
   ↓
[AI 打关节] ← 本次要做的事
用户确认一下（"看起来对"）
   ↓
[已 work] 自然语言 → AI 生 PKF → 动画播放
```

**定位**：不替代人，**只替代"配关节"这一步**，降低动作标注人员的上手门槛。
**范围**：不改现有 AI 生 PKF 流程，不改导入导出，只在"加载模型"和"配关节"之间插入一个 AI 自动化步骤 + 一个确认 UI。

---

## 2. 关节打在哪儿的精度要求 — 为什么不是所有关节一视同仁

### 核心技术观察

MotionForge 的关节数学告诉我们一个关键分工：

**Revolute（旋转关节）**：
```
child 位置 = origin + Rotation(axis, value) · (baseTransform.position - origin)
                ↑ origin 是旋转中心，必须精确
```
origin 偏一点，旋转时零件会扫出错误的弧。

**Prismatic（平移关节）**：
```
child 位置 = baseTransform.position + axis · value
                                        ↑ 只看方向
```
**origin 完全不参与计算**。prismatic 的 origin 写 (0,0,0) 都能跑，只要 axis 方向对。

### 由此得出的难度排序

| 需要 AI 算什么 | 难度 | 对精度要求 |
|---|---|---|
| 旋转关节 origin（铰链轴位置） | ⭐⭐⭐⭐ | **必须精确** |
| 旋转关节 axis（铰链方向） | ⭐⭐⭐ | 一般精确（偏几度能接受） |
| 平移关节 axis（滑动方向） | ⭐⭐ | 方向对就行 |
| 平移关节 origin | ⭐ | 写死 (0,0,0) 也能跑 |
| parent-child 拓扑 | ⭐⭐⭐⭐ | 错了链式动画断 |

### 结论

> **AI 打关节的核心硬骨头 = 精确算出旋转关节的 origin（铰链轴位置）**
>
> 其他（prismatic 方向、父子关系）是工程问题，规则/几何算法就能兜底。

这和 mentor 那句"只要找到旋转关节就行"吻合——他说的"找到"**不是字面的"只找 revolute"，而是"把几何精度最高的那一类关节处理掉"**。

---

## 3. 技术分工建议

| 负责方 | 做什么 |
|---|---|
| **AI（LLM + 几何分析）** | 旋转关节的 origin + axis；所有关节的 type/axis 推断 |
| **规则 / 几何算法** | 父子拓扑（bbox 包含、距离、跳过无名 Object3D 包装）；prismatic 方向默认（主惯性轴 / 父级朝向） |
| **用户** | 一次性确认 UI（不逐个配，点"看起来对"即可） |

---

## 4. 已知要避开的坑

这些是 MotionForge 踩过的 bug，AI 打关节设计时**不能假装不知道**：

- **GLTFLoader 无名包装**：导入 GLB 时三方 loader 会在逻辑父级外面插入无名 `Object3D` group。如果"子→父自动"按场景树 parent 取值，会绑到无名包装，链式动画断（[CLAUDE.md #18](../../CLAUDE.md)）。**方案**：按"第一个有名字的祖先"找父级。
- **origin 是 parent-local 而非世界坐标**（[CLAUDE.md #5](../../CLAUDE.md)）：AI 输出 origin 时要明确是哪个坐标系。
- **baseTransform 用四元数不用 Euler**（[CLAUDE.md #7](../../CLAUDE.md)）：避免万向锁。
- **关节链拓扑排序**（[CLAUDE.md #8](../../CLAUDE.md)）：父关节先驱动，子关节再驱动。

---

## 5. 验证场景（演示模型：三向车）

叉车 5 个关节里只有 1 个是 revolute，其他 4 个是 prismatic。这个分布刚好能压力测试上面的分工：

| 关节 | type | role | AI 硬骨头？ |
|---|---|---|---|
| `_CS19110` | revolute | 叉齿旋转 | ✅ 要精确算 origin |
| `_____10` | prismatic | 门架升降 | ❌ 只要方向 |
| `cAR201` | prismatic | 门架升降 | ❌ 只要方向 |
| `_CS198` | prismatic | 叉齿侧移 | ❌ 只要方向 |
| `三向车.glb` | prismatic | 车体前进 | ❌ 只要方向 |

**验证标准**：如果 AI 能把 `_CS19110` 的 origin 定在叉齿真正的铰链轴上（误差 < 几毫米），其他 4 个给出正确 axis 方向，父子关系正确链上，就算过。

---

## 6. 和 MotionForge 现有架构的衔接

MotionForge 的 joint schema（v4）已经准备好了这次接入需要的字段：

```json
{
  "id": "...",
  "name": "_CS19110",
  "type": "revolute",
  "axis": "z",
  "role": "叉齿旋转",           // v6+ 语义标签，AI 生 PKF 按它匹配
  "origin": { "x": 0, "y": 0, "z": 0 },  // parent-local
  "parent_id": "...",
  "parent_name": "..."           // 跨 roundtrip 稳定标识
}
```

**AI 打关节只要吐出这个 schema 的数组，MotionForge 就能直接消费**。后半段（AI 生 PKF → 动画）已经 work。

---

## 7. 待 mentor 确认的点

1. **"只找旋转关节"是字面意思还是泛指**？按我现在的理解：**字面上 AI 只算精确 origin 的是 revolute，prismatic 可以用规则/默认值覆盖**。这个理解对吗？

2. **prismatic 的 axis 怎么定**？几个候选：
   - (a) 主惯性轴（长条零件沿长边滑）
   - (b) 父级坐标系主轴对齐
   - (c) LLM 根据命名语义推（"叉齿侧移" → x 轴）
   - (d) 默认 parent Y 轴，让用户改

3. **子→父拓扑自动推算法是什么**？BBox 包含？距离最近？几何包含有歧义时（如叉齿既包含在门架又包含在升降组）怎么办？

4. **无名 Object3D 包装如何处理**？跳过直到找到有名祖先，还是别的策略？

5. **用户确认 UI 的粒度**？一次看全局（类似 URDF preview），还是逐关节确认？

6. **失败回退路径**？AI 打错时，用户是手动纠正单个关节，还是整体回退到"从头手配"？
