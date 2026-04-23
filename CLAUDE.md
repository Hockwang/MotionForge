# MotionForge — Claude 协作手册

> **本文档只放"每轮都必须生效的规则"**：架构红线、协作流程、调试钩子。判断一条内容该不该留在这里，就问：这次对话如果没读到它，我会做错事吗？
>
> 详细 bug 历史 → [docs/bugfix-log.md](docs/bugfix-log.md)
> 诊断脚本完整用法 → [docs/diagnostics.md](docs/diagnostics.md)
> 知识库按主题入口 → [docs/index.md](docs/index.md)

---

## 项目文档矩阵（按角色找入口）

| 你是谁 / 想做什么 | 先读 |
|---|---|
| 新人 / 新 chat 接入项目 | [README.md](README.md)（3 分钟知道项目是什么） |
| 看完整产品能力和操作流程 | [FLOW.md](FLOW.md) |
| **改代码 / 定位 bug / 理解架构** | 本文档（红线 + 钩子）+ [docs/index.md](docs/index.md)（知识库索引）|
| 查某个历史 bug 怎么修的 | [docs/bugfix-log.md](docs/bugfix-log.md) |
| 用诊断脚本排错 | [docs/diagnostics.md](docs/diagnostics.md) |
| 了解 AI 打关节研究方向 | [AI-RIGGING-README.md](AI-RIGGING-README.md) |
| 了解当前技术债 | [DEBT.md](DEBT.md) |
| 看二期路线图 | [docs/ROADMAP.md](docs/ROADMAP.md) |

**AI 打关节研究专题**：[HANDOFF.md](docs/ai-rigging/HANDOFF.md) / [RESEARCH-LOG.md](docs/ai-rigging/RESEARCH-LOG.md)

**历史文档**（不再维护）：[docs/archive/](docs/archive/)

---

## 项目背景

MotionForge 是 Web 端 3D 模型处理工具，输出标准化的运动资产包（ZIP：manifest / joints / motion / pkf / model.glb）。技术栈：Three.js + Vite。

**核心系统**：
- **FK 关节系统**（URDF 风格，四元数 baseTransform，拓扑排序）
- **全局关键帧**（项目级 clips，捕获所有关节 value）
- **PKF 参数化公式**（parameters + steps，支持 AI 生成）
- **GLB ZIP Roundtrip**（schema v6，GLTFExporter 序列化当前场景）

**关键文件**：
```
src/
  core/
    AssetLoader.js           # 资产加载分发
    SceneManager.js          # Three.js 场景 / Gizmo
    SelectionManager.js      # 选中与高亮
    KeyframeManager.js       # 关节定义 + 全局关键帧 + FK 求解器 + PKF
    ResultPackageExporter.js # ZIP 结果包导出
  ui/
    EditorUI.js              # 编辑器布局与 UI
  main.js                    # 应用编排（含导入导出流程）
tools/
  conversion-service.js      # AI 后端（L1/L2 + Blender 转换 + sanitize）
```

---

## 核心架构约束（不可随意改动）

以下设计决定**都是踩过坑换来的**。违反前必须先读对应 bug log 条目。

