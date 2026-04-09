# MotionForge 需求文档（开发辅助版）

## 1. 文档目的

本需求文档用于指导 `MotionForge` 后续迭代开发，聚焦“工业/机器人资产的外部轻量编辑”工作流验证。

核心原则：

- 不在浏览器端直接生成完整 USD
- Three.js 前端负责交互编辑与中间结果导出
- USD 资产生成与回写由后端/工具链完成
- 架构决策（固定条款）：当前阶段统一采用 `原始 USD + 扩展结果包` 双产物模式；扩展结果包承载关节节点、动作语义、关键帧等动画数据，后续再由 USD 工具链映射回标准 `UsdSkelSkeleton/UsdSkelAnimation`

---

## 2. 项目目标与定位

### 2.1 目标

构建一个可运行的外部动作编辑原型，验证以下链路：

`asset -> lightweight external edit -> structured motion result package -> downstream USD mapping`

### 2.2 非目标（明确不做）

- 不实现完整工业仿真
- 不实现完整 rig/joint authoring 系统
- 不在前端直接写回完整 USD 文件
- 不实现复杂曲线编辑器与物理系统

---

## 3. 用户与典型使用流程

### 3.1 目标用户

- 动作标注/编辑人员
- 管线工程师（需要验证导出数据结构）
- 下游 USD 集成工程师

### 3.2 典型流程

1. 上传资产（优先 `usdz/glb/gltf`，`usd/usda` 可走降级或服务模式）
2. 选择对象/部件
3. 配置动作语义（motion type、axis、clip、范围、时长）
4. 添加关键帧并预览
5. 导出结构化结果包（ZIP）
6. 下游工具消费结果包并映射到 `UsdSkelSkeleton/UsdSkelAnimation`

---

## 4. 当前能力基线（As-Is）

- 本地资产加载（`usdz/glb/gltf`，`usd/usda` mock fallback）
- 对象选择（列表 + 视口拾取）
- 基础变换编辑（X 平移、Y 旋转）
- 时间轴与关键帧（创建、拖动、播放）
- 多片段（clip）管理（创建、切换）
- 结构化导出：
  - 当前对象 JSON
  - 结果包 ZIP（`manifest.json`、`motion.json`、`asset-metadata.json`）

---

## 5. To-Be 需求总览

### 5.1 功能需求（Functional Requirements）

#### FR-01 资产加载

- 支持本地上传资产
- 支持识别源文件名、源格式并写入 manifest
- 对不支持的 USD 解析路径应有明确提示（例如 mock mode）

#### FR-02 场景结构与选择

- 展示可编辑对象列表
- 支持从视口和列表双入口选择对象
- 被选中对象应有高亮反馈

#### FR-03 动作语义编辑

每个对象下每个 clip 需支持：

- `motion_type`: `translate | rotate`
- `axis`: `x | y | z`
- `clip_name`: string
- `min_value` / `max_value`: optional number
- `duration`: number (seconds)

#### FR-04 关键帧编辑与播放

- 在当前时间为当前对象当前 clip 添加关键帧
- 支持时间轴拖动（scrub）
- 支持播放/暂停
- 插值可先用线性插值

#### FR-05 多 Clip 支持

- 同一对象可创建多个命名 clip
- 可切换 active clip
- 关键帧与语义配置绑定在 clip 维度
- 导出时包含该对象所有 clip

#### FR-06 结构化结果包导出

导出 ZIP，至少包含：

- `manifest.json`
- `motion.json`
- `asset-metadata.json`（可选占位但建议包含）

#### FR-07 可扩展接口

- 预留 USD 服务模式接口（上传/转换/回写）
- 预留 joint semantics 映射点
- 预留内部系统映射规则入口

---

## 6. 中间资产格式需求（Interchange Schema）

> 目标：该格式可稳定映射为 USD Skel。

### 6.1 顶层结构（建议）

```json
{
  "schema_version": 1,
  "editor_name": "MotionForge",
  "exported_at": "2026-03-31T00:00:00.000Z",
  "source": {
    "file_name": "robot.usd",
    "format": "usd",
    "up_axis": "Y",
    "units_in_meters": 1.0,
    "fps": 30
  },
  "skeletons": [],
  "objects": [],
  "clips": []
}
```

### 6.2 Skeleton 必备字段

