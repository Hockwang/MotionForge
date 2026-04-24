# MotionForge 技术补遗 —— 从 mvp1 到 mvp3 新加的那几层

> 作者：正淳  项目：MotionForge —— 基于 Three.js + Vite 的浏览器端 FK 求解器 + 参数化动画系统
> 阅读时间：约 20 分钟
> 适合谁：读过我 mvp1 那篇《MotionForge 核心系统》，想看"让系统长期能跑"的工程部分
> 前置阅读：[MotionForge — 基于 Three.js + Vite 的浏览器端 FK 求解器 + 参数化动画系统](https://...)（正淳，2026-04-16）

## TL;DR

mvp1 那篇讲的是系统的**数学核心**（FK / PKF / 关键帧 / AI pipeline），等于回答"这个东西怎么算对"。上线跑了两周之后，真正拖住项目的不是这些——它们已经被测试和踩坑固化住了。拖住项目的是工程化的那些"看起来不酷"的事：导入失败污染现场、schema 改了文档没同步、AI 生成的 PKF 看起来对但实际偏 0.3m 说不出来在哪。

这篇补遗写这两周加的五件事：

1. **可视化辅助层**：轨迹 overlay 从 Console 脚本毕业成产品功能，采样锚点从 Object3D pivot 改为 bbox 功能点
2. **ZIP 导入事务化**：导入失败不再污染当前工程
3. **Schema v7 + 文档闭环**：双段门架 overflow + 模板段号 + 让下游系统看到新字段
4. **测试基建**：145 unit tests → 177（+11 集成测试 + 21 AI pipeline 测试）+ GitHub Actions CI
5. **Bundle 瘦身**：首屏 1,140 kB → 945 kB，lazy import GLTFExporter / USDZLoader / JSZip

每一件单独看都不复杂，但合起来让 MotionForge 从"本地 demo"变成"下游能对接、CI 能兜底、协作能 AI 化"的工具。和 Manycore 在做的参数化平台（Make）类似，工具价值从"算对了"跨到"长期可用"这一步，需要的恰好是这几类基建。

## 为什么写

mvp1 文章写完不到十天，就遇到三类新问题：

1. GPT 和 Claude 跑独立 review，各自都抓到我自己 review 没抓到的 P1 问题（说明单人 review 盲区很大）
2. 用户反馈"放货位偏了 0.3m"，我看截图看不出偏在哪——文字描述 3D 的带宽太低
3. 改一次 main.js 里的导入逻辑，几个 roundtrip 边界 bug 又回来了——单元测试防不住这种跨模块回归

前两件是**协作问题**（人↔AI、人↔人），第三件是**工程化问题**。解法都不在数学层，而在基建层。这些基建没有炫技空间，但缺了它们项目就不能长期跑。

这篇算是我自己的第二阶段技术备忘。同样，和 Manycore 相关方向有复用点，放在这里供讨论。

---

## 目录

1. [轨迹 overlay：从 Console 脚本到产品功能](#1-轨迹-overlay从-console-脚本到产品功能)
2. [ZIP 导入的事务化](#2-zip-导入的事务化)
3. [Schema v7 + 文档闭环](#3-schema-v7--文档闭环)
4. [测试基建：集成测试 + AI pipeline 测试](#4-测试基建集成测试--ai-pipeline-测试)
5. [Bundle 瘦身：lazy import 的取舍](#5-bundle-瘦身lazy-import-的取舍)
6. [这两周攒的几条通用原则](#6-这两周攒的几条通用原则)

---

## 1. 轨迹 overlay：从 Console 脚本到产品功能

### 1.1 起点

PKF 动画调试最痛的点不是"写不对"，是"错了也说不清错在哪"。用户反馈"放货位偏了"，我拿到一张截图——里面只有一辆小车和一个货箱，没有坐标轴、没有刻度、没有参考点。偏在 x、y、z 哪个方向？偏多少？肉眼测不出来。

最早这个诊断是靠 `tests/diag-template.js` 里的 `__diagTpl.drawTrajectory()`，一段得手动粘到浏览器 Console 的脚本。门槛高，不是常态工具，只有我自己调 bug 时会用。

### 1.2 产品化

把这段脚本在 UI 的时间轴右侧接一个 🎨 轨迹 toggle，勾上就按 200 个采样点走完整个 duration，fork 和 cargo 的世界坐标串成蓝/橙双色折线画进 sceneRoot。Attach 事件画红大球、detach 画绿大球。同时 console.table 每段 PKF step 的坐标。

**采样流程**（见 `src/core/TrajectoryOverlay.js`）：

```
1. 保存 joint values + currentTime（退出时要复原）
2. 把所有 PKF 触及的 joint 一次性清零
   ↳ 不清的话：用户在 t=5s 开轨迹 toggle，前 5s 的采样会带上 t=5s 的残留 value，线画到错的位置
3. 对 200 个 t 值（等距分 duration）：
   a. evaluatePkfAt(t)
   b. 覆盖 joint values
   c. applyAllJointDrives
   d. applyReparentEventsAtTime(t)
   e. updateMatrixWorld
   f. 采样 fork / cargo 的世界坐标
4. try/finally 复原 joint values + currentTime + reparent 状态
```

**关键**：采样过程会动真实的 joint value 和 cargo 的 scene graph parent。必须 try/finally 完全复原，不然退出轨迹模式用户的场景就被污染了。这条比"画对线条"本身重要得多。

### 1.3 采样点选对，比画线本身重要

初版用 `fork.getWorldPosition()` 和 `cargo.getWorldPosition()` 直接采。结果轨迹线飘在小车上方 1-2m 的位置，用户第一反应是"这不是真实轨迹吧"。

问题出在：**`getWorldPosition` 返回的是 Object3D 的 pivot（原点）**。pivot 在哪完全取决于建模时的设定。我们这辆三向车的 `_CS19110` mesh（fork 旋转节点）的 pivot 偏在几何体顶部附近，不是用户眼里的"叉齿承载面"。

改成 bbox 底面中心：

```js
// 首帧（i=0，t=0 姿态）算一次 local offset
if (fork) {
  const box = new THREE.Box3().setFromObject(fork);
  if (!box.isEmpty()) {
    const center = box.getCenter(new THREE.Vector3());
    const anchorWorld = new THREE.Vector3(center.x, box.min.y, center.z);
    forkAnchorLocal = fork.worldToLocal(anchorWorld);
  }
}

// 每帧：local → world，自动跟 fork 动画（含旋转）
if (fork && forkAnchorLocal) {
  forkPts.push(fork.localToWorld(forkAnchorLocal.clone()));
}
```

三个关键：

1. **bbox 底面中心 `(center.x, box.min.y, center.z)` threejs**——和 `computeForkAnchorZero`（AI pipeline 里 `fork_anchor_zero` 的来源）同公式。这样**轨迹显示的点和 AI 看到的 anchor 是同一个点**，不会让用户困惑"AI 说 anchor 在这儿，可轨迹画在那儿"
2. **local offset + localToWorld**：首帧算一次，之后每帧复用。比"每帧重算 bbox"更精确（world-space bbox 在旋转后是 AABB，不贴几何体），比"存世界 offset"更通用（后者不跟动画）
3. **降级路径**：bbox 空 / 对象不存在 → 回退到 `getWorldPosition`，老行为不炸

### 1.4 数据正确不等于视觉正确

改完之后数据确实对了：fork 采样 y 从 0.042m（地面）变化到 1.0m（放货货架），变化范围 0.96m。但用户第一眼还是说"看起来还是平的"。

原因是：

1. 相机侧视 + 透视 → Y 方向变化被压平
2. 动画里 transport 段占 3 秒长水平，视觉上主导
3. 用户心理预期是"轨迹该贴地面"，但这辆三向车的业务场景是**在 1m 货架上取放**，物理上本来就应该在空中

这种情况下**改代码没意义**，数据已经对了。改的是在 console.table 后面追一条 Y 范围汇总：

```
━━ Y 范围（看轨迹是不是"真的平"）━━
  fork.y : [0.042, 1.000] 变化 0.958m
  cargo.y : [0.500, 1.098] 变化 0.598m
  ↑ 数值差 > 0.2m 但视觉看着平 → 相机透视压缩，切正射视图看
```

数字说话比反复辩论"看起来像"快得多。这是一个一般的教训：**可视化工具要做"可看"和"可读"两种输出**。看的是直觉，读的是精确。两者都留出口，用户在两种语言间来回切换，诊断效率翻倍。

### 1.5 和 AI 协作的接口

`TrajectoryOverlay.sampleOnly()` 返回结构化数据（`rows` / `forkPts` / `cargoPts` / `duration` / `fork` / `cargo`），不画线。这是故意设计的：

- 看：`refresh()` 画线 + 画球
- 读：`sampleOnly()` 返回数据，不动场景

当前 AI pipeline 还没接这个接口，但 API 就是按"可看可读"双输出原则写的。下一步就是把 `sampleOnly()` 的返回值序列化喂给 LLM 做 PKF 自检——AI 看不到渲染结果，但能读结构化的采样表，对比期望/实际，自动发现偏差。

延伸阅读：[AI 编辑 3D 软件的可能性 —— 从一条轨迹辅助线说起](ai-3d-editing-visual-handles.md)

---

## 2. ZIP 导入的事务化

### 2.1 问题

老版本的 `handleImportPackage` 大致这样：

```js
try {
  const zip = await JSZip.loadAsync(zipData);
  const manifest = JSON.parse(await zip.file('manifest.json').async('string'));
  const root = await assetLoader.loadFromFile(modelFile);

  sceneManager.setSceneRoot(root);      // ← 第一次 mutation
  keyframeManager.reset();               // ← 清空旧工程

  // 然后才解析 joints/motion/pkf JSON
  const jointsData = JSON.parse(await zip.file('joints-xxx.json').async('string'));
  // ↑ 这里 JSON.parse 抛异常 → 上面两行 mutation 已经发生了
} catch (err) {
  ui.setLoadStatus('导入失败: ' + err.message);
  // 用户当前工程被污染：旧模型没了，关节也没了，只剩错误信息
}
```

**mutate-first-validate-later**——先改状态，后校验。任何一个 JSON 文件损坏都会让用户丢失当前编辑中的内容。这种模式在"加载文件覆盖当前工程"类流程里是反模式。

### 2.2 Phase 1 / Phase 2

重构成两阶段（见 [src/main.js](../../src/main.js) `handleImportPackage`）：

```
Phase 1（零 mutation，纯解析）：
  1. 读 zip 字节
  2. 解析 manifest
  3. 预解析 joints JSON → jointsData 变量
  4. 预解析 motion JSON → motionData 变量
  5. 预解析 pkf JSON → pkfData 变量（可选）
  6. assetLoader 构造 Three.js root（不 attach 到 sceneManager）

Phase 2（全部校验通过才开始动状态）：
  7. trajectoryOverlay.clear()
  8. sceneManager.setSceneRoot(root)
  9. keyframeManager.reset()
  10. 用 Phase 1 解析好的 data 重建 joints / motion / pkf / markers
```

任一 JSON 损坏 → 在 Phase 1 抛异常 → catch 时 `sceneManager` / `keyframeManager` / `trajectoryOverlay` 都还没被触碰 → 用户当前工程完好。

### 2.3 为什么不上 snapshot + rollback

另一种做法是 Phase 2 前全量快照，失败时 restore。**更复杂、更慢**。

实际观察：导入失败的场景里 **99% 是 JSON 解析阶段**（格式错、字段缺失、旧 schema）。Three.js loader 失败 / 场景 mutation 抛异常的概率极低。把所有解析前置就能覆盖绝大多数失败。

YAGNI。等真遇到 Phase 2 失败的案例再上 snapshot。目前 Phase 1 + Phase 2 的分层已经够。

### 2.4 这条规则通用

任何"加载文件覆盖当前工程"的流程都适用这个模式：先解析到内存，全部通过再动状态。催生这条规则的不只是这次，我历史上在另一个项目也踩过一次 —— 两次以后就再也没违反过。

---

## 3. Schema v7 + 文档闭环

### 3.1 Schema 变迁

| 版本 | 关键变化 | 驱动原因 |
|------|---------|---------|
| v4 | model.glb 改由 GLTFExporter 重新序列化（不再透传原文件） | 跨平台编辑需要统一状态 |
| v5 | motion.json 新增 `reparent_events[]` | 取货/放货需要时间轴上切 parent |
| v6 | manifest 新增 `scene_markers[]` + pkf.json 文件 | 货物占位 + 参数化动画 |
| v7 | joints 新增 `limit_upper` + `overflow_to`（双段门架 overflow）+ pkf steps 新增 `template_segment` / `template_segment_name` | bugfix #59 + F61 |

### 3.2 双段门架 overflow（v7 的核心）

叉车门架常见结构是内外嵌套（内门架在外门架里滑动）。用户的自然做法是把 `role=门架升降` 同时贴给内外两段—— role 是业务语义，两段都是门架升降没错。但 `findPrimaryByRole('门架升降')` 遇到两个候选就随机选一个，模板 PKF 绑错关节，叉齿不抬。

解法：

```json
{
  "name": "InnerMast",
  "role": "门架升降",
  "limits": { "min": 0, "max": 2.0 },
  "limit_upper": 1.5,
  "overflow_to": "OuterMast"
}
```

`limit_upper` 是内段"本段能吃多少"的上限。超过的部分由运行时 `_redistributeOverflows()` 转给 `overflow_to` 指向的关节。`overflow_to` 存关节 **名字**（跨 roundtrip 稳定），不是 uuid。

`findPrimaryByRole` 看到某关节被别人 `overflow_to` 指向，自动把它当 slave，不参与 primary 选择。规则自动推导，**用户不用标 primary/slave**，也没有额外 UI 按钮。

### 3.3 文档闭环问题

`ResultPackageExporter.js` 里 schema_version 常量 v4 → v7 改过三次，但 `docs/schema/` 目录下一直只有 `v4.md`。README 和 docs/index.md 的链接也指向 v4.md。下游系统按 v4 实现会漏读 `scene_markers` / `limit_upper` / `overflow_to` / `template_meta` 等字段——写代码时觉得"只是加个字段"，其实**每加一个字段就有一份新的对接契约**。

修法：

1. 新建 `docs/schema/v7.md`，完整字段定义 + v4→v7 迁移表（v5/v6 的增量字段在迁移表里一并写）
2. README / docs/index.md / docs/concepts/zip-output-schema.md 所有链接改指向 v7.md
3. v4.md 保留做历史版本

这条修完后我把"schema 版本号动必须三处联动"加进了 CLAUDE.md 的协作规则——常量 / docs/schema/vN.md / 对外链接。漏一处下游就按错版本实现，这是真实付出过代价的。

---

## 4. 测试基建：集成测试 + AI pipeline 测试

### 4.1 问题

mvp1 做完时有 145 unit tests，覆盖：FK 求解器 / 模板编译 / 关节环检测 / `computeForkAnchorZero` 等**纯数学核心**。但 main.js 的导入/导出 / AI pipeline / UI 接线**零测试覆盖**。

历史上每个跨模块 bug——#18 parent_name 丢失、#22 懒捕获时机、#30 导入后停末态、F61 template_segment 丢失——修完只能靠手工跑"加载 → 配关节 → 🚀 一键 → 导出 → 新 session 导入 → 播放"一遍确认。费时易漏。

### 4.2 集成测试设计

新增 `tests/integration/` 目录，vitest include 加一条路径同时跑 unit + integration。策略：**纯 Node 环境 + stub 掉 DOM 依赖**，不用 Playwright。

关键 helper：

```js
function createSilentExporter() {
  const exporter = new ResultPackageExporter();
  exporter.serializeSceneToGlb = async () => new ArrayBuffer(8);  // 跳过 GLTFExporter（DOM 依赖）
  exporter.downloadBlob = () => {};                                // 跳过 document.createElement
  return exporter;
}
```

然后构造 KeyframeManager + 最小 THREE scene，调 `exportZip` 拿回 `{ manifest, joints, motion, pkf }`，`JSON.stringify → JSON.parse` 模拟下游从 ZIP 读数据的视角，断言字段完整。

五个场景（每个对应一个真实历史 bug）：

1. joint def name/parent_name/role/四元数 roundtrip（防 #18 / #7）
2. PKF template_segment roundtrip（防 F61）
3. limit_upper + overflow_to roundtrip（防 #59）
4. schema_version 恒为 7 + scene_markers + root_name 存在（防版本号退化）
5. PKF-only clip（keyframes 空但 duration + reparent_events 完整，防老版 `isV2` 误判）

### 4.3 AI pipeline 测试

`ensurePkfCoversAttachPoint` 是 🚀 一键流程里最复杂的 AI 输出 sanitize + 自动补 step 逻辑——大约 100 行，包含正则清洗、attach 点偏差检测、自动注入 step 三套逻辑。原来内联在 main.js 里，闭包依赖 `keyframeManager`。

抽成独立模块 `src/core/aiPipeline/ensurePkfCoversAttachPoint.js`，`keyframeManager` 改为显式第 3 参——**这一步改动只加了 1 行代码**（调用点 + 函数签名），但让单测变得 trivial。

21 个测试分四组：

- **sanitize 逻辑 6 测**：approach_gap 强制归 0 / fork_anchor_zero 裸常数清洗 / 合法 `+ approach_gap` 保留 / 混合表达式 / warning 省略号
- **跳过条件 4 测**：无 attach event / cargo 找不到 / forkAnchor 残缺 / 三维都 < 阈值
- **注入行为 7 测**：单维注入 / 三维全注入 / 缺 role warning / 已覆盖不重复 / cargo_height 半高 / approach_gap sanitize 后算 / revolute → rotate channel
- **边界 4 测**：pkf=null / undefined / steps 缺失 / keyframeManager=null 不抛

### 4.4 GitHub Actions CI

30 行 YAML：

```yaml
on: [push, pull_request]
jobs:
  test-and-build:
    concurrency:
      group: ci-${{ github.ref }}
      cancel-in-progress: true
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm }
      - run: npm ci
      - run: npm test
      - run: npm run build
```

`concurrency` 防止连续 push 多次跑（每次 push 只留最新一次）。最简单的 CI，但从此改 main.js / exporter / AssetLoader / AI pipeline 任何一处都有兜底——**本地忘了跑测试就 merge 这条路被堵死了**。

### 4.5 几点教训

1. **集成测试是兜"单元测试看不见"的跨模块 bug**。单测防单函数算错；集成测试防"两个函数接起来数据变形"。我历史上的 roundtrip bug 都是第二类
2. **抽函数 = 把难测变可测**。`ensurePkfCoversAttachPoint` 闭包依赖改成显式参数只加 1 行，但让测试从"不可能写"变成"20 分钟写完"
3. **不用上 Playwright 也能起步**。Node 层 stub DOM 覆盖 80% 的序列化边界回归，低成本高回报。剩下 20%（真实 UI 交互）以后真有痛点再加
4. **测试要映射真实历史 bug**。每个测试注释里写清楚防哪个 #编号——写测试不是为了覆盖率，是为了防退化

---

## 5. Bundle 瘦身：lazy import 的取舍

### 5.1 数据

改之前：

```
dist/assets/index-xxx.js   1,140 kB │ gzip: 305 kB
(!) Some chunks are larger than 500 kB after minification.
```

改之后：

```
dist/assets/index-xxx.js             945 kB │ gzip: 247 kB
dist/assets/GLTFExporter-xxx.js       35 kB │ gzip:  10 kB
dist/assets/USDZLoader-xxx.js         64 kB │ gzip:  19 kB
dist/assets/jszip.min-xxx.js          95 kB │ gzip:  28 kB
```

首屏 −17%（gzip −19%）。Vite 的 chunk 警告消失。

### 5.2 选什么、不选什么

**改成 lazy import**：

- `USDZLoader`（见 `AssetLoader.js`）：只有用户上传 `.usdz` 才下载
- `GLTFExporter`（见 `ResultPackageExporter.js`）：只有用户导出 ZIP 才下载
- `JSZip`（两处：`ResultPackageExporter.js` 和 `main.js`）：只有导入/导出 ZIP 才下载

**保持静态 import**：

- `GLTFLoader`：绝大多数用户一打开页面立即加载 `.glb`，懒加载反而让第一次加载多一次 round trip
- `OrbitControls` / `TransformControls` / `ViewHelper`：渲染场景必需

原则是**按"用户路径概率"决定**。90%+ 用户走的路径保持静态；偶尔才走的路径改 lazy。

### 5.3 代码 pattern

```js
// 旧（顶部静态 import）
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

// 新（用到时动态 import）
async serializeSceneToGlb(sceneRoot) {
  const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
  const exporter = new GLTFExporter();
  // ...
}
```

Vite 看到 `await import(...)` 自动切独立 chunk，浏览器第一次访问这段代码时 fetch 对应 chunk 文件。代码侧的成本：函数签名从同步变 async，传染上去——但几乎所有 import/export 调用链本来就是 async，几乎无感。

### 5.4 权衡

- **收益**：首屏 −17%，慢网用户体验好；Vite chunk 警告消失；lazy chunk 独立缓存，改业务代码不影响这些 chunk 的 hash，部署流量省
- **代价**：用户第一次导出 ZIP / 第一次打开 USDZ 会有 ~200ms 的 chunk 下载延迟（同样 chunk 第二次就缓存了）；函数签名传染 async（影响小）
- **风险**：离线或 chunk 文件 404 时 `await import()` 抛 `ChunkLoadError`。**没写 try/catch**——接受默认错误行为，这种 case 太少，写统一处理反而让错误语义糊掉

### 5.5 没做的事：大文件拆分

外部 review 里同时提到"拆 main.js / EditorUI.js / KeyframeManager.js（都 1500+ 行）"。**我没拆**。

理由：

- 不是团队协作，没有 merge conflict 问题
- 文件内部有清晰的 section 注释（`// ══` 分块），搜索跳转不难
- 和 Claude 协作时 AI 读 2600 行 main.js 完全没问题
- Vite 打包看 import graph，拆文件**不减少** bundle 体积
- 拆文件有风险（闭包变量要显式传参、依赖倒置、漏一处就炸），而 main.js 没集成测试托底

我的观点：**文件大不等于代码坏**。拆分要有具体痛点才做（团队协作冲突 / 真的读不过来 / 要按功能独立部署），条件反射拆分是工程浪费。这条和"lazy import"的判断同根——都是看**有没有真实收益**，不是看"业界规范是什么"。

---

## 6. 这两周攒的几条通用原则

按"这次再遇到时可以直接套用"的粒度列：

1. **Mutation-first-validate-later 是反模式**——"加载文件覆盖当前工程"类流程一律两段：Phase 1 纯解析、Phase 2 再动状态
2. **Schema 版本号动必须三处联动**——代码常量 / docs/schema/vN.md / 对外链接。漏一处下游就按错版本
3. **抽函数 = 让难测变可测**——闭包依赖改成显式参数一般只要加 1 行，但测试从"不可能写"变成"trivial"
4. **bbox 底面中心 + localToWorld = 跟动画的锚点**——比 `getWorldPosition()`（pivot 不可靠）好，比"每帧算 bbox"（AABB 旋转后失真）好，比"存世界 offset"（不跟动画）好
5. **数据正确 ≠ 视觉正确**——可视化工具要按**用户视觉期望**选采样点，不是按"数学上正确的点"。编程正确和用户有用是两件事
6. **集成测试要映射真实历史 bug**——每个测试注释里写防哪个 #编号。测试不是覆盖率，是防退化
7. **lazy import 收益 ≈ 15-20% bundle 瘦身**——和预期接近，实际改起来不复杂（10-20 分钟/处），但不要过度优化
8. **文件大不等于坏代码**——拆分要有具体痛点，条件反射拆分是工程浪费
9. **CI 从第一天起加**——即使只是 `npm test + npm run build` 也能兜住 90% 的"本地忘跑测试就 merge"
10. **小工具是大杠杆**——300 行的 TrajectoryOverlay 让人机协作效率翻倍；30 行的 CI yaml 让测试再也不会被遗忘；50 行的 lazy import 改动砍 17% bundle。工程基建不靠写大量代码，靠**在对的位置放小杠杆**

---

## 代码入口索引（补 mvp1 那份）

| 主题 | 文件 | 关键函数 |
|------|------|---------|
| 轨迹 overlay | `src/core/TrajectoryOverlay.js` | `sampleOnly`, `refresh` |
| AI 输出 sanitize | `src/core/aiPipeline/ensurePkfCoversAttachPoint.js` | `ensurePkfCoversAttachPoint` |
| ZIP 事务化导入 | `src/main.js` | `handleImportPackage`（Phase 1 + Phase 2） |
| Schema v7 导出 | `src/core/ResultPackageExporter.js` | `exportZip` |
| 集成测试 | `tests/integration/zip-roundtrip.test.js` | 5 场景 / 11 测试 |
| AI pipeline 测试 | `tests/integration/ai-pipeline.test.js` | 4 组 / 21 测试 |
| CI | `.github/workflows/ci.yml` | push + PR 触发 |
| 双段门架 overflow | `src/core/KeyframeManager.js` | `_redistributeOverflows`, `findPrimaryByRole` |

## 相关文档

- [docs/bugfix-log.md](../bugfix-log.md) —— 完整 bug 历史 #1-#66
- [docs/schema/v7.md](../schema/v7.md) —— 当前 ZIP 输出格式
- [docs/concepts/forklift-pickup-model.md](../concepts/forklift-pickup-model.md) —— fork_anchor 机制
- [docs/articles/ai-3d-editing-visual-handles.md](ai-3d-editing-visual-handles.md) —— AI + 3D 编辑讨论（围绕轨迹 overlay 展开）

---

## 结语

mvp1 那篇我写的是**"怎么让这个系统跑对"**——数学、核心流程、踩坑换来的 11 条设计决策。
这篇写的是**"怎么让这个系统长期被人用"**——工程基建、可视化、测试、CI、bundle。

做项目最容易犯的错是过度重视前者（算法 / 数学 / 核心正确）而忽视后者（基建 / 测试 / 协作效率）。前者决定系统的天花板，后者决定下限能持续多久。没有后者，前者做得再漂亮也会在"换个协作者"或"下游对接"那一刻崩。

两周内加的这五层工程化基建，每一层单独看都平平无奇——Phase 1/Phase 2 导入、两个 tests/integration/ 目录、几行 lazy import、30 行 CI、150 行可视化 overlay。但它们合起来让 MotionForge 从**我一个人能跑的 demo** 变成**多方（人、AI、下游系统）能协作的工具**。这个身份转变本身就是个工程师必须有的阶段。

对在做参数化设计、机器人仿真、Web 端 3D 编辑器的朋友：每一条都是现成、低成本、可复用。评论区见，或者找我聊。
