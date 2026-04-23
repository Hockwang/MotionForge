/**
 * 诊断：轨迹 overlay 采样 vs 实际播放的 fork 世界坐标对比（bug #60 回归检测）
 *
 * 背景：TrajectoryOverlay.refresh 采样循环不像 applyPkfAtTime 那样每帧清零
 *       "PKF 触及的 joint"。用户在非 t=0 时刻打开轨迹 toggle 时，未开始的 step
 *       对应的关节会残留当前 joint value → 前段采样位置错 → 画出"fork 实际不会经过的
 *       轨迹线"（经典现象：段 1-2 出现一段直角 L，实际播放不经过那里）。
 *
 * 本脚本做什么：
 *   1. 以 applyPkfAtTime 的逻辑（每帧清零）dense 采样 fork 世界坐标 → "播放真值"
 *   2. 以 TrajectoryOverlay 的当前采样逻辑 dense 采样 fork 世界坐标 → "overlay 画值"
 *   3. 逐 t 对比两者，距离 > 阈值的 t 列表打印出来
 *   4. 任何一个关节上输入残留非零值重跑，确认是否修复（"残留污染测试"）
 *
 * 用法（浏览器 Console）：
 *   1. 加载模型、🚀 一键生成、确保 pkfSteps 非空
 *   2. 粘贴本文件全文到 Chrome Console
 *   3. __diagTraj.all()         → 一把梭：正常对比 + 残留污染测试
 *      __diagTraj.compare()     → 当前状态下 overlay vs playback 对比
 *      __diagTraj.stressResidue() → 人为给关节灌残留，测 overlay 是否被污染
 *      __diagTraj.help()
 */
