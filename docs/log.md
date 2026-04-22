# MotionForge Wiki 时间线

> Append-only。格式：`## [YYYY-MM-DD] <事件类型> | <标题>`
> 事件类型：init / decision / gotcha / architecture / concept / milestone / deprecated

---

## [2026-04-18] init | 建立 wiki 骨架

创建 `docs/{architecture,concepts,decisions,gotchas,raw}/` 目录结构。
从 CLAUDE.md 的 35 条 bug 修复历史提炼出 7 个 ADR、5 个 gotcha、3 篇架构文档、3 篇概念文档。
当前项目版本：v12+，最近修复 #35（fixed 关节不跟 joint parent 运动）。

## [2026-04-21] milestone | v14 AI 一键生成 + fork_anchor_zero 合并

`v14-ai-oneshot` 分支 commit `f005ef3`：🚀 一键生成（L1 + L2 串联）+ fork_anchor_zero 语义修复。
追加 bug log `#32-#37`（CLAUDE.md）、新 gotcha `006-coordinate-swap-forgotten`、新 architecture `ai-pipeline`。

## [2026-04-21] milestone | vitest 基建落地（feature/vitest-infra）

v14.1 tag 后立即接 F4 基建：`vitest ^4.1.5` + 23 个单元测试覆盖 5 个历史 bug 经过的关键路径（#22/#31/#33/#36/#37/#39）。`npm test` 11ms 跑完。CONTRIBUTING.md 单元测试章节 + README 快速上手追加。详见 CLAUDE.md #45。

## [2026-04-21] review | v14.1 三份 review 合并

三份独立 AI 评审合并成 master：[REVIEW-v14.md](REVIEW-v14.md)。
- 源 1：Claude Opus 4.7 全仓补充（安全/测试/组织）
- 源 2：Codex 7 条硬 finding（build 已验证） → 归档到 `docs/raw/codex-full-repo-review-2026-04-21.md`
- 源 3：GPT-5 forklift-pickup-model review sections → 合并后源文档瘦身为纯领域文档

产出：F1-F27 findings + Week 1/2/3 行动路线。Codex 标注的 4 条 P0/P1 bug 已知待修（`aiDecomposeBtn` Y/Z swap、`removeAllReparentEventsForChild` 缓存失效、SelectionManager 材质泄漏、setSceneRoot 不 dispose）。

## [2026-04-22] milestone | #47 吸附姿态升级 + AI 维度兜底（消除 attach teleport）

症状：🚀 一键生成后播放到 t=attach 瞬间 cargo 下跳 ~0.3m。根因两个叠加 —— (1) AI 漏生门架升降 step（只输出前进）→ attach 时 fork z 还在零位 → snap 把 cargo 拽到 fork 高度；(2) center-to-center 吸附不符合"叉齿托底"物理直觉。

修复三层：
- 吸附语义：`fork_anchor_zero` 从 bbox center 改为 bbox 顶面中心；snap-attach desiredWorldPos 改为 `(center.x, max.y + cargoH/2, center.z)` —— cargo 底面贴叉齿顶面
- Prompt：L1/L2 门架升降公式加 `- cargo_height/2`；明确三维覆盖强制
- 前端兜底：新增 `ensurePkfCoversAttachPoint` —— 收到 L2 PKF 后按 x/y/z 目标位移查缺失 step，按 role 自动注入；找不到 role 关节则 warning

CLAUDE.md #47；单元测试 30/30 通过（`computeForkAnchorZero` case 期望从 center.y 改成 max.y）。
