---
date: 2026-04-23
severity: low
status: active
---
# 轨迹可视化 overlay：出怪事时优先怀疑

## 谁看这篇

MotionForge 从 2026-04-23 起引入了 **🎨 轨迹可视化 overlay** 功能（时间轴右侧 toggle 按钮）。这是个**新加的跨模块 feature**，接线点遍布 4 个文件 17 处。功能本身是只读采样不该影响主流程，但**新代码总是比老代码更容易出锅**。这篇记录它可能惹的麻烦以及两层关停手段。

## 功能是什么

勾选"🎨 轨迹"开关后：

1. 在 3D 视口里画 fork（蓝）+ cargo（橙）的世界空间轨迹，段边界标小球，attach/detach 标红/绿大球
2. Console 打印段表：seg / joint / t_end / value_end / fork xyz / cargo xyz / dy
3. PKF 参数 / 步骤 / reparent 事件 / marker 变动时**自动刷新**（microtask 合并同 tick 多次改动）

实现：[src/core/TrajectoryOverlay.js](../../src/core/TrajectoryOverlay.js) + 4 个 refresh 函数里各加一行 `trajectoryOverlay?.requestRefresh()`。

## 它可能引起的症状

| 用户观察 | 怀疑 overlay 的理由 |
|---|---|
| 关 PKF 编辑面板时视口出现诡异轨迹残影 | `clear()` 没正确 dispose group |
| 切场景 / 重新加载模型时主动画行为变了 | `refresh()` 采样流程改了 `joint.currentValue` 没完全复原 |
| cargo 位置在某段播放瞬间瞬移/抽搐 | 采样时调 `applyReparentEventsAtTime` 触发了 side effect（snap-attach 等）|
| Console 疯狂打表刷屏 | 某个 refresh hook 被频繁触发，microtask 合并失效 |
| 渲染性能明显下降 | `samples=200` 对复杂场景可能偏高；或 `Line` 没 dispose 材质泄漏 |
| **导出 ZIP 后 cargo 尺寸 / 位置异常** | overlay 在导出瞬间恰好触发 refresh，污染了 scene graph（**#52 类型**：export-during-playback race） |

## 怎么快速排除嫌疑

**一步测试**：把 [src/main.js:20](../../src/main.js#L20) 的开关翻掉：

```js
const TRAJECTORY_OVERLAY_ENABLED = false;  // 从 true 改成 false
```

硬刷浏览器后重现原始操作。如果问题消失 → 锁定是 overlay；如果问题仍在 → 和 overlay 无关，回翻 true 继续查别处。

这个开关做了三件事（一次翻全走）：
- 不实例化 `trajectoryOverlay`（`= null`）
- UI 按钮 `display: none`（用户看不见）
- 所有 `trajectoryOverlay?.requestRefresh()` 走 optional chaining 变 no-op

## 怎么彻底删除

如果确认是这个功能持续惹麻烦、且短期不想修，可以整块拆除：

```bash
grep -rn "trajectory-overlay" src/
```

会列出当前 17 处（main.js × 12、EditorUI.js × 2、style.css × 2、TrajectoryOverlay.js × 1）。按列表清光注释和相关代码行，再：

- 删 [src/core/TrajectoryOverlay.js](../../src/core/TrajectoryOverlay.js) 整个文件
- style.css 里 `.timeline` 的 `grid-template-columns` 末尾 `auto` 列回退为原来的 `120px 1fr 170px`

之后 `npm run build` 验证通过 = 拆干净。

## 关联

- 替代品（仍可用）：[tests/diag-template.js](../../tests/diag-template.js) 的 `__diagTpl.drawTrajectory()`——功能一样，但要手动粘到 Console 跑，不污染 production 代码
- 引入 commit：`55833f8`（feature）+ `8d0c26d`（加 flag + tag）
- 设计历史：[docs/log.md 2026-04-22 tooling 条目](../log.md)——`__diagTpl.drawTrajectory` 被确立为首选调试工具后，用户提出"能不能直接放 UI 里"，于是毕业成 production overlay

## 经验教训

**新跨模块 feature 上线时建立"整体关停 + 精确定位"两层保险是划算的**——开关让你秒级排除嫌疑不用改代码，grep tag 让几周后的自己（或接手的人）能一把找到所有接线点。代价是多一个常量、每处接线点多一行注释，相比出事时"散在 N 个文件里找代码"成本低得多。

不是所有新功能都该这样搞——**单文件内的小功能**不值得，**跨 3+ 文件的 feature** 才有 ROI。
