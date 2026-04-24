/**
 * 轨迹可视化 overlay（production 版，从 tests/diag-template.js 的 drawTrajectory 毕业）
 *
 * 作用：在 3D 视口里画出 fork / cargo 走过的世界空间轨迹，辅助用户/AI 协作调试 PKF 动画。
 *
 * ─────────────────────────────────────────────────────────────────────
 * 🚨 功能出问题时的关停/删除指南
 * ─────────────────────────────────────────────────────────────────────
 *  1. **临时隐藏**（运行时关）：在 src/main.js 顶部把 TRAJECTORY_OVERLAY_ENABLED = false
 *     → 不实例化 overlay、隐藏 UI 按钮、所有 hook 成 no-op
 *  2. **彻底删除**：全仓 grep `trajectory-overlay`（tag 标记）— 所有接线点都有此注释，
 *     一次性删光：本文件 + main.js（7 处）+ EditorUI.js（2 处）+ style.css（1 块）
 * ─────────────────────────────────────────────────────────────────────
 *
 * 设计要点：
 *  - 和 __diagTpl 并存但互不干扰：group.userData 标记不同（__isTrajectoryOverlay vs __isDiagTrajectory）
 *  - 生命周期：enabled=true 时重绘；enabled=false 时清线 dispose
 *  - 自动刷新：requestRefresh() 用 queueMicrotask 合并同 tick 多次调用
 *  - 状态保全：采样过程修改了 joint value 和 cargo parent，必须 try/finally 复原
 *  - 降级：PKF 空 / reparent 空 / cargo fork 找不到 → 只画能画的，不报错中断
 */
// [trajectory-overlay] 可删除 tag：grep 这个字符串能找到所有接线点
import * as THREE from 'three';

const COLOR_FORK_LINE = 0x3b82f6;       // 蓝 fork 轨迹
const COLOR_FORK_DOT = 0x2563eb;
const COLOR_CARGO_LINE = 0xf97316;      // 橙 cargo 轨迹
const COLOR_CARGO_DOT = 0xea580c;
const COLOR_ATTACH_DOT = 0xdc2626;      // 红 attach
const COLOR_DETACH_DOT = 0x16a34a;      // 绿 detach

export class TrajectoryOverlay {
  /**
   * @param {SceneManager} sceneManager
   * @param {KeyframeManager} keyframeManager
   * @param {Object} [options]
   * @param {number} [options.samples=200] - 线条采样点数（段数 17 → 200 够平滑）
   * @param {boolean} [options.logTable=true] - 刷新时是否 console.table 动画信息
   */
  constructor(sceneManager, keyframeManager, options = {}) {
    this.sm = sceneManager;
    this.km = keyframeManager;
    this.samples = options.samples ?? 200;
    this.logTable = options.logTable ?? true;

    this.enabled = false;
    this.group = null;
    this._refreshScheduled = false;
  }

  setEnabled(flag) {
    const next = Boolean(flag);
    if (next === this.enabled) return;
    this.enabled = next;
    if (next) {
      this.refresh();
    } else {
      this.clear();
    }
  }

  /**
   * 请求刷新（合并同 tick 的多次调用，避免参数逐个改时重复重绘）
   */
  requestRefresh() {
    if (!this.enabled) return;
    if (this._refreshScheduled) return;
    this._refreshScheduled = true;
    queueMicrotask(() => {
      this._refreshScheduled = false;
      if (this.enabled) this.refresh();
    });
  }

