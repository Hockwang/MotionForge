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

## [2026-04-22] milestone | mvp3 模板扩展到 17 段（加 x 横移对齐）

实机验证后用户反馈"叉车没有横移去取货"——__diagTpl.drawTrajectory 的轨迹表显示 fork.x 全程停在 0.277，cargo.x=5.000，x 方向 4.72m 差距从未缩小。

**根因**：原 14 段模板只驱动 `车体前进 + 门架升降`，完全没用横移轴。三向车有 `车体横移` / `叉齿侧移` 这第三个 role 但模板没接进来 → x 对不齐时 attach 被老 snap-attach 拽出瞬移。

**改动**：14 段 → 17 段（加 3 段 optional）：
- 段 1：横移对齐 cargo x（开头）
- 段 9：横移到 drop x（运输阶段）
- 段 17：返回 x=0（结尾）

optional 意味着场景无横移 role 时这 3 段编译期跳过，降级回 14 段（普通叉车行为不变）。横移 role 接受 `车体横移`（优先）或 `叉齿侧移`（fallback）两种同义命名。

**后端**：`/api/template-rhythm` prompt 同步 17 段描述 + 校验从 14 段改为 17 段。

**attach/detach 段号**：attach 从段 3 改到段 4，detach 从段 11 改到段 13（几何论证在文档 §5 同步更新）。

测试：80/80 通过（31 老 + 49 新，新增 17 段场景 + 三向车 x 对齐路径）。

## [2026-04-22] milestone | mvp3 autoDetectForkName 按 role 优先级识别叉齿

接 17 段扩展后实机验证，用户反馈"cargo 又到车体里面了"。诊断发现：
- `__mf.keyframeManager.getReparentEvents()` 指向 `_____10`，bbox = 5.3m 高（整个门架）
- 对比场景里 `_CS19110`（叉齿旋转 joint 的 childId）bbox = 1.2 × 0.55 × 1.6m，就是叉齿本体

autoDetectForkName 之前只认 `门架升降` role → bbox 包含整个门架 → fork_anchor_zero 取了门架中部坐标 → 车体横移到 "cargo.x - 门架中部.x" 时车身穿进 cargo。

修复：优先级链路改为
1. role 以 `"叉齿"` 开头（叉齿旋转/叉齿侧移/叉齿前伸 等）——最深、最具体
2. role === `"门架升降"`——兜底（普通叉车老行为）

实机验证：17 段轨迹全部正确，attach/detach 连续性 < 0.01m，cargo 从 cargo_pos 到 drop_pos 误差 < 0.01m。

commit `ee55716`。

## [2026-04-22] tooling | ⭐ 轨迹可视化诊断 __diagTpl.drawTrajectory 确立为首选调试工具

mvp3 三向车调试过程中发现 `__diagTpl.drawTrajectory` 极其有用：

**输出双通道**：
- 3D 视口：蓝线 (fork) + 橙线 (cargo) + 段边界小球 + attach/detach 大球
- Console：14/17 段文字表（joint / t_end / value_end / fork_xyz / cargo_xyz / dy）

**协作优势**：截图给人看，文字表直接贴给 AI → AI 根据数值立刻看出是哪段 x/y/z 不对齐、哪段 attach 后 cargo 是否跟随 fork。和单点快照比，效率高数倍。

已在以下位置标记首选：
- [CLAUDE.md §调试钩子](../CLAUDE.md) 加了⭐标注和使用说明
- [docs/diagnostics.md](diagnostics.md) 索引表 `⭐` 前缀 + 场景 8 顶部"首选"专栏
- [docs/concepts/forklift-pickup-template.md](concepts/forklift-pickup-template.md) 相关调试段落

后续协作约定：**任何 PKF / 模板动画的视觉问题，先跑 `__diagTpl.drawTrajectory()` 再沟通**。

当前状态：🚧 主线 mvp3 仍在迭代，有已知问题未解决，继续打磨。先推当前状态到 git。

## [2026-04-23] milestone | mvp3 收尾：REVIEW-v15 P0/P1 清完 + 文档全仓对齐

mvp3 密集迭代两周后做了一份 [REVIEW-v15.md](REVIEW-v15.md) 止损（16 条 finding F28-F43）。同日下午清完 P0 和所有 P1：

