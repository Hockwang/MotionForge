# MotionForge

Web 端 3D 动作编辑器（Three.js + Vite），用自然语言或关键帧驱动模型做动画，导出标准化运动包。

**当前版本**：v11 演示稳定版（2026-04-15）

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
