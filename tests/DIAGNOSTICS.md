# MotionForge 诊断脚本指南

本目录包含 5 个浏览器 Console 诊断脚本，用于定位关节系统、导出导入 roundtrip、动画播放相关问题。

## 通用用法

1. 启动 MotionForge (`npm run dev`)，加载模型
2. 按 **F12** 打开 DevTools → **Console**
3. 打开对应 `tests/diag-*.js` 文件，**全选复制**脚本内容
4. 粘贴到 Console，回车 → 看到 `✅ ... 已加载`
5. 按脚本说明调用 `__diagX.xxx()` 方法

所有脚本都通过 `window.__mf`（在 [main.js](../src/main.js) 底部注册）访问内部状态，只读诊断不修改源代码。

---

## 脚本索引

| 脚本 | 诊断范围 | 触发命令 |
|------|---------|---------|
| [diag-export-roundtrip.js](diag-export-roundtrip.js) | 导出前/导入后的场景树、关节、动画结构差异 | `__diagRT.snapshot/diff` |
| [diag-roundtrip-transform.js](diag-roundtrip-transform.js) | 节点世界 transform 在 roundtrip 前后的精确差异 | `__diagT.phaseA/B/C/compare` |
| [diag-joint-integrity.js](diag-joint-integrity.js) | 关节定义的 parentId/childId 引用完整性 | `__diagJ.check()` |
| [diag-zero-pose.js](diag-zero-pose.js) | 对比不同"归零策略"的效果 | `__diagZ.testZeroPose/testNaturalPose` |
| [diag-animation.js](diag-animation.js) | 动画播放过程中各时间点的关节状态 | `__diagA.scanClip/at/keyframes` |

---

## 场景 1：导入后模型变形 / 下沉 / 位置错乱

### 可能原因

- GLB roundtrip 层级丢失或根节点被重命名（如 `三向车.glb` → `AuxScene`）
- `alignObjectToGround` 双重对齐或未对齐，导致整体 Y 方向偏移
- 关节 `baseTransform` 在错误时机捕获，造成 double-apply（导入时驱动叠加两次）

### 检测流程

```js
// 1. 导出前 → 导入前运行：
__diagT.phaseA()                      // 快照"驱动态"+"零位态"

// 2. 正常导出 ZIP → 导入 ZIP

// 3. 导入后立即运行：
__diagT.phaseB()                      // 快照导入态
__diagT.phaseC()                      // 把关节全部归零，快照导入零位态
__diagT.compare()                     // 输出 4 组对比 + 自动结论
```

### 结论对照表

| 导入态 ≈ 驱动态？ | 导入零位 ≈ 原始零位？ | 结论 |
|---|---|---|
| Yes | Yes | GLB 忠实 + double-apply |
| Yes | No | GLB 忠实 + 零位有偏差 |
| No | Yes | 导入流程改变了 transform |
| No | No | GLB 序列化/反序列化有损 |

---

## 场景 2：关节父级引用丢失 / 零件断开 / 链式关节失效

### 典型症状

- 导入后 "_CS19110 飞出去"
- "_CS198 不跟随运动"
- 关节父级在左侧面板消失

### 可能原因

- 导入时 `parentId` 被错误地覆盖为 `childObj.parent.uuid`（scene parent，无名 Object3D 包装），而不是按 `parent_name` 解析原始逻辑父级
- `childId`/`parentId` 在 GLB roundtrip 后 UUID 变化，引用断裂

### 检测流程

```js
// 加载完（或导入后）直接运行：
__diagJ.check()
```

关注输出：

- **① 场景树结构**：看 `insertedGroup` 是否还在、层级是否正常
- **③ 关节定义完整性**：每个关节的 `childId`/`parentId` 是否都找到
  - `parentId === sceneParent? true` + 父级是无名 `Object3D` → **parentId 被错误地解析成了 scene parent（bug）**
  - `parentId === sceneParent? false` → parentId 指向真实逻辑父级（正确）
- **④ 关节链分析**：有无链式关系（`A ← 依赖 → B`），独立关节列表
- **🏁 总结**：childId/parentId 失效数量

---

## 场景 3：导入后播放动画组件整体下沉 / 链式关节错位

### 可能原因

- 导入时 `applyAllJointDrives` 直接用 JSON 里的 `currentValue`（非零）触发拓扑排序
- 父级 joint 先驱动 → 子级 `lazy capture` 的 base 是父级**驱动态**下的相对位置
- 之后动画把父级改回零位，子级相对**下沉父级位移量**

### 检测流程

```js
// 1. 看关键帧原始数据
__diagA.keyframes()

// 2. 扫描 clip 多个时间点（默认 6 点）
__diagA.scanClip()

// 3. 查看任意时间点
__diagA.at(2.5)
```

关注输出：

- **🔍 检测：哪些节点 Y 方向下降？**：如果多个零件的 Y 变化范围相同 → 整体下沉，说明链式关节 base 错位
- **drift warning** (来自 [KeyframeManager.js:340](../src/core/KeyframeManager.js)) 里的 `jointParent: XXX` 显示实际链式关系
- 每个时间点的 `base=(...)` vs 驱动下的 `worldY` → 看是否合理

### 修复方向

导入时**两阶段**应用关节：
```
① 恢复 joints，但先把所有 currentValue 设为 0
② applyAllJointDrives → 所有关节在零位懒捕获 base
③ 恢复真实 currentValue
④ 再 applyAllJointDrives → 正确驱动
```

---

## 场景 4：Gizmo 拖动旋转突然跳变 360°

### 典型症状

- 逆时针拖动叉齿到某个角度后继续拖，角度突然跳变
- 视觉上零件瞬间"翻一圈"

### 原因

