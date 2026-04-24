# MotionForge 技术补遗 —— 工程基建与可视化辅助层

> 作者：Hockwang  项目：MotionForge
> 时间：2026-04-24
> 阅读时间：约 20 分钟
> 适合谁：读过正淳那篇《MotionForge 核心系统》之后，想看"工程化部分"怎么做的
> 前置阅读：[MotionForge — 基于 Three.js + Vite 的浏览器端 FK 求解器 + 参数化动画系统](https://...)（正淳，2026-04-16）

## TL;DR

正淳的文章覆盖了 MotionForge 的数学核心（FK / PKF / 关键帧 / AI pipeline）。这篇补遗讨论 2026-04-16 之后的两周里加的**工程化基建**：

1. **可视化辅助层**：轨迹 overlay 从诊断脚本毕业成产品功能，锚点从 Object3D pivot 改为 bbox 功能点
2. **ZIP 事务化**：导入失败不再污染当前工程
3. **Schema v7**：双段门架 overflow + 模板段号 + 文档闭环
4. **测试基建**：从 145 unit tests 扩展到 177（+11 集成测试 + 21 AI pipeline 测试）+ GitHub Actions CI
5. **Bundle 瘦身**：首屏 1,140 kB → 945 kB（lazy import GLTFExporter / USDZLoader / JSZip）

每一条都是**独立的小模块**，不涉及核心 FK/PKF 逻辑，但加起来让这个项目从"本地能跑"变成"下游能对接、CI 能兜底、协作能 AI 化"。

## 为什么写

前一篇核心系统的文章写完之后，我又经历了两轮外部 review（GPT-5.5 的独立 review）和一轮用户反馈驱动的轨迹可视化迭代。这些迭代本身数学不复杂，但**每一条都是真实踩过的坑换来的工程决定**，值得沉淀。

---

## 目录

1. [轨迹 overlay：从诊断脚本到产品功能](#1-轨迹-overlay从诊断脚本到产品功能)
2. [ZIP 导入的事务化](#2-zip-导入的事务化)
3. [Schema v7 演进 + 文档闭环](#3-schema-v7-演进--文档闭环)
4. [测试基建：集成测试 + AI pipeline 测试](#4-测试基建集成测试--ai-pipeline-测试)
5. [Bundle 瘦身：lazy import 的取舍](#5-bundle-瘦身lazy-import-的取舍)
6. [关键经验教训](#6-关键经验教训)

---

## 1. 轨迹 overlay：从诊断脚本到产品功能

### 1.1 动机

PKF 动画调试的常见困境：用户说"放货位偏了 0.3m"，你看截图看不出偏在哪、偏多少。console.warn 刷屏你看不过来。改完 PKF 重新播放，眼睛盯着看叉齿有没有瞬移。

早期版本里这个诊断靠 `tests/diag-template.js` 的 `__diagTpl.drawTrajectory()` —— 一个 Console 脚本，需要用户手动粘贴执行。门槛高 + 不是常态工具。

### 1.2 产品化

在 UI 的时间轴右侧加一个 🎨 轨迹 toggle，勾上就采样 duration 内的 fork / cargo 世界坐标，串成折线画进 sceneRoot。Attach 事件画红大球、detach 画绿大球。同时 console.table 每段 PKF step 的坐标。

**采样策略**（[TrajectoryOverlay.sampleOnly](../../src/core/TrajectoryOverlay.js)）：

```
1. 保存当前 joint values + currentTime
2. 把所有 PKF 触及的 joint 一次性清零（bug #60 修：否则非 t=0 时刻打开 toggle 会污染小 t 采样）
3. 对 200 个 t 值（等距）：
   a. evaluatePkfAt(t)
   b. 覆盖 joint values
   c. applyAllJointDrives
   d. applyReparentEventsAtTime(t)
   e. 采样 fork / cargo 的世界坐标
4. try/finally 复原快照
```

### 1.3 采样锚点：从 pivot 到 bbox 底面中心

最初的实现用 `fork.getWorldPosition()` 和 `cargo.getWorldPosition()` 采样。结果轨迹线飘在小车上方 1-2m，用户说"这不是真实轨迹吧"。

问题在于：**`getWorldPosition` 返回的是 Object3D 的 pivot（原点）**，它是建模时设定的抽象点，不一定是"叉齿承载面"或"货物底面"。在我们的三向车模型里，`_CS19110` 这个 mesh 的 pivot 偏移在几何体顶部。

修法（[bugfix #66](../bugfix-log.md)）：

```js
// 首帧（i=0，t=0 姿态）算 local offset
if (fork) {
  const box = new THREE.Box3().setFromObject(fork);
  if (!box.isEmpty()) {
    const center = box.getCenter(new THREE.Vector3());
    const anchorWorld = new THREE.Vector3(center.x, box.min.y, center.z);
    forkAnchorLocal = fork.worldToLocal(anchorWorld);
  }
}

// 每帧：local → world，自动跟随 fork 动画（含旋转）
if (fork && forkAnchorLocal) {
  forkPts.push(fork.localToWorld(forkAnchorLocal.clone()));
}
```

关键点：
- **bbox 底面中心**（`(center.x, box.min.y, center.z)` threejs），和 `computeForkAnchorZero`（AI pipeline 用的 fork_anchor_zero）同公式 —— 保证轨迹线和 AI 看到的 anchor 是同一个点
- **local offset + localToWorld**：首帧算一次，之后每帧复用。这处理旋转比"每帧算 bbox"更精确（后者是 axis-aligned 世界 bbox，旋转后失真），比"存世界 offset"更通用（后者不跟随动画）
- **降级路径**：bbox 为空 / 对象不存在 → 回退到 `getWorldPosition`，老行为不炸

### 1.4 视觉 vs 数据的 gap

一个值得记的观察：**数据正确 ≠ 视觉正确**。我们把采样锚点修到 bbox 底面中心后，数据确实反映 tine 位置，但用户第一眼还是觉得"没变化"。原因是：

1. 相机侧视 + 透视压缩 → Y 变化被压平
2. 长水平 transport 段占视觉主导
3. 用户心理预期（"轨迹应该在地面"）和 PKF 实际（三向车在 1m 货架放货）不一致

解决手段不是改代码，是在 console.table 后面追加一条 **Y 范围汇总 log**：

```
━━ Y 范围（看轨迹是不是"真的平"）━━
  fork.y : [0.042, 1.000] 变化 0.958m
  cargo.y : [0.500, 1.098] 变化 0.598m
  ↑ 数值差 > 0.2m 但视觉看着平 → 相机透视压缩，切正射视图看
```

数字说话，比反复辩论"看起来像"更快。

### 1.5 和 AI 协作的连接点

这套 overlay 同时是 AI 协作基建。`sampleOnly` 返回结构化数据（rows / forkPts / cargoPts / duration / fork / cargo 对象），可以直接序列化喂给 LLM 做自检。

当前还没接自检（L3 预留位），但 API 设计时已经按"既可看又可导出"的原则写。UI 渲染和数据采样走同一套逻辑，两种输出：

- 看：`TrajectoryOverlay.refresh()` 画线 + 画球
- 导：`TrajectoryOverlay.sampleOnly()` 返回数据，不动场景

延伸阅读：[AI 编辑 3D 软件的可能性 —— 从一条轨迹辅助线说起](ai-3d-editing-visual-handles.md)

---

## 2. ZIP 导入的事务化

### 2.1 问题

老版本的 `handleImportPackage` 流程：

```js
try {
  const zip = await JSZip.loadAsync(zipData);
  const manifest = JSON.parse(...);
  const modelFile = ...;
  const root = await assetLoader.loadFromFile(modelFile, ...);
  
  sceneManager.setSceneRoot(root);   // ← 第一次 mutation
  keyframeManager.reset();            // ← 清空所有数据
  
  // 然后才开始解析 joints/motion/pkf JSON
  const jointsData = JSON.parse(await zip.file('joints-xxx.json').async('string'));
  // ... 如果这里抛异常，上面的 sceneRoot 已经被替换了
  
} catch (err) {
  ui.setLoadStatus('导入失败: ' + err.message);
  // 用户当前工程已经被污染 —— 旧模型没了、关节也没了、只剩错误信息
}
```

这是 **mutate-first-validate-later 反模式**。任何一个 JSON 损坏都会让用户丢失当前编辑中的工程。

### 2.2 解法：两阶段

重构成 Phase 1 + Phase 2（[main.js handleImportPackage](../../src/main.js)）：

```
Phase 1（零 mutation）：
  1. 读 zip 字节
  2. 解析 manifest
  3. 预解析 joints-xxx.json 到 `jointsData` 变量
  4. 预解析 motion-xxx.json 到 `motionData` 变量
  5. 预解析 pkf-xxx.json 到 `pkfData`（可选）
  6. 走 assetLoader 构造 Three.js root（不 attach 到 sceneManager）

Phase 2（全部校验通过才开始 mutation）：
  7. trajectoryOverlay.clear()
  8. sceneManager.setSceneRoot(root)
  9. keyframeManager.reset()
  10. 用 jointsData / motionData / pkfData 重建内部状态
```

任一 JSON 损坏 → Phase 1 抛异常 → catch 时 `sceneManager` / `keyframeManager` / `trajectoryOverlay` 都未被触碰 → 用户当前工程完好。

### 2.3 为什么不做"snapshot + rollback"

另一种做法是 mutation 前全量快照，失败时 restore。**更复杂、更慢，也不是必需**。

观察是：导入流程里 **99% 的失败在 JSON 解析阶段**（格式错、字段缺失、Schema 版本旧）。Three.js loader 失败或场景 mutation 抛异常的概率极低。只要把所有解析工作前置，就能覆盖绝大多数失败情况。

**YAGNI**：等真遇到 Phase 2 失败案例再加 snapshot 机制。目前 Phase 1 + Phase 2 的分层已经够。

### 2.4 通用教训

**"加载文件覆盖当前工程"类流程都适用这个模式**：任何会修改全局状态的代码，前面加一个"纯解析、零 mutation"的校验层。catch 的语义从"出错了告诉用户，已经太迟"变成"出错了回滚到健康状态"。

---

## 3. Schema v7 演进 + 文档闭环

### 3.1 Schema 变迁

| 版本 | 关键变化 | 驱动 bug |
|------|---------|---------|
| v4 | model.glb 由 GLTFExporter 重新序列化 | 导出后跨平台编辑 |
| v5 | motion.json 新增 `reparent_events[]` | 取货 / 放货 reparent |
| v6 | manifest 新增 `scene_markers[]` + pkf.json 文件 | 货物占位 + 参数化动画 |
| v7 | joints 新增 `limit_upper` + `overflow_to`（双段门架 overflow）+ pkf steps 新增 `template_segment` / `template_segment_name` | bugfix #59 + F61 |

### 3.2 双段门架 overflow（v7 核心）

问题：叉车门架常常是内外嵌套（主门架 + 副门架）。用户自然地把 `role=门架升降` 同时贴给内外两段，但 `findPrimaryByRole('门架升降')` 随机选一个 → 模板 PKF 绑错。

修法（[bugfix #59](../bugfix-log.md)）：

```
joints.json: {
  name: "InnerMast", role: "门架升降",
  limits: { min: 0, max: 2.0 },
  limit_upper: 1.5,           // 内段上限
  overflow_to: "OuterMast",   // 超过部分派给谁（用名字，跨 roundtrip 稳定）
}
```

运行时：`applyAllJointDrives` 前跑 `_redistributeOverflows()`，把超过 limit_upper 的部分转给 `overflow_to` 关节。

`findPrimaryByRole` 看到 `overflow_to` 字段就把被指向的关节当 slave，自动跳过 —— 用户不用手动标 primary/slave，规则自动推导。

### 3.3 文档闭环

**问题**：`ResultPackageExporter.js` 的常量 `schema_version: 7` 改了三次版本号，但 `docs/schema/` 下还只有 `v4.md`。README 链接也指向 v4.md。下游按 v4 实现会漏读 `scene_markers` / `limit_upper` / `template_meta` 等字段。

修法（[bugfix #63](../bugfix-log.md)）：

1. 新建 `docs/schema/v7.md`（完整字段定义 + v4→v7 迁移表）
2. README / docs/index.md / docs/concepts/zip-output-schema.md 所有链接指向 v7.md
3. v4.md 保留作历史版本

**教训**：**schema 版本号变动必须三处联动** —— `ResultPackageExporter.js` 常量 / `docs/schema/vN.md` / 链接。漏一处就让下游按错的 schema 实现。这条以后要写进 CLAUDE.md 的协作规则。

---

## 4. 测试基建：集成测试 + AI pipeline 测试

### 4.1 问题

前一轮的 145 unit tests 全覆盖核心数学（FK / 模板编译 / 环检测 / `computeForkAnchorZero` 等）。但 main.js 的导入/导出流程 + AI pipeline 零测试 —— 历史上每个跨模块 bug（#18 parent_name 丢失 / #22 懒捕获时机 / #30 导入停末态 / F61 template_segment 丢失）修完只能靠手动测 "加载 → 配关节 → 🚀 一键 → 导出 → 再导入" 的路径，费时易漏。

### 4.2 集成测试设计

新增 `tests/integration/` 目录，配置 vitest include 同时跑 unit + integration。核心策略：**纯 Node 环境 + stub DOM 依赖**。

关键 helper（[tests/integration/zip-roundtrip.test.js](../../tests/integration/zip-roundtrip.test.js)）：

```js
function createSilentExporter() {
  const exporter = new ResultPackageExporter();
  exporter.serializeSceneToGlb = async () => new ArrayBuffer(8);  // 跳过 GLTFExporter（DOM 依赖）
  exporter.downloadBlob = () => { /* no-op */ };                  // 跳过 document
  return exporter;
}
```

exportZip 返回 `{ manifest, joints, motion, pkf }`，JSON.stringify → JSON.parse 一遍模拟下游从 ZIP 读数据的视角。5 场景覆盖：

1. joint def name/parent_name/role/四元数 roundtrip（防 #18 / #7）
2. PKF template_segment roundtrip（防 F61）
3. limit_upper + overflow_to roundtrip（防 #59）
4. schema_version 恒为 7 + scene_markers + root_name 存在
5. PKF-only clip（keyframes 空但 duration + reparent_events 完整）

### 4.3 AI pipeline 测试

`ensurePkfCoversAttachPoint` 是 🚀 一键流程里最复杂的 AI 输出 sanitize + 自动补 step 逻辑。从 main.js 闭包依赖抽出成独立模块（[src/core/aiPipeline/ensurePkfCoversAttachPoint.js](../../src/core/aiPipeline/ensurePkfCoversAttachPoint.js)），`keyframeManager` 改为显式第 3 参 —— 这一步改动只加了 1 行代码，却让单测变得 trivial。

21 个测试分 4 组（[tests/integration/ai-pipeline.test.js](../../tests/integration/ai-pipeline.test.js)）：

- **sanitize 逻辑 6 测**：approach_gap 强制归 0 / fork_anchor_zero 裸常数清洗 / 合法表达式保留 / 混合表达式 / warning 省略号
- **跳过条件 4 测**：无 attach event / cargo 找不到 / forkAnchor 残缺 / 三维都 < 阈值
- **注入行为 7 测**：单维注入 / 三维全注入 / 缺 role warning / 已覆盖不重复 / cargo_height 半高 / approach_gap sanitize 后计算 / revolute → rotate channel
- **边界 4 测**：pkf=null / undefined / steps 缺失 / keyframeManager=null 不抛

### 4.4 GitHub Actions CI

加 [.github/workflows/ci.yml](../../.github/workflows/ci.yml)：

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

30 行 YAML，`concurrency` 防止连续 push 叠跑。这是最低成本的 CI，从此改 main.js / exporter / AssetLoader / AI pipeline 任一处都有 CI 兜底。

### 4.5 经验教训

1. **集成测试 = 兜住"单元测试看不见"的跨模块 bug**。单元测试防单函数算错，集成测试防"两个函数接起来数据变形"
2. **抽函数到独立模块是把"难测"变"可测"的最低成本方案**。`ensurePkfCoversAttachPoint` 闭包依赖改成显式参数只加了 1 行
3. **不用上 Playwright 也能起步**。纯 Node 调被测函数 + stub DOM，覆盖 80% 的序列化边界回归
4. **测试要映射真实历史 bug**。每个测试注释里写清楚防哪个 #编号，写测试不是为了覆盖率而是为了防退化

---

## 5. Bundle 瘦身：lazy import 的取舍

### 5.1 数据

改之前：

```
dist/assets/index-xxx.js  1,140 kB │ gzip: 305 kB
(!) Some chunks are larger than 500 kB after minification.
```

改之后：

```
dist/assets/index-xxx.js          945 kB │ gzip: 247 kB
dist/assets/GLTFExporter-xxx.js    35 kB │ gzip:  10 kB
dist/assets/USDZLoader-xxx.js      64 kB │ gzip:  19 kB
dist/assets/jszip.min-xxx.js       95 kB │ gzip:  28 kB
```

首屏 -17%（gzip -19%）。

### 5.2 选了什么、没选什么

**改**：
- `USDZLoader`（[AssetLoader.js](../../src/core/AssetLoader.js)）：只有 `.usdz` 文件才下载
- `GLTFExporter`（[ResultPackageExporter.js](../../src/core/ResultPackageExporter.js)）：只有导出 ZIP 才下载
- `JSZip`（[ResultPackageExporter.js](../../src/core/ResultPackageExporter.js) + [main.js](../../src/main.js)）：只有导入/导出 ZIP 才下载

**没改**：
- `GLTFLoader`：绝大多数用户打开页面后立即加载 `.glb` 模型，懒加载反而让第一次加载延迟
- `OrbitControls` / `TransformControls` / `ViewHelper`：渲染场景必备，首屏必需

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

Vite build 时看到 `await import(...)` 自动切独立 chunk，浏览器首次访问这段代码时 fetch 对应 chunk 文件。

### 5.4 权衡

- **收益**：首屏 -17%，慢网 / 手机用户打开更快；Vite chunk 警告消失；lazy chunk 独立缓存，业务代码改动不影响这些文件的 hash
- **代价**：用户首次使用某功能（第一次导出 ZIP、第一次打开 USDZ）会有一次 ~200ms 延迟；调用点函数签名变 async（传染性，但几乎所有调用链本来就是 async）
- **风险**：网络断开时 `await import()` 抛 `ChunkLoadError`。**没加 try/catch** —— 接受默认错误行为，因为这种失败极少见，统一处理会让代码复杂

### 5.5 不做的选项

GPT review 原始建议里还有一条 "把 main.js / EditorUI.js / KeyframeManager.js 拆小"。**拒绝了**。

理由：
- 不是团队协作，没有 merge conflict
- 文件内部有清晰的 section 注释，搜索/跳转不难
- Claude 读 2600 行 main.js 没问题
- Vite 打包看 import graph，拆文件不减少 bundle
- 拆文件有风险（闭包变量漏传、依赖倒置），main.js 没集成测试

**"文件大 ≠ 代码坏"**。拆分要有具体痛点才做，不是条件反射。

---

## 6. 关键经验教训

这两周工程基建沉淀下来的几条跨 bug 通用原则：

### 6.1 Mutation-first-validate-later 是反模式

任何"加载文件覆盖当前工程"的场景，把解析和 mutation 切成两段。Phase 1 纯解析抛异常 → catch 零污染。

### 6.2 Schema 版本号动必须三处联动

代码常量 / docs/schema/vN.md / 对外链接。漏一处下游就按错版本实现。

### 6.3 抽函数 = 让难测变可测

闭包依赖改成显式参数一般只要加 1 行代码，但让单测 trivial。AI pipeline 里 `ensurePkfCoversAttachPoint` 就是典型例子。

### 6.4 bbox 底面中心 + localToWorld = 跟动画的锚点

比 `getWorldPosition()`（pivot 不可靠）好，比"每帧算 bbox"（AABB 在旋转后失真）好，比"存世界 offset"（不跟动画）好。

### 6.5 数据正确 ≠ 视觉正确

可视化工具要按用户视觉期望选采样点。`_CS19110` Object3D 的 pivot 是数学抽象点；bbox 底面中心是用户眼里的"叉齿 tine"。前者对编程正确，后者对用户有用。

### 6.6 集成测试要映射真实历史 bug

每个测试注释写清楚防哪个 #编号。测试不是为了覆盖率，是为了防退化。

### 6.7 lazy import 收益 ≈ 15-20% bundle 瘦身

和预期接近；实际改起来没有想象中复杂（改 3 处 import + 相应调用点），10-20 分钟/处。不要过度优化，但值得做。

### 6.8 大文件 ≠ 坏代码

拆分要有具体痛点才做（团队协作冲突 / 文件真的读不过来 / 打包要分 chunk）。条件反射拆分是工程浪费。

### 6.9 CI 从第一天起加

即使只是 `npm test + npm run build` 两条命令，也能兜住 90% 的"本地忘了跑测试就 merge" 问题。

### 6.10 文件大 ≠ 代码坏；小工具 = 大杠杆

300 行的 TrajectoryOverlay 让人机协作效率翻倍；30 行的 CI yaml 让测试从来不会被遗忘；50 行的 lazy import 改动砍 17% bundle。工程基建不靠写大量代码，靠**在对的位置放小杠杆**。

---

## 代码入口索引（补充正淳文的那份）

| 主题 | 文件 | 关键函数 |
|------|------|---------|
| 轨迹 overlay | [src/core/TrajectoryOverlay.js](../../src/core/TrajectoryOverlay.js) | `sampleOnly`, `refresh` |
| AI 输出 sanitize | [src/core/aiPipeline/ensurePkfCoversAttachPoint.js](../../src/core/aiPipeline/ensurePkfCoversAttachPoint.js) | `ensurePkfCoversAttachPoint` |
| ZIP 事务化导入 | [src/main.js](../../src/main.js) | `handleImportPackage`（Phase 1 + Phase 2） |
| Schema v7 导出 | [src/core/ResultPackageExporter.js](../../src/core/ResultPackageExporter.js) | `exportZip` |
| 集成测试 | [tests/integration/zip-roundtrip.test.js](../../tests/integration/zip-roundtrip.test.js) | 5 场景 / 11 测试 |
| AI pipeline 测试 | [tests/integration/ai-pipeline.test.js](../../tests/integration/ai-pipeline.test.js) | 4 组 / 21 测试 |
| CI | [.github/workflows/ci.yml](../../.github/workflows/ci.yml) | push + PR 触发 |
| 双段门架 overflow | [src/core/KeyframeManager.js](../../src/core/KeyframeManager.js) | `_redistributeOverflows`, `findPrimaryByRole` |

## 相关文档

- [docs/bugfix-log.md](../bugfix-log.md) — 完整 bug 历史 #1-#66
- [docs/schema/v7.md](../schema/v7.md) — 当前 ZIP 输出格式
- [docs/concepts/forklift-pickup-model.md](../concepts/forklift-pickup-model.md) — fork_anchor 机制
- [docs/articles/ai-3d-editing-visual-handles.md](ai-3d-editing-visual-handles.md) — AI + 3D 编辑讨论

---

## 结语

正淳那篇讲的是**"怎么让这个系统跑对"**（数学 + 核心流程）。
这篇讲的是**"怎么让这个系统能长期被人用"**（工程基建 + 可视化 + 测试 + CI）。

两者都重要。前者决定系统的天花板，后者决定系统的下限能持续多久。

做产品化工程最容易犯的错误是过度重视前者（算法 / 数学 / 核心正确性）而忽视后者（基建 / 测试 / 协作效率）。后者看起来"不酷"、没有炫技空间，但它是决定一个项目能不能跑 6 个月的关键。

两周内加的这些工程化层，每一层单独看都不复杂，合起来让 MotionForge 从"能用的 demo"变成"能协作、能对接、能长期维护的工具"。这个转换本身，是最值得记录的。