**代码修复**：
- **F28 P0**：轨迹 overlay 导出时会被烘焙进 GLB → 导出 handler 开头 `trajectoryOverlay?.clear()` + ResultPackageExporter 过滤 `userData.__isTrajectoryOverlay`/`__isDiagTrajectory`（两层防护）
- **F34**：`addPkfStep` 保留 `template_segment` / `template_segment_name`（之前静默丢）
- **F35**：`serializeState` / `restoreState` 纳入 `_pkfTemplateMeta`（避免 undo 后 snap-attach 被误激活）

**文档对齐**（F29-F33）：
- 代码注释 / 用户对话框 / AI prompt 7 处 `14 段` → `17 段（14 必选 + 3 可选横移）`
- README: mvp2 → mvp3，补 83 tests 里程碑
- bugfix-log: 补 #53（autoDetectForkName fork role）/ #54（export race）/ #55（_pkfTemplateMeta 序列化）/ #56（isV2 检测放宽）
- docs/index.md: 补 forklift-pickup-template / alignment 文档 / gotcha 008 / log.md 条目，更新脚本数 7→9
- CLAUDE.md: `__mf.trajectoryOverlay` 调试钩子登记，诊断脚本数 7→9，bug 编号 #52 → #56

**仍欠（P2 / 非必修）**：F36 TrajectoryOverlay 单测 + F37 main.js 拆分 + F38 alert→toast + F39 UUID 统一 + F40 diag 整理 + F41 CONTRIBUTING 加 feature-flag 模式 + F42 marker 拖动刷新。等下个大 feature 触发一起做。

83 单测通过。状态：mvp3 主线功能完整，可 merge `main` 打 `mvp3` tag。

## [2026-04-23] review | GPT 外部 review 回合：F1/F3/F4 已修 + F44 XSS 跟踪

[REVIEW-v15.md](REVIEW-v15.md) 合并后接 GPT 独立 review，交叉验证 4 条 finding 全部成立：

- **#57 F1 marker rename undo 散**（🔴 高）：captureHierarchySnapshot 没存 `obj.name`，rename 后 undo 导致 Three.js 对象名、marker metadata、reparent events 三者分裂 → reparent 播放按老名查对象静默失效。修：snapshot 加 `name` + undo 补 `snapshotOriginalParents`
- **#58 F4 PKF 参数 ID 未校验**（🟡 中）：`addPkfParameter` 只查空+重名，带正则元字符的 id 会让 `new RegExp(\\b${id}\\b)` 抛异常；带空格的 id 公式求值器识别不出来。修：`PKF_ID_VALID_RE` 白名单 + main.js try/catch + HTML5 `pattern` 属性 + 12 个新单测
- **F3 转换服务资源保护**（🟡 中）：v14 F3 只修了 AI 接口漏了 `/api/convert-to-glb`。修：multer 200MB limit + Blender 60s timeout + app.listen 绑 127.0.0.1 + convertRateLimit 10 次/分钟
- **F44 innerHTML XSS**（🟡 中）：20+ 处散布 DOM 注入面。本地工具风险低，**暂不修**，等做 toast 组件统一治理（和 F38 一起）

95 单测通过（83 + 12 新 F4/F35/F34）。commit 本次。

## [2026-04-23] decision | 状态机框架对齐：17 段模板保留，不重构

看到 mentor 的《固定资源状态动画》文档（状态拆分 + 姿态继承框架，覆盖升降机/RGV/转台/堆垛机/机械臂），初判我们的 17 段模板应该重构成 5 个原子状态（load/travelEmpty/travelLoaded/unload/idle）。

写了对齐文档 [docs/raw/alignment-state-animation-framework-2026-04-23.md](raw/alignment-state-animation-framework-2026-04-23.md) 准备过方案，和 mentor 当面对齐后结论反转：**不重构**。

**Mentor 判定**：17 段模板 = 状态机里 `load + travelLoaded + unload` 三个状态连起来的一个环节（不是与状态机并列的东西）。状态拆分 / idle 待命 / 多次搬运 / 充电巡检是**更上层**的调度职责，MotionForge 作为编辑器不管。

**职责分层**：
- 上层（仿真/调度）：任务队列、状态切换、`idle` / 多次 `load`（拆码垛）
- MotionForge：单次完整搬运环节的动画（当前 17 段）
- MotionForge 运行时：公式求值、关节驱动、attach/detach

**影响**：对外 PKF/ZIP 格式不变，继续打磨 17 段本身（几何精度、AI 节奏、UI 体验）。充电/巡检/拆码垛不作为 MotionForge 的产品需求处理。

commit `1223e62`（对齐文档）。
