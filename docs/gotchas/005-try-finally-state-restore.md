---
date: 2026-04-18
severity: medium
---
# 临时状态修改后的恢复必须用 try/finally

## 症状

导出 ZIP 时如果 `GLTFExporter` 抛异常（模型过大 / 材质跨域等），模型卡在"全关节归零 + 无选中"状态，看起来动画配置丢失，需要刷新页面才能恢复。

## 根因

导出流程是"临时改状态 → 导出 → 恢复状态"的三段式：
1. 保存当前关节值 + 选中状态
2. 全部归零 + 清除选中（让 GLB 烘焙零位）
3. 导出 GLB
4. 恢复关节值 + 选中

原实现把步骤 4 放在 `try` 块尾部，`await exportZip()` 抛异常后跳到 `catch`，步骤 4 不执行。

## 解决方案

把恢复逻辑从 `try` 块尾部移到 `finally` 块，不管成功失败都执行：

```js
const savedValues = ...; // 保存当前状态
try {
  applyZeroPose();
  await exportZip(...);
} finally {
  restoreSavedValues(savedValues); // 始终恢复
}
```

这个模式适用于**所有**"临时改状态 → 执行操作 → 恢复状态"的流程。

## 相关代码

- [`src/main.js`](../../src/main.js) — 导出按钮处理函数里的 `try/finally`

## 相关 bug

#32（导出 ZIP 异常时卡在零位状态）
