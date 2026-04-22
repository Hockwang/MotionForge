---
date: 2026-04-22
severity: high
---
# 合并 mesh 的 bbox 不能代表"子部件几何"

## 症状

想用几何启发式（bbox.min / max / center）在合并 mesh 上推断"某个可见子部件的位置"，结果完全错位。最痛的例子：三向车.glb 的 `_CS19110` 把**叉齿+门架+支架**合并成一个 mesh，试图用 `bbox.max.y` 当"叉齿顶面高度" → 实际拿到的是门架顶端（相差 ~0.5m），叉齿下穿地面 0.55m（见 [CLAUDE.md #47](../../CLAUDE.md)）。

## 根因

**"合并 mesh"意味着原本该作为独立节点的子部件（叉齿 / 门架 / 车体 / 轮子）被建模师在 Blender 导出时合并成一个 BufferGeometry**。Three.js 里这是**单个 Mesh**，它的 `Box3` 是整个合并后形状的 axis-aligned bbox —— **没有"子部件"边界信息可提取**。

- `bbox.min.y` = 合并形状最低点（可能是轮子底、可能是叉齿底、可能是支架底，不确定哪个）
- `bbox.max.y` = 合并形状最高点（通常是门架/柱子顶端，**几乎肯定不是叉齿顶**）
- `bbox.center` = 合并形状几何中心（受所有子部件"拉扯"，不对应任何单一部件中心）

想从合并 mesh 里抠出"叉齿部分"需要 mesh 分析（连通分量 / 面片分组 / vertex 扫描），超出 bbox 启发式能力。

## 诊断

如果你的算法想基于 bbox 推断"子部件在哪"，先跑一次：

```js
const forkObj = sceneRoot.getObjectByName('_CS19110');
const meshes = [];
forkObj.traverse((o) => { if (o.isMesh) meshes.push(o); });
console.log('mesh count:', meshes.length);
// 1 = 合并 mesh（启发式失效）；>1 = 独立 mesh，启发式 可能 有效
```

完整版见 [`tests/diag-fork-anchor.js`](../../tests/diag-fork-anchor.js)。

## 修复

**不要基于 bbox 猜子部件位置**。候选方案：

1. **接受整个 bbox 作为统一目标**（MotionForge #52 选）：
   - 把 fork_anchor_zero 定义为"整个 fork mesh 的 bbox 底面中心"
   - 用户心智模型：*"cargo 吸附到叉齿大致中间、底面高度"* —— 对演示用途够用
   - 代价：cargo 可能视觉上陷进 fork 的某个部分（门架 / 支架），但 demo 无所谓穿模

2. **加用户可控的 marker**（未实施的 C 方案）：
   - UI 里让用户拖一个"承载点"标记到叉齿真正的尖端
   - 完全脱离几何启发式，用户自己指定
   - 代价：要新 UI 组件 + 数据 schema（存 marker 位置）

3. **要求资产拆 mesh**（外部约定）：
   - 文档说明"叉齿应建模为独立 mesh 节点"
   - 合并 mesh 视为不支持 —— 但实际用户上传的模型可控性差，这条很难推

## 走过的坑（反例存档）

六轮几何启发式迭代都败于合并 mesh：

| 尝试 | 假设 | 败因 |
|---|---|---|
| #37 初版 | bbox.center 代表"fork 中心" | 合并 mesh center 偏向门架，cargo 陷 fork |
| #47 | bbox.max.y 代表"叉齿顶面" | 合并 mesh max.y 是门架顶（高 0.5m）→ 穿地 |
| #48 回退 center | 同 #37 | 同 #37 |
| #49 | bbox.min.y 代表"叉齿底面" | 恰好合并 mesh 最低点是叉齿底（运气好），但 x/z 仍是合并中心 |
| #50 | bbox 朝 cargo 方向的前端极值 | 猜得更激进，非对称 bbox 下数学 bug + snap 时序 bug |
| #51 | 读 joint.origin 当承载点 | 承载点 ≠ 旋转支点（URDF 语义冲突，破坏关节行为）|
| #52 | 自动 bbox 底面中心 | ✓ 选择"够用就行"，不再追求精确对齐 |

## 关联

- [CLAUDE.md #36](../../CLAUDE.md) — `_findForkTineMesh` 启发式（已删）
- [CLAUDE.md #47-#52](../../CLAUDE.md) — 六轮迭代完整日志
- [docs/concepts/forklift-pickup-model.md](../concepts/forklift-pickup-model.md) — 叉车取货模型的抽象层
- [gotchas/001-gltf-scene-wrapping-roundtrip](001-gltf-scene-wrapping-roundtrip.md) — 另一个"导出工具不给我们想要的结构"的例子
