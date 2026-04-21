---
tags: [review, archive, codex, v14]
updated: 2026-04-21
status: archived
---
# Codex v14.1 全仓 Review（归档原文）

> **本文档是归档**。所有 finding 已迁移到 [../REVIEW-v14.md](../REVIEW-v14.md)，合并映射见那份 §8。
>
> 保留原文是为了可追溯：Codex 的原话 / 证据精度 / 优先级判定，日后回看能还原当时判断。
>
> - 分支：`v14-ai-oneshot`
> - 审阅日期：2026-04-21
> - 覆盖方式：全仓静态审查 + `npm run build` 验证（通过，有 large bundle warning 但非失败）

## Findings

### 1. High: `aiDecomposeBtn` 仍然把 Three.js Y-up 坐标直接发给 L1，和一键生成主链路不一致
- 证据：
  - `src/main.js:1132-1140` 的 `collectSceneForAi()` 已做 `y/z` swap，发送 `{ x: wp.x, y: wp.z, z: wp.y }`
  - `src/main.js:1264-1277` 的“🪄 仅拆解”路径仍发送 `{ x: wp.x, y: wp.y, z: wp.z }`
  - `docs/architecture/ai-pipeline.md:49-55` 已把这件事标成已知 bug
- 影响：
  - 同一个场景，经“仅拆解”和“🚀 一键生成”送进 L1，会得到不同的空间理解。
  - 这会直接影响 marker/cargo/drop 的方位判断，属于真实行为分叉，不只是文档问题。
- 建议：
  - 把 `aiDecomposeBtn` 统一改为复用 `collectSceneForAi()`，不要再维护第二套采集逻辑。

### 2. High: `removeAllReparentEventsForChild()` 不会失效 `fork_anchor_zero` 缓存，容易让 PKF 预览继续读旧锚点
- 证据：
  - `src/core/KeyframeManager.js:231-233` 定义了 `invalidateForkAnchorZero()`
  - `src/core/KeyframeManager.js:272-296` 中，`addReparentEvent()` 和 `removeReparentEvent()` 都会调用这个失效逻辑
  - `src/core/KeyframeManager.js:301-305` 的 `removeAllReparentEventsForChild()` 只过滤事件，不失效缓存
  - 这个方法被 UI 直接调用：
    - `src/main.js:437-442` 清某对象全部 reparent
    - `src/main.js:1894-1914` 删除 marker 时顺带清相关 reparent
- 影响：
  - `buildDefaultParamValues()` 会继续读旧 `fork_anchor_zero_*`。
  - 用户清掉 attach/detach 后，如果继续做 PKF 预览、公式求值或再次编辑，很可能用的是过期几何参考。
- 建议：
  - 让所有 reparent mutator 统一走同一条缓存失效路径，避免“单删正确、批删错误”的状态分叉。

### 3. Medium: “清空所有标记”不是一次可撤销动作，而是 N 次独立 undo snapshot
- 证据：
  - `src/main.js:1894-1900` 的 `removeMarkerById()` 内部会先 `pushUndoSnapshot()`
  - `src/main.js:1927-1934` 的 `removeAllMarkersBtn` 只是 `ids.forEach((id) => removeMarkerById(id))`
- 影响：
  - 用户点击一次“清空所有标记”，撤销时却只能一个个回退。
  - 这会让 undo 栈语义和用户动作不一致，尤其 marker 多时体验很差。
- 建议：
  - 把 bulk delete 包成单次事务：批量前 push 一次 snapshot，循环删除时不再逐个 push。

### 4. Medium: 选中高亮会长期污染材质状态，并有内存泄漏风险
- 证据：
  - `src/core/SelectionManager.js:83-84` 首次高亮时会 `clone()` 材质并把 `emissiveIntensity` 设为 `0.55`
  - `src/core/SelectionManager.js:88` 只保存了 `emissive` 颜色，没有保存原始 `emissiveIntensity`
  - `src/core/SelectionManager.js:105` 清高亮时把强度硬编码回 `0.2`
  - 代码里没有看到对这些 clone material 的 `dispose()`，`originalMaterialState` 里的记录也不删除
- 影响：
  - 任何原本使用自定义 emissive 强度的材质，选中一遍后就会被永久改成 `0.2`
  - 长时间点选不同对象会不断累积 clone material 和状态映射，属于渐进式内存/GPU 资源泄漏
- 建议：
  - 保存完整原始高亮状态，而不是只存颜色。
  - 在取消高亮或对象销毁时回收 clone material，并清理 `originalMaterialState`。

### 5. Medium: 反复导入/切换模型时，旧 `sceneRoot` 只被移出场景，没有递归释放 Three.js 资源
- 证据：
  - `src/core/SceneManager.js:178-185` 的 `setSceneRoot()` 在已有 `sceneRoot` 时只做 `this.scene.remove(this.sceneRoot)`
  - 这里没有释放旧 root 下的 `geometry / material / texture`
