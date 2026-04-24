---
updated: 2026-04-23
---
# MotionForge 项目 Wiki 索引

> Karpathy LLM Wiki 风格文档体系。新 session 接手项目从这里开始。
> 快速定向：**改代码** → decisions + gotchas；**理解系统** → architecture；**理解格式** → concepts；**决策时间线** → [log.md](log.md)。

---

## Architecture（系统架构）

- [overview.md](architecture/overview.md) — 6 个核心模块的职责、依赖关系、坐标系约定（含 Y↔Z swap 说明）
- [fk-joint-system.md](architecture/fk-joint-system.md) — FK 关节数据结构、拓扑排序求解流程、懒捕获机制
- [export-import-roundtrip.md](architecture/export-import-roundtrip.md) — ZIP 导出/导入流水线、schema v1-v6 版本历史
- [ai-pipeline.md](architecture/ai-pipeline.md) — L1/L2 AI 生成流水线（意图拆解 + PKF 生成 + 坐标注入）

---

## Decisions（架构决策 ADR）

- [001-quaternion-base-transform.md](decisions/001-quaternion-base-transform.md) — baseTransform 用四元数不用 Euler（防万向锁）
- [002-parent-local-origin.md](decisions/002-parent-local-origin.md) — joint origin 用 parent-local 坐标（URDF 风格，父动子跟）
- [003-topology-sorted-fk-solver.md](decisions/003-topology-sorted-fk-solver.md) — FK 求解器用拓扑排序而非场景树顺序
- [004-name-based-cross-roundtrip-ids.md](decisions/004-name-based-cross-roundtrip-ids.md) — 跨 roundtrip 标识用 name 不用 UUID
- [005-glb-export-children-not-scene.md](decisions/005-glb-export-children-not-scene.md) — GLB 导出 children 数组而非 Scene 对象（防包层错位）
- [006-global-keyframes-not-per-object.md](decisions/006-global-keyframes-not-per-object.md) — 关键帧系统改为项目级全局（支持多关节协调）
- [007-two-phase-joint-import.md](decisions/007-two-phase-joint-import.md) — 导入时两阶段应用关节（先零位捕获 base 再恢复）

---

## Gotchas（踩坑记录）

- [001-gltf-scene-wrapping-roundtrip.md](gotchas/001-gltf-scene-wrapping-roundtrip.md) — ⚠️ HIGH：GLTFExporter/Loader Scene 包层不对称，roundtrip 层级错位
- [002-lazy-base-capture-timing.md](gotchas/002-lazy-base-capture-timing.md) — ⚠️ HIGH：懒捕获 base 必须在零位态，驱动态下捕获导致整体漂移
- [003-quaternion-double-cover-360-jump.md](gotchas/003-quaternion-double-cover-360-jump.md) — ⚡ MED：四元数双重覆盖导致旋转跳变 360°，需要角度解缠
- [004-material-sharing-emissive-bake.md](gotchas/004-material-sharing-emissive-bake.md) — ⚡ MED：共享材质 emissive 被烘焙进 GLB，导入后零件持续发光
- [005-try-finally-state-restore.md](gotchas/005-try-finally-state-restore.md) — ⚡ MED：临时状态恢复必须用 try/finally，否则异常时卡死
- [006-coordinate-swap-forgotten.md](gotchas/006-coordinate-swap-forgotten.md) — ⚠️ HIGH：外部序列化漏做 Y↔Z swap 导致 AI 坐标语义错位（高度/距离对调）
- [007-merged-mesh-bbox-trap.md](gotchas/007-merged-mesh-bbox-trap.md) — ⚠️ HIGH：合并 mesh 下 bbox 不代表"子部件几何"（承载锚点六轮迭代踩坑合集）
- [008-trajectory-overlay-as-suspect.md](gotchas/008-trajectory-overlay-as-suspect.md) — 🟢 LOW：🎨 轨迹 overlay 作为新跨模块 feature 出怪事时的优先怀疑清单 + 关停/删除指南

---

## Concepts（领域概念）

- [pkf-parametric-keyframe-formula.md](concepts/pkf-parametric-keyframe-formula.md) — PKF 格式：parameters + steps + 公式求值 + AI 生成流程
- [zip-output-schema.md](concepts/zip-output-schema.md) — ZIP 包结构（manifest/joints/motion/pkf/model.glb）及各文件格式
- [scene-marker-system.md](concepts/scene-marker-system.md) — 场景标记（cargo/pickup/dropoff）及 schema v6
- [forklift-pickup-model.md](concepts/forklift-pickup-model.md) — 叉车取放货领域模型：fork_anchor_zero（mvp2 = auto bbox 底面中心）+ snap-attach + 12 条隐含假设 + 失效矩阵
- **[forklift-pickup-template.md](concepts/forklift-pickup-template.md)** — mvp3 核心契约：17 段叉车取放模板（14 必选 + 3 可选横移），前端锁死几何，AI 只出节奏
- **[threeway-template.md](concepts/threeway-template.md)** — 三向车（VNA）参数化模板：车体不横移，靠门架横移 + 叉齿旋转实现 +x/+y/-x 三向取放；动态 13-22 段；模板库架构（src/core/templates/）

---

## Raw（草稿/待整理）

`docs/raw/` 目录用于存放未成型的笔记、草稿、口头决定记录等，不要求格式。

---

## 其他文档入口

- [CLAUDE.md](../CLAUDE.md) — 协作手册（**只放红线规则 + 钩子**，2026-04-22 瘦身至 ~165 行）
- **[log.md](log.md)** — Append-only 决策/里程碑时间线（mvp2 → mvp3 完整轨迹）
- **[bugfix-log.md](bugfix-log.md)** — Bug 修复完整历史 #1-#56+（从 CLAUDE.md 拆出）
- **[diagnostics.md](diagnostics.md)** — 诊断脚本完整指南 9 脚本 + 8 场景（从 CLAUDE.md 拆出）
- [README.md](../README.md) — 项目概览（3 分钟版）
- [FLOW.md](../FLOW.md) — 完整产品操作流程
- [DEBT.md](../DEBT.md) — 技术债清单（持续跟踪）
- [docs/schema/v7.md](schema/v7.md) — ZIP schema v7 详细规范（当前版本）
- [docs/schema/v4.md](schema/v4.md) — ZIP schema v4 字段参考（历史版本）
- [docs/ROADMAP.md](ROADMAP.md) — 二期路线图
- **[docs/REVIEW-v15.md](REVIEW-v15.md)** — mvp3 最新 review（F28-F43 + 收尾 checklist）
- [docs/REVIEW-v14.md](REVIEW-v14.md) — v14.1 master review（F1-F27，多数已完成）
- [docs/raw/alignment-state-animation-framework-2026-04-23.md](raw/alignment-state-animation-framework-2026-04-23.md) — 和 mentor 对齐的状态机框架决策（结论：17 段模板不重构）
- [docs/raw/codex-full-repo-review-2026-04-21.md](raw/codex-full-repo-review-2026-04-21.md) — Codex 原版 review（归档）