1. **`baseTransform` 存四元数**（qx/qy/qz/qw），**不要**改回 Euler — 万向锁（[#7](docs/bugfix-log.md)）
2. **origin 是 parent-local** 空间（URDF 风格），**不是**世界坐标（[#5](docs/bugfix-log.md)）
3. **关节链驱动用拓扑排序**，不依赖场景树层级（[#8/#10](docs/bugfix-log.md)）
4. **跨 roundtrip 的标识用 name**（joint name / parent_name），**不要**依赖 UUID（[#18/#19](docs/bugfix-log.md)）
5. **导出 GLB 前必须归零**关节 + 清除选中（避免 emissive 烘焙 / double-apply）（[#17/#20](docs/bugfix-log.md)）
6. **导入后必须两阶段应用**关节（先全零化懒捕获 base，再恢复 value）（[#22](docs/bugfix-log.md)）
7. **懒捕获 base 在 parent=零位时**发生，任何时刻父级驱动态下捕获都是错的（[#22](docs/bugfix-log.md)）
8. **导出前"临时归零 → 导出 → 恢复"必须用 try/finally**（[#32](docs/bugfix-log.md)）
9. **关节链不允许成环**，`setJointDef` 设 parentId 时做环检测（[#33](docs/bugfix-log.md)）
10. **snap-attach 的 bbox 必须在 attach 之前算**，否则 `Box3.setFromObject` 会把刚 attach 的 cargo mesh 一起算进去（[#50d](docs/bugfix-log.md)）
11. **承载锚点 ≠ 关节原点**，不要把 `def.origin` 当 cargo 吸附点用（origin 是 URDF 旋转支点）（[#51/#52](docs/bugfix-log.md)）
12. **任何 data-out 到外部系统**（AI / 导出 / 日志）都走同一个 helper，不允许双实现（[#38](docs/bugfix-log.md)）

---

## 协作规则

> 完整协作流程（commit / PR / 文档同步 / dev setup）见 [CONTRIBUTING.md](CONTRIBUTING.md)。
> 这里只保留**红线**。

### 1. 修 bug 必须追加 [docs/bugfix-log.md](docs/bugfix-log.md) 条目

编号延续递增（当前最大 #52），格式：

```markdown
#### #编号 简短标题

- **症状**：用户看到什么现象
- **排查**：用了什么诊断脚本/方法找到问题
- **根因**：具体是什么代码/机制导致的
- **修复**：改了什么（文件 + 关键变更）
- **经验教训**（非必需，有新启发再写）：跨 bug 的通用原则
```

### 2. 新增诊断脚本必须更新 [docs/diagnostics.md](docs/diagnostics.md)

- 加到"脚本索引"表
- 对应新 bug 场景的追加"场景 N"子章节

### 3. 文档维护触发条件

| 触发时机 | 写到哪里 |
|---------|---------|
| 做了影响范围 > 1 个文件的架构决策 | `docs/decisions/` 新增 ADR |
| 修了需要诊断脚本才定位的疑难 bug | `docs/gotchas/` 新增条目 |
| 发现新的领域概念需要解释 | `docs/concepts/` 新增文档 |
| 重要里程碑或决策 | 追加到 [docs/log.md](docs/log.md) |
| 任何 bug 修复 | 追加到 [docs/bugfix-log.md](docs/bugfix-log.md) |

### 4. 不能放在 CLAUDE.md 的内容

以下内容**必须**放到 docs/ 下，不要往 CLAUDE.md 加：

- 具体 bug 的排查过程 → `docs/bugfix-log.md`
- 已修 bug 的根因分析 → `docs/bugfix-log.md`
- 诊断脚本详细用法 → `docs/diagnostics.md`
- 经验教训的长篇复盘 → 各 bug 条目内
- 单行快速命令集 → `docs/diagnostics.md` 附录
- 当前版本信息（版本会漂移）→ [README.md](README.md)

---

## 调试钩子（不查就不知道的接口）

`main.js` 底部注册，浏览器 Console 随时可用：

```js
__mf.THREE              // THREE 命名空间（脚本用它构造 Vector3/Quaternion）
__mf.sceneManager       // SceneManager 实例（sceneRoot / scene / camera / jointGizmo）
__mf.keyframeManager    // KeyframeManager（jointDefinitions / globalClips / applyAllJointDrives / evaluateAllAt）
__mf.selectionManager   // SelectionManager（selectedObject / clearSelection / selectObject）
__mf.editableObjects()  // 当前可编辑对象列表（不含无名 Object3D 包装）
__mf.getJointDefs()     // 所有关节定义的快照
__mf.lastOneshot        // 🚀 一键生成最后一次的 AI 请求/响应（{intent, scene, joints, l1, l2, l2Patched}）
__mf.lastTemplate       // 🚀 模板路径最后一次的 {intent, rhythm, compiled}（mvp3）
__mf.trajectoryOverlay  // 🎨 轨迹 overlay（.refresh() 手动刷 / .setEnabled(bool) / .group 看 THREE.Group）
```

**遇到难定位的 bug，先写诊断脚本再改代码**。已有脚本用法见 [docs/diagnostics.md](docs/diagnostics.md)。

⭐ **和 AI / 外部协作时排查 PKF / 动画问题首选**（两种用法同源）：
- **UI 开关**：时间轴右侧 `🎨 轨迹` toggle（mvp3）——打开即在 3D 视口画蓝/橙轨迹 + console 自动打印段表
- **Console 脚本**：粘贴 [tests/diag-template.js](tests/diag-template.js) → `__diagTpl.drawTrajectory()`（同逻辑，但覆盖其他 6 个检测）

**3D 视口截图 + console.table 文字表**一起发：图让人看得到走偏，表让 AI 能精确定位是哪段的公式 / 关节 / 坐标出问题。

---

## 文档目录结构

```
docs/
├── index.md          # 分类导航索引（新 session 从这里开始）
├── log.md            # Append-only 时间线（重要决策/里程碑记录）
├── bugfix-log.md     # Bug 修复完整历史（#1-#56+）
├── diagnostics.md    # 诊断脚本指南（9 脚本 + 8 场景 + 单行命令）
├── architecture/     # 系统架构文档（模块职责、数据流、坐标系）
├── concepts/         # 领域概念（PKF、ZIP schema、forklift-pickup-model）
├── decisions/        # ADR 架构决策记录
├── gotchas/          # 踩坑记录（按主题）
├── raw/              # 草稿/未整理笔记
├── ai-rigging/       # AI 打关节研究专题
├── archive/          # 历史文档（不再更新）
└── schema/           # ZIP 输出格式规范
```

**新 session 接手时的阅读顺序**：
1. [`README.md`](README.md) — 3 分钟了解项目是什么
2. [`CLAUDE.md`](CLAUDE.md)（本文档）— 规则 + 钩子
3. [`docs/index.md`](docs/index.md) — 找到与当前任务相关的文档
4. [`docs/architecture/overview.md`](docs/architecture/overview.md) — 理解模块关系
5. 按需查 [`docs/bugfix-log.md`](docs/bugfix-log.md) / [`docs/diagnostics.md`](docs/diagnostics.md) / 对应 concept + gotcha
