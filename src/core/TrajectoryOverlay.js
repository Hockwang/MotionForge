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
  refresh() {
    this.clear();

    const { km, sm } = this;
    const pkfSteps = km.pkfSteps || [];
    if (pkfSteps.length === 0) {
      if (this.logTable) console.log('[TrajectoryOverlay] PKF 步骤为空，无轨迹可绘制');
      return null;
    }

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

    // 保存状态（采样会修改 joint value + cargo parent，必须完整复原）
    const savedTime = km.currentTime;
    const savedJointValues = km.getAllJointDefs().map((d) => ({ id: d.id, v: d.currentValue }));

    const forkPts = [];
    const cargoPts = [];
    const samples = this.samples;

    try {
      for (let i = 0; i <= samples; i++) {
        const t = (i / samples) * duration;
        const pkfResults = km.evaluatePkfAt(t) || [];
        pkfResults.forEach((r) => {
          const d = km.jointDefinitions.get(r.joint_def_id);
          if (d) d.currentValue = r.value;
        });
        km.applyAllJointDrives(sm.sceneRoot);
        km.applyReparentEventsAtTime(t, sm.sceneRoot);
        sm.sceneRoot.updateMatrixWorld(true);

        if (fork) forkPts.push(fork.getWorldPosition(new THREE.Vector3()));
        if (cargo) cargoPts.push(cargo.getWorldPosition(new THREE.Vector3()));
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
      console.groupCollapsed(`🎨 轨迹 overlay 刷新（${pkfSteps.length} 段，duration=${duration.toFixed(2)}s）`);
      console.table(rows);
      console.log('蓝=fork 轨迹 / 橙=cargo 轨迹 / 🔴大球=attach / 🟢大球=detach');
      console.log('坐标 Three.js Y-up（y=高度）。UI 里的 z 对应这里的 y。');
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
