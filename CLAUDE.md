# MotionForge — Claude 协作说明

## 项目背景

MotionForge 是 Web 端 3D 模型处理工具，输出标准化的运动资产包（ZIP：manifest / joints / motion / pkf / model.glb）。技术栈：Three.js + Vite。

核心系统：
- **FK 关节系统**（URDF 风格，四元数 baseTransform，拓扑排序）
- **全局关键帧**（项目级 clips，捕获所有关节 value）
- **PKF 参数化公式**（parameters + steps，支持 AI 生成）
- **GLB ZIP Roundtrip**（schema v4，GLTFExporter 序列化当前场景）

详见 [docs/BUGFIX-LOG.md](docs/BUGFIX-LOG.md) 了解历史演进和踩过的坑。

---

## 协作规则

### 每次修复 bug 或做重要改动，必须更新日志

完成任何 bug 修复、架构调整、behavior 改动后，**必须**在 [docs/BUGFIX-LOG.md](docs/BUGFIX-LOG.md) 追加一条记录，格式：

```markdown
### #编号 简短标题

- **症状**：用户看到什么现象
- **排查**：用了什么诊断脚本/方法找到问题
- **根因**：具体是什么代码/机制导致的
- **修复**：改了什么（文件 + 关键变更）
```

编号延续 BUGFIX-LOG.md 最后一条继续递增。

### 新增诊断脚本，必须同步更新指南

在 [tests/](tests/) 新增 `diag-*.js` 脚本后，**必须**同步更新 [tests/DIAGNOSTICS.md](tests/DIAGNOSTICS.md)：
- 加到脚本索引表
- 如果对应新的 bug 场景，追加一个"场景 N"章节

### 提交习惯

- 重要节点 commit 时 message 带上版本标识（如 `v8`、`v9`）
- `zip/` 已在 `.gitignore`，不要误 commit 导出产物
- 大二进制文件（模型、ZIP）一律不入 git

---

## 调试惯例

### `window.__mf` 钩子

`main.js` 底部注册，Console 随时可用：

```js
__mf.THREE              // THREE 命名空间
__mf.sceneManager       // SceneManager 实例
__mf.keyframeManager    // KeyframeManager 实例
__mf.selectionManager   // SelectionManager 实例
__mf.editableObjects()  // 当前可编辑对象列表
__mf.getJointDefs()     // 所有关节定义快照
```

### 诊断脚本优先

遇到难定位的 bug，**先写诊断脚本再改代码**。盲改容易引入新 bug。已有脚本见 [tests/DIAGNOSTICS.md](tests/DIAGNOSTICS.md)。

---

## 代码风格

- 中文注释、关键函数写文档，解释"为什么"而不是"做什么"
- 关键算法逐行注释（参考 [src/core/KeyframeManager.js](src/core/KeyframeManager.js) 里 `applyJointDrive` 的写法）
- 模块顶部写简短 block 注释说明该模块职责

---

## 核心架构约束

以下设计决定不要随意改动（都是踩过坑换来的）：

1. **`baseTransform` 存四元数**（qx/qy/qz/qw），**不要**改回 Euler — 万向锁
2. **origin 是 parent-local** 空间（URDF 风格），**不是**世界坐标
3. **关节链驱动用拓扑排序**，不依赖场景树层级
4. **跨 roundtrip 的标识用 name**（joint name / parent_name），**不要**依赖 UUID
5. **导出 GLB 前必须归零** 关节 + 清除选中（避免 emissive 烘焙 / double-apply）
6. **导入后必须两阶段应用** 关节（先全零化懒捕获 base，再恢复 value）
7. **懒捕获 base 在 parent=零位时** 发生，任何时刻父级驱动态下捕获都是错的

---

## 当前版本

最新 commit：`e847818` — 新增诊断脚本指南 tests/DIAGNOSTICS.md

最近 v8 修复：
- 链式关节导入后整体下沉（两阶段应用）
- 导出前清除选中（避免高亮 emissive 烘焙）
- Gizmo 旋转角度解缠（避免 360° 跳变）
