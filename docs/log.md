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

## [2026-04-22] milestone | mvp2 合主：vitest 基建 + 承载锚点六轮迭代终结

`feature/vitest-infra` → `main`（PR #1，merge commit `d13e852`）。v14.1 以来累计 12 commit，分三块：

**测试基建 + 安全**（#45/#46/F3）：
- vitest ^4.1.5 + 31 个核心单元测试（`npm test` ~20ms）
- F11 restoreState 保留 role（DEBT #3）；F13 fork_anchor_zero hash-based 缓存自动失效
- CORS 白名单 + AI rate limit + express.json size limit

**AI 生成兜底**（#47 / #50b）：
- 🚀 一键生成：`ensurePkfCoversAttachPoint` 检查 L2 输出三维覆盖，按 role 自动补缺失 step
- Sanitize：AI 违规 `approach_gap=1` 强制归 0；正则清洗公式里凭空加的常数（如 `-0.1`）

**叉齿承载锚点六轮迭代**（#47 → #52，完整收录 CLAUDE.md）：
| # | 算法 | 结果 |
|---|---|---|
| #47 | bbox.max.y 顶面 | 合并 mesh 穿地 |
| #48 | 回退 center | cargo 陷 fork |
| #49 | y 改 min.y | z 对了 |
| #50 | forward-extreme 朝 cargo | 数学 bug + 时序 bug |
| #51 | 读 joint.origin | 破坏旋转支点 |
| **#52** | auto bbox 底面中心（= "子对象底部"按钮公式）| ✓ |

关键教训：**承载锚点 ≠ 关节原点**（URDF 旋转支点），两个概念解耦；**合并 mesh 下 bbox 不等于"叉齿几何"本身**，但对 demo 足够。

新 gotcha：[merged-mesh-bbox-trap](gotchas/007-merged-mesh-bbox-trap.md)。
tag：`mvp2` 分支保留里程碑状态。

## [2026-04-22] milestone | mvp3 叉车 14 段模板（Phase A + B 实现）

`feature/pickup-template` 分支。契约文档（[forklift-pickup-template.md](concepts/forklift-pickup-template.md)）审过后一次性落地前后端。

**设计动机**：六轮承载锚点迭代后，attach 基本正确但 AI 生成的 PKF 仍有几何精度问题（approach_gap 被偷偷改回 1、公式漏项、凭空加常数）。把"节奏"和"几何精度"从 AI 手里分开——前端持有行业标准 14 段模板 + 几何公式，AI 只出节奏和 easing。

**实现**：
- 新增 [src/core/ForkliftTemplate.js](../src/core/ForkliftTemplate.js)：`FORKLIFT_TEMPLATE` 14 段数据 + `collectTemplateContext` 场景扫描 + `compileTemplate` 编译器
- 新增 [tests/unit/forklift-template.test.js](../tests/unit/forklift-template.test.js)：32 个测试（几何对齐、参数注入、公式正确、value_start 级联）
- 新增后端 `/api/template-rhythm` 端点（[tools/conversion-service.js](../tools/conversion-service.js)）：简化 prompt，只出节奏；严格校验返回 14 段齐全
- [src/main.js](../src/main.js) 🚀 按钮路由：场景满足四要素（cargo + drop + 两 role + attach 事件）弹窗让用户选"模板 / 自由"；选模板则 AI 出节奏（失败降级默认匀速）→ 编译 → 应用
- [src/core/KeyframeManager.js](../src/core/KeyframeManager.js) `_pkfTemplateMeta` 模板标记；`applyReparentEventsAtTime` 模板路径禁用 snap-attach（靠 Three.js attach 原生保世界坐标）

**新增 4 个 PKF 参数**（复用 cargo_pos / drop_pos / fork_anchor_zero 不改命名）：
- `cargo_fork_height`（cargo 叉齿孔相对 cargo 底面的偏移，default 0）
- `safe_distance`（0.8m）
- `lift_clearance`（0.1m）
- `transport_height`（0.2m，叉齿承载面离地高度）

**契约保证**：输出 ZIP 格式不变，schema 不升版本。pkf.json 的 parameters 数组多 4 条，steps 从 ~5–10 涨到 ~14（严格串行），中台评估逻辑不用改。

测试：全部 63 个单元测试通过（31 老 + 32 新）。实机验证待用户🚀触发确认。
