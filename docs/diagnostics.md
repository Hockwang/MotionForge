---
tags: [diagnostics, debugging, reference]
updated: 2026-04-22
---
# 诊断脚本指南

> MotionForge 的 Console 诊断工具集，用于定位关节系统 / 导出导入 roundtrip / 动画播放 / AI 一键生成相关的 bug。从 CLAUDE.md 拆分出来（2026-04-22）—— CLAUDE.md 只保留调试钩子入口，详细用法放这里按需查阅。
>
> **先写诊断脚本，再改代码**。多数历史 bug 是通过这条流程定位的（[docs/bugfix-log.md](bugfix-log.md) 经验教训 8）。

---

## 目录

- [通用用法](#通用用法)
- [脚本索引](#脚本索引)
- [场景 1：导入后模型变形 / 下沉 / 位置错乱](#场景-1导入后模型变形--下沉--位置错乱)
- [场景 2：关节父级引用丢失 / 零件断开 / 链式关节失效](#场景-2关节父级引用丢失--零件断开--链式关节失效)
- [场景 3：导入后播放动画组件整体下沉 / 链式关节错位](#场景-3导入后播放动画组件整体下沉--链式关节错位)
- [场景 4：Gizmo 拖动旋转突然跳变 360°](#场景-4gizmo-拖动旋转突然跳变-360)
- [场景 5：判断"归零策略"是否正确](#场景-5判断归零策略是否正确)
- [场景 6：模型某片零件一直发光高亮](#场景-6模型某片零件一直发光高亮)
- [场景 7：承载锚点 / 叉齿 mesh 分析](#场景-7承载锚点--叉齿-mesh-分析)
- [场景 8：叉车 14 段模板路径验证（mvp3）](#场景-8叉车-14-段模板路径验证mvp3)
- [附：单行快速检查命令](#附单行快速检查命令)

---

## 通用用法

1. 启动 MotionForge (`npm run dev`)，加载模型
2. 按 **F12** 打开 DevTools → **Console**
3. 打开对应 `tests/diag-*.js` 文件，**全选复制**脚本内容
4. 粘贴到 Console，回车 → 看到 `✅ ... 已加载`
5. 按脚本说明调用 `__diagX.xxx()` 方法

所有脚本都通过 `window.__mf` 访问内部状态，**只读诊断不修改源代码**。

---

## 脚本索引

| 脚本 | 诊断范围 | 触发命令 |
|------|---------|---------|
| [tests/diag-export-roundtrip.js](../tests/diag-export-roundtrip.js) | 导出前/导入后的场景树、关节、动画结构差异 | `__diagRT.snapshot/diff` |
| [tests/diag-roundtrip-transform.js](../tests/diag-roundtrip-transform.js) | 节点世界 transform 在 roundtrip 前后的精确差异 | `__diagT.phaseA/B/C/compare` |
| [tests/diag-joint-integrity.js](../tests/diag-joint-integrity.js) | 关节定义的 parentId/childId 引用完整性 | `__diagJ.check()` |
| [tests/diag-joint-state.js](../tests/diag-joint-state.js) | 关节 runtime 状态（baseTransform / currentValue / world position） | `__diagJ.state()` |
| [tests/diag-zero-pose.js](../tests/diag-zero-pose.js) | 对比不同"归零策略"的效果 | `__diagZ.testZeroPose/testNaturalPose` |
| [tests/diag-animation.js](../tests/diag-animation.js) | 动画播放过程中各时间点的关节状态 | `__diagA.scanClip/at/keyframes` |
| [tests/diag-oneshot.js](../tests/diag-oneshot.js) | 🚀 一键生成流程排查（L1 / L2 / PKF eval / markers） | `__diagO.report/l1/l2/plan/actual` |
| [tests/diag-fork-anchor.js](../tests/diag-fork-anchor.js) | 承载锚点 / 叉齿 mesh / bbox / PKF eval 一把梭 | `__diagFA.run/listForkSubmeshes` |
| [tests/diag-template.js](../tests/diag-template.js) | 叉车 14 段模板：编译产物 / 公式 / 级联 / 循环 / 时间采样 | `__diagTpl.all/compiled/formulas/...` |

---

## 场景 1：导入后模型变形 / 下沉 / 位置错乱

**可能原因**
- GLB roundtrip 层级丢失或根节点被重命名（如 `三向车.glb` → `AuxScene`）
- `alignObjectToGround` 双重对齐或未对齐，导致整体 Y 方向偏移
- 关节 `baseTransform` 在错误时机捕获，造成 double-apply

**检测流程**

```js
// 1. 导出前运行：
__diagT.phaseA()                      // 快照"驱动态"+"零位态"

// 2. 正常导出 ZIP → 导入 ZIP

// 3. 导入后立即运行：
__diagT.phaseB()                      // 快照导入态
__diagT.phaseC()                      // 把关节全部归零，快照导入零位态
__diagT.compare()                     // 输出 4 组对比 + 自动结论
```

**结论对照表**

| 导入态 ≈ 驱动态？ | 导入零位 ≈ 原始零位？ | 结论 |
|---|---|---|
| Yes | Yes | GLB 忠实 + double-apply（bug #20 类） |
| Yes | No | GLB 忠实 + 零位有偏差（bug #14 类） |
| No | Yes | 导入流程改变了 transform |
| No | No | GLB 序列化/反序列化有损 |

**相关 bug**：[#12-#16, #20-#22](bugfix-log.md)

---

## 场景 2：关节父级引用丢失 / 零件断开 / 链式关节失效

**典型症状**
- 导入后 `_CS19110 飞出去`
- `_CS198 不跟随运动`
- 关节父级在左侧面板消失

**可能原因**
- 导入时 `parentId` 被错误地覆盖为 `childObj.parent.uuid`（无名 Object3D 包装），而不是按 `parent_name` 解析原始逻辑父级
- `childId`/`parentId` 在 GLB roundtrip 后 UUID 变化，引用断裂

**检测流程**

```js
__diagJ.check()
```

**关注输出**
- **① 场景树结构**：看 `insertedGroup` 是否还在、层级是否正常
- **③ 关节定义完整性**：
  - `parentId === sceneParent? true` + 父级是无名 `Object3D` → **parentId 被错误解析（bug）**
  - `parentId === sceneParent? false` → parentId 指向真实逻辑父级（正确）
- **④ 关节链分析**：有无链式关系（`A ← 依赖 → B`）

**相关 bug**：[#10, #18, #34](bugfix-log.md)

---

## 场景 3：导入后播放动画组件整体下沉 / 链式关节错位

**可能原因**
- 导入时 `applyAllJointDrives` 直接用 JSON 里的 `currentValue`（非零）触发拓扑排序
- 父级 joint 先驱动 → 子级 lazy capture 的 base 是父级**驱动态**下的相对位置
- 动画把父级改回零位后，子级相对下沉父级位移量

**检测流程**

```js
__diagA.keyframes()     // 查看关键帧原始数据
__diagA.scanClip()      // 扫描 clip 多个时间点
__diagA.at(2.5)         // 查看指定时间点
```

**关注输出**
- **🔍 检测：哪些节点 Y 方向下降？**：如果多个零件的 Y 变化范围相同 → 整体下沉，说明链式关节 base 错位
- drift warning 里的 `jointParent: XXX` 显示实际链式关系

**修复方向** — 导入时两阶段应用关节（已实现）：
1. 先把所有 `currentValue = 0`
2. `applyAllJointDrives` → 所有关节在零位懒捕获 base
3. 恢复真实 `currentValue`
4. 再 `applyAllJointDrives` → 正常驱动

**相关 bug**：[#22](bugfix-log.md)

---

## 场景 4：Gizmo 拖动旋转突然跳变 360°

**原因** — 四元数双重覆盖：`q` 和 `-q` 表示同一旋转，但 `2 * atan2(sinHalf, cosHalf)` 提取的角度会跳 ±2π。TransformControls 大角度时可能把 current quaternion 归一化到"最短路径"表示，触发符号翻转。

**检测方法** — 不需要专门脚本，直接拖动观察。

**修复方向**（已在 [SceneManager.js](../src/core/SceneManager.js) 修复）：角度解缠，保持相邻帧 angle 差值 ≤ π，超过就加减 2π 补偿：

```js
if (this._gizmoLastAngle !== undefined) {
  while (angle - this._gizmoLastAngle > Math.PI) angle -= 2 * Math.PI;
  while (angle - this._gizmoLastAngle < -Math.PI) angle += 2 * Math.PI;
}
this._gizmoLastAngle = angle;
```

每次新拖拽时重置 `_gizmoLastAngle = undefined`。

**相关 bug**：[#23](bugfix-log.md)

---

## 场景 5：判断"归零策略"是否正确

**用途** — 修改导出流程时，验证 `applyJointDrive(value=0)` 是否真的能把模型还原到自然零位。

**检测流程**

```js
__diagZ.snapshot("before")
__diagZ.testNaturalPose()
__diagZ.testZeroPose()
__diagZ.snapshot("zeroKeepBase")
__diagZ.restore()
__diagZ.testZeroPoseClearBase()
__diagZ.snapshot("zeroClearBase")
__diagZ.restore()
__diagZ.compare()
```

**结论对照**
- **方案A (`before` 和 `zeroKeepBase` 只差有 value 的关节)**：归零生效 ✅
- **方案B (和 `before` 完全一致)**：清空 base → 懒捕获从**驱动态**重建 → 没归零 ❌

**相关 bug**：[#20, #21](bugfix-log.md)

---

## 场景 6：模型某片零件一直发光高亮

**原因** — `SelectionManager` 高亮机制 clone material 并修改 `emissive`。导出前没清除选中 → GLTFExporter 把带 emissive 的 material 烘焙进 GLB。

**快速检测**

```js
let c = null;
__mf.sceneManager.sceneRoot.traverse(o => { if (o.name === '_CS19110') c = o; });
console.log('emissive:', c?.material?.emissive);
// 如果 emissive 不是 (0, 0, 0) 就是被烘焙进去了
```

**修复方向**（已实现）— 导出前 `selectionManager.clearSelection()`，导出后 `selectionManager.selectObject(savedSelection)`。

**相关 bug**：[#17, #25, #42](bugfix-log.md)

---

## 场景 7：承载锚点 / 叉齿 mesh 分析

**典型症状**
- 🚀 一键生成后播放到 t=attach，cargo 瞬移 / 飘空 / 穿地
- 叉齿底面位置不对，fork_anchor_zero 数值异常

**检测流程**

```js
__diagFA.run()                // 完整分析：叉齿 mesh + bbox + fork_anchor_zero + PKF eval
__diagFA.listForkSubmeshes()  // 只看叉齿子树所有 mesh 的 bbox（按 min.y 升序）
```

**关注输出**
- **3️⃣ 叉齿子树所有 mesh**：看有几个 mesh —— 1 个 = 合并 mesh（启发式失效）；>1 = 独立 mesh
- **5️⃣ fork_anchor_zero**：x/y/z 数值是否合理（对照 cargo 位置）
- **7️⃣ / 8️⃣ PKF eval**：attach 时各关节实际驱动值；与期望值对比找漏生成 / 数值错位

**推荐配合**：

```js
// 看 cargo 在 t=attach 前后的世界位置变化（判断有无 teleport）
(() => {
  const { THREE, sceneManager: sm, keyframeManager: km } = window.__mf;
  const cargo = sm.sceneRoot.getObjectByName('cargo');
  sm.sceneRoot.updateMatrixWorld(true);
  const wp = cargo.getWorldPosition(new THREE.Vector3());
  console.log(`t=${km.currentTime.toFixed(2)}s cargo: (${wp.x.toFixed(3)}, ${wp.y.toFixed(3)}, ${wp.z.toFixed(3)})`);
})();
```

**相关 bug**：[#36, #37, #40, #47-#52](bugfix-log.md) + [gotchas/007-merged-mesh-bbox-trap](gotchas/007-merged-mesh-bbox-trap.md)

---

## 场景 8：叉车 14 段模板路径验证（mvp3）

**典型症状 / 触发时机**
- 🚀 一键生成选了"模板"后验证是否真的零瞬移
- 想看 AI 返回的节奏是什么 / 编译后的 14 段结构
- 怀疑 attach 前后 cargo 世界坐标不连续（瞬移）
- 想做循环回 t=0 时 cargo 回原位验证

**检测流程**

```js
__diagTpl.all()                 // 一把梭：健康 + 编译 + reparent 时间 + 级联 + 公式限位 + 循环 + 时间采样

// 或按需单跑：
__diagTpl.health()              // _pkfTemplateMeta / lastTemplate 是否就绪
__diagTpl.compiled()            // 看 14 段结构 + 参数 + reparent 事件
__diagTpl.reparentTiming()      // attach.t 应 = 段 3 t_end；detach.t 应 = 段 11 t_end
__diagTpl.cascadeCheck()        // 每段 value_start 严格等于同 joint 上一段 value_end
__diagTpl.formulas()            // 逐段 eval value_end + 对比关节 limits（超限会被钳位）
__diagTpl.loopBoundary()        // seek t=0 后 cargo 偏移应 < 0.01m
__diagTpl.playbackSample()      // 每段末尾 cargo/fork 世界位置采样（默认 14 点，attach/detach 连续性）
__diagTpl.playbackSample([3.0, 3.01, 3.99, 4.0])  // 自定义采样 attach 前后
```

**关注输出**
- **compiled → steps 表**：每段 seg/joint/value_start/value_end/easing——对照 §4 模板表确认公式正确
- **reparentTiming**：所有 OK 列为 true，否则编译器 bug
- **cascadeCheck**：空 problems → ✅；有 problems → compileTemplate 的 prevValueByRole 级联错
- **formulas**：**超限** 列有 ⚠️ 的段会被钳位 → 动作不到位；需要调 cargo 位置或关节行程
- **loopBoundary**：偏移 < 0.01 = cargo 正常回原位；偏移大 = 可能 originalWorldTransforms 未快照
- **playbackSample**：attach 前后 t（如 3.0 vs 3.01）cargo 世界坐标差 > 0.05m = 瞬移未消除

**相关 bug / 契约**：[#47-#52](bugfix-log.md) + [concepts/forklift-pickup-template](concepts/forklift-pickup-template.md)

---

## 附：单行快速检查命令

除了完整诊断脚本，以下单行 Console 命令也常用：

```js
// 查看所有关节定义（含 parentId/childId）
__mf.getJointDefs().map(d => ({ name: d.name, parentId: d.parentId?.slice(0,8), childId: d.childId?.slice(0,8), value: d.currentValue }))

// 检查 parentId 是否能在场景树找到
__mf.getJointDefs().map(d => { let found = null; __mf.sceneManager.sceneRoot.traverse(o => { if(o.uuid === d.parentId) found = o.name || o.type; }); return d.name + ': ' + (found || '❌'); })

// 检查 parentId 是否等于 scene parent（应 false 表示正确的链式关节）
__mf.getJointDefs().map(d => { let c = null; __mf.sceneManager.sceneRoot.traverse(o => { if(o.uuid === d.childId) c = o; }); return d.name + ': parentId===sceneParent? ' + (d.parentId === c?.parent?.uuid); })

// 对比关节的 stored base 和当前 should_be（不一致说明 base 过时）
__mf.getJointDefs().map(d => { let jp = null, c = null; __mf.sceneManager.sceneRoot.traverse(o => { if(o.uuid === d.parentId) jp = o; if(o.uuid === d.childId) c = o; }); if(!jp||!c) return d.name+': NOT FOUND'; jp.updateMatrixWorld(true); c.updateMatrixWorld(true); const cwp = c.getWorldPosition(new __mf.THREE.Vector3()); const correct = jp.worldToLocal(cwp.clone()); return d.name + ': stored=(' + d.baseTransform.tx.toFixed(2) + ',' + d.baseTransform.ty.toFixed(2) + ',' + d.baseTransform.tz.toFixed(2) + ') should_be=(' + correct.x.toFixed(2) + ',' + correct.y.toFixed(2) + ',' + correct.z.toFixed(2) + ')'; })

// 查看 child 的当前 local position
__mf.getJointDefs().map(d => { let c = null; __mf.sceneManager.sceneRoot.traverse(o => { if(o.uuid === d.childId) c = o; }); return d.name + ': pos=(' + c?.position.x.toFixed(2) + ',' + c?.position.y.toFixed(2) + ',' + c?.position.z.toFixed(2) + ')'; })

// 快速检查高亮是否被烘焙进材质
let c = null; __mf.sceneManager.sceneRoot.traverse(o => { if (o.name === '_CS19110') c = o; }); console.log('emissive:', c?.material?.emissive);

// 看 🚀 一键生成的 AI 输出原文 + sanitize warnings
window.__mf.lastOneshot?.l1                   // L1 拆解结果
window.__mf.lastOneshot?.l2                   // L2 PKF 生成原文
window.__mf.lastOneshot?.l2Patched?.warnings  // sanitize 日志（approach_gap 覆盖 / 公式清洗）
```

---

## 相关文档

- [CLAUDE.md](../CLAUDE.md) — 协作手册，`window.__mf` 钩子列表
- [docs/bugfix-log.md](bugfix-log.md) — 完整 bug 修复历史，每个 bug 的"排查"字段都标了用哪个脚本
- [docs/gotchas/](gotchas/) — 按主题分类的深度踩坑档案
