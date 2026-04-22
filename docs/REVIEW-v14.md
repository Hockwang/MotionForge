---
tags: [review, audit, v14]
updated: 2026-04-21
---
# MotionForge v14.1 全仓深度 Review（合并版）

> 本文档合并了三份独立 AI 评审的结果，去重后按优先级重排，是 v14.1 的**唯一权威 review**。
>
> - **覆盖**：代码正确性、AI pipeline 分叉、资源泄漏、缓存语义、安全、测试、依赖、文档漂移
> - **不覆盖**：性能 profiling、a11y、i18n、移动端适配（见 [§7 省略话题](#7-本-review-省略的话题)）
> - **使用建议**：
>   - 想看"出啥问题" → [§3 Findings](#3-findings按优先级)
>   - 想知道"先做什么" → [§4 行动路线](#4-推荐行动顺序)
>   - 领域概念细节（mermaid 管线图 / 失效矩阵）→ [forklift-pickup-model.md](concepts/forklift-pickup-model.md)

**审阅元数据**
- 分支：`v14-ai-oneshot`，commit：`f005ef3`
- 数据源：Claude Opus 4.7（全仓补充） + Codex（7 条硬 finding，build 已验证） + GPT-5（forklift-pickup-model review sections）
- 三份源评审的合并映射见 [§8](#8-评审者备注)

---

## 1. TL;DR — 整体健康度

| 维度 | 评分 | 一句话 |
|---|---|---|
| 架构 | **B+** | FK / roundtrip / PKF / reparent / oneshot 职责清晰，`v14.1` 的 `fork_anchor_zero` 方向正确；`main.js` 2083 行是短板 |
| 代码质量 | **B** | 无 TODO/FIXME 说明规范严格；但同一概念**双实现**开始分叉（`aiDecomposeBtn` vs `collectSceneForAi`），局部缓存失效语义不统一 |
| 测试覆盖 | **C**（改善中）| 新增 vitest + 23 个核心单元测试（F4 ✅）；`tests/diag-*.js` 浏览器脚本仍保留作交互诊断。剩余空白：main.js/UI 路径 |
| 安全 | **C+** | 本地开发 OK；放公网**立刻有问题**（CORS 通配、无 rate limit、无认证、`express.json` 无 limit） |
| 依赖 | **B** | 量少版本较新；USDZLoader 已 deprecated 警告；three caret range 小版本可能破兼容 |
| 文档 | **A-** | CLAUDE.md + docs/ + ROADMAP 体系罕见完善；但**版本漂移**（README 仍写 v12+、诊断脚本数仍写 5 实际 7）开始误导维护者 |
| AI pipeline | **B** | 70% 领域模型 + 30% 启发式 + 10% 历史债务（详见 forklift-pickup-model.md） |
| 工程化 | **C** | 无 lint / format / CI / pre-commit hook；提交靠开发者自律 |

**结论**：**产品层面 v14.1 基本可交付**，**上公网前有 3 条安全红线必堵**，**发布前有 4 条一致性 bug 建议修**（见 [§4](#4-推荐行动顺序)）。

---

## 2. Scope & Inputs

### 本次 Review 的输入
- **代码**：`src/main.js` · `src/core/*` · `src/ui/EditorUI.js` · `src/style.css` · `index.html` · `src/counter.js`
- **后端/工具**：`tools/conversion-service.js` · `tools/convert_usd_to_glb.py` · `package.json`
- **测试**：`tests/diag-*.js` · `tests/test-pkf-p*.js`
- **文档**：`CLAUDE.md` · `FLOW.md` · `README.md` · `HOW-IT-WORKS.md` · `USER-GUIDE.md` · `DEBT.md` · `CHANGELOG.md` · `CONTRIBUTING.md` · `docs/**`
- **验证**：`npm run build` 通过（有 large bundle 警告，非失败）

### 未跑的东西
- 浏览器态 `tests/diag-*.js` 实跑
- 真实场景 oneshot/L1/L2 端到端
- Blender USD/FBX 转换链实测
- Profiler / Lighthouse / security scanner

### 仓库速描（commit f005ef3）
```
9 865 行 JS/CSS（src+tools+tests）
├── src/main.js              2083 行 ★ god file
├── src/ui/EditorUI.js       1419 行 ★ UI 单文件
├── src/core/KeyframeManager 1403 行   架构核心
├── src/style.css             723 行
├── tools/conversion-service  651 行   Node AI 代理
├── src/core/SceneManager     373 行
├── src/core/ResultPackage    248 行
├── src/core/SelectionMgr     125 行
└── src/core/AssetLoader      117 行

docs/ 22 个 markdown  |  CLAUDE.md 701 行（37 条 bug）  |  DEBT.md 189 行
tests/ 12 个纯 console 粘贴脚本
依赖：three ^0.183.2  vite ^8.0.1  express ^4.22.1  jszip ^3.10.1
```

---

## 3. Findings（按优先级）

命名约定：**F** = Finding，级别 `🔴 P0 必修` / `🟡 P1 建议修` / `🟢 P2 Nice-to-have`。

---

### 🔴 P0 — 必修

#### F1. ~~`aiDecomposeBtn` 坐标系未做 Y↔Z swap~~（Codex H1 + forklift R2）✅ 已修 @ 2026-04-21（CLAUDE.md #38）
- **位置**：[src/main.js:1264-1277](../src/main.js#L1264)
- **证据**：主路径 [`collectSceneForAi()` L1132-1140](../src/main.js#L1132) 已做 swap `{x, y: wp.z, z: wp.y}`；"🪄 仅拆解"按钮 handler 直接发 Three.js Y-up `{x, y: wp.y, z: wp.z}`
- **影响**：同一场景经"仅拆解"和"🚀 一键生成"送进 L1 得到**不同空间理解**，cargo/drop/marker 方位判断分叉。真实行为分叉，不只是文档问题
- **修复**：改用 `collectSceneForAi()` 统一路径，删除内联采集。见 CLAUDE.md #38

#### F2. ~~`removeAllReparentEventsForChild` 不失效 fork_anchor_zero 缓存~~（Codex H2）✅ 已修 @ 2026-04-21（CLAUDE.md #39A）
- **位置**：[src/core/KeyframeManager.js:301-305](../src/core/KeyframeManager.js#L301)
- **证据**：
  - 缓存失效定义：[:231-233](../src/core/KeyframeManager.js#L231)
  - `addReparentEvent` [:272-296](../src/core/KeyframeManager.js#L272) 和 `removeReparentEvent` 都 invalidate ✓
  - 但 `removeAllReparentEventsForChild` 只 filter，**不 invalidate**
  - 被 UI 直接调用：[src/main.js:437-442](../src/main.js#L437)（清某对象全部）、[:1894-1914](../src/main.js#L1894)（删 marker 时）
- **影响**：用户清完 attach/detach → PKF 预览继续读**过期 anchor** → 公式求值用错几何
- **修**：3 行改动 — `removeAllReparentEventsForChild` 里补 `this.invalidateForkAnchorZero()`

#### F3. ~~安全配置不适合公网~~（新发现）✅ 部分已修 @ 2026-04-21（CLAUDE.md #43）—— CORS 白名单 + rate limit + express.json limit 已做；**auth 层还没加**（生产部署前补）
- **S3a. CORS 通配**：[tools/conversion-service.js:23](../tools/conversion-service.js#L23) `app.use(cors())` → 任意站点能调 `/api/generate-pkf` → 免费刷 AI 额度
- **S3b. 无 rate limit**：连续点 🚀 可 3s 内发 3 次 AI 请求，后端无节流
- **S3c. 无认证**：只要知道端口 8091 就能消费
- **S3d. `express.json()` 无 size limit**：依赖默认 100kb，未来依赖升级改默认会静默变大
- **影响**：仅本地开发无风险。一旦 LAN/公网暴露就是信用卡漏油
- **修**：
  ```js
  app.use(cors({ origin: process.env.CORS_ALLOW || 'http://localhost:5173' }));
  app.use(express.json({ limit: '500kb' }));
  app.use(rateLimit({ windowMs: 60_000, max: 20 }));
  app.use(apiKeyMiddleware);  // 生产需要
  ```

#### F4. ~~零单元测试~~ ✅ 已修 @ 2026-04-21（CLAUDE.md #45）
- **现状**（原）：`tests/` 12 文件全是 console 粘贴脚本；`package.json` 无 `test` script；37 个已修 bug 无一个有回归测试
- **修复**：
  - 引入 `vitest ^4.1.5`
  - `npm test` / `npm run test:watch` 脚本
  - [vitest.config.js](../vitest.config.js)：node 环境，只跑 `tests/unit/**`
  - [tests/unit/keyframe-manager.test.js](../tests/unit/keyframe-manager.test.js) 23 test cases，5 个 describe block：
    1. `setJointDef` 环检测（bug #33）
    2. `buildDefaultParamValues` 注入（cargo size + fork_anchor_zero）
    3. `_interpolateJointValueAtTime` 关键帧插值
    4. `computeForkAnchorZero`（bug #36/#37，用真 THREE 构建最小 scene）
    5. `addReparentEvent` 排序 + 缓存失效（bug #39）
  - 运行时间 ~300ms，全部通过

---

### 🟡 P1 — 建议修（v14.1 正式 tag 前）

#### F5. ~~PKF 公式层 vs snap-attach 层参考点不一致~~（forklift R1）✅ 已修 @ 2026-04-21（CLAUDE.md #40）
- **位置**：[KeyframeManager.js:392](../src/core/KeyframeManager.js#L392)
- **证据**：
  - 公式层：`fork_anchor_zero = box.getCenter()` — bbox **中心**
  - snap-attach 层：`desiredWorldPos = (center.x, box.min.y + h/2, center.z)` — bbox **底部** + cargo.h/2
- **影响**：这两点差 `bbox_height/2 - cargo_h/2`。用户看到 t=attach 瞬间 cargo **垂直方向**有跳变（水平方向 approach_gap=0 能抵消，垂直不行）
- **修**：snap 层改为 `desiredWorldPos = center` 纯 bbox 中心 → 结构性零跳变

#### F6. ~~SelectionManager 材质状态污染 + 内存泄漏~~（Codex M4）✅ 已修 @ 2026-04-21（CLAUDE.md #42）
- **位置**：[src/core/SelectionManager.js:83-105](../src/core/SelectionManager.js#L83)
- **证据**：
  - `applyHighlight` 首次高亮 `clone()` 材质并 `emissiveIntensity = 0.55`
  - `originalMaterialState` **只存颜色不存 intensity**
  - `clearHighlight` 硬编码 `emissiveIntensity = 0.2`
  - clone material 和 `originalMaterialState` 记录**永不 dispose/delete**
- **影响**：
  - 任何自定义 emissive 强度材质被选一遍就永久改成 0.2
  - 长时间点选不同对象 → GPU 资源渐进泄漏
- **修**：
  1. 保存完整原始高亮状态（至少 `emissive` + `emissiveIntensity`）
  2. `clearHighlight` 或对象销毁时 `dispose()` clone material 并 `delete originalMaterialState.get(id)`

#### F7. ~~`setSceneRoot` 不 dispose 旧资源~~（Codex M5 + DEBT #1）✅ 已修 @ 2026-04-21（CLAUDE.md #41）
- **位置**：[src/core/SceneManager.js:178-185](../src/core/SceneManager.js#L178)
- **证据**：替换旧 root 时只 `scene.remove(this.sceneRoot)`，不递归 dispose geometry/material/texture
- **影响**：反复导入大 GLB/USD 时 GPU 内存线性涨
- **修**：见 DEBT.md #1 的代码示例，递归 dispose（~10 行）

#### F8. ~~Bulk delete marker 的 undo 语义碎片化~~（Codex M3）✅ 已修 @ 2026-04-21（CLAUDE.md #39B）
- **位置**：[src/main.js:1894-1934](../src/main.js#L1894)
- **证据**：`removeMarkerById` 内部 `pushUndoSnapshot()`；`removeAllMarkersBtn` 只是 `ids.forEach((id) => removeMarkerById(id))` → N 个 marker = N 次 undo snapshot
- **影响**：用户"清空所有 marker"一次动作，撤销要点 N 次
- **修**：`removeAllMarkersBtn` 先 `pushUndoSnapshot()` 一次，然后**传 `{ skipUndoSnapshot: true }` 给 `removeMarkerById`**

#### F9. ~~AI prompt few-shot 与 v14.1 语义自相矛盾~~（forklift P1）✅ 已修 @ 2026-04-21（CLAUDE.md #44）
- **位置**：
  - L2 few-shot 用旧语义：[conversion-service.js:213-240](../tools/conversion-service.js#L213) `pickup_point_x - safe_distance`（绝对坐标风格）
  - L1 示例 rows 用写死数值："车体前进到 cargo 前方 (y=4.5, 留 0.5m 前插间距)"（违反 L483-495 的"禁止具体数值"规则）
- **影响**：LLM 面对自相矛盾 system prompt，输出质量方差大
- **修**：
  - L2 few-shot 改成 v14.1 位移语义（`cargo_pos_x - fork_anchor_zero_x - approach_gap`）
  - L1 示例 rows 改成纯公式（`"y=cargo.y - fork_anchor_zero_y - approach_gap"`）
  - 把"⚠️ 关键语义"blocks 前置到 few-shot 之前（prompt engineering 共识）

#### F10. ~~文档版本漂移~~（Codex L7）✅ 部分已修 @ 2026-04-21（CLAUDE.md #44）—— README/FLOW/CLAUDE 版本号 + 脚本数已对齐；ResultPackageExporter comment/EditorUI 内 L2 提示后续清理
- **位置**：多处
  - [README.md:5](../README.md#L5) 写 `v12+`（实际 v14.1）
  - [docs/ROADMAP.md:6](ROADMAP.md) 写 `v12+`
  - [README.md:218](../README.md#L218) 写"5 个诊断脚本"（实际 7 个）
  - [CLAUDE.md:137](../CLAUDE.md#L137) 同样
  - [FLOW.md:11](../FLOW.md#L11) 同样
  - [src/ui/EditorUI.js:629](../src/ui/EditorUI.js#L629) 提示"L2 不要输出 reparent，用户手工加"——但 oneshot 已由前端自动应用
  - [src/core/ResultPackageExporter.js:139](../src/core/ResultPackageExporter.js#L139) `_comment` 把 `origin` 说成"世界空间"——实际是 parent-local/URDF
- **影响**：新接手的人在"代码 v14.1 但文档 v12+"状态下做错误推断
- **修**：一轮对齐（半小时）

#### F11. ~~Undo 覆盖 role 字段为空~~（DEBT #3）✅ 已修 @ 2026-04-22（CLAUDE.md #46）—— 防御性：snapshot 缺 role 字段时保留当前 role

---

### 🟢 P2 — Nice-to-have

#### F12. ~~`test-pkf-p4.js` 过时断言~~（Codex M6）✅ 已修 @ 2026-04-21（CLAUDE.md #44）—— 断言 `t=3 results.length === 1 && value === 100`（保末态语义）

#### F13. ~~Cache invalidation 时机不全~~（forklift 8-code-smell-4）✅ 已修 @ 2026-04-22（CLAUDE.md #46）—— `_computeForkAnchorInputsHash` 覆盖 reparent events + 叉齿子树 mesh uuids，自动失效

#### F14. ~~`_lastSceneRoot` 是 dead code~~（forklift 8-code-smell-2）✅ 已修 @ 2026-04-21（CLAUDE.md #44）

#### F15. ~~`_driftWarned` 永不复位~~（forklift 8-code-smell-6）✅ 已修 @ 2026-04-21（CLAUDE.md #44）—— `rebindJointBaseTransform` 里补 `delete def._driftWarned`

#### F16. ~~`new_parent_name` 没验证存在性~~（forklift 8-code-smell-3）✅ 已修 @ 2026-04-21（CLAUDE.md #44）—— 加校验 + skipped events 打 warning

#### F17. 资源使用与清理（DEBT #2 / R2 / R4）
合集：
- SelectionManager clone material 永不释放（见 F6，已升 P1）
- main.js window listener 无 cleanup（HMR 场景叠加 RAF）
- `requestAnimationFrame` 没 cancel（DEBT P2-4）

#### F18. ID 生成用 `Math.random + Date.now`（新发现）
5 处（`KeyframeManager.js:83, :276, :1061` · `main.js:785, :1221`）用 `Math.random().toString(36).slice(2, 8)`，约 36 亿分之一重复概率。session 内不会碰撞，但 `crypto.randomUUID()` 更规范。**修**：加 `src/utils/id.js` 统一。

#### F19. ~~`.env.example` 缺失~~ ✅ 已修 @ 2026-04-21

#### F20. ~~`docs/.obsidian/` 未进 gitignore~~ ✅ 已修 @ 2026-04-21（上个 commit）

#### F21. ~~`docs/WIKI-SETUP-PROMPT.md` 是临时文件~~ ✅ 已修 @ 2026-04-21 —— 移到 `docs/raw/wiki-setup-prompt.md`

#### F22. ~~AI prompt 硬编码 "前进 = prismatic y"~~（forklift P2）✅ 已修 @ 2026-04-21（CLAUDE.md #44）

#### F23. ~~role 列表没去重~~（forklift P2）✅ 已修 @ 2026-04-21（CLAUDE.md #44）

#### F24. main.js 是 god file（2083 行）
DEBT.md 架构坏味道已标。推荐切分：
```
src/main.js                ← 启动 + 事件绑定 (~300 行)
src/app/aiPipeline.js      ← 🚀 oneshot、L1/L2 (~500 行)
src/app/importExport.js    ← handleImportPackage + 导出 (~400 行)
src/app/playback.js        ← loop、updateTimeline (~200 行)
src/app/markerManager.js   ← marker + snapshotForkAnchorZero (~300 行)
src/app/undo.js            ← undoStack (~150 行)
```
等 AI 打关节方向定了一起做。

#### F25. 多 `alert()` 阻塞主线程
10+ 处见 grep。应改 toast。

#### F26. 依赖 caret range 过宽
`three: ^0.183.2` 等 caret 未来小版本可能破。建议 `package-lock.json` 保证 + 选择性 pin。

#### F27. USDZLoader 已 deprecated
Three.js r184 可能删。**修**：按 warning 提示换 API 或 pin three 版本。

---

## 4. 推荐行动顺序 + 执行状态

### ✅ 已完成（2026-04-21 两个 commit：cd56857、本次）
- F1 aiDecomposeBtn Y/Z swap（CLAUDE.md #38）
- F2 removeAllReparentEventsForChild 缓存失效（CLAUDE.md #39A）
- F3 CORS + rate limit + express.json size limit（CLAUDE.md #43）**部分完成** — auth 层还没加
- F5 anchor/snap 参考点统一（CLAUDE.md #40）
- F6 SelectionManager 材质/资源清理（CLAUDE.md #42）
- F7 setSceneRoot dispose（CLAUDE.md #41）
- F8 marker bulk delete undo 合并（CLAUDE.md #39B）
- F9 AI prompt few-shot 清理（CLAUDE.md #44）
- F10 文档版本漂移 **部分完成**（README/CLAUDE/FLOW），次要的 ResultPackageExporter comment/EditorUI L2 提示留待后续
- F12 test-pkf-p4.js 过时断言（CLAUDE.md #44）
- F14 _lastSceneRoot dead code（CLAUDE.md #44）
- F15 _driftWarned 复位（CLAUDE.md #44）
- F16 new_parent_name 验证（CLAUDE.md #44）
- F19 .env.example 新建
- F20 docs/.obsidian/ 入 gitignore
- F21 WIKI-SETUP-PROMPT 移 docs/raw/
- F22 AI prompt 去硬编码 axis（CLAUDE.md #44）
- F23 role 去重（CLAUDE.md #44）

### 🟡 仍未做（按优先级）
**P1（v14.2 前补完）**
- **F11** Undo 覆盖 role 字段（DEBT #3）— 需要 restoreState 里保守合并
- **F13** cache invalidation 补齐（hash-based 方案）

**P2（有真实触发再做）**
- **F17** 全局 listener cleanup / RAF cancel（HMR 累积场景）
- **F18** `crypto.randomUUID` 统一 id 生成
- **F24** main.js 拆分（2083 行 god file）
- **F25** alert() → toast
- **F26** 依赖 pin（three 版本锁）
- **F27** USDZLoader 迁移

### ✅ 已完成（feature/vitest-infra @ 本次）
- **F4** vitest 基建 + 23 个核心单元测试（5 个 describe × 23 case）

### 不在规划（等真需求触发）
- forklift R11/R12 多 anchor / approach_axis
- DEBT P2 全部
- TypeScript 迁移
- CI/CD

---

## 5. 红线（别碰的）

已经磨过很多 bug、稳定的核心，**重构前必须写回归测试**才能动：
- FK 求解器（`KeyframeManager.applyJointDrive`）— 29 个 bug 磨过
- 拓扑排序（Kahn's in `applyAllJointDrives`）
- roundtrip schema（v1→v6 演进稳）
- Undo/Redo 全量序列化（慢但正确）
- Three.js Y↔Z swap 分散（想整理要做 `src/utils/coordinate.js` 整体整理，不要局部补丁）

---

## 6. 跨文档地图

```
CLAUDE.md（37 bug + 架构约束）
  ↓ 详细化
docs/gotchas/ (6)    docs/decisions/ (7)
  ↓ 聚合
docs/architecture/ (4)
  ↓ 领域模型
docs/concepts/ (4)
  └── forklift-pickup-model.md  ← AI pickup 专项（领域 + 管线图 + 失效矩阵）
docs/schema/v4.md
docs/ROADMAP.md
DEBT.md               ← P0/P1/P2 技术债 + 架构坏味道
docs/REVIEW-v14.md    ← 本文档（master review）
docs/raw/             ← 历史归档
  └── codex-full-repo-review-2026-04-21.md  ← Codex 原版 review
```

### 空缺文档（建议后续补）
- `docs/schema/v6.md` — 当前 schema v6 只在 ResultPackageExporter.js 注释里
- `docs/architecture/security.md` — F3 + 生产部署章节
- `docs/architecture/testing.md` — F4 + 测试计划

---

## 7. 本 review 省略的话题

- **性能 profiling** — 大场景表现未知（DEBT P2-1 占位符）
- **可访问性 (a11y)** — DevTools 的 accessibility 面板未看
- **国际化 (i18n)** — 所有 UI 文案硬编码中文
- **移动端适配** — `style.css` 没看到 `@media` 断点
- **浏览器兼容性** — 依赖现代 Chromium（`crypto.randomUUID`、`?.`、`??=`）

这些**本次不值得做**。记录在案，真需要时 triage。

---

## 8. 评审者备注

- **三份源审阅的贡献**：
  - Codex 的 7 条 finding 全部进入本文档（F1 F2 F6 F7 F8 F10 F12）— 特色是证据精确到 line
  - forklift-pickup-model 的 review sections（R1-R12 + 8 code smell + 5 prompt issue）合并进 F5 F9 F13 F14 F15 F16 F22 F23
  - Claude Opus 4.7 贡献的 §1 scorecard / §2 scope / §3 security+dep+tests+org / §7 省略话题
- **领域内容**保留在 [forklift-pickup-model.md](concepts/forklift-pickup-model.md)（mermaid 图 / 域假设清单 / 失效矩阵 / cache 生命周期 / 诊断盲区）。本文档只保留**评审性**内容
- **下次 review 时机**：v14.1 正式 tag 后，或接入第二个真实叉车模型前
