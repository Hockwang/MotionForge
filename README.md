# MotionForge

Web 端 3D 动作编辑器（Three.js + Vite），用自然语言或关键帧驱动模型做动画，导出标准化运动包。

**当前版本**：v12+（2026-04-16，35 条 bug 已修）

---

## 🗺️ 项目全景（一眼看清）

### 系统地图

```
┌─ 编辑器（浏览器前端）──────────────────────────────────────────
│  ├─ 资产加载            ✅ 稳定     GLB/GLTF/USDZ 直接；USD/FBX 经 Blender
│  ├─ 场景树 + 选中        ✅ 稳定     左侧树 + 视口点选 + 高亮
│  ├─ Gizmo 交互           ✅ 稳定     revolute 旋转 / prismatic 平移拖拽
│  ├─ FK 关节系统          ✅ 稳定     revolute / prismatic / fixed（URDF 风格）
│  ├─ 全局关键帧            ✅ 稳定     项目级 clips，同步捕获所有关节
│  ├─ PKF 参数化公式       ✅ 稳定     parameters + steps + 循环闭环
│  ├─ 视口坐标 gizmo       ✅ 稳定     右上角 Y-up 指示
│  └─ 导出/导入 ZIP         ✅ 稳定     schema v4，两阶段应用防漂移
│
├─ AI 服务（Node 后端，localhost:8091）─────────────────────────
│  ├─ Blender 转换         ✅ 稳定     USD/FBX → GLB
│  └─ AI 生 PKF            ✅ 稳定     自然语言 → parameters + steps
│     ├─ role 语义匹配      ✅          关节按角色匹配，不靠 axis 硬猜
│     └─ few-shot 示例      ✅          system prompt 内嵌 pickup 示例
│
└─ 研究专题（不在当前代码里）──────────────────────────────────
   ├─ AI 自动打关节         🟡 调研中   方向：LLM 判语义 + 几何算精度
   │                                  详见 AI-RIGGING-README.md
   └─ 人工 GT 评估体系      🟡 待标注   目标 3-5 车型 × 4 字段/关节
```

### 数据流

```
[用户]
  │
  ├─ 加载模型 ──→ 场景树
  │                │
  │                ├──[手动配]──→ 关节定义（type / axis / origin / parent / role）
  │                │                            │
  │                │                            ├─ FK 求解器（拓扑排序）
  │                │                            └─ applyAllJointDrives
  │                │                                         │
  │                ├──[关键帧]──────────→ globalClips ───────┤
  │                │                                         ├→ 场景渲染
  │                └──[自然语言]──→ AI 后端 ──→ PKF ────────┘
  │                                               │
  └─ 导出 ZIP ←──── schema v4 ←──────────────────┘
       │
       └── 其他系统消费
```

### 关键子系统 ↔ 文档/代码映射

| 子系统 | 代码入口 | 深入文档 |
|---|---|---|
| FK 关节求解 | [KeyframeManager.js](src/core/KeyframeManager.js) `applyJointDrive` | [HOW-IT-WORKS §2](HOW-IT-WORKS.md) |
| 拓扑排序 | `applyAllJointDrives` | [HOW-IT-WORKS §4](HOW-IT-WORKS.md) |
| PKF 公式求值 | `evaluatePkfFormula` / `evaluatePkfAt` | [HOW-IT-WORKS §5](HOW-IT-WORKS.md) |
| 全局关键帧 | `evaluateAllAt` | [HOW-IT-WORKS §6](HOW-IT-WORKS.md) |
| 导出 ZIP | [ResultPackageExporter.js](src/core/ResultPackageExporter.js) | [HOW-IT-WORKS §8](HOW-IT-WORKS.md) |
| 导入两阶段 | [main.js](src/main.js) `handleImportPackage` | [HOW-IT-WORKS §8](HOW-IT-WORKS.md) |
| AI 后端 | [conversion-service.js](tools/conversion-service.js) | [HOW-IT-WORKS §9](HOW-IT-WORKS.md) |
| Gizmo + ViewHelper | [SceneManager.js](src/core/SceneManager.js) | [HOW-IT-WORKS §3](HOW-IT-WORKS.md) |

