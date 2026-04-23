---
tags: [concepts, template, threeway, forklift, vna]
updated: 2026-04-23
status: implemented
---

# 三向车（VNA）参数化动画模板

## 背景

三向车（VNA forklift / trilateral forklift）在窄巷道仓储场景里很常见：车体**不做左右横移**，只沿走道（y 轴）前后运动；靠**门架横移机构**把叉齿推到货架侧面；靠**叉齿旋转机构**切换 +x / +y / -x 三个插入方向。

17 段模板（`ForkliftTemplate.js`）假设车体横移（`ROLE_CAR_SIDEWAYS_PRIMARY='车体横移'`）存在，在三向车场景下不适用——三向车没有这个 role 的关节。三向车模板 `ThreewayTemplate.js` 填这个空。

**关联 bug log**：[#59 双段门架 overflow](../bugfix-log.md#59)（三向车常配双段门架，依赖 overflow 机制才能正确升降）。

---

## 关节要求

必需 role（canApply 门槛）：
- **`车体前进`**（`ROLE_CAR_FORWARD`）—— 沿 y 轴前后
- **`门架升降`**（`ROLE_MAST_LIFT`）—— 升降；双段门架走 `findPrimaryByRole` 自动挑 primary，外段 slave 自动受益 overflow
- **`门架横移`**（`ROLE_MAST_LATERAL='门架横移'`）—— 沿 x 轴侧推（新 role）
- **`叉齿旋转`**（`ROLE_FORK_ROTATE='叉齿旋转'`）—— 绕 z 轴转（新 role）

排他条件：
- ❌ **没有** `role=车体横移` 的关节（若有 → 走 `ForkliftTemplate` 17 段）

---

## 叉齿朝向约定

以用户模型 图 1 为参考，fork 默认姿态朝 +x：

| 角度（弧度）| 朝向 | 用户"顺时针"语义 |
|---|---|---|
| 0 | +x | 默认（图 1）|
| π/2 | +y（正前方）| 旋转 90°（图 2） |
| π | -x | 旋转 180°（图 3） |
| 3π/2 | -y（不用）| — |

数学上用户的"顺时针 90°" = 右手系 +z 轴 CCW +π/2（俯视镜像约定）。

---

## 工作流程（动态参数化）

### decideAxis：根据 cargo/drop 位置自动决定从哪轴插

```
if |pos.x| > x_axis_threshold (默认 0.3m):
    from ±x (pos.x 符号决定)
else:
    from +y（正面取）
```

**关键洞察**：先让 `_AHR23`（车体前进）走到 cargo.y 对齐，diagonal cargo 会自然压进单一轴向。

cargo 在 (1.5, 1.5) 的例子：
1. 车体前进到 y=1.5 → cargo 在当前坐标系的 (+1.5, 0)
2. `|x|=1.5 > 0.3` → 从 +x 侧插
3. `_CS198` 向 +x 推到 cargo.x

### 段序（动态 13~22 段）

```
[1] 车体前进到 cargo.y（或 cargo.y - insertion_depth 如果 +y 取货）
[2] 叉齿旋转到 cargoAxis（若已到位省略）
[3] 门架升到取货高度（低 clearance）
[4] 横移/前进 approach 到 safe（仅 ±x；+y 已在段 1 止于 safe）
[5] 横移/前进 insert 到 cargo ← attach
[6] 门架微抬 lift_clearance（把 cargo 从架上顶起）
[7] 横移/前进 retract 到 safe
[8] 横移复位到 0（仅 ±x 用过）
[9] 门架升到 transport_height（运输避让）
[10] 叉齿旋转到 +y 运输姿态（若已 +y 省略）
[11] 车体前进到 drop.y（或 drop.y - insertion_depth 如果 +y 放货）
[12] 叉齿旋转到 dropAxis（若已到位省略）
[13] 门架调整到 drop 工作面
[14] 横移 approach to safe（仅 ±x）
[15] 横移/前进 insert to drop
[16] 门架下降 lift_clearance 放货 ← detach
[17] 横移/前进 retract to safe
[18] 横移复位（仅 ±x 用过）
[19] 叉齿旋转归零（若已 0° 省略）
[20] 门架下降到 0
[21] 车体退回原位（y=0）
```

旋转优化：`rotateToAngle` 内部检查当前 `forkAngle`，目标和当前差 < 1e-6 就不 emit 段。

### 9 种 (cargoAxis, dropAxis) 组合

| cargo | drop | 段数 | 特点 |
|---|---|---|---|
| +x | +x | 15-16 | 两端同侧，少一次旋转（travel 前 +y，drop 前 +x） |
| +x | -x | 17-18 | 经典场景（用户示例） |
| +x | +y | 14-15 | drop 少一次旋转（+y→+y travel→drop） |
| -x | +x | 17-18 | 镜像场景 |
| -x | -x | 15-16 | — |
| -x | +y | 14-15 | — |
| +y | +x | 14-15 | cargo 少一次（取货前已是 +x→+y 的第一段） |
| +y | -x | 14-15 | — |
| +y | +y | 11-12 | 最少（两端都正面） |

---

## 参数（`TEMPLATE_PARAMETERS`）

继承 `ForkliftTemplate` 的：
- `cargo_fork_height`（0m）
- `safe_distance`（0.8m，本模板不用，保留向后兼容）
- `lift_clearance`（0.1m）
- `transport_height`（0.2m）

三向车新增：
- **`fork_insertion_depth`（0.5m）** — fork 从 safe 到 cargo 中心的位移。用户在 PKF 参数面板里可改（比如更大的 cargo 要调大）
- **`x_axis_threshold`（0.3m）** — `decideAxis` 判定阈值。可改：更大阈值让更多场景走 +y 正面取（减少横移）；更小让所有偏 x 都走 ±x

---

## UI 集成

`🚀 一键生成` 的路由逻辑（main.js 约 L1588）：

```js
const detected = detectTemplate(km, sceneRoot);
if (detected) {
  const { template, ctx } = detected;
  const kindLabel = template.kind === 'threeway' ? '三向车（VNA）' : '叉车 17 段';
  // 弹窗：使用模板 / 走自由生成
  if (userConfirmed) {
    // 三向车先默认编译拿段序 → AI 节奏 → 重新编译
    const rhythm = await requestTemplateRhythm(intent, segmentsForAi, template.kind);
    const compiled = template.compileTemplate(ctx, rhythm, forkAnchorZero);
    applyCompiledTemplate(compiled);
  }
}
```

后端 `/api/template-rhythm` 按 `template_kind` 选 prompt 分支（`TEMPLATE_RHYTHM_SYSTEM_PROMPT` vs `TEMPLATE_RHYTHM_SYSTEM_PROMPT_THREEWAY`）。

---

## 调试

和 17 段一样支持：
- **`🎨 轨迹 toggle`**：视口画 fork（蓝）/ cargo（橙）轨迹 + console.table 段表
- **`__diagTraj.verifyOverlay()`**：直测 TrajectoryOverlay.sampleOnly vs playback
- **`__mf.lastTemplate.compiled.meta.cargo_axis` / `drop_axis`**：确认 axis 识别对了

典型现场问题：
- 如果轨迹穿墙/穿 cargo 侧面，检查 `x_axis_threshold` 是否合理（cargo 特别靠中线时把阈值调大 → 走 +y 路径）
- 如果旋转方向反了，检查 `_CS19110` 关节的 axis 字段（默认 z），可能模型零位朝向和预期不同
- 如果三向车被误识别为普通叉车，检查是否**意外**给某个关节打了 `车体横移` role → canApply 排他失败 → fallback 到 ForkliftTemplate

---

## 架构：模板库 `src/core/templates/`

```
src/core/templates/
├── index.js              # 注册表 + detectTemplate(km, root)
├── ForkliftTemplate.js   # 17 段普通叉车
└── ThreewayTemplate.js   # 18±段三向车（本文档主题）
```

加新模板模式（将来遇到别的特立独行车型时）：
1. 新建 `src/core/templates/MyTemplate.js`
2. export `kind`、`canApply(km, root)`、`compileTemplate(ctx, rhythm?, forkAnchorZero?)`、`buildDefaultRhythm(totalSeconds?, segCount?)`
3. 在 `index.js` 的 `TEMPLATES` 数组里注册（更特异的放前面）
4. 后端 `/api/template-rhythm` 若需要独立 prompt，加第三套 `TEMPLATE_RHYTHM_SYSTEM_PROMPT_MYKIND`

---

## 关联

- 17 段模板：[forklift-pickup-template.md](forklift-pickup-template.md)
- 双段门架 overflow：[bugfix-log #59](../bugfix-log.md)
- 模板库架构 commit 历史：`refactor(templates):` + `feat(threeway):` 系列
