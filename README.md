# MotionForge（Validation Prototype）

一个轻量级 Web 原型，用于验证工业 3D 资产外部动作编辑流程：

`asset -> lightweight external motion editing -> structured result package`

本项目是工作流验证工具，不是完整工业仿真产品。

## 运行方式

```bash
npm install
npm run dev
```

默认启动后访问终端显示的本地地址（通常是 `http://localhost:5173`）。

### 一键启动（Windows）

- 双击项目根目录 `start-motionforge.bat`
- 首次会自动安装依赖，随后启动并自动打开浏览器
- 如果希望自动转换 `.usd/.fbx`，请使用 `start-motionforge-with-converter.bat`（会同时启动转换服务）
- 也可直接执行：

```bash
npm start
```

### 自动转换 USD/FBX（本地 Blender 服务）

1. 安装 Blender（已验证路径示例：`C:\Program Files\Blender Foundation\Blender 5.1\blender.exe`）
2. 启动转换服务（任选其一）：

```bash
npm run converter
```

或双击：

```text
start-motionforge-with-converter.bat
```

3. 启动前端后直接上传 `.usd/.usda/.usdc/.fbx`，前端会自动调用服务转换为 `.glb` 并显示

> 可通过环境变量覆盖默认服务地址：`VITE_CONVERTER_URL`（默认 `http://localhost:8090`）

## 本次新增能力（MVP Extension）

- 动作语义编辑（按对象-片段）
  - `motion_type`: `translate` / `rotate`
  - `axis`: `x` / `y` / `z`
  - `clip_name`
  - `min_value` / `max_value`（可选）
  - `duration`
- 单对象多片段（multi clips）
  - 创建片段
  - 切换当前片段
  - 在当前片段下添加关键帧
- 结构化导出
  - 导出当前对象结构化 `motion JSON`
  - 导出结果包 `ZIP`（`manifest.json` + `motion.json` + `asset-metadata.json`）

## 结果包格式

`manifest.json` 最小结构示例：

```json
{
  "package_version": "0.1.0",
  "editor_name": "MotionForge",
  "source_file_name": "asset.usd",
  "source_format": "usd",
  "exported_objects": [
    { "object_id": "uuid", "object_name": "arm", "clip_count": 2 }
  ],
  "available_clips": ["open", "close"]
}
```

`motion.json` 最小结构示例：

```json
{
  "schema_version": 1,
  "exported_at": "2026-03-31T00:00:00.000Z",
  "objects": [
    {
      "object_id": "uuid",
      "object_name": "arm",
      "clips": [
        {
          "clip_name": "open",
          "motion_type": "rotate",
          "axis": "y",
          "duration": 2.0,
          "min_value": -20,
          "max_value": 45,
          "keyframes": [
            {
              "time": 0.0,
              "value": 0.0,
              "transform": {
                "tx": 0,
                "ty": 0,
                "tz": 0,
                "rx": 0,
                "ry": 0,
                "rz": 0
              }
            }
          ]
        }
      ],
      "semantics_version": 1
    }
  ]
}
```

## 当前 MVP 范围

- 资产加载：
  - 本地直载：`.usdz` / `.glb` / `.gltf`
  - 自动转换后加载：`.usd` / `.usda` / `.usdc` / `.fbx`（需本地转换服务）
- 场景编辑：对象列表 + 视口点击选择 + 高亮
- 变换编辑：当前对象 `X 平移`、`Y 旋转`
- 关键帧：时间轴拖动、播放/暂停、线性插值
- 语义与片段：每对象多片段及语义参数编辑
- 导出：结构化 JSON + 结果包 ZIP

## 目录结构

```text
src/
  core/
    AssetLoader.js           # 资产加载分发（含 USD 扩展点）
    SceneManager.js          # Three.js 场景、相机、渲染与控制
    SelectionManager.js      # 选中与高亮逻辑
    KeyframeManager.js       # 多对象/多片段关键帧与语义模型
    ResultPackageExporter.js # ZIP 结果包导出
  ui/
    EditorUI.js              # 编辑器布局与 UI 更新
  main.js                    # 应用编排入口
  style.css                  # 最小布局样式
```

## 已知限制

- `USD` 真实几何显示依赖本地转换服务和 Blender；未启动服务时无法自动转换
- 复杂材质在不同工具链（Omniverse -> Blender -> glTF）间可能有保真损失
- 变换编辑 UI 仍保持轻量（当前提供 X 平移、Y 高度、Y 旋转）
- 时间轴为基础实现，不包含曲线编辑、撤销/重做、复杂轨道管理
- 不包含 USD 回写与 rig/joint authoring

## 未来扩展方向

- 接入真实 USD 资产管线（本地转换服务或远端服务）
- 引入真实 joint semantics（替代纯 mesh transform 语义）
- 增强结果包到内部系统映射层（ID 映射、命名规范、校验规则）
- 扩展多对象协同片段、片段复用与版本化
