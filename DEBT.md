# MotionForge 债务地图

> 生成日期：2026-04-15（v11 演示稳定版之后）
> 最后更新：2026-04-16
> 扫描范围：src/core/*、src/main.js、src/ui/EditorUI.js、tools/conversion-service.js
> 方法：两个并行 Explore 扫描（Three.js 生命周期 + 状态同步/错误处理），去重合并

## 已修复清单

| # | 内容 | 修复版本 |
|---|---|---|
| #5 | PKF 步骤错误静默跳过 → console.warn 去重显示 | v12 |
| #10 | AI 模糊匹配过宽 → 精确优先 + 唯一命中 fallback | v12 |
| #32 | 导出异常卡零位 → try/finally 恢复 | v12+ |
| #33 | 关节链环检测缺失 → setJointDef 入口拒绝成环 | v12+ |
| #34 | FBX 源 roundtrip 根节点改名 → manifest 保存 root_name | v12+ |
| #35 | Fixed 类型不跟 joint parent → applyJointDrive 加 fixed 分支 | v12+ |

## 剩余债务（B 档）

**P2 本轮跳过**，下次打磨再说。
**不碰的**：FK 求解器、roundtrip schema、拓扑排序逻辑（被 29 个 bug 磨过，fragile 但正确）。

**修复顺序**（每改完一组跑完整冒烟：加载→配关节→关键帧→AI 生 PKF→导出→导入→播放）：
1. P0 资源泄漏（#1/#2）— 一次改完，影响最广
2. P0 状态错乱（#3/#4/#5）— 独立改，每条单独验证
3. P1 防御性改动（#6-#10）— 按文件就近合并

---

## P0 严重 — 会触发可见 bug 或持续内存泄漏

### #1 sceneRoot 切换时不 dispose 旧模型资源
- **位置**：[src/core/SceneManager.js:86-89](src/core/SceneManager.js#L86)（`setSceneRoot`）
- **现象**：用户连续加载多个 GLB/USD（比如 30MB → 40MB），只 `scene.remove()` 旧 root，**geometry/material/texture 都不 dispose**，GPU 内存线性累加
- **修复**：`setSceneRoot` 开头递归 traverse 旧 root，dispose 所有 geometry + material（含 material 数组 / texture maps）
- **风险**：低。加 dispose 不破坏现有功能
- **代码示例**：
  ```js
  if (this.sceneRoot) {
    this.sceneRoot.traverse((c) => {
      if (c.geometry) c.geometry.dispose();
      if (c.material) {
        (Array.isArray(c.material) ? c.material : [c.material]).forEach((m) => {
          for (const k in m) { if (m[k]?.isTexture) m[k].dispose(); }
          m.dispose();
        });
      }
    });
    this.scene.remove(this.sceneRoot);
  }
  ```

### #2 SelectionManager clone material 永不释放
- **位置**：[src/core/SelectionManager.js:75-76](src/core/SelectionManager.js#L75)（`applyHighlight`）
- **现象**：每次选中新对象 clone 一份 material（避免污染共享 material，#25），但换选时旧 clone material **不 dispose**。用户点 100 个 mesh → 100 份孤立 material
- **修复**：`clearHighlight` 里如果 `userData._ownMaterial`，dispose 完再还原
- **风险**：低。dispose 的是 clone 出来的副本，不影响原材质

### #3 Undo/Redo 覆盖 role 字段为空
- **位置**：[src/core/KeyframeManager.js:762-771](src/core/KeyframeManager.js#L762)（`restoreState`）
- **现象**：`pushUndoSnapshot` 里快照是改动**前**状态。用户先编辑关键帧（role 未改动），Ctrl+Z → 恢复到没有 role 的旧快照 → role 被清空
- **修复**：`restoreState` 遇到 role 为空的情况时保留当前值（向后兼容老快照），或确保所有快照点都序列化完整 role
- **建议实现**：`role: d.role !== undefined ? d.role : (existing?.role || '')`
- **风险**：中。需测试 undo 链式操作不丢其他字段
- **验证**：
  1. 给关节设 role="叉齿侧移"
  2. 编辑 duration/关键帧等非 role 操作
  3. Ctrl+Z 到最早
  4. 检查 `__mf.getJointDefs().map(d => ({ name: d.name, role: d.role }))` — role 不应变空

### #4 AI 422 错误前端丢失 `available_roles`
- **位置**：[src/main.js:1057-1073](src/main.js#L1057)（`requestAiGeneratePkf` catch 块）
- **现象**：后端返回 `{error, available_roles}` 让用户知道模型有哪些角色可选，前端只显示 error 文本，available_roles 被丢
- **修复**：catch 里检查 body 是否有 `available_roles`，拼到错误消息里显示
- **风险**：无。只改错误显示路径

### #5 PKF 步骤求值失败静默跳过
- **位置**：[src/core/KeyframeManager.js:870](src/core/KeyframeManager.js#L870) + [src/main.js:1356-1370](src/main.js#L1356)
- **现象**：步骤引用已删除的参数/关节 → `evaluatePkfAt` 返回 error 或关节查找失败 → 代码直接 `return` 不报错 → 用户看动画少了动作但不知道哪一步错
- **修复**：`applyPkfAtTime` 收集 error，通过 `ui.setLoadStatus` 或 PKF 预览区显示"步骤 X 错误：..."
- **风险**：低。只是加错误输出

---

## P1 中等 — 特定场景触发，防御性改动

### #6 JSON.parse 异常后状态未重置
- **位置**：[src/main.js:544,628,678,737](src/main.js#L544)（`handleImportPackage`）
- **现象**：损坏 ZIP 导入失败时，catch 只显示错误文本，但 sceneRoot 可能已部分加载，editableObjects / keyframeManager 状态混乱，用户看似能继续操作但其实是半毁状态
- **修复**：catch 里调用 `sceneManager.setSceneRoot(null)` + `editableObjects=[]` + `keyframeManager.reset()`（如果有 reset，没有就清 `jointDefinitions` 和 `globalClips`）
- **风险**：低。失败路径的清理

### #7 jointConfigPanel 切换面板时监听泄漏
- **位置**：[src/ui/EditorUI.js:760-1043](src/ui/EditorUI.js#L760)（`showJointConfigPanel`）
- **现象**：每次打开面板注册 15+ 个 listener。`hideJointConfigPanel` 只 `panel.remove()` → DOM 节点被 GC，但 closure 引用 listener + 其捕获的上下文
  - 注意：现代浏览器会在 DOM 节点被完全释放时回收 listener，但由于 closure 持有 `handlers`/`currentDef`，可能阻止释放
- **修复**：最简方案 — 在所有 listener 里不持有大对象的强引用（通过 `this.xxx` 间接访问），或保存 cleanup 数组在 hide 时遍历 removeEventListener
- **风险**：中。listener 管理改动面较大，建议仅改明显泄漏的，不做全面重构

### #8 window 全局 listener 无 cleanup
- **位置**：[src/main.js:1458-1468](src/main.js#L1458)（resize/wheel/keydown）
- **现象**：SPA 路由切换 / HMR 时不会清。当前项目是单页直跑，实际影响小
- **修复**：保存 handler 引用，暴露 cleanup 函数。**HMR 场景**额外加 `import.meta.hot.dispose(cleanup)`
- **风险**：低
- **ROI**：本轮可跳过（当前单页场景不触发），但加上 HMR 清理能避免开发时 RAF 叠加

### #9 空 clip 切换后关节值不归零
- **位置**：[src/core/KeyframeManager.js:544-555](src/core/KeyframeManager.js#L544)（`evaluateAllAt`）
- **现象**：切到无关键帧的 clip，`evaluateAllAt` 直接 return，关节保留上个 clip 末尾值。用户在新 clip 添加关键帧 → 起点是脏值
- **修复**：空 clip 分支把所有 `def.currentValue = 0` 再 return
- **风险**：中。可能影响 "空 clip 保留上帧预览" 这种未明确的行为。建议：如果改了发现别人依赖旧行为，回滚
- **验证**：创建 clip_A 关键帧（45°）→ 创建空 clip_B → 切到 B → `__mf.getJointDefs()` 所有 currentValue 应为 0

### #10 AI 返回步骤名模糊匹配过宽
- **位置**：[tools/conversion-service.js:323-334](tools/conversion-service.js#L323)
- **现象**：`n.includes(step.joint) || step.joint.includes(n)` 双向子串匹配。如果 AI 输出 "_CS" 会同时命中 "_CS198" 和 "_CS19110"
- **修复**：改为精确匹配优先，fallback 时要求 `step.joint.length > 3` 才做子串匹配
- **风险**：低。收紧匹配可能导致个别 AI 拼错的关节识别不到，但"识别不到"比"错误匹配"好（前者有显式报错，后者静默错动）

---

## P2 轻微 — 本轮跳过，下次再说

| # | 位置 | 问题 | 何时再做 |
|---|---|---|---|
| P2-1 | KeyframeManager.applyAllJointDrives | 每帧 traverse 建 nodeMap，大场景（1000+）卡 | 接到大模型测试再做 |
| P2-2 | EditorUI.renderObjectList | innerHTML 全量重建 | 节点数 > 200 出现明显卡顿再做 |
| P2-3 | SceneManager.dispose | GridHelper/pivotMarker/Lights 不 dispose | 低优先 |
| P2-4 | RAF 无 cancel | 仅 HMR 场景累积，生产无影响 | 和 #8 一起做 |
| P2-5 | currentValue 类型断言 | 只在手改 devtools 时触发 | 不做 |
| P2-6 | refreshObjectTree 无防抖 | 拖拽大场景微卡 | 和 P2-2 一起做 |
| P2-7 | scenePath 临时 group 影响 | 用户极少撤销 insertGroup | 不做 |
| P2-8 | 关键帧外推策略 | 用户不会拖出范围 | 不做 |
| P2-9 | PKF 步骤导入 joint 空校验 | 只在手改 pkf.json 触发 | 不做 |

---

## 架构坏味道（本轮不动）

1. **main.js 1400+ 行**：有该下沉的逻辑（`applyPkfAtTime`、`buildExportClips`、`getScenePath` 等应在 core/）。但重构面积大，等 AI 打关节方向定了一起做
2. **三套状态管理**：`keyframeManager`、`selectionManager`、main.js 里的 `editableObjects`/`sceneTreeNodes`/`undoStack`。没有集中入口，同步靠约定
3. **Undo 只是 serializeState/restoreState 快照**：每次全量序列化，场景大时会慢
4. **没有测试**：所有回归靠手动冒烟和 5 个 console 诊断脚本

这些都是 C 档（架构重构）的目标，不在 B 档范围。

---

## 冒烟测试流程（每条改动后跑一遍）

1. `npm run dev`
2. 加载 `三向车.glb`
3. 配 4 个关节 + role（`_CS198`→叉齿侧移，`_CS19110`→叉齿旋转，`_____10`→门架升降，`三向车.glb`→车体前进）
4. 打 2 个关键帧（0s / 5s）
5. AI 输入 "叉齿侧移 0.5 米，升降 0.3 米"
6. 应用 PKF → 切"PKF 驱动播放" → 播放完整一遍
7. 导出 ZIP
8. 刷新页面 → 导入 ZIP
9. 验证关节 role 保留、动画正常播放
10. 打开 DevTools → 看 console 无新增警告/错误
