---
tags: [review, audit, v15, mvp3]
updated: 2026-04-23
---
# MotionForge mvp3 全仓 Review（v14 → v15）

> **⚠️ 更新 2026-04-23（同日下午）**：首版写完后**当天完成 mvp3 收尾 checklist 中的文档/代码必修项**。
> - P0 **F28** 已修（commit TBD，导出前 clear + exporter 过滤 userData 兜底）
> - P1 **F29 / F30 / F31 / F32 / F33 / F34 / F35** 全部已修
> - 剩余 P2 仍未做（F37 main.js 拆分、F38 alert→toast、F39 UUID、F40 diag 整理、F41 flag 模式写进 CONTRIBUTING、F42 marker 拖动刷新）+ F36 TrajectoryOverlay 单测仍待补
> - 下面正文是首版写作时的快照，具体哪条已修以本框为准

> **目的**：v14.1 合并后两周，mvp3 主线（17 段模板 + AI 节奏 + 状态机对齐 + 轨迹 overlay）密集迭代完成。这份 review 给这段工作一个止损点：盘点成绩、列出新欠账、标出仍未兑现的 v14 遗留项。
>
> - **审阅元数据**：分支 `feature/pickup-template`，commit `5eddebe`
> - **数据源**：Claude Opus 4.7 单评审者（区别于 v14 的三源合并）
> - **不覆盖**：性能 profiling、a11y、i18n、移动端、端到端 oneshot 端到端实测（本地未跑完整叉车模型）
> - **使用建议**：
>   - 想看"哪些要马上修" → [§3 P0/P1 Findings](#3-findings按优先级)
>   - 想知道"mvp3 干了什么" → [§2 变更摘要](#2-v14--v15-变更摘要)
>   - 找 v14 finding 的最新状态 → [§6 v14 遗留跟踪](#6-v14-遗留跟踪)

---

## 1. TL;DR — 整体健康度

| 维度 | v14.1 评分 | v15 评分 | 变化 | 一句话 |
|---|---|---|---|---|
| 架构 | B+ | B+ | = | 17 段模板 + 状态机对齐已定位"MotionForge 只做单个搬运环节"，路线清晰；`main.js` 从 2083 → **2440** 行越发拖后腿 |
| 代码质量 | B | B- | ↓ | 17 段模板是高质量设计（几何锁死、AI 只出节奏），但 mvp3 期间**文档/代码注释/用户对话框多处仍说"14 段"**，新功能字段被 `addPkfStep` 静默丢弃 |
| 测试覆盖 | C | B- | ↑ | 31 → **83** 单元测试（ForkliftTemplate 52 个新测试）；TrajectoryOverlay 无测试；依赖老"诊断脚本"的集成点无覆盖 |
| 安全 | C+ | C+ | = | 无新风险；v14 提到的 auth 层仍未加 |
| 依赖 | B | B | = | 无变化 |
| 文档 | A- | **B** | ↓ | mvp3 密集迭代期间**未按 CLAUDE.md 约定追加 bugfix-log 条目**（最近 4 个 fix commit 没写 #53+）；README/CLAUDE/ForkliftTemplate 多处还说"14 段"；`docs/index.md` 漏 forklift-pickup-template / alignment 文档 / gotcha 008 |
| AI pipeline | B | **A-** | ↑ | 17 段模板大幅收紧 AI 表面积（只出节奏），几何精度从 "prompt 管" 升级到"前端公式锁死"，精度暴涨 |
| 工程化 | C | C | = | 无变化 |

**结论**：
- ✅ **产品层面**：mvp3 核心价值（精度暴涨、AI 解耦）已兑现；叉车取放动画流程稳定。
- ⚠️ **工程层面**：mvp3 密集迭代欠了一笔**文档整理债**——需要 30–60 分钟一轮批量对齐。
- 🔴 **一个潜在 P0**：轨迹 overlay 开启状态下导出 ZIP，overlay group 会被烘焙进 model.glb（未验证，但按代码路径推断成立）。

---

## 2. v14 → v15 变更摘要

### 新增 / 毕业
- **`src/core/ForkliftTemplate.js`**（393 行新模块）：17 段模板（14 必选 + 3 optional 横移）+ 几何公式 + `autoDetectForkName` + `collectTemplateContext` + `compileTemplate`
- **`src/core/TrajectoryOverlay.js`**（237 行新模块）：从 `tests/diag-template.js` 的 `drawTrajectory` 毕业；时间轴右侧 toggle；PKF/参数/marker 变动时 microtask 合并刷新
- **`tests/unit/forklift-template.test.js`**（52 个新单元测试，6 个 describe block）
- **后端 `/api/template-rhythm`**（~170 行）：AI 只出 17 段节奏 JSON（duration + easing），严格校验
- **`tests/diag-template.js`** 扩展：`postImportCheck` / `drawTrajectory` 支持导入后场景降级

### 修复（未进 bugfix-log.md，应追加 #53–#56）
- `ee55716` fix(mvp3)：`autoDetectForkName` 优先 `叉齿*` role，避免合并 mesh 下取到门架 bbox（用户反馈"cargo 到车体里面"）
- `4cb90e7` fix(export)：导出前暂停播放 + `currentTime = 0`，防 GLB 烘焙 racy scene graph（cargo 变巨大）
- `95f4c65` fix(import)：序列化 `_pkfTemplateMeta` 到 `pkf.json`，修复导入后 attach 瞬移
- `41f914c` fix(import)：`isV2` 检测放宽（允许空 keyframes 但有 duration / reparent_events 的 PKF-only clip）

### 决策 / 文档
- **[docs/raw/alignment-state-animation-framework-2026-04-23.md](raw/alignment-state-animation-framework-2026-04-23.md)**：和 mentor 对齐"17 段模板保留，不重构为 5 状态"。状态拆分是上层调度职责，MotionForge 不管。
- **[docs/gotchas/008-trajectory-overlay-as-suspect.md](gotchas/008-trajectory-overlay-as-suspect.md)**：轨迹 overlay 功能的关停/删除指南（feature flag + grep tag）
- **[docs/log.md](log.md)** 新增 4 个 milestone/decision 条目

### Lines changed
```
main.js           2083 → 2440 (+357)  god file 继续恶化
EditorUI.js       1419 → 1426 (+7)
KeyframeManager   1403 → 1471 (+68)   _pkfTemplateMeta、snap-attach 模板旁路
conversion-svc     651 → 868 (+217)  /api/template-rhythm 新端点
新增 ForkliftTemplate.js  0 → 393
新增 TrajectoryOverlay.js 0 → 237
新增 forklift-template.test.js 0 → 611
```

---

## 3. Findings（按优先级）

命名约定：**F** = Finding，级别 `🔴 P0 必修` / `🟡 P1 建议修` / `🟢 P2 Nice-to-have`。

---

### 🔴 P0 — 必修

#### F28. 轨迹 overlay 开启状态下导出 ZIP 会把 overlay 烘焙进 GLB

**位置**：[src/main.js:2323-2405](../src/main.js#L2323)（`ui.exportPackageBtn` handler）+ [src/core/ResultPackageExporter.js:35-37](../src/core/ResultPackageExporter.js#L35)

**证据**：
- 导出过滤逻辑：
  ```js
  const exportTargets = (sceneRoot.children || []).filter(
    (c) => !c.isLight && !c.isCamera && !c.type?.includes('Helper'),
  );
  ```
- 轨迹 overlay 是 `THREE.Group`，`type === 'Group'`，不是 Light / Camera / Helper → **通过过滤**
- 导出 handler 做了：停播放 + 归零 + 清选中 + reparent 回 t=0 + 关节归零；**没有** `trajectoryOverlay?.clear()`

**影响**：用户勾选 🎨 轨迹按钮后导出 ZIP，轨迹的 Line + Sphere 对象被 GLTFExporter 序列化进 model.glb。导入时这些假几何和动画轨迹会出现在场景里，污染用户作品。

**复现**：
1. 加载叉车场景 → 🚀 生成 17 段
2. 勾选"🎨 轨迹"（见蓝/橙线）
3. 点"导出结果包 ZIP"
4. 导入同一 ZIP → 场景里多了蓝橙线条和小球

**修**：导出 handler 在 try 开头加一行：
```js
trajectoryOverlay?.clear();
```
finally 块可选再 `trajectoryOverlay?.requestRefresh()` 恢复。2 行改动。

**或者**：在 `serializeSceneToGlb` 过滤条件加 `!c.userData?.__isTrajectoryOverlay`（也要过滤 `__diagTpl_trajectory`，即 `__isDiagTrajectory`）。更防御性，覆盖用户手动跑 `__diagTpl.drawTrajectory()` 的情况。

**推荐**：两条都做（export handler 清 + 过滤兜底）。

---

### 🟡 P1 — 建议修（合并前清掉）

#### F29. 文档 / 代码 / UI 对话框 "14 段" vs "17 段" 漂移

**影响面大**：用户每次点 🚀 都看到 "14 段" 对话框，AI prompt 的 fallback 消息也说 "14 段"，编译器源码注释和 JSDoc 还是 "14 段"。

**位置**（共 ~22 处）：

**用户可见 / AI 可见**（优先）：
- [src/main.js:1575](../src/main.js#L1575) `'确定 = 用【叉车取放 14 段模板】（结构性零瞬移，AI 只管节奏）'` — 每次 🚀 弹窗展示
- [tools/conversion-service.js:559](../tools/conversion-service.js#L559) `'请按 system prompt 里的 14 段语义'` — AI fallback 提示
- [tools/conversion-service.js:560](../tools/conversion-service.js#L560) `请返回 14 段的节奏 JSON` — user message 给 AI（system prompt 已是 17 段，与此自相矛盾）

**代码注释 / JSDoc**：
- [src/main.js:1455](../src/main.js#L1455) `叉车取放 14 段模板路径（mvp3 / Phase A+B）`
- [src/core/ForkliftTemplate.js:2](../src/core/ForkliftTemplate.js#L2) `叉车取放 14 段模板编译器（Phase A / B）`
- [src/core/ForkliftTemplate.js:123](../src/core/ForkliftTemplate.js#L123) `默认节奏：14 段均分 12 秒`
- [src/core/ForkliftTemplate.js:281](../src/core/ForkliftTemplate.js#L281) `把 14 段模板编译成标准 PKF`
- [src/core/ForkliftTemplate.js:367](../src/core/ForkliftTemplate.js#L367) `§4.4 attach 在段 3 末尾，detach 在段 11 末尾` — **不只是 14/17 漂移，attach/detach 段号也错**（应 4 / 13）
- [tools/conversion-service.js:463](../tools/conversion-service.js#L463) `前端已用"叉车取放 14 段模板"生成几何结构`

**文档（用户看）**：
- [docs/concepts/forklift-pickup-template.md:8,28,157,293,300,339,369,397,425](concepts/forklift-pickup-template.md) 多处"14 段"需改成"17 段（含 3 段可选）"或按上下文改
- [docs/diagnostics.md:26](diagnostics.md#L26) 目录项"叉车 14 段模板路径验证"
- [CHANGELOG.md:93](../CHANGELOG.md#L93) `5 个浏览器 Console 脚本` 实际 9 个
- [DEBT.md:144](../DEBT.md#L144) `5 个 console 诊断脚本` 实际 9 个

**历史引用（不该改）**：
- docs/log.md 里的 milestone 条目（2026-04-22 14 段、2026-04-22 → 17 段扩展）—— 这些是**历史时间线**，必须保留 14 段的字样记录决策过程
- ForkliftTemplate.js 里"历史：原 14 段..." 的注释 —— 讲历史，保留
- `降级为 14 段` / `无横移时降级 14 段` 的表述 —— **功能描述**（optional segs 跳过后确实就是 14 段运行），保留

**修**：一轮对齐，30 分钟（改语义引用但保留历史引用）。清单比较机械，可以 grep 批量处理。

---

#### F30. `README.md` 版本号仍是 mvp2

**位置**：[README.md:5](../README.md#L5)

**当前**：`**当前版本**：mvp2（2026-04-22，52 条 bug 已修，AI 一键生成 + 承载锚点自动对齐 + vitest 基建）`

**应改**：`**当前版本**：mvp3（2026-04-23，52 条 bug 已修 + 17 段叉车模板 + AI 节奏 + 状态机对齐 + 轨迹可视化 + vitest 基建 83 tests）`

类似 v14 的 F10（版本漂移）—— 同一个问题换个版本号又犯了。根因：**迭代过快，README/CHANGELOG 没有在 PR checklist 里强制更新**。

---

#### F31. `docs/bugfix-log.md` 落后，4 个 fix commit 未追加

**位置**：[docs/bugfix-log.md](bugfix-log.md) 最新是 `#52`（bbox 底面中心）。此后有 4 个 fix commit 未进 log：

| commit | 建议编号 | 标题 |
|---|---|---|
| `ee55716` | #53 | `autoDetectForkName` 优先"叉齿\*" role（修 cargo 穿车体） |
| `4cb90e7` | #54 | 导出前暂停播放 + 重置时间轴（修 cargo 变巨大） |
| `95f4c65` | #55 | 序列化 `_pkfTemplateMeta` 修导入后 attach 瞬移 |
| `41f914c` | #56 | `isV2` 检测放宽，修 PKF-only clip 导入 duration/reparent_events 丢失 |

**原因**：CLAUDE.md 协作规则 §1 明确"**修 bug 必须追加 bugfix-log.md 条目**"，mvp3 密集迭代期间有所松动。

**影响**：未来接手者从 bugfix-log 找不到这些 fix 的根因 → 再次踩坑时没有参考。

**修**：补 4 条 bugfix-log 条目（30 分钟）。内容在 commit message 和对应 session 里都有，复制整理即可。

---

#### F32. `docs/index.md` 漏 mvp3 产出的关键文档

**位置**：[docs/index.md](index.md)

**漏项**：
- [docs/concepts/forklift-pickup-template.md](concepts/forklift-pickup-template.md) —— mvp3 最重要的设计契约文档
- [docs/raw/alignment-state-animation-framework-2026-04-23.md](raw/alignment-state-animation-framework-2026-04-23.md) —— 和 mentor 的对齐文档
- [docs/gotchas/008-trajectory-overlay-as-suspect.md](gotchas/008-trajectory-overlay-as-suspect.md) —— 今天刚加
- [docs/log.md](log.md) —— 决策时间线（在 index.md 最下方但未标重要性）
- [DEBT.md](../DEBT.md) —— 技术债

**index.md line 63 也过时**：`诊断脚本完整指南 7 脚本 + 7 场景` 实际 9 脚本（`ls tests/diag-*.js | wc -l = 9`）

**修**：一轮对齐（15 分钟）。

---

#### F33. `CLAUDE.md` 调试钩子章节漏 `__mf.trajectoryOverlay`

**位置**：[CLAUDE.md:130-138](../CLAUDE.md#L130)

**当前**：
```
__mf.lastTemplate       // 🚀 模板路径最后一次的 {intent, rhythm, compiled}（mvp3）
```
之后就结束了。

**应加**：
```
__mf.trajectoryOverlay  // 🎨 轨迹可视化（可 .refresh() / .setEnabled(bool) / inspect .group）
```

**影响**：新 session 不知道有这个钩子，用不上。

---

#### F34. `addPkfStep` 静默丢弃 `template_segment` / `template_segment_name` 字段

**位置**：[src/core/KeyframeManager.js:1115-1128](../src/core/KeyframeManager.js#L1115)

**证据**：
- `compileTemplate` 给每个 step 打 `template_segment` + `template_segment_name` 标签（[ForkliftTemplate.js:362-363](../src/core/ForkliftTemplate.js#L362)）
- `applyCompiledTemplate` 调 `addPkfStep({ ..., template_segment: s.template_segment, template_segment_name: s.template_segment_name })`（[main.js:1507-1508](../src/main.js#L1507)）
- 但 `addPkfStep` 只构建固定 9 字段的 `created` 对象，多余字段被丢

**影响**：
- 轨迹 overlay 读 `s.template_segment ?? idx0 + 1` → 永远走兜底 `idx0 + 1`
- 当场景无横移 role（optional segs 1/9/17 被跳过）时，实际 segs 是 `[2,3,4,5,6,7,8,10,11,12,13,14,15,16]`，overlay 渲染出来却是 `[1,2,...,14]`
- 用户看段号和文档/诊断脚本对不上
- 同样问题：PKF UI 无法显示段名称（即使 applyCompiledTemplate 传了）

**修**：两选一：
1. `addPkfStep` 里加 `template_segment: step?.template_segment ?? null, template_segment_name: step?.template_segment_name ?? null`（保真）
2. 或让 applyCompiledTemplate 不传这两字段，覆盖 `pkfSteps` 数组时直接赋值（绕过 addPkfStep）

推荐 1（保真 + 保持 addPkfStep 作为单一入口）。

---

#### F35. `_pkfTemplateMeta` 不进 undo 快照，undo 语义不一致

**位置**：[src/core/KeyframeManager.js:1174](../src/core/KeyframeManager.js#L1174)（`serializeState`）+ [:1222](../src/core/KeyframeManager.js#L1222)（`restoreState`）

**证据**：
- `_pkfTemplateMeta` 是模板路径的关键 runtime 状态（决定是否禁用 snap-attach）
- `serializeState` 列出了 currentTime / jointDefinitions / globalClips / pkfParameters / pkfSteps / sceneMarkers —— **没有 \_pkfTemplateMeta**
- `restoreState` 同样不恢复此字段

**影响**：
- 用户 🚀 模板路径 → `_pkfTemplateMeta = {...}` → `pushUndoSnapshot`（保存但不含此字段） → 改点东西 → Ctrl+Z
- restoreState 只改 pkfSteps/pkfParameters，**不改 \_pkfTemplateMeta**
- 于是 pkfSteps 恢复到"前一版模板"但 \_pkfTemplateMeta 还是当前值 —— 通常还对得上
- 但如果用户"🚀 模板 → 清空 PKF → Ctrl+Z" → pkfSteps 回到模板态，但 `_pkfTemplateMeta = null` 从清空后也没变 → **模板态 PKF + null meta = snap-attach 被重新激活 → attach 时被强拽**

**修**：`serializeState` + `restoreState` 加 `_pkfTemplateMeta`（深拷贝，5 行改动）。

---

#### F36. 轨迹 overlay 无单元测试

**位置**：[src/core/TrajectoryOverlay.js](../src/core/TrajectoryOverlay.js)（237 行）+ [tests/unit/](../tests/unit/)

**证据**：
```bash
$ grep -l TrajectoryOverlay tests/
(空)
```

**影响**：新模块，无测试覆盖。复杂逻辑包括：
- `refresh()` 的 try/finally 状态复原
- `requestRefresh()` microtask 合并
- `setEnabled()` 边界（true/false/重复调用）
- `clear()` 的 dispose 链路
- PKF 空场景 / reparent 空 / cargo/fork 找不到的降级路径

**修**：写 5–8 个测试覆盖上述路径（1–2 小时）。可以在 node 环境用假 THREE scene（tests/unit/keyframe-manager.test.js 已有真 THREE scene 构造示例）。

---

### 🟢 P2 — Nice-to-have

#### F37. `main.js` 越发臃肿（2083 → 2440 行，+357）

v14 的 F24 已标。mvp3 迭代又加了：
- 模板路径（~150 行 @ L1454-1638）
- 导出前暂停/归零（~80 行 @ L2332-2404）
- 轨迹 overlay 接线（~30 行散落）
- Import 修复逻辑 (~50 行 @ L770-830)

不是紧急问题，但每次新功能都在 main.js 加 100+ 行。**建议下个大 feature 前先拆一版**。最容易剥离的块：

```
src/app/oneshotPipeline.js   ← 🚀 oneshot（模板 + L1/L2）~500 行
src/app/importExport.js      ← handleImportPackage + exportPackageBtn ~500 行
src/app/undo.js              ← undoStack ~150 行
```

等 AI 打关节方向定了一起做（和 v14 F24 说法一致）。

---

#### F38. `alert()` 数量从 10+ 增至 17

v14 F25 已标，mvp3 又新增几个。合并成 toast 组件时一起改。

---

#### F39. Math.random id 生成仍 3 处（v14 F18 未做）

[src/main.js:818, :1367](../src/main.js#L818) + [src/core/KeyframeManager.js:1117](../src/core/KeyframeManager.js#L1117)

仍在等 `src/utils/id.js` 的统一抽取。

---

#### F40. `tests/diag-*.js` 数量膨胀到 9 个，有冗余嫌疑

```
diag-animation.js
diag-export-roundtrip.js
diag-fork-anchor.js
diag-joint-integrity.js
diag-joint-state.js
diag-oneshot.js
diag-roundtrip-transform.js
diag-template.js     ← 845 行，功能最多（drawTrajectory 已毕业到 UI）
diag-zero-pose.js
```

`diag-template.drawTrajectory()` 的可视化功能已经在 UI（轨迹 toggle）里有，Console 脚本是否仍需要？
- **保留理由**：UI 按钮只画当前 PKF 的轨迹，Console 脚本有 6 个其他检测（`reparentTiming` / `cascadeCheck` / `formulas` / `loopBoundary` / `playbackSample` / `postImportCheck`），都没毕业
- **删除理由**：两套代码重复维护风险

建议保留 Console 脚本，但在 `docs/diagnostics.md` 里说清两者关系（哪个用于什么）。

---

#### F41. 轨迹 overlay 的 feature flag 机制是良性先例，建议**系统化**

[docs/gotchas/008-trajectory-overlay-as-suspect.md](gotchas/008-trajectory-overlay-as-suspect.md) 记录的 "feature flag 顶部 + grep tag 注释" 双保险模式是**对新跨模块 feature 的清晰止损机制**。

建议把这个模式写进 CONTRIBUTING.md：
- 跨 3+ 文件的新 feature 上线时，考虑加关停 flag + grep tag
- 单文件 feature 不需要

这样未来新功能（比如下次做充电模板 / IK 机械臂）有成熟模式可复用。

---

#### F42. 轨迹 overlay 没处理 marker 拖动事件

[src/core/TrajectoryOverlay.js](../src/core/TrajectoryOverlay.js) 自动刷新在 `refreshPkfParamsUI` / `refreshPkfStepsUI` / `refreshReparentEventList` / `refreshMarkerList` 里埋点，但 **marker gizmo 拖动**（主视口里直接拖 cargo marker）不经过 `refreshMarkerList` → 轨迹 overlay 不刷新。

用户体验：拖 cargo 后轨迹不更新。**临时 workaround**：取消/重新勾选开关。

**修**：SceneManager 的 gizmo onDragEnd 加 `trajectoryOverlay?.requestRefresh()`（需要暴露引用或通过事件机制）。

---

#### F43. 轨迹 overlay `samples = 200` 对 17 段可能过密

[src/core/TrajectoryOverlay.js:37](../src/core/TrajectoryOverlay.js#L37) 默认 200 采样。17 段场景下每段 ~12 点，视觉够用。但对复杂场景（多关节 + 慢机器）刷新有感。

**修**：暂不改。需要时参数化暴露给用户（"低/中/高"三档）。

---

## 4. 推荐行动顺序

### 🔴 立即（合并 feature/pickup-template 到 main 前）
- **F28** 轨迹 overlay 被烘焙进 GLB（2 行 + 过滤兜底）
- **F35** `_pkfTemplateMeta` 进 undo 快照（5 行）

### 🟡 mvp3 tag 前
- **F29** "14 段" → "17 段" 文档/代码 grep 对齐（30 min，机械）
- **F30** README.md 版本号 mvp2 → mvp3
- **F31** 补 bugfix-log #53–#56（30 min）
- **F32** docs/index.md 补漏（15 min）
- **F33** CLAUDE.md 加 `__mf.trajectoryOverlay` 钩子（1 行）
- **F34** addPkfStep 保 template_segment 字段（3 行）
- **F36** TrajectoryOverlay 单元测试（1-2 小时）

### 🟢 不急（下个 feature 前再一起）
- F37 main.js 拆分
- F38 alert → toast
- F39 统一 id 生成
- F40 diag 脚本整理
- F41 feature flag 模式写进 CONTRIBUTING.md
- F42 marker 拖动刷新

---

## 5. 红线（别碰的）

延续 v14.1 原则：

- FK 求解器（`KeyframeManager.applyJointDrive`）—— 29+ bug 磨过，现在很稳
- 拓扑排序（Kahn's in `applyAllJointDrives`）
- roundtrip schema v6（已趋稳，不要随意升 v7）
- Undo 全量序列化（慢但正确，只加新字段不改结构）
- **新增红线：17 段模板的几何公式**（src/core/ForkliftTemplate.js FORKLIFT_TEMPLATE 常量）—— 已经写进 52 bug 的经验教训，改公式必须同步改单测和 forklift-pickup-template.md
- **新增红线：`applyReparentEventsAtTime` 的模板路径分流逻辑**（L431-450）—— 两种路径（模板/自由）的切换已经被 #54 bug 教育过

---

## 6. v14 遗留跟踪（F1–F27 状态更新）

| v14 Finding | v14 状态 | v15 状态 | 备注 |
|---|---|---|---|
| F1 aiDecomposeBtn Y/Z swap | ✅ | ✅ | 稳 |
| F2 缓存失效 | ✅ | ✅ | 稳 |
| F3 公网安全 | 部分 | 部分 | auth 仍未加；未上公网则 OK |
| F4 vitest 基建 | ✅ | ✅↑ | 31 → 83 测试 |
| F5 anchor/snap 参考点 | ✅ | ✅ | 稳 |
| F6 SelectionManager 材质 | ✅ | ✅ | 稳 |
| F7 setSceneRoot dispose | ✅ | ✅ | 稳 |
| F8 marker bulk delete undo | ✅ | ✅ | 稳 |
| F9 AI prompt few-shot | ✅ | ✅ | mvp3 新 /api/template-rhythm 继承良好 prompt 风格 |
| F10 文档版本漂移 | 部分 | **恶化** | 又漂移一次（mvp2/14 段 / 诊断脚本数）—— 见 F29-F32 |
| F11 Undo 覆盖 role | ✅ | ✅ | 稳 |
| F12 test-pkf-p4 断言 | ✅ | ✅ | 稳 |
| F13 cache hash 失效 | ✅ | ✅ | 稳 |
| F14 \_lastSceneRoot dead code | ✅ | ✅ | 稳 |
| F15 \_driftWarned 复位 | ✅ | ✅ | 稳 |
| F16 new_parent_name 验证 | ✅ | ✅ | 稳 |
| F17 listener cleanup / RAF cancel | 未做 | 未做 | 无 HMR 问题报告，继续观察 |
| F18 crypto.randomUUID 统一 | 未做 | 未做 | 见 F39 |
| F19 .env.example | ✅ | ✅ | 稳 |
| F20 .obsidian gitignore | ✅ | ✅ | 稳 |
| F21 WIKI-SETUP-PROMPT 移位 | ✅ | ✅ | 稳 |
| F22 AI prompt 硬编码轴 | ✅ | ✅ | 稳 |
| F23 role 去重 | ✅ | ✅ | 稳 |
| F24 main.js god file | 未做 | **恶化** | 2083 → 2440 行，+357 |
| F25 alert → toast | 未做 | **恶化** | 10+ → 17 次 |
| F26 依赖 pin | 未做 | 未做 | 无破坏性升级报告 |
| F27 USDZLoader deprecated | 未做 | 未做 | warning 仍在 |

**小结**：v14 的 "稳定稳" 部分继续稳定；**"持续欠账"项（F10 文档漂移、F24 god file、F25 alert）在 mvp3 密集迭代期间进一步恶化**。不致命，但是拖得越久债越大。

---

## 7. 未跑 / 省略

- 未跑：浏览器态端到端测试（叉车模型 → 🚀 → 播放 → 导出 → 导入）；本次 review 基于代码 + 文档 + 测试静态分析
- 未跑：Profiler / Lighthouse / security scanner
- 未跑：F28 的实机验证（用户下次手工测试即可确认是否真烘焙了轨迹进 GLB）
- 省略：a11y、i18n、移动端、USD 转换链、CI/CD
- 省略：AI 打关节研究（`docs/ai-rigging/` 是独立产品线）

---

## 8. 给 mvp3 收尾的 checklist

按时间排列，不分 P0/P1：

- [ ] **F28** 修轨迹 overlay GLB 烘焙（2 行）
- [ ] **F35** `_pkfTemplateMeta` 进 undo（5 行）
- [ ] **F34** addPkfStep 保 template_segment（3 行）
- [ ] 跑 `npm test` 确认 83 tests 仍通过
- [ ] **F31** 补 bugfix-log #53-#56
- [ ] **F29** 批量 grep "14 段" → "17 段"（分 user-visible / 注释 / 文档三档）
- [ ] **F30** README.md mvp2 → mvp3
- [ ] **F32** docs/index.md 补漏
- [ ] **F33** CLAUDE.md 加 `__mf.trajectoryOverlay`
- [ ] **F36** TrajectoryOverlay 写 5-8 个单测
- [ ] 实机验证 F28 是否真发生
- [ ] merge `feature/pickup-template` → `main`，打 tag `mvp3`

总工作量估计 **3–5 小时**。做完合并，打 tag。

---

## 修订记录

- 2026-04-23：首版（Claude Opus 4.7）。commit `5eddebe`。