  /**
   * 立即重绘。先清旧 group，再按当前 PKF 状态画新的。
   * 返回 { samples, rows } 用于调用方（如果需要看数据）
   */
  /**
   * 只采样不画线——供 refresh() 内部复用，也供诊断脚本直接调用做回归检测。
   *
   * 采样逻辑（和 main.js:applyPkfAtTime 行为等价）：
   *   1. 保存 joint currentValue / currentTime 快照
   *   2. 把所有 PKF 触及的 joint 一次性清零（#60 修）
   *   3. 对每个 t：evaluatePkfAt → 覆盖活跃/完成 step 的 joint → applyAllJointDrives + reparent
   *   4. 采样 fork / cargo 的世界坐标
   *   5. try/finally 复原快照（不污染正在编辑的场景）
   *
   * @param {Object} [opts]
   * @param {number[]} [opts.tValues] - 自定义采样 t 列表；不传则按 this.samples 均分 duration
   * @returns {{ forkPts: THREE.Vector3[], cargoPts: THREE.Vector3[], tValues: number[], duration: number, fork: THREE.Object3D|null, cargo: THREE.Object3D|null } | null}
   */
  sampleOnly(opts = {}) {
    const { km, sm } = this;
    const pkfSteps = km.pkfSteps || [];
    if (pkfSteps.length === 0) return null;

    // 找 cargo / fork（从 reparent 事件推断——attach 事件的 child=cargo，parent=fork）
    const reparentEvents = km.getReparentEvents ? km.getReparentEvents() : [];
    const attachEvent = reparentEvents.find((e) => e.new_parent_name);
    const cargoName = attachEvent?.child_name;
    const forkName = attachEvent?.new_parent_name;
    const cargo = cargoName ? sm.sceneRoot.getObjectByName(cargoName) : null;
    const fork = forkName ? sm.sceneRoot.getObjectByName(forkName) : null;

    // 时长：优先 clip.duration，兜底 PKF maxT
    const clip = km.getActiveGlobalClip ? km.getActiveGlobalClip() : null;
    const maxT = pkfSteps.reduce((m, s) => Math.max(m, Number(s.t_end) || 0), 0);
    const duration = Math.max(clip?.duration || 0, maxT, 1);

    // 决定采样 t 数组
    let tValues;
    if (Array.isArray(opts.tValues) && opts.tValues.length > 0) {
      tValues = opts.tValues.map((t) => Number(t) || 0);
    } else {
      const samples = this.samples;
      tValues = [];
      for (let i = 0; i <= samples; i++) tValues.push((i / samples) * duration);
    }

    // 保存状态（采样会修改 joint value + cargo parent，必须完整复原）
    const savedTime = km.currentTime;
    const savedJointValues = km.getAllJointDefs().map((d) => ({ id: d.id, v: d.currentValue }));

    // #60 修：把所有 PKF 触及的 joint 先一次性清零——否则若用户在非 t=0 时刻
    //     打开轨迹 toggle，那些"在当前 t 有 value 但在 sample 的小 t 下 step 还没开始"
    //     的关节会残留污染，导致轨迹线画在 fork 实际不会经过的位置（bug #60）。
    //     和 main.js:applyPkfAtTime 的每帧重置逻辑同构，只是这里循环外一次搞定足够：
    //     evaluatePkfAt 对完成的 step 也会返回 value_end（自动覆盖），对未开始的 step
    //     不返回 → 靠这次清零让它们保持 0，和实际播放行为一致。
    const defByName = new Map();
    km.jointDefinitions.forEach((d) => { if (d.name) defByName.set(d.name, d); });
    pkfSteps.forEach((step) => {
      let d = step.joint_def_id ? km.jointDefinitions.get(step.joint_def_id) : null;
      if (!d && step.joint) d = defByName.get(step.joint);
      if (d) d.currentValue = 0;
    });

    const forkPts = [];
    const cargoPts = [];

    // #66：改用"功能性锚点"而不是 Object3D 原点（见 bugfix #66 / REVIEW-v17 T4）：
    //   - fork：bbox 底面中心（和 computeForkAnchorZero 同口径，threejs (center.x, box.min.y, center.z)）
    //     → 轨迹线贴着叉齿 tine 承载面走，视觉上"贴"叉齿运动
    //   - cargo：bbox 底面中心 → attach/detach 大球落在地面高度，不是悬在半空
    // 策略：首帧（i=0）在当前姿态算 bbox，转到 object local 空间存下来；
    //       之后每帧 `object.localToWorld(offsetLocal.clone())` 自动跟随 fork/cargo 动画（含旋转）。
    //       无法算 bbox（对象空 / 对象不存在）→ 降级到原点采样，保持老行为不炸。
    let forkAnchorLocal = null;
    let cargoAnchorLocal = null;

    try {
      for (let i = 0; i < tValues.length; i++) {
        const t = tValues[i];
        const pkfResults = km.evaluatePkfAt(t) || [];
        pkfResults.forEach((r) => {
          const d = km.jointDefinitions.get(r.joint_def_id);
          if (d) d.currentValue = r.value;
        });
        km.applyAllJointDrives(sm.sceneRoot);
        km.applyReparentEventsAtTime(t, sm.sceneRoot);
        sm.sceneRoot.updateMatrixWorld(true);

        // 首帧：在 t=0 姿态下算 local offset，后续帧复用（fork 旋转时 localToWorld 自动跟）
        if (i === 0) {
          if (fork) {
            const box = new THREE.Box3().setFromObject(fork);
            if (!box.isEmpty()) {
              const center = box.getCenter(new THREE.Vector3());
              // 底面中心（threejs y 是高度，box.min.y = 底面）—— 和 computeForkAnchorZero 同公式
              const anchorWorld = new THREE.Vector3(center.x, box.min.y, center.z);
              forkAnchorLocal = fork.worldToLocal(anchorWorld);
            }
          }
          if (cargo) {
            const cbox = new THREE.Box3().setFromObject(cargo);
            if (!cbox.isEmpty()) {
              const cc = cbox.getCenter(new THREE.Vector3());
              const anchorWorld = new THREE.Vector3(cc.x, cbox.min.y, cc.z);
              cargoAnchorLocal = cargo.worldToLocal(anchorWorld);
            }
          }
        }

        if (fork) {
          if (forkAnchorLocal) {
            forkPts.push(fork.localToWorld(forkAnchorLocal.clone()));
          } else {
            forkPts.push(fork.getWorldPosition(new THREE.Vector3()));
          }
        }
        if (cargo) {
          if (cargoAnchorLocal) {
            cargoPts.push(cargo.localToWorld(cargoAnchorLocal.clone()));
          } else {
            cargoPts.push(cargo.getWorldPosition(new THREE.Vector3()));
          }
        }
      }
    } finally {
      // 恢复 joint value + 时间 + reparent 状态
      savedJointValues.forEach((s) => {
        const d = km.jointDefinitions.get(s.id);
        if (d) d.currentValue = s.v;
      });
      km.currentTime = savedTime;
      km.applyAllJointDrives(sm.sceneRoot);
      km.applyReparentEventsAtTime(savedTime, sm.sceneRoot);
    }

    return { forkPts, cargoPts, tValues, duration, fork, cargo };
  }

