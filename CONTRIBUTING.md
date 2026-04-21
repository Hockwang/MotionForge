# 贡献指南

> 面向改代码 / 修 bug / 加功能的人。纯使用者看 [USER-GUIDE.md](USER-GUIDE.md)。
> 架构细节和历史债务在 [CLAUDE.md](CLAUDE.md)，这里只讲协作规则。

---

## 快速上手

```bash
git clone <repo>
cd MotionForge
npm install
cp .env.example .env  # 填入 AI_API_KEY 等
npm run dev       # 前端（默认 http://localhost:5173）
npm run converter # AI 后端 + Blender 转换（可选，端口 8091）
npm test          # 单元测试（vitest）
```

需要 Node 18+。USD/FBX 转换需本地 Blender（验证路径见 [README.md](README.md#usdfbx-自动转换可选)）。

---

## 改动前必读

1. **[CLAUDE.md 核心架构约束](CLAUDE.md#核心架构约束不可随意改动)** — 9 条红线（四元数 baseTransform / URDF 风格 origin / 拓扑排序 / 导出归零 / 两阶段导入 ...），每条都对应踩过的坑，别绕开
2. **[DEBT.md](DEBT.md)** — 已知技术债，改动可能撞上
3. **[HOW-IT-WORKS.md](HOW-IT-WORKS.md)** — FK 数学、PKF 求值、roundtrip 的原理

---

## 协作规则

### 1. 修 bug 必须更新 CLAUDE.md

完成任何 bug 修复、架构调整、behavior 改动后，在 [CLAUDE.md Bug 修复历史](CLAUDE.md#bug-修复历史) 追加一条：

```markdown
### #编号 简短标题

- **症状**：用户看到什么现象
- **排查**：用了什么诊断脚本/方法找到问题
- **根因**：具体是什么代码/机制导致的
- **修复**：改了什么（文件 + 关键变更）
```

编号延续最后一条递增（当前最大 #35）。这份 log 是团队共享记忆，下次遇到相似症状直接查就能定位。

### 2. 新增诊断脚本必须更新指南

在 [tests/](tests/) 新增 `diag-*.js` 后，同步更新 [CLAUDE.md 诊断脚本指南](CLAUDE.md#诊断脚本指南)：
- 加到脚本索引表
- 如果对应新的 bug 场景，追加"场景 N"子章节

### 3. 版本里程碑更新 CHANGELOG.md

涉及用户可见变化的改动（新功能 / bug 修复 / breaking change）在 [CHANGELOG.md](CHANGELOG.md) 当前版本条目下追加：
- `Added` — 新功能
- `Fixed` — bug 修复（关联 CLAUDE.md bug 编号）
- `Changed` — 行为变更
- `Breaking` — 不兼容改动

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

### 4. Schema 变更必须升级版本号

`manifest.json` / `joints.json` / `motion.json` / `pkf.json` 任何字段增删改都要：
1. 升级 `manifest.schema_version`（v4 → v5）
2. 在 [docs/schema/](docs/schema/) 新建对应版本文档
3. 旧版本文档保留，加迁移说明
4. 导入代码保留旧版兼容逻辑（或明确拒绝并提示）

---

## 写代码的约定

### 注释风格

- **中文注释**，函数级 + 关键逻辑行级
- 函数顶部说清 **做什么 / 输入 / 输出 / 边界**
- 踩坑点（尤其涉及 Three.js 反直觉行为、数学边界）一定要写**为什么这么做**，留引用 bug 编号或 commit
- 示例：
  ```js
  // 关闭 autoClear：因为 ViewHelper.render 内部会调 renderer.render，
  // 如果 autoClear=true 会清整个画布（不只是 ViewHelper 的 viewport）→ 主场景被擦黑
  this.renderer.autoClear = false;
  ```

### 命名

- 文件：kebab-case（`conversion-service.js`）
- 模块：PascalCase（`SceneManager`、`KeyframeManager`）
- 函数/变量：camelCase
- 常量：SCREAMING_SNAKE

### 不要碰的代码

CLAUDE.md 有警告的：
- `applyJointDrive` 里的 fixed 分支（被 #35 磨过）
- 拓扑排序 Kahn 算法
- 两阶段导入（零位捕获 base → 恢复 value）
- `baseTransform` 存储结构（四元数，不是 Euler）

这些不是"不能改"，而是"改前先读完对应 bug，想清楚你知不知道在改什么"。

---

## 调试工作流

### 遇到 bug 先做诊断

**不要盲改代码**。MotionForge 的 bug 多数涉及坐标系/时序/状态同步，猜错容易引入新坑。

步骤：
1. 浏览器 Console，`__mf` 对象查当前状态（`__mf.getJointDefs()` / `__mf.sceneManager.sceneRoot` ...）
2. 看 [CLAUDE.md 诊断脚本指南](CLAUDE.md#诊断脚本指南) 是否有匹配场景，复制对应 `tests/diag-*.js` 到 Console 跑
3. 场景对不上就写新诊断脚本（只读，不改源码状态）
4. 定位根因再改

### `__mf` 钩子（永远可用）

```js
__mf.THREE              // THREE 命名空间
__mf.sceneManager       // sceneRoot / scene / camera / jointGizmo
__mf.keyframeManager    // jointDefinitions / globalClips / applyAllJointDrives
__mf.selectionManager   // selectedObject / clearSelection
__mf.editableObjects()  // 可编辑对象列表
__mf.getJointDefs()     // 关节定义快照
```

### 单元测试（vitest）

核心逻辑改动（KeyframeManager / 公式求值 / reparent / fork_anchor_zero）先跑：

```bash
npm test           # 一次性跑完
npm run test:watch # 开发时 watch 模式
```

测试位置：[tests/unit/](tests/unit/)（vitest 只跑这里，不碰 `tests/diag-*.js` 浏览器脚本）。

**写新单元测试的场景**：
- 修 bug 时补一个覆盖 bug 场景的测试，防止再犯（bug 回归防线）
- 新加 KeyframeManager 公开方法时
- 改变历史 bug 修复语义时（比如改 #31 的"保末态"就会打掉现有测试——这是提醒你在破坏语义）

### 冒烟测试流程

改完跑一遍完整路径（参考 [DEBT.md 冒烟流程](DEBT.md#冒烟测试流程每条改动后跑一遍)）：

1. `npm run dev`
2. 加载 `三向车.glb`
3. 配 4 个关节 + role（叉齿侧移 / 叉齿旋转 / 门架升降 / 车体前进）
4. 打 2 个关键帧
5. AI 输入"叉齿侧移 0.5 米，升降 0.3 米" → 应用 PKF
6. 切 PKF 驱动播放 → 完整播放一遍
7. 导出 ZIP → 刷新 → 导入 → 验证动画和 role 保留
8. DevTools 无新警告

---

## Git 提交习惯

### Commit message

- **重要里程碑**：message 带版本标识（`v12`、`v12+`），参考现有 commits
- **日常改动**：中文简述"改了什么"，一行搞定；复杂改动在 body 说明动机
- 示例：
  ```
  v12+: FBX 源 ZIP roundtrip 修复 + Fixed 类型刚性连接语义对齐
  ```

### 不要 commit 的东西

- `zip/`（已在 `.gitignore`，导出产物）
- 大二进制文件（模型 `.glb` / `.fbx` / `.usd`）— 见 [CLAUDE.md #27](CLAUDE.md#27-git-push-失败corrupt-loose-object) 为什么
- `.env` / 含密钥的配置
- `node_modules/`、构建产物、IDE 缓存

误 commit 了大文件后 push 失败，看 #27 的修复步骤。

### 分支策略

项目当前单主干（`main` 直接开发）。未来开源后会转 PR flow：
- `feature/xxx` — 新功能
- `fix/xxx` — bug 修复
- PR 要求：跑过冒烟 + 更新 CLAUDE.md/CHANGELOG（如涉及）

---

## 文档同步要求

**改代码时，哪些文档要跟着改？**

| 改动类型 | 必须更新 | 推荐更新 |
|---|---|---|
| 修 bug | [CLAUDE.md](CLAUDE.md) bug log | [CHANGELOG.md](CHANGELOG.md) |
| 新增功能 | [CHANGELOG.md](CHANGELOG.md) + [README.md](README.md) 能力描述 | [USER-GUIDE.md](USER-GUIDE.md) / [HOW-IT-WORKS.md](HOW-IT-WORKS.md) |
| Schema 变更 | [docs/schema/vN.md](docs/schema/) + [CHANGELOG.md](CHANGELOG.md) Breaking | [HOW-IT-WORKS.md §8](HOW-IT-WORKS.md) |
| 新诊断脚本 | [CLAUDE.md 诊断指南](CLAUDE.md#诊断脚本指南) | [FLOW.md 故障表](FLOW.md) |
| 架构决策 | [CLAUDE.md 核心架构约束](CLAUDE.md#核心架构约束不可随意改动)（如属于红线） | [HOW-IT-WORKS.md §10](HOW-IT-WORKS.md) |
| 已知技术债 | [DEBT.md](DEBT.md) | — |

原则：**代码即事实，文档是导航**。事实变了，导航不同步，下一个接手的人就会被误导。

---

## 问题反馈

- 用户使用问题：优先参考 [USER-GUIDE.md 常见问题](USER-GUIDE.md#9-常见问题)
- 开发问题：先查 [CLAUDE.md](CLAUDE.md) bug 历史（35 条覆盖大多数常见坑）
- 实在查不到：提 issue，附上复现步骤 + `__mf` 诊断输出

---

## 许可证

待定（项目可能开源）。候选：MIT / Apache 2.0 / AGPL。确定前所有贡献默认归属原作者。