### 当前能做 / 不能做（一句话）

- ✅ 单模型动画编排 + 导出 + 导入 roundtrip
- ✅ 自然语言生成复合动作（前进 / 升降 / 旋转 / 侧移）
- ✅ 多模型类型（GLB / USDZ / USD / FBX / GLTF）
- ❌ AI 自动打关节（还在调研，要手配）
- ❌ 多模型同场景编辑（当前单模型）
- ❌ 测试套件（回归靠手动 + 诊断脚本）
- ❌ Redo（只有 Undo，Ctrl+Z）

---

## 📖 文档导航

**第一次进项目？按角色找入口**：

| 你是谁 | 先读这个 |
|---|---|
| **纯用户**（不懂技术，想用编辑器做动画） | 👉 [USER-GUIDE.md](USER-GUIDE.md)（使用说明，从加载模型到导出） |
| 想快速运行项目 | 继续往下读（本文件） |
| 想看完整流程和故障排查 | [FLOW.md](FLOW.md) |
| 想了解技术原理（FK 数学、PKF 求值、roundtrip） | [HOW-IT-WORKS.md](HOW-IT-WORKS.md) |
| 想改代码 / 定位 bug / 理解架构 | [CLAUDE.md](CLAUDE.md) |
| 想了解 AI 打关节研究方向（长期课题） | [AI-RIGGING-README.md](AI-RIGGING-README.md) |
| 想了解当前技术债 | [DEBT.md](DEBT.md) |

**历史文档**（了解演进过程）：
- [REQUIREMENTS.md](docs/archive/REQUIREMENTS.md) — 最初需求文档（March，部分已实现）
- [joint-definition-plan.md](docs/archive/joint-definition-plan.md) — 早期关节系统设计（已实现）

### 🔎 按具体问题查文档

**使用层面**（你在用编辑器时遇到）：