四元数双重覆盖：`q` 和 `-q` 表示同一旋转，但 `2 * atan2(sinHalf, cosHalf)` 提取的角度会跳 ±2π（360°）。TransformControls 在大角度时可能把 current quaternion 归一化到"最短路径"表示，触发符号翻转。

### 检测方法

不需要专门脚本，直接拖动观察。

### 修复方向（已在 [SceneManager.js](../src/core/SceneManager.js) 修复）

角度解缠：保持相邻帧 angle 差值 ≤ π，超过就加减 2π 补偿：

```js
if (this._gizmoLastAngle !== undefined) {
  while (angle - this._gizmoLastAngle > Math.PI) angle -= 2 * Math.PI;
  while (angle - this._gizmoLastAngle < -Math.PI) angle += 2 * Math.PI;
}
this._gizmoLastAngle = angle;
```

每次新拖拽时重置 `_gizmoLastAngle = undefined`。

---

## 场景 5：判断"归零策略"是否正确（导出前零位化）

### 用途

在修改导出流程时，验证 `applyJointDrive(value=0)` 是否真的能把模型还原到自然零位。

### 检测流程

```js
__diagZ.snapshot("before")             // 记录当前状态
__diagZ.testNaturalPose()              // 查看 base vs child.position 是否一致
__diagZ.testZeroPose()                 // 方案A：value=0 保留base
__diagZ.snapshot("zeroKeepBase")
__diagZ.restore()
__diagZ.testZeroPoseClearBase()        // 方案B：value=0 清空base
__diagZ.snapshot("zeroClearBase")
__diagZ.restore()
__diagZ.compare()                      // 两两对比
```

### 结论对照

- **方案A (`before` 和 `zeroKeepBase` 只差有 value 的关节)**：归零生效，GLB 会存真零位 ✅
- **方案A (差异为 0)**：所有 value 本来就是 0，归零也是 0 ✓
- **方案B (和 `before` 完全一致)**：清空 base → 懒捕获从**驱动态**重建 → 没归零 ❌
- **方案B (有差异)**：说明懒捕获在某些条件下能正确归零，但不稳定

---

## 场景 6：模型上一片零件一直发光高亮

### 原因

`SelectionManager` 高亮机制 clone material 并修改 `emissive`。导出前没清除选中 → GLTFExporter 把带 emissive 的 material 烘焙进 GLB → 导入后一直发光。

### 快速检测

```js
// 随便挑一个对象检查
let c = null;
__mf.sceneManager.sceneRoot.traverse(o => { if (o.name === '_CS19110') c = o; });
console.log('emissive:', c?.material?.emissive);
// 如果 emissive 不是 (0, 0, 0) 就是被烘焙进去了
```

### 修复方向（已在导出逻辑修复）

导出前 `selectionManager.clearSelection()`，导出后 `selectionManager.selectObject(savedSelection)`。

---

## 手动快速检查片段

除了完整脚本，以下单行 Console 命令也常用：

```js
// 查看所有关节定义（含 parentId/childId）
__mf.getJointDefs().map(d => ({ name: d.name, parentId: d.parentId?.slice(0,8), childId: d.childId?.slice(0,8), value: d.currentValue }))

// 检查 parentId 是否能在场景树找到
__mf.getJointDefs().map(d => { let found = null; __mf.sceneManager.sceneRoot.traverse(o => { if(o.uuid === d.parentId) found = o.name || o.type; }); return d.name + ': ' + (found || '❌'); })

// 检查 parentId 是否等于 scene parent（isParentSameAsSceneParent）
__mf.getJointDefs().map(d => { let c = null; __mf.sceneManager.sceneRoot.traverse(o => { if(o.uuid === d.childId) c = o; }); return d.name + ': parentId===sceneParent? ' + (d.parentId === c?.parent?.uuid); })

// 对比关节的 stored base 和当前 should_be
__mf.getJointDefs().map(d => { let jp = null, c = null; __mf.sceneManager.sceneRoot.traverse(o => { if(o.uuid === d.parentId) jp = o; if(o.uuid === d.childId) c = o; }); if(!jp||!c) return d.name+': NOT FOUND'; jp.updateMatrixWorld(true); c.updateMatrixWorld(true); const cwp = c.getWorldPosition(new __mf.THREE.Vector3()); const correct = jp.worldToLocal(cwp.clone()); return d.name + ': stored=(' + d.baseTransform.tx.toFixed(2) + ',' + d.baseTransform.ty.toFixed(2) + ',' + d.baseTransform.tz.toFixed(2) + ') should_be=(' + correct.x.toFixed(2) + ',' + correct.y.toFixed(2) + ',' + correct.z.toFixed(2) + ')'; })

// 查看 child 的当前 local position
__mf.getJointDefs().map(d => { let c = null; __mf.sceneManager.sceneRoot.traverse(o => { if(o.uuid === d.childId) c = o; }); return d.name + ': pos=(' + c?.position.x.toFixed(2) + ',' + c?.position.y.toFixed(2) + ',' + c?.position.z.toFixed(2) + ')'; })
```

---

## 附：__mf 暴露的调试钩子

在 [main.js](../src/main.js) 底部注册，Console 随时可用：

```js
__mf.THREE              // THREE.js 命名空间（脚本用它构造 Vector3/Quaternion）
__mf.sceneManager       // SceneManager 实例（有 sceneRoot / scene / camera / jointGizmo）
__mf.keyframeManager    // KeyframeManager（jointDefinitions / globalClips / applyAllJointDrives / evaluateAllAt）
__mf.selectionManager   // SelectionManager（selectedObject / clearSelection / selectObject）
__mf.editableObjects()  // 当前所有可编辑对象（不含无名 Object3D 包装）
__mf.getJointDefs()     // 所有关节定义的快照
```
