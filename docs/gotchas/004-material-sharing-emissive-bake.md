---
date: 2026-04-18
severity: medium
---
# 共享材质 emissive 被烘焙进 GLB（导入后零件持续发光）

## 症状

导入 ZIP 后某个零件持续发蓝绿色高亮光，无法消除。诊断：`c.material.emissive` 不是 (0,0,0)，是高亮色。

## 根因

`SelectionManager` 高亮选中对象时修改 `material.emissive`。  
问题一：材质是共享引用，直接修改影响所有使用该材质的对象（bug #25）。  
问题二：导出 ZIP 前没有清除选中状态，`GLTFExporter` 把带 emissive 的材质烘焙进 GLB（bug #17）。

## 解决方案

1. 高亮前先 `material.clone()`，只改这个对象自己的拷贝（已修 #25）
2. 导出 ZIP 前 `selectionManager.clearSelection()`，导出后用 `try/finally` 恢复选中状态（已修 #17）

```js
// 导出前
const savedSelection = selectionManager.selectedObject;
selectionManager.clearSelection();
try {
  await exportZip(...);
} finally {
  selectionManager.selectObject(savedSelection);
}
```

## 相关代码

- [`src/core/SelectionManager.js`](../../src/core/SelectionManager.js) — `selectObject` 里的 `material.clone()`
- [`src/main.js`](../../src/main.js) — 导出流程里的 `clearSelection` + `try/finally`

## 相关 bug

#17（导入后高亮不消失）、#25（高亮影响共享材质的其他对象）