- 影响：
  - 对大型 GLB/USD/FBX 模型反复导入时，GPU/内存占用会持续上涨。
  - 这类问题通常在“开发者长时间调模型”和“用户连续尝试多个 ZIP/模型”时才暴露，所以比较隐蔽。
- 建议：
  - 在 `setSceneRoot()` 替换旧 root 前统一做递归 dispose。
  - 这条在 `DEBT.md` 里已有记录，建议继续维持为显式已知债务，别让它停留在隐性状态。

### 6. Medium: `tests/test-pkf-p4.js` 的断言已经和当前 PKF 运行时语义相反
- 证据：
  - `src/core/KeyframeManager.js:1337-1356`：`evaluatePkfAt()` 对 `t >= step.t_end` 会设 `progress = 1`
  - `docs/concepts/pkf-parametric-keyframe-formula.md:47` 也明确写了“`t > t_end` 保持末态，不 return”，这是 bug `#31` 的关键修复点
  - 但 `tests/test-pkf-p4.js:190-192` 仍然断言 `t=3` 时 `results.length === 0`
- 影响：
  - 这份测试脚本如果有人拿来回归，会把“正确行为”判断成失败。
  - 它会误导后续维护者重新引入 `#31` 同类 bug。
- 建议：
  - 先把测试语义对齐到当前实现，再考虑是否需要真正自动化执行这些脚本。

### 7. Low: 仓库里存在一组明显的文档/提示词漂移，已经开始误导维护者
- 证据：
  - 版本信息还停在 `v12+`
    - `README.md:5`
    - `docs/ROADMAP.md:6`
  - 诊断脚本数量仍写成“5 个”
    - `README.md:218`
    - `CLAUDE.md:137`
    - `FLOW.md:11`
    - 实际 `tests/` 下已有 7 个 `diag-*.js`
  - `src/ui/EditorUI.js:629` 仍提示 L2“不要输出 reparent，用户会手工加 reparent 事件”，但当前 oneshot 流水线已由 L1/L前端自动应用 reparent
  - `src/core/ResultPackageExporter.js:139` 的 `_comment` 还把 `origin` 说成“世界空间旋转/平移参考点”，而当前主架构实际是 parent-local/URDF 风格
- 影响：
  - 新接手的人会在“代码已经进到 v14.1，但说明还停在 v12+”的状态下做错误推断。
  - 这类漂移不会马上炸，但会持续抬高后续协作和排障成本。
- 建议：
  - 把版本、脚本数量、reparent 责任边界、origin 语义统一做一轮对齐。
  - 这不一定要一次性全修完，但至少要让主入口文档不再明显误导。

## Scope

本次 review 以“全仓静态审查”为主，已覆盖：
- 运行时代码：`src/main.js`、`src/core/*`、`src/ui/EditorUI.js`、`src/style.css`、`index.html`、`src/counter.js`
- 后端/工具：`tools/conversion-service.js`、`tools/convert_usd_to_glb.py`、启动脚本、`package.json`
- 测试与诊断：`tests/diag-*.js`、`tests/test-pkf-p*.js`
- 文档：`CLAUDE.md`、`FLOW.md`、`README.md`、`HOW-IT-WORKS.md`、`USER-GUIDE.md`、`DEBT.md`、`CHANGELOG.md`、`CONTRIBUTING.md`、`docs/architecture/*`、`docs/concepts/*`、`docs/decisions/*`、`docs/gotchas/*`、`docs/ROADMAP.md`

## Verification

- 已执行：`npm run build`
  - 结果：通过
  - 备注：有大 bundle 警告，但不是构建失败
- 未执行：
  - 浏览器态 `tests/diag-*.js`
  - 真实场景下的 oneshot/L1/L2 端到端交互
  - Blender 转换链路的实际导入导出回归

## Overall Assessment

仓库的核心主干是清晰的：FK、roundtrip、PKF、reparent、oneshot 的职责边界基本已经成型，`v14.1` 的 `fork_anchor_zero` 方向也比早期 `fork_offset` 更稳。当前更大的问题不是“整体架构错误”，而是：

1. 同一概念在不同入口存在双实现，已经开始分叉（最典型是场景坐标采集）
2. 局部状态缓存和 UI 批量操作没有完全统一语义（fork anchor cache、undo）
3. 文档和测试有明显漂移，开始反向误导维护工作

如果现在要排优先级，我建议先修：
- `aiDecomposeBtn` 坐标系分叉
- `removeAllReparentEventsForChild()` 的缓存失效
- marker bulk delete 的 undo 语义
- Selection/SceneManager 的资源泄漏

其余问题更适合作为 `v14.2` 的一致性收口和测试补齐工作来做。