| 遇到的问题 | 看哪里 |
|---|---|
| 不知道怎么开始用 | [USER-GUIDE §2-3](USER-GUIDE.md) |
| 关节配了但模型不动 | [USER-GUIDE FAQ](USER-GUIDE.md#9-常见问题) |
| 旋转方向反了 / 绕错中心 | [USER-GUIDE §4.3](USER-GUIDE.md) |
| AI 生成的动作选错关节 | [USER-GUIDE FAQ · Q](USER-GUIDE.md#9-常见问题) → 检查 role 字段 |
| 导出后再导入模型不对 | [FLOW.md 故障表](FLOW.md) |
| 播放循环卡顿 / 瞬跳 | [CLAUDE #31](CLAUDE.md) |
| 窗口变窄右面板消失 | 按 Ctrl+0 重置浏览器缩放 |
| 想了解坐标约定（Y-up 还是 Z-up） | [HOW-IT-WORKS §1](HOW-IT-WORKS.md) |

**开发层面**（你在改代码时遇到）：

| 遇到的问题 | 看哪里 |
|---|---|
| 新 bug 要定位 | [FLOW §2 故障定位表](FLOW.md) → 对应诊断脚本 |
| 要理解 FK 数学 / 公式 | [HOW-IT-WORKS §2](HOW-IT-WORKS.md) |
| 要理解 PKF 求值管线 | [HOW-IT-WORKS §5](HOW-IT-WORKS.md) |
| 要理解导出/导入 roundtrip | [HOW-IT-WORKS §8](HOW-IT-WORKS.md) |
| 遇到"链式关节下沉 / 断链" | [CLAUDE #18 #22](CLAUDE.md) |
| 遇到"导入后停在末态" | [CLAUDE #30](CLAUDE.md) |
| 遇到"旋转 90° 失真" | [CLAUDE #7 万向锁](CLAUDE.md) |
| 想写新诊断脚本 | [CLAUDE §诊断脚本指南](CLAUDE.md) |
| 修完 bug 要归档记录 | [CLAUDE §协作规则](CLAUDE.md) |
| 想看还有哪些债 | [DEBT.md](DEBT.md) |

**研究层面**（和 AI 打关节相关）：

| 遇到的问题 | 看哪里 |
|---|---|
| 想快速对齐 AI 打关节方向 | [AI-RIGGING-README.md](AI-RIGGING-README.md)（2 分钟） |
| 要把 context 交给外部研究方 | [docs/ai-rigging/HANDOFF.md](docs/ai-rigging/HANDOFF.md) |
| 想看观点是怎么演进的 | [docs/ai-rigging/RESEARCH-LOG.md](docs/ai-rigging/RESEARCH-LOG.md) |

---

## 🚀 运行方式

```bash
npm install
npm run dev
```

默认访问 `http://localhost:5173`。

### 一键启动（Windows）

- 双击 `start-motionforge.bat`（只启动前端）
- 双击 `start-motionforge-with-converter.bat`（同时启动 USD/FBX 转换服务）
- 或命令行：`npm start`

### USD/FBX 自动转换（可选）

需要本地安装 Blender（验证路径 `C:\Program Files\Blender Foundation\Blender 5.1\blender.exe`）。

```bash
npm run converter    # 启动 Blender 转换服务
```

启动后上传 `.usd/.usda/.usdc/.fbx` 会自动转 GLB。可用 `VITE_CONVERTER_URL` 覆盖默认地址。

### AI 生成 PKF（可选）

Converter 服务同时承载 AI 后端（端口 8091）。设置环境变量：
- `AI_BASE_URL`：AI 服务地址（默认接入 Gemini）
- `AI_MODEL`：模型名（默认 `gemini-3-flash-thinking`）

---

## 🧩 核心能力

**输入**：GLB / GLTF / USDZ（本地）/ USD / FBX（经转换服务）

**编辑**：
- FK 关节系统（revolute / prismatic / fixed，URDF 风格，四元数 baseTransform）
- 全局关键帧（项目级 clips，每帧捕获所有关节 value）
- PKF 参数化公式（parameters + steps，支持 AI 自然语言生成）
- 关节 role 语义标签（供 AI 按意图匹配）

**输出**：ZIP 运动包（schema v4）
- `manifest.json` — 元信息 + 文件索引
- `joints.json` — FK 关节定义（含 role / parent_name）
- `motion.json` — 全局关键帧 clips
- `pkf.json` — 参数化公式（可选）
- `model.glb` — GLTFExporter 序列化后的场景

完整流程图见 [FLOW.md](FLOW.md)。

---

## 📁 目录结构

```text
src/
  core/
    AssetLoader.js           # 资产加载分发（含 USD 扩展点）
    SceneManager.js          # Three.js 场景 / 相机 / Gizmo
    SelectionManager.js      # 选中与高亮
    KeyframeManager.js       # 关节定义 + 全局关键帧 + FK 求解器 + PKF
    ResultPackageExporter.js # ZIP 结果包导出
  ui/
    EditorUI.js              # 编辑器布局与 UI
  main.js                    # 应用编排入口
  style.css                  # 布局样式
tools/
  conversion-service.js      # Blender 转换服务 + AI 生 PKF 后端
  convert_usd_to_glb.py      # USD → GLB 转换脚本
tests/
  diag-*.js                  # 5 个浏览器 Console 诊断脚本（见 FLOW.md）
```

---

## ⚠️ 已知限制

- USD 真实几何显示依赖本地转换服务和 Blender
- 复杂材质跨工具链（Omniverse → Blender → glTF）可能有保真损失
- 时间轴不支持曲线编辑（只有线性插值）
- AI 打关节**尚未接入**（研究阶段，见 [AI-RIGGING-README.md](AI-RIGGING-README.md)）

---

## 🛠️ 调试钩子

浏览器 Console 可用：

```js
__mf.THREE              // THREE 命名空间
__mf.sceneManager       // SceneManager 实例
__mf.keyframeManager    // KeyframeManager
__mf.selectionManager   // SelectionManager
__mf.getJointDefs()     // 关节定义快照
__mf.editableObjects()  // 可编辑对象列表
```

遇到 bug → 先看 [FLOW.md 第 2 节故障定位表](FLOW.md)，再看对应诊断脚本。
