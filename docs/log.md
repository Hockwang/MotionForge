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

## [2026-04-21] review | v14.1 三份 review 合并

三份独立 AI 评审合并成 master：[REVIEW-v14.md](REVIEW-v14.md)。
- 源 1：Claude Opus 4.7 全仓补充（安全/测试/组织）
- 源 2：Codex 7 条硬 finding（build 已验证） → 归档到 `docs/raw/codex-full-repo-review-2026-04-21.md`
- 源 3：GPT-5 forklift-pickup-model review sections → 合并后源文档瘦身为纯领域文档

产出：F1-F27 findings + Week 1/2/3 行动路线。Codex 标注的 4 条 P0/P1 bug 已知待修（`aiDecomposeBtn` Y/Z swap、`removeAllReparentEventsForChild` 缓存失效、SelectionManager 材质泄漏、setSceneRoot 不 dispose）。
