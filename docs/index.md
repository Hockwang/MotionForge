---
updated: 2026-04-22
---
# MotionForge 项目 Wiki 索引

> Karpathy LLM Wiki 风格文档体系。新 session 接手项目从这里开始。
> 快速定向：**改代码** → decisions + gotchas；**理解系统** → architecture；**理解格式** → concepts。

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

---

## Concepts（领域概念）

- [pkf-parametric-keyframe-formula.md](concepts/pkf-parametric-keyframe-formula.md) — PKF 格式：parameters + steps + 公式求值 + AI 生成流程
- [zip-output-schema.md](concepts/zip-output-schema.md) — ZIP 包结构（manifest/joints/motion/pkf/model.glb）及各文件格式
- [scene-marker-system.md](concepts/scene-marker-system.md) — 场景标记（cargo/pickup/dropoff）及 schema v6
- [forklift-pickup-model.md](concepts/forklift-pickup-model.md) — 叉车取放货领域模型：fork_anchor_zero（mvp2 = auto bbox 底面中心）+ snap-attach + 12 条隐含假设 + 失效矩阵

---

## Raw（草稿/待整理）

`docs/raw/` 目录用于存放未成型的笔记、草稿、口头决定记录等，不要求格式。

---

## 其他文档入口

- [CLAUDE.md](../CLAUDE.md) — 协作手册（**只放红线规则 + 钩子**，2026-04-22 瘦身至 ~165 行）
- **[bugfix-log.md](bugfix-log.md)** — Bug 修复完整历史 #1-#52+（从 CLAUDE.md 拆出）
- **[diagnostics.md](diagnostics.md)** — 诊断脚本完整指南 7 脚本 + 7 场景（从 CLAUDE.md 拆出）
- [README.md](../README.md) — 项目概览（3 分钟版）
- [FLOW.md](../FLOW.md) — 完整产品操作流程
- [docs/schema/v4.md](schema/v4.md) — ZIP schema v4 详细规范
- [docs/ROADMAP.md](ROADMAP.md) — 二期路线图
- **[docs/REVIEW-v14.md](REVIEW-v14.md)** — v14.1 master review（三份 AI 评审合并版，F1-F27 + 行动路线）
- [docs/raw/codex-full-repo-review-2026-04-21.md](raw/codex-full-repo-review-2026-04-21.md) — Codex 原版 review（归档）
