---
tags: [review, mvp3, threeway, archive-candidate]
updated: 2026-04-23
scope: 三向车模板 + 模板库架构 + #59 overflow + #60 trajectory overlay 一揽子变更
---

# REVIEW-v16 · 三向车模板收尾全仓 review

> 背景：mvp3 在 #58 收尾后，连续三轮大改：双段门架 overflow（#59）+ trajectory overlay 残留污染（#60）+ 三向车模板 + 模板库架构。145 单测通过、实机跑通后做这次 review，**只找问题不修代码**。后续清 P0 的时候可以再开 commit。
>
> 上一次 review：[REVIEW-v15.md](REVIEW-v15.md)（F28-F44）。本次延续 F 编号从 **F45** 开始。

---

## 🔴 P0（阻塞 / 现在就该修）

### F45 · `x_axis_threshold` 硬编码，PKF 参数改了不生效

**位置**：[src/core/templates/ThreewayTemplate.js:277](../src/core/templates/ThreewayTemplate.js#L277)

```js
const threshold = 0.3; // 和 TEMPLATE_PARAMETERS_THREEWAY 的 default 对齐；compile 时读 default
```

注释说"compile 时读 default"，实际写死了 0.3。用户在 PKF 参数面板改了 `x_axis_threshold`，再点 🚀 重新生成——仍然用 0.3，用户会以为参数坏了。

**修复方向**：`compileTemplate` 第一步从 `TEMPLATE_PARAMETERS_THREEWAY` 里查 `x_axis_threshold` 的 default 值（或者干脆从 ctx 透传用户当前的 PKF 参数覆盖）。两个实现都 <5 行。

### F46 · `forkAnchorByAxis` fallback 路径会产生 NaN 参数

**位置**：[ThreewayTemplate.js:283-286](../src/core/templates/ThreewayTemplate.js#L283), [L315-324](../src/core/templates/ThreewayTemplate.js#L315)

```js
const anchorByAxis = {
  '+x': (forkAnchorByAxis && forkAnchorByAxis['+x']) || forkAnchorZero,
  '+y': (forkAnchorByAxis && forkAnchorByAxis['+y']) || forkAnchorZero,
  '-x': (forkAnchorByAxis && forkAnchorByAxis['-x']) || forkAnchorZero,
};
// 之后：anchorByAxis['+y'].fork_anchor_zero_x ?? 0
```

如果 `forkAnchorByAxis` 为 `undefined`（比如外部测试直接调 `compileTemplate` 不传第四参），而 `forkAnchorZero` 也是 `{}`，那 `anchorByAxis['+y']` = `{}`，后续 `.fork_anchor_zero_x` = `undefined`，`?? 0` 救回来了 — 但 `toFixed(3)` 接受 `0` 是 OK 的。

**实际风险**：外部调用如果传 `{ fork_anchor_zero_x: null }`（显式 null 而非缺字段），`null ?? 0` 是 0 ✓。但 `NaN ?? 0` 会返回 NaN（nullish 不匹配 NaN）。

**修复方向**：`Number(x) || 0` 替换 `?? 0` 兜住 NaN；或加一个 sanitize helper 集中处理。

### F47 · `snapshotForkAnchorAtRotations` 缺 null-safety

**位置**：[src/main.js:1251](../src/main.js#L1251) 附近

```js
const forkObj = sceneManager.sceneRoot.getObjectByName(attachEvent.new_parent_name);
```

`sceneManager.sceneRoot` 未判空。异常路径（比如模型还没加载完就触发 🚀）会抛错且 try-catch 从 L1263 才开始 —— 前面的 null deref 漏到顶层。

**修复方向**：函数开头加 `if (!sceneManager?.sceneRoot) return {};`。

### F48 · placeholder reparent event 在 AI 失败 catch 路径未清理

**位置**：[src/main.js:1703-1729](../src/main.js#L1703)

```js
placeholderEventId = keyframeManager.addReparentEvent(...);
// ...
// 'AI 节奏请求' 在 L1722 的 try 里；如果 throw，catch 里 console.warn 后继续，
// 但 placeholderEventId 的清理在更后面 L1705，**该清理已经执行过了**（在 snapshot 调用后立即）
```

等等，再读一遍代码：snapshot 完成**之后 L1704**就立即 `removeReparentEvent(placeholderEventId)`。所以 AI 失败的时候 placeholder 已经被清了。✅ 其实 OK，**这个发现是误报**。

但检查出来一个相关问题：**pre-compile 之后才加的 placeholder 和 remove 顺序**。细读代码：
- L1694-1700 加 placeholder → L1702 snapshotForkAnchorZero → L1704 remove placeholder ✓
- L1707-1717 preCompile（三向车用于拿段序）→ 此时 placeholder 已经不在
- L1722 AI rhythm 请求
- L1733 final compile

preCompile 需要 placeholder 吗？preCompile 不计算 forkAnchor 了，不需要。✅ 这个也 OK。

**降级为 Not a Bug**。但 **L1698 的 forkSource 判断**（`'auto_from_mast_joint' || 'auto_from_rotate_joint'`）和 canApply 内部实际返回的 forkSource 值 `'auto_from_rotate_joint'` 对得上——好。

### F49 · `detectTemplate` 循环无 try-catch 隔离

**位置**：[src/core/templates/index.js:41-47](../src/core/templates/index.js#L41)

```js
for (const tpl of TEMPLATES) {
  if (typeof tpl.canApply !== 'function') continue;
  const result = tpl.canApply(keyframeManager, sceneRoot); // ← 某模板的 bug 会炸全场
  if (result?.ok) return { template: tpl, ctx: result.data };
}
```

一个模板的 `canApply` 如果抛异常，整个识别流程中断，后续模板根本轮不到。

**修复方向**：每次调用用 try-catch 包裹，异常降级为 `{ ok: false, missing: ['内部错误'] }` 并 console.warn。

---

## 🟡 P1（应尽快修，功能性坑）

### F50 · `canApply` 不拒绝 cargo.y < 0 或 cargo == drop 的边界

**位置**：[ThreewayTemplate.js:134-229](../src/core/templates/ThreewayTemplate.js#L134)

- `cargo.y < 0`：文档明确说"不支持倒车插货"，但 canApply 通过 → compileTemplate 生成"车体前进到负 y" 的 step → 物理不可行（车体往后移但朝向前）
- `cargo` 和 `drop` 位置相同或极近：canApply 通过 → 生成无意义的取放循环，可能段数异常
- cargo 和 drop 同 marker 名（用户手误）：canApply 内两个 for 循环分别找 type，没防重名

**修复方向**：canApply 末尾加 validation block，拒绝列出具体 missing reason。

### F51 · preCompiled 和 final compile 段数可能不一致

**位置**：[main.js:1713](../src/main.js#L1713) vs [L1733](../src/main.js#L1733)

三向车流程：
1. L1713 `preCompiled = compileTemplate(ctx, undefined, ...)`——默认节奏
2. `segmentsForAi = preCompiled.steps.map(...)` 拿段数 N
3. L1722 AI 根据 N 段返回节奏
4. L1733 `compile = compileTemplate(ctx, rhythm, ...)`——用 AI 节奏

理论上 1 和 4 的 ctx 一样，段数应该一致。但 `compileTemplate` 里的 `decideAxis(ctx.pos, threshold)` 如果受 hardcoded threshold（见 F45）影响，两次跑出的 axis 应该一致。**实际短期内无 bug**，但如果修了 F45 让 threshold 从参数读，则两次 compile 可能读不同参数 default → 段数飘。

**修复方向**：修完 F45 后，保证两次 compile 的 ctx 和 threshold 都相同；或者重构成单次 compile 流程（先请 AI 拿节奏 hint 再 compile）。

### F52 · 后端 `/api/template-rhythm` 沉默降级 + expectedCount 边界

**位置**：[tools/conversion-service.js:650-680](../tools/conversion-service.js#L650)

三个 sub-issue：
1. **老前端不传 `template_kind`** → default `'forklift'` → 沉默走 17 段。新前端/旧后端组合也可能走错。没有 API 版本标记
2. **`expectedCount` 推算**：`templateSegments` 为 `null` 或 `undefined` 时 → 走默认 18。但前端对 threeway 必然传非空数组（L1714 map 过），假设成立但脆弱
3. **未知 `template_kind` 只 warn 不拒**：[L664](../tools/conversion-service.js#L664) `console.warn` 然后继续当 forklift 处理

**修复方向**：
- 对 threeway 要求 `template_segments` 必传且非空（现在有 `expectedCount < 1` 的检查，但只在 `Array.isArray` 假时生效）
- 未知 kind 直接 400 拒绝，不沉默降级
- 加 API 版本号或 client_version 做 handshake

### F53 · 段数校验失败时 `raw_response` 暴露给前端

**位置**：[conversion-service.js:705](../tools/conversion-service.js#L705), [L727](../tools/conversion-service.js#L727)

```js
res.status(422).json({
  error: `AI 返回 segments 必须为 ${expectedCount} 项数组...`,
  raw_response: content,  // ← AI 完整返回
});
```

AI 返回可能含内部 reasoning 或 token，dump 到前端响应是信息泄露（低危，但属 XSS/info-leak 模式）。

**修复方向**：raw_response 只进服务端日志，前端 error 只返回 error 文本。

### F54 · 测试覆盖盲区

**位置**：[tests/unit/templates/threeway-template.test.js](../tests/unit/templates/threeway-template.test.js)

- 9 种 (cargoAxis, dropAxis) 组合只测了 5 种（自述 3×3 但实测 5 个）
- `forkAnchorByAxis` 参数的 fallback 路径（传 null / 缺字段 / 空对象）没测
- cargo.y < 0 / cargo == drop 等边界没测（对应 F50）
- `x_axis_threshold` 硬编码的问题如果修了，相应也要加测试验证"用户改参数后 compile 读到新值"

---

## 🟢 P2（nice-to-have，风格/文档）

### F55 · 文档 schema 版本数字飘移

**位置**：README.md 多处

- [README.md:22](../README.md#L22) / [:52](../README.md#L52) / [:95](../README.md#L95) / [:133](../README.md#L133) / [:192](../README.md#L192)：**schema v4** → 应是 **v7**（#59 已 bump 到 v7）
- [README.md:77](../README.md#L77)：**83 tests** → **145 tests**
- [docs/index.md:67](../docs/index.md#L67) 或类似位置：诊断脚本数 **9** → **10**（新加 diag-trajectory-vs-playback）

### F56 · docs/concepts/forklift-pickup-template.md 没提三向车姊妹模板

[docs/concepts/forklift-pickup-template.md](../docs/concepts/forklift-pickup-template.md) 底部"关联"章节应加注：本模板和 [threeway-template.md](../docs/concepts/threeway-template.md) 同属模板库 `src/core/templates/`，共享 detectTemplate 机制。

### F57 · diag-trajectory-vs-playback `sampleOverlayLike` 注释歧义

**位置**：[tests/diag-trajectory-vs-playback.js:82-98](../tests/diag-trajectory-vs-playback.js#L82)

注释说"模拟 TrajectoryOverlay 的采样"，但其实模拟的是"修复后"的逻辑（已有预清零）。容易让读者误以为"当前 overlay 仍有 bug"。

**修复方向**：把注释改成"replicating the fixed behavior"或"reference implementation"。

### F58 · `snapshotForkAnchorAtRotations` vs `snapshotForkAnchorZero` 命名不对称

两个函数都是 snapshot 承载点，前者叫 "AtRotations" 后者叫 "Zero"。命名不统一：
- `snapshotForkAnchorZero` 暗示"at zero pose"（所有关节归零）
- `snapshotForkAnchorAtRotations` 是前者的多次版本

**修复方向**：统一成 `snapshotForkAnchor(angles?)` 单一入口，angles 为空时退化到 zero。或保持双函数但加 JSDoc 强调关系。

### F59 · `axisToAngle` 混用正负：`0 / -90 / -180`

**位置**：[ThreewayTemplate.js:109-116](../src/core/templates/ThreewayTemplate.js#L109)

注释解释了左手系映射需要负值，但 `-x → -180` 和 `+180` 视觉等价，读代码的人会疑惑"为什么不是 +180"。

**修复方向**：全部返回负值统一（保持代码逻辑），但把这个约定放到模块顶部的大注释里而不是散在函数上。或者 factor out `applyLeftHandedSign(deg) => -deg`，意图更明显。

---

## 📊 总结

| 优先级 | 数量 | 代表 |
|---|---|---|
| 🔴 P0 | 4 项（F45-F49，F48 已澄清不是 bug） | threshold 硬编码、null 不安全、detectTemplate 无 try-catch |
| 🟡 P1 | 5 项（F50-F54） | canApply 边界、preCompile vs final、后端 API 版本、测试盲区 |
| 🟢 P2 | 5 项（F55-F59） | README schema 版本、文档互连、命名对称、注释歧义 |

**共 14 条有效 finding**（F48 澄清后剔除）。

## 建议修复节奏

1. **马上修**：F45 + F47（< 1 小时）—— 用户改参数生效 + null 安全
2. **一周内修**：F46 + F49 + F50 + F54（半天）—— 健壮性 + 单测补
3. **下次大改前修**：F51-F53 + P2 所有（半天）—— 后端 API 版本 + 文档同步
4. **下个 iteration 前看看再决定**：F57-F59（半小时，纯风格）

## 不是本次 review 范围但想起来的

- `docs/REVIEW-v15.md` 里的 F36（TrajectoryOverlay 单元测试）仍未加。F60 bug 已经靠 diag 脚本守护，单测优先级降低
- main.js 2400+ 行（REVIEW-v15 F37）没拆，三向车又加了 ~60 行
- AI prompt 的 token 预算没监控（conversion-service 新增 70 行 threeway prompt）

这些放 REVIEW-v17 或 mvp3→mvp4 过渡时看。