- `skeleton_path`：目标骨架路径（用于 USD 定位）
- `joint_order[]`：严格顺序（映射必须用同一顺序）
- `joint_hierarchy[]`：父子关系（`joint`, `parent_joint`）
- `rest_pose` / `bind_pose`：每 joint 的本地 TRS（rotation 用 quaternion）

### 6.3 Animation 必备字段

- `clip_name`
- `duration`
- `time_samples[]`
- 每个 sample 按 `joint_order` 展开 TRS
- rotation 必须 quaternion（避免欧拉角歧义）

### 6.4 Mesh Skinning 必备字段

- mesh 标识（`mesh_id`, `mesh_path`）
- `skeleton_path`
- 顶点 skinning：
  - `joint_indices`
  - `joint_weights`
- 要求索引可映射到 `joint_order`

### 6.5 数据约束

- 必须明确单位、坐标系、fps
- 关键帧时间必须单调递增
- 同名 clip 不允许重复（同对象范围内）
- `joint_weights` 需可归一化（误差容忍阈值可配置）

---

## 7. USD 映射需求（概念层）

### 7.1 Skeleton 映射

- 中间格式 `skeleton_path + joint_order + rest/bind pose`
  -> `UsdSkelSkeleton`

### 7.2 Animation 映射

- clip 的时间采样 TRS
  -> `UsdSkelAnimation`
- 保持与 `joint_order` 一致

### 7.3 Mesh Binding 映射

- mesh 的 skinning 绑定信息
  -> `UsdSkelBindingAPI`

### 7.4 输出策略

- 默认写入新 layer（非破坏式）
- 允许 source USD + overlay layer 组合输出

---

## 8. 非功能需求（NFR）

### NFR-01 性能

- 小中型资产（例如 < 100k vertices）下交互不卡顿
- 时间轴拖动应具备可接受实时反馈

### NFR-02 可维护性

- 保持模块化：
  - loader
  - scene
  - selection
  - keyframe/clip
  - exporter
- 避免把核心逻辑写入单一超大文件

### NFR-03 可靠性

- 导出前校验（无对象、无关键帧、非法 clip 名）
- 导出失败时给出可读错误信息

### NFR-04 可扩展性

- 支持未来接入真实 USD 服务（API Adapter）
- 支持从 object-level semantics 迁移到 joint-level semantics

---

## 9. 里程碑建议（Roadmap）

### M1（已完成/近完成）

- 轻量编辑器基础能力（加载/选择/关键帧/导出）
- clip + 语义参数 + ZIP 结果包

### M2（下一阶段）

- 中间格式升级为 joint-friendly schema
- 增加字段校验器（schema validator）
- 导出包完整性检查（manifest 与 motion 一致性）

### M3（管线联调）

- 接入 USD 后端适配器（mock API -> real API）
- 实现中间格式 -> USD Skel 映射脚本（Python pxr）
- 建立回归样例资产与基准测试

---

## 10. 验收标准（Definition of Done）

一次完整验收需满足：

1. 能加载资产并显示可编辑对象
2. 能选择对象并编辑动作语义
3. 能创建多个 clip 并分别打关键帧
4. 能播放预览并在 timeline scrub
5. 能导出 ZIP 结果包，且包含必需文件
6. `manifest.json` 与 `motion.json` 字段完整且相互一致
7. 前端构建通过（`npm run build`）

---

## 11. 风险与应对

### 风险 R1：浏览器侧 USD 解析限制

- 应对：明确双模式（mock / service），优先验证工作流

### 风险 R2：joint 标识不稳定导致映射失败

- 应对：统一 joint 唯一标识策略（建议 path/token）

### 风险 R3：时间单位/坐标系不一致

- 应对：在 schema 顶层强制记录 `fps/up_axis/units`

### 风险 R4：导出结构随迭代漂移

- 应对：引入 `schema_version` 和 JSON Schema 校验

---

## 12. 开发实施建议（短期）

1. 固化 JSON Schema（先文档后代码）
2. 在前端增加导出前校验提示
3. 产出 2~3 份标准测试资产和预期导出结果
4. 增加一个最小 Python 映射器原型（只打通一条 clip）
5. 完成一次端到端联调演示并记录问题清单

---

## 13. 附录：术语

- **中间资产包**：前端编辑结果的结构化输出，不等于最终 USD
- **joint_order**：关节严格顺序，是动画数组映射基准
- **bind pose/rest pose**：骨骼绑定与初始姿态参考
- **overlay layer**：在不改动源资产前提下附加动画/元数据的 USD 层