(() => {
  const mf = window.__mf;
  if (!mf) {
    console.error('[diag-traj] window.__mf 未就绪，先加载模型 + 🚀 一键生成');
    return;
  }
  const THREE = mf.THREE;
  const km = mf.keyframeManager;
  const sm = mf.sceneManager;

  // ── 工具：取 fork 对象（从 attach reparent 事件推断，和 TrajectoryOverlay 同源）
  function locateForkAndCargo() {
    const events = km.getReparentEvents ? km.getReparentEvents() : [];
    const attach = events.find((e) => e.new_parent_name);
    if (!attach) return { fork: null, cargo: null };
    return {
      fork: sm.sceneRoot.getObjectByName(attach.new_parent_name) || null,
      cargo: sm.sceneRoot.getObjectByName(attach.child_name) || null,
    };
  }

  // ── 采样路径 A：模拟 applyPkfAtTime（每帧清零，和实际播放等价）
  function samplePlayback(tValues) {
    const defByName = new Map();
    km.jointDefinitions.forEach((d) => { if (d.name) defByName.set(d.name, d); });
    const out = [];
    tValues.forEach((t) => {
      // reset PKF-target joints to 0
      (km.pkfSteps || []).forEach((step) => {
        let d = step.joint_def_id ? km.jointDefinitions.get(step.joint_def_id) : null;
        if (!d && step.joint) d = defByName.get(step.joint);
        if (d) d.currentValue = 0;
      });
      // apply active/completed results
      const results = km.evaluatePkfAt(t) || [];
      results.forEach((r) => {
        const d = km.jointDefinitions.get(r.joint_def_id)
          || (r.joint ? defByName.get(r.joint) : null);
        if (d) d.currentValue = r.value;
      });
      km.applyAllJointDrives(sm.sceneRoot);
      km.applyReparentEventsAtTime(t, sm.sceneRoot);
      sm.sceneRoot.updateMatrixWorld(true);
      const { fork } = locateForkAndCargo();
      out.push(fork ? fork.getWorldPosition(new THREE.Vector3()) : null);
    });
    return out;
  }

  // ── 采样路径 B：模拟 TrajectoryOverlay.refresh（不清零，只覆盖活跃 step）
  //   注意：参数 residueLoader 可选，用来在首个采样前人为注入残留值（压力测试用）
  function sampleOverlayLike(tValues, residueLoader) {
    if (residueLoader) residueLoader();
    const out = [];
    tValues.forEach((t) => {
      const results = km.evaluatePkfAt(t) || [];
      results.forEach((r) => {
        const d = km.jointDefinitions.get(r.joint_def_id);
        if (d) d.currentValue = r.value;
      });
      km.applyAllJointDrives(sm.sceneRoot);
      km.applyReparentEventsAtTime(t, sm.sceneRoot);
      sm.sceneRoot.updateMatrixWorld(true);
      const { fork } = locateForkAndCargo();
      out.push(fork ? fork.getWorldPosition(new THREE.Vector3()) : null);
    });
    return out;
  }

  // ── 保存/恢复状态（避免诊断污染正在编辑的场景）
  function snapshotState() {
    return {
      time: km.currentTime,
      jointValues: [...km.jointDefinitions.values()].map((d) => ({ id: d.id, v: d.currentValue })),
    };
  }
  function restoreState(snap) {
    snap.jointValues.forEach((s) => {
      const d = km.jointDefinitions.get(s.id);
      if (d) d.currentValue = s.v;
    });
    km.currentTime = snap.time;
    km.applyAllJointDrives(sm.sceneRoot);
    km.applyReparentEventsAtTime(snap.time, sm.sceneRoot);
  }

  // ── 核心对比：两路采样，逐 t 求距离，超阈值打印
  function compareInternal({ samples = 200, threshold = 0.01, residueLoader, label } = {}) {
    const steps = km.pkfSteps || [];
    if (steps.length === 0) {
      console.warn('[diag-traj] PKF 步骤为空，无轨迹可对比');
      return null;
    }
    const clip = km.getActiveGlobalClip ? km.getActiveGlobalClip() : null;
    const maxT = steps.reduce((m, s) => Math.max(m, Number(s.t_end) || 0), 0);
    const duration = Math.max(clip?.duration || 0, maxT, 1);
    const tValues = [];
    for (let i = 0; i <= samples; i++) tValues.push((i / samples) * duration);

    const snap = snapshotState();
    let playback, overlay;
    try {
      playback = samplePlayback(tValues);
      overlay = sampleOverlayLike(tValues, residueLoader);
    } finally {
      restoreState(snap);
    }

    // 对比
    const diffs = [];
    for (let i = 0; i < tValues.length; i++) {
      const p = playback[i];
      const o = overlay[i];
      if (!p || !o) continue;
      const d = p.distanceTo(o);
      if (d > threshold) {
        diffs.push({
          t: Number(tValues[i].toFixed(3)),
          dist_m: Number(d.toFixed(4)),
          playback: `(${p.x.toFixed(3)}, ${p.y.toFixed(3)}, ${p.z.toFixed(3)})`,
          overlay: `(${o.x.toFixed(3)}, ${o.y.toFixed(3)}, ${o.z.toFixed(3)})`,
        });
      }
    }

    console.groupCollapsed(`🔍 [diag-traj] ${label || 'compare'}：${tValues.length} 点 / 阈值 ${threshold}m / 超阈值 ${diffs.length} 点`);
    if (diffs.length === 0) {
      console.log('✅ 全部采样点 overlay 与 playback 距离 ≤ 阈值，判定一致');
    } else {
      console.log(`❌ 有 ${diffs.length} 个采样点超阈值 — 前 10 个：`);
      console.table(diffs.slice(0, 10));
      console.log('（提示：diff 大的 t 通常集中在"首段之前"——对应 bug #60 残留污染现象）');
    }
    console.groupEnd();
    return { tValues, playback, overlay, diffs };
  }

  // ── 压力测试：人为给几个关节注入残留值，模拟"用户在 t=10 打开轨迹 toggle"
  //   若 TrajectoryOverlay 已加清零补丁 → 残留应被磨平；若未修 → overlay 偏移
  function stressResidue({ samples = 200, threshold = 0.01 } = {}) {
    const defs = [...km.jointDefinitions.values()];
    if (defs.length === 0) {
      console.warn('[diag-traj] 无关节定义');
      return null;
    }

    // 找几个可动关节灌残留值（模拟用户正在播放时的中段状态）
    const drivables = defs.filter((d) => d.type === 'prismatic' || d.type === 'revolute');
    if (drivables.length === 0) {
      console.warn('[diag-traj] 无可动关节，跳过残留测试');
      return null;
    }
    const residueSnapshot = drivables.map((d) => ({ id: d.id, name: d.name, inject: 2.5 }));

    console.log(`[diag-traj] 残留压力测试：给 ${drivables.length} 个可动关节各灌 2.5 的 currentValue`);
    return compareInternal({
      samples,
      threshold,
      label: 'residue stress',
      residueLoader: () => {
        residueSnapshot.forEach((r) => {
          const d = km.jointDefinitions.get(r.id);
          if (d) d.currentValue = r.inject;
        });
      },
    });
  }

  window.__diagTraj = {
    compare: (opts = {}) => compareInternal({ label: 'normal', ...opts }),
    stressResidue,
    all() {
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('[diag-traj] 先做常规对比（当前 joint 状态）');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      const a = compareInternal({ label: 'normal' });
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('[diag-traj] 再做残留压力测试');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      const b = stressResidue();
      const pass = (a?.diffs?.length === 0) && (b?.diffs?.length === 0);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log(pass ? '✅ 整体通过：overlay 采样和 playback 完全一致' : '❌ 检测到偏差：bug #60 仍存在或有其他问题');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      return { normal: a, stress: b, pass };
    },
    help() {
      console.log(`
[diag-traj] 轨迹 overlay 采样 vs 播放对比（bug #60）

  __diagTraj.compare({ samples=200, threshold=0.01 })
      常规对比：当前 joint 状态下两路采样比距离
  __diagTraj.stressResidue({ samples=200, threshold=0.01 })
      压力测试：人为给关节注入 2.5 的残留，测 overlay 是否被污染
  __diagTraj.all()
      一把梭跑 compare + stressResidue

  阈值默认 1cm（threshold=0.01 米），超过则打印前 10 个偏差点
      `);
    },
  };
  console.log('[diag-traj] 就绪。运行 __diagTraj.all() 开始检测。');
})();
