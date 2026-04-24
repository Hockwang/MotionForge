---
updated: 2026-04-24
---
# MotionForge 文档类型索引 —— 该写哪里？

> 写文档前先看这页：**你要写的东西属于哪一类？去哪个目录？用什么模板？**
> 目标是不同类型的知识有**固定落位**，不互相冲突，也不到处找。

---

## 一张表

| 类型 | 目录 | 颗粒度 | 时机 | 格式 | 给谁看 |
|------|------|-------|-----|------|-------|
| **工程反思博客** | `docs/articles/` | 一个迭代（2 周 – 2 月） | 事后 1-2 周回看 | 自由博客体 | 外部同行 / 自己 |
| **ADR 架构决策** | `docs/decisions/` | 单个决策 | 决策做出时 | 固定模板（[见下](#adr-模板)） | 项目内 + 接手者 |
| **Gotcha 踩坑** | `docs/gotchas/` | 单个坑 | 踩到后立即 | 警示体（[见下](#gotcha-模板)） | 未来的自己 / 接手者 |
| **领域概念** | `docs/concepts/` | 单个概念 | 概念稳定后 | 教学文档 | 新人 / AI 协作 |
| **架构** | `docs/architecture/` | 单个子系统 | 结构成型后 | 模块分解 + 数据流 | 协作者 |
| **Bug 修复** | `docs/bugfix-log.md` | 单 bug | 修完立即 | 固定条目（[见下](#bugfix-条目模板)） | 项目内 + 未来的自己 |
| **里程碑** | `docs/log.md` | 项目事件 | 事件发生时 | append-only 流水 | 自己 |
| **Review** | `docs/REVIEW-vN.md` | 阶段末审查 | 阶段末 | 清单 | 项目内 |
| **Schema 规范** | `docs/schema/vN.md` | 单版本 ZIP 格式 | schema 改动时 | 字段字典 | 下游对接者 |
| **Roadmap** | `docs/ROADMAP.md` | 未来方向 | 季度更新 | 优先级列表 | 自己 + stakeholder |
| **诊断脚本** | `docs/diagnostics.md` | 脚本索引 | 加新脚本时 | 脚本表 + 场景用法 | 协作者 |
| **草稿 / 未整理** | `docs/raw/` | 任意 | 随手 | 无要求 | 自己 |

## 选择流程（5 秒决策）

```
你要写的东西是：

─ 做完一个迭代，想对外 / 对自己复盘
│  └─ articles/<主题>.md    （博客体）
│
─ 刚做了一个架构决策（"为什么选 A 不选 B"）
│  └─ decisions/<编号>-<决策名>.md    （ADR 模板）
│
─ 刚踩到一个非平凡的坑（别人接手 / 未来的自己会重踩）
│  └─ gotchas/<编号>-<主题>.md    （警示体）
│
─ 项目里有个新的领域概念需要解释清楚
│  └─ concepts/<概念名>.md    （教学）
│
─ 修了一个 bug（不管大小）
│  └─ 追加到 bugfix-log.md    （固定条目，编号递增）
│
─ 有个重要决定 / 项目节点
│  └─ 追加到 log.md    （流水）
│
─ 想快点记个想法但不确定该放哪
│  └─ raw/<日期>-<主题>.md    （以后整理时再挪）
```

---

## 类型详解

### 工程反思博客（`docs/articles/`）

**特征**：
- 第一人称、非正式、有观点
- 具体数字 / 代码路径 / bug 编号
- 敢承认不做的事并说明理由（YAGNI / 工程浪费）

**标准结构**：
```
1. 元信息 block       作者 / 项目定位 / 阅读时间 / 适合谁 / 前置阅读
2. TL;DR             5 行以内，让读者决定要不要读下去
3. 为什么写           动机（通常是"遇到 N 类新问题催生"）
4. 目录              带锚点，老手直接跳章
5. 主体 N 章          每章：问题 → 解法 → 权衡 → 教训
6. 跨章通用原则        编号列表，这次再遇到能直接套
7. 代码入口索引        表格，让 dive-deep 读者找到源码
8. 结语              一两句话抽象收尾，点出立场
```

**什么时候写 / 不写**：
- ✅ 迭代周期完成（2 周 – 2 月），有多个模块改动且**有主题**能串起来
- ✅ 踩的坑背后有**可复用原则**（不是"这次因为拼错字段名"）
- ✅ 愿意对外输出（招聘 / 同行交流 / 讨论伙伴）
- ❌ 单个 bug 修复（→ bugfix-log）
- ❌ 架构方向刚拍板（→ ADR）
- ❌ 日常进度流水（→ log.md）
- ❌ 没踩到新原则、只是做了几件事（写出来会像清单）

**节奏**：2 周 – 2 月一篇最合适。隔得太近说明没沉淀，太远说明在拖延。

**典型例子**：
- [motionforge-tech-addendum.md](articles/motionforge-tech-addendum.md) —— mvp1 → mvp3 两周工程基建的五件事
- [ai-3d-editing-visual-handles.md](articles/ai-3d-editing-visual-handles.md) —— 围绕轨迹 overlay 展开的 AI + 3D 协作讨论

---

### ADR 架构决策（`docs/decisions/`）

**触发条件**：做了一个**影响范围 > 1 个文件**的架构决定，且**有过备选**。

**模板**：

```markdown
# NNN：<决策一句话名>

## Context（背景）

为什么要做这个决定？触发它的问题 / 痛点是什么？

## Options（选项）

考虑过的几种方案，各自的优劣：
- 方案 A：...
- 方案 B：...
- 方案 C：...

## Decision（决策）

选了 X，because。

## Consequences（后果）

- 这个决策解决了什么
- 带来了什么新约束 / 代价
- 以后什么情况下应该重新评估
```

**编号**：递增。文件名 `NNN-主题.md`。

**关键**：ADR 是**决策当时**的快照。后来发现选错了，不改 ADR；写新 ADR 说明为什么推翻前一个。

**典型例子**：
- [001-quaternion-base-transform.md](decisions/001-quaternion-base-transform.md) —— 四元数 vs Euler
- [007-two-phase-joint-import.md](decisions/007-two-phase-joint-import.md) —— 两阶段导入

---

### Gotcha 踩坑（`docs/gotchas/`）

**触发条件**：踩到一个**非平凡**的坑（调试花过 30 分钟以上），且别人接手 / 未来的自己会重踩。

**模板**：

```markdown
# NNN：<坑的一句话名>

> ⚠️ HIGH / ⚡ MED / 🟢 LOW — 严重程度

## 现象

出错时看到的症状，越具体越好。

## 根因

为什么会这样。

## 修法

代码侧怎么绕开 / 防御。

## 如何避免重踩

下次类似场景应该怎么做 / 不做。

## 相关

- 对应 bug：#编号
- 对应代码：`path/to/file.js:行号`
```

**编号**：递增。

**和 bugfix-log 的区别**：
- bugfix-log = **事件**（一次修复，流水记录）
- gotcha = **教训**（可能涉及多次踩坑，提炼成防御指南）

典型例子：[002-lazy-base-capture-timing.md](gotchas/002-lazy-base-capture-timing.md)

---

### 领域概念（`docs/concepts/`）

**触发条件**：项目里有个**领域术语 / 业务模型**需要解释清楚，而不是代码架构。

特征：读完这篇文档，新人能听懂你说 "PKF"、"fork_anchor_zero"、"17 段模板" 时在讲什么。

**模板**（松散）：
```
1. 定义 —— 这个概念是什么
2. 例子 —— 具体场景里长什么样
3. 边界 —— 不是什么 / 不能用来做什么
4. 和其他概念的关系
5. 代码入口
```

典型例子：
- [pkf-parametric-keyframe-formula.md](concepts/pkf-parametric-keyframe-formula.md)
- [forklift-pickup-model.md](concepts/forklift-pickup-model.md)

---

### 架构（`docs/architecture/`）

**触发条件**：某个子系统结构**成型**（不再频繁变动），需要给协作者一张整体图。

**关注**：**模块分解 + 数据流 + 依赖关系**，不讲具体函数细节（那是代码注释的事）。

典型例子：
- [overview.md](architecture/overview.md) —— 6 个核心模块的关系
- [fk-joint-system.md](architecture/fk-joint-system.md) —— FK 子系统

---

### Bug 修复（`docs/bugfix-log.md`）

**触发条件**：修了任何 bug（不管大小）。

#### bugfix 条目模板

```markdown
#### #编号 简短标题

- **症状**：用户看到什么现象
- **排查**：用了什么诊断脚本/方法找到问题
- **根因**：具体是什么代码/机制导致的
- **修复**：改了什么（文件 + 关键变更）
- **经验教训**（非必需，有新启发再写）：跨 bug 的通用原则
```

**编号**：递增，当前最新 #67。查最大编号：`grep "^#### #" docs/bugfix-log.md | tail -3`。

**长度**：每条 10-30 行。超过 50 行说明应该单独写成 gotcha + 一条精简 bugfix 指向 gotcha。

---

### 里程碑 / 决策时间线（`docs/log.md`）

Append-only 流水。**决策 / 节点 / 方向转折**记在这里。

和 bugfix-log 的区别：bugfix-log 是"修了什么"，log.md 是"为什么要修 / 为什么走这个方向"。

---

### Review（`docs/REVIEW-vN.md`）

**触发条件**：阶段性（mvp1 / mvp2 / mvp3 的末尾）做完整审查。

格式：清单体，按严重程度（P0 / P1 / P2）分。审完产生的 action item 走 bugfix-log 的编号系统。

---

### Schema 规范（`docs/schema/vN.md`）

**触发条件**：ZIP 输出格式版本号变动。

⚠️ **协作红线**：schema 版本号变动必须**三处联动**：
1. `src/core/ResultPackageExporter.js` 的 `schema_version` 常量
2. `docs/schema/vN.md`（新建或更新）
3. 所有对外引用链接（README / docs/index.md / docs/concepts/zip-output-schema.md）

漏一处下游就按错版本实现，下游报 bug 的成本远高于同步 3 个文件的成本。

---

### 草稿（`docs/raw/`）

**触发条件**：你有个想法想写下来但**不确定最终属于哪类**。

规则：
- 文件名 `<日期>-<主题>.md`
- 没有格式要求
- 整理时迁移到对应目录，**原文件可以留一份占位指向新位置**（防止外链失效）

典型例子：
- `raw/alignment-state-animation-framework-2026-04-23.md` —— 和 mentor 对齐后的想法，最后部分升级成了 ROADMAP 条目

---

## 误放 / 混淆的反例

| 放错的情况 | 应该放哪 | 理由 |
|-----------|---------|------|
| 把"为什么选 A 不选 B"写进 concept 文档 | ADR | concept 讲**是什么**，ADR 讲**为什么这样** |
| 把完整 bug 排查过程写进 articles | bugfix-log（+ gotcha 如果非平凡） | articles 是**聚合多个 bug 的故事**，不是单 bug |
| 把 bugfix 写成 50 行复盘 | gotcha + 精简 bugfix | bugfix 是流水，gotcha 才是复盘 |
| 在 architecture 里写函数签名 | 代码注释 / concepts | architecture 讲**模块边界**，不讲 API |
| 把 review action item 留在 REVIEW 文档里不动 | 转成 bugfix-log 条目 | REVIEW 是快照，真正的修复历史在 bugfix-log |

---

## 相关文档

- [docs/index.md](index.md) —— 所有文档的入口索引
- [CLAUDE.md](../CLAUDE.md) —— 协作红线 + 固定钩子
- [CONTRIBUTING.md](../CONTRIBUTING.md) —— 协作流程（commit / PR / 测试）
