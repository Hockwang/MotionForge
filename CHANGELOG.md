# Changelog

> 格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)
> 版本号按 `v1`–`v12+` 里程碑（项目演进式，不走 semver）
> Bug 编号见 [CLAUDE.md](CLAUDE.md) 修复历史章节

---

## [v12+] — 2026-04-16

### Added
- **视口坐标 gizmo**：右上角 XYZ 轴指示器（Three.js ViewHelper），跟相机转。方便识别不同软件导出模型的坐标约定
- **README 项目全景区块**：系统地图 + 数据流 + 子系统↔文档映射 + 能做/不能做清单
- **README 按问题查文档跳转表**：使用层 8 种、开发层 10 种、研究层 3 种场景
- **USER-GUIDE.md**：纯用户使用说明（9 章，面向不懂技术的使用者）
- **HOW-IT-WORKS.md**：技术原理文档（10 章，FK 数学、PKF 求值、roundtrip 等）
- **对话归档工具** `tools/export-conversation.cjs`：Claude Code session .jsonl → Markdown 导出（支持 --all / --all-projects）

### Fixed
- **#34** FBX 源 ZIP roundtrip 后根节点改名导致 parent=root 的关节找不到父级
- **#35** Fixed 类型关节不跟 joint parent 动（与 revolute/prismatic 语义对齐）

### Changed
- `manifest.source` 新增 `root_name` 字段（向后兼容旧 ZIP，fallback 到 file_name）
- `applyJointDrive` 对 fixed 类型不再 early return，按 URDF 刚性连接语义处理

---

## [v12] — 2026-04-15

### Added
- **ViewHelper 坐标指示器**（后补到 v12+，见上）
- 常用 role 预定义新增 "门架横移"
- 关节 origin 输入框 step 从 0.01 → 1（方向键调参不再蜗牛）
- **FLOW.md**：端到端流程 + 故障定位决策树
- **DEBT.md**：技术债地图（17 条分类 + 执行建议）

### Fixed
- **#30** 导出 joints.json 保存驱动态 currentValue，导入后停在末态（改为写 0）
- **#31** PKF 循环播放时关节卡末态 2 秒瞬跳回原点（每帧重置 + 完成 step 保持 value_end）
- **#32** 导出 ZIP 异常时卡在零位状态（try/finally 恢复）
- **#33** 关节链循环依赖静默失效（setJointDef 设 parentId 时检测环）
- **DEBT #5** PKF 步骤求值失败静默跳过（console.warn 去重显示）
- **DEBT #10** AI 关节名模糊匹配过宽（精确优先 + 唯一命中 fallback）
- 播放键：从末尾点再播时自动回 0
- CSS Grid 用 minmax(0, 1fr) 防止 canvas 撑开列导致右面板挤出视口
- Timeline 在窄屏不再被挤出
- 关节配置面板超出底部时自动上移
- 禁用 Ctrl+滚轮页面缩放（防止左右面板被撑飞）
- `applyJointDrive` drift warning 改为对比 stored base 世界位置（不再误报 value 恢复操作）

### Changed
- **文档结构动静态分离**：根目录留 5 份活跃文档，废弃/历史文档移到 `docs/archive/`，AI 打关节研究文档移到 `docs/ai-rigging/`
- 废弃文档顶部加 banner 标注状态

---

## [v11] — 2026-04-13

### Added
- **AI 关节 chips 面板**：自然语言输入框上方显示已配置关节按钮，点击插入 `@jointName` 精确指定关节

---

## [v10] — 2026-04-12

### Added
- **关节 role 语义标签**（[#29](CLAUDE.md#29-ai-按轴向硬猜导致选错关节)）
  - 预定义 8 个工业 role（车体前进、门架升降、叉齿旋转 ...）+ 自定义
  - AI 按 role 匹配意图，不靠 axis 硬猜
  - 后端 role 不匹配时返回 422 + available_roles

### Breaking
- 老 ZIP（无 role 字段）导入时 role 为空，不影响功能但 AI 匹配能力受限

---

## [v9] — 2026-04-11

### Added
- **AI PKF few-shot 示例**（[#28](CLAUDE.md#28-ai-从零写-pkf-公式不稳定)）：system prompt 内嵌完整的叉车取货动作示例
- **Gizmo 旋转角度解缠**（[#23](CLAUDE.md#23-旋转-gizmo-大角度跳变-360)）：四元数双重覆盖导致的 360° 跳变修复

### Removed
- 回滚 "模板库 + role 映射" 过度设计方案

---

## [v8] — 2026-04-10

### Added
- **CLAUDE.md**：协作手册（合并原 BUGFIX-LOG 和 DIAGNOSTICS）
- **诊断脚本套件** `tests/diag-*.js`（5 个浏览器 Console 脚本）

### Fixed
- **#22** 链式关节导入后整体下沉（两阶段应用关节：先零位捕获 base，再恢复 value）
- **#17** 导入后零件高亮不消失（导出前清除选中）
- **#18** parentId 在导入后被错误覆盖（parent_name 字段跨 roundtrip）
- **#19** PKF joint_def_id 跨导入失效（改用 joint name 标识）
- **#20** Double-apply：导出的 GLB 烘焙了驱动态（导出前归零）
- **#21** 第一版零位导出失败（清空 base 导致懒捕获错误 → 改为保留 base + value=0）

### Breaking
- **schema v4**：model.glb 由 GLTFExporter 重新序列化当前 sceneRoot（v3 是原始文件副本）
- v1/v2/v3 文件导入时会提示需要重新配置关节

---

## [v7 及之前] — 2026-03 至 2026-04-09

### 关节系统 v1 基础（[#1-#8](CLAUDE.md)）
- Gizmo 视口卡死修复
- 关节 baseTransform 懒捕获
- reparent 后 rebind baseTransform
- Gizmo 平移用世界空间（#4）
- origin 改 URDF 风格 parent-local（#5，语义变更）
- Gizmo 旋转围绕 origin 而非对象 pivot（#6）
- baseTransform 改存四元数（#7，避免万向锁）
- Kahn 拓扑排序驱动关节链（#8，不用场景树深度）

### 架构重构（[#9-#11](CLAUDE.md)）
- per-object 关键帧 → 全局关键帧（项目级 clips）
- FK 求解器与场景树层级解耦
- 删除旧关节点系统 ~300 行

### 导出 / 导入 Roundtrip（[#12-#19](CLAUDE.md)）
- GLTFExporter 导出策略修正（不传 Scene，传 children）
- 节点丢失修复（ALL 有意义子节点）
- 对齐偏移烘焙修复
- 根节点 name 恢复为源文件名

### 其他细节（[#24-#27](CLAUDE.md)）
- GridHelper alpha 警告
- 材质高亮污染其他对象
- 关键帧生成函数重写
- git 仓库 corrupt object 修复（zip/ 加 .gitignore）

---

## 完整 bug 历史

见 [CLAUDE.md § Bug 修复历史](CLAUDE.md)（35 条，按阶段分组）