  refresh() {
    this.clear();

    const pkfSteps = this.km.pkfSteps || [];
    if (pkfSteps.length === 0) {
      if (this.logTable) console.log('[TrajectoryOverlay] PKF 步骤为空，无轨迹可绘制');
      return null;
    }

    const sampled = this.sampleOnly();
    if (!sampled) return null;
    const { forkPts, cargoPts, duration, fork, cargo } = sampled;
    const { sm, km } = this;
    const samples = this.samples;

    // reparentEvents 重新拿一次用于下面画 attach/detach 大球
    const reparentEvents = km.getReparentEvents ? km.getReparentEvents() : [];

    // 构建可视化 group
    const group = new THREE.Group();
    group.name = '__trajectoryOverlay';
    group.userData.__isTrajectoryOverlay = true;

    if (forkPts.length >= 2) {
      const geom = new THREE.BufferGeometry().setFromPoints(forkPts);
      const mat = new THREE.LineBasicMaterial({ color: COLOR_FORK_LINE });
      const line = new THREE.Line(geom, mat);
      line.name = 'fork_trajectory';
      group.add(line);
    }
    if (cargoPts.length >= 2) {
      const geom = new THREE.BufferGeometry().setFromPoints(cargoPts);
      const mat = new THREE.LineBasicMaterial({ color: COLOR_CARGO_LINE });
      const line = new THREE.Line(geom, mat);
      line.name = 'cargo_trajectory';
      group.add(line);
    }

    // 段边界小球（每步 t_end 一个）
    const smallSphereGeom = new THREE.SphereGeometry(0.04, 8, 8);
    pkfSteps.forEach((s, idx0) => {
      const tEnd = Number(s.t_end) || 0;
      const idx = Math.round((tEnd / duration) * samples);
      const segLabel = s.template_segment ?? idx0 + 1;
      if (forkPts[idx]) {
        const sphere = new THREE.Mesh(smallSphereGeom, new THREE.MeshBasicMaterial({ color: COLOR_FORK_DOT }));
        sphere.position.copy(forkPts[idx]);
        sphere.name = `seg${segLabel}_fork_end`;
        group.add(sphere);
      }
      if (cargoPts[idx]) {
        const sphere = new THREE.Mesh(smallSphereGeom, new THREE.MeshBasicMaterial({ color: COLOR_CARGO_DOT }));
        sphere.position.copy(cargoPts[idx]);
        sphere.name = `seg${segLabel}_cargo_end`;
        group.add(sphere);
      }
    });

    // attach / detach 大球
    const bigSphereGeom = new THREE.SphereGeometry(0.08, 16, 16);
    reparentEvents.forEach((ev) => {
      const idx = Math.round((Number(ev.t) / duration) * samples);
      if (!cargoPts[idx]) return;
      const color = ev.new_parent_name ? COLOR_ATTACH_DOT : COLOR_DETACH_DOT;
      const sphere = new THREE.Mesh(bigSphereGeom, new THREE.MeshBasicMaterial({ color }));
      sphere.position.copy(cargoPts[idx]);
      sphere.name = ev.new_parent_name ? 'attach_marker' : 'detach_marker';
      group.add(sphere);
    });

    sm.sceneRoot.add(group);
    this.group = group;

    // 构造动画信息表
    const fmt = (v) => (typeof v === 'number' ? v.toFixed(3) : String(v));
    const v3 = (p) => (p ? `(${fmt(p.x)}, ${fmt(p.y)}, ${fmt(p.z)})` : '-');
    const rows = pkfSteps.map((s, idx0) => {
      const tEnd = Number(s.t_end) || 0;
      const idx = Math.round((tEnd / duration) * samples);
      const fp = forkPts[idx];
      const cp = cargoPts[idx];
      return {
        seg: s.template_segment ?? idx0 + 1,
        name: s.template_segment_name ?? '-',
        joint: s.joint,
        t_end: fmt(tEnd),
        value_end: s.value_end,
        'fork(threejs)': v3(fp),
        'cargo(threejs)': v3(cp),
        'cargo-fork.dy': (fp && cp) ? fmt(cp.y - fp.y) : '-',
      };
    });

    if (this.logTable) {
      // #66 Y 范围汇总：帮助用户判断"轨迹看起来水平"是数据平还是视觉透视压缩
      // （典型三向车：pickup 0.5m / transport 0.2m / drop 1.0m，Y 变化 0.8m，但远视角看像水平）
      const yStats = (pts, label) => {
        if (!pts.length) return `${label}: 无采样`;
        let min = Infinity;
        let max = -Infinity;
        pts.forEach((p) => { if (p.y < min) min = p.y; if (p.y > max) max = p.y; });
        return `${label}: [${min.toFixed(3)}, ${max.toFixed(3)}] 变化 ${(max - min).toFixed(3)}m`;
      };
      console.groupCollapsed(`🎨 轨迹 overlay 刷新（${pkfSteps.length} 段，duration=${duration.toFixed(2)}s）`);
      console.table(rows);
      console.log('蓝=fork 轨迹 / 橙=cargo 轨迹 / 🔴大球=attach / 🟢大球=detach');
      console.log('坐标 Three.js Y-up（y=高度）。UI 里的 z 对应这里的 y。');
      console.log('━━ Y 范围（看轨迹是不是"真的平"）━━');
      console.log(`  fork.y ${yStats(forkPts, '')}`);
      console.log(`  cargo.y ${yStats(cargoPts, '')}`);
      console.log('  ↑ 数值差 > 0.2m 但视觉看着平 → 相机透视压缩，切正射视图看');
      console.groupEnd();
    }

    return { samples: samples + 1, rows, duration };
  }

  clear() {
    if (!this.group) return;
    const group = this.group;
    this.group = null;
    group.parent?.remove(group);
    group.traverse((n) => {
      n.geometry?.dispose?.();
      if (Array.isArray(n.material)) n.material.forEach((m) => m.dispose?.());
      else n.material?.dispose?.();
    });
  }

  dispose() {
    this.clear();
  }
}
