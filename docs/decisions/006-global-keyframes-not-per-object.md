---
date: 2026-04-18
status: accepted
---
# 关键帧系统改为项目级全局，而非 per-object

## 背景

早期版本的关键帧是 per-object 的：每个对象有自己的 clips，关键帧只记录该对象的 transform。

## 考虑过的选项

1. **Per-object clips**：类似 Unity Animation 组件，每个对象独立
2. **项目级全局 clips**：一个 clip 里的每个 keyframe 快照所有关节的 value

## 决定

重构为**全局关键帧系统**：`KeyframeManager.globalClips`，每个 keyframe 包含 `jointValues: { [jointDefId]: number }` 字典，记录所有关节在该时刻的值。

## 理由

Bug #9：选中 A 添加关键帧，切到 B 再添加，两个 clip 互相看不见，用户无法管理跨对象的协调动画（比如叉车门架升起同时叉齿前伸）。全局 keyframe 让所有关节共享同一时间轴，一个 keyframe 捕获整机状态。

## 后果

- 关键帧数量不再随对象数量线性增长，每个时间点只有一条记录
- `evaluateAllAt(t)` 对所有关节插值，单次调用驱动整机
- per-object clip 数据结构已删除，旧代码有 `objectDataById` 但只保留 baseTransform fallback
- motion.json 格式：`clips[].keyframes[].joint_values` 字典（见 `docs/concepts/zip-output-schema.md`）

## 相关代码

- [`src/core/KeyframeManager.js`](../../src/core/KeyframeManager.js) — `globalClips`、`evaluateAllAt`
