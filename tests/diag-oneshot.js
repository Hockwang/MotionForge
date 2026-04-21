/**
 * 一键动画诊断脚本（v14）
 *
 * 用法：
 *   1. npm run dev + npm run converter（后端终端会实时打印 L1/L2 的 AI 原文）
 *   2. 点 🚀 一键生成
 *   3. 在 DevTools Console 粘贴本文件
 *   4. __diagO.report()  —— 打出所有诊断信息
 *   5. 单项调用：
 *        __diagO.l1()        只看 L1（意图拆解）的原始返回
 *        __diagO.l2()        只看 L2（PKF 生成）的原始返回
 *        __diagO.plan()      看期望的几何运动（delta 分解）
 *        __diagO.actual()    按时间片段扫 PKF，看每个关节实际在哪里
 *        __diagO.markers()   看 cargo/drop/其他 marker 世界坐标
 */
(() => {
  const mf = window.__mf;
  if (!mf) {
    console.error('[diag-oneshot] window.__mf 不存在，先加载模型');
    return;
  }
  const THREE = mf.THREE;

  function markerSnapshot() {
    const markers = [];
    mf.sceneManager.sceneRoot.traverse((o) => {
      if (!o.name) return;
      if (o.userData?.__isMarker || /cargo|drop|pickup/i.test(o.name)) {
        const wp = o.getWorldPosition(new THREE.Vector3());
        markers.push({
          name: o.name,
          type: o.userData?.markerType || '?',
          size: o.userData?.markerSize || null,
          // threejs (y-up) → UI/AI (z-up) swap：和发给 AI 的坐标一致
          world: { x: +wp.x.toFixed(3), y: +wp.z.toFixed(3), z: +wp.y.toFixed(3) },
        });
      }
    });
    return markers;
  }

  function jointSummary() {
    return mf.getJointDefs().map((d) => ({
      name: d.name,
      type: d.type,
      axis: d.axis,
      role: d.role || '',
      value: d.currentValue,
      limits: d.limits,
    }));
  }

  function l1() {
    const s = window.__mf?.lastOneshot;
    if (!s) {
      console.warn('没有 lastOneshot，先点一键生成');
      return null;
    }
    console.group('🪄 L1 拆解（用户意图 → 时间表 + reparent_events）');
    console.log('用户意图:', s.intent);
    console.log('送给 AI 的 scene:', s.scene);
    console.log('送给 AI 的 joints:', s.joints);
    console.log('AI 返回 rows:');
    console.table(s.l1?.rows || []);
    console.log('AI 返回 reparent_events:');
    console.table(s.l1?.reparent_events || []);
    console.log('AI 警告:', s.l1?.warnings || []);
    console.groupEnd();
    return s.l1;
  }

  function l2() {
    const s = window.__mf?.lastOneshot;
    if (!s) {
      console.warn('没有 lastOneshot，先点一键生成');
      return null;
    }
    console.group('🪄 L2 PKF 生成（时间表 → PKF 公式）');
    console.log('送给 L2 的 prompt:\n' + (s.l2Prompt || '(未保存)'));
    console.log('PKF parameters:');
    console.table(s.l2?.parameters || []);
    console.log('PKF steps:');
    console.table((s.l2?.steps || []).map((st) => ({
      joint: st.joint,
      channel: st.channel,
      axis: st.axis,
      t_start: st.t_start,
      t_end: st.t_end,
      value_start: st.value_start,
      value_end: st.value_end,
      easing: st.easing,
    })));
    console.groupEnd();
    return s.l2;
  }

  function plan() {
    const m = markerSnapshot();
    const j = jointSummary();
    const cargo = m.find((x) => /cargo/i.test(x.name) || x.type === 'cargo');
    const drop = m.find((x) => /drop/i.test(x.name) || x.type === 'drop');
    const car = j.find((x) => x.role === '车体前进' || /前进/.test(x.role));
    const lat = j.find((x) => x.role === '车体横移' || /横移/.test(x.role));
    const lift = j.find((x) => x.role === '门架升降' || /升降/.test(x.role));

    console.group('📐 几何期望 vs 关节能力');
    console.log('cargo:', cargo, ' drop:', drop);
    console.log('车体前进关节:', car);
    console.log('车体横移关节:', lat);
    console.log('门架升降关节:', lift);
    if (cargo && car) {
      console.log(`期望 pickup 阶段 ${car.axis} delta = ${cargo.world[car.axis].toFixed(2)}`);
      console.log(`  但"前插取货"应 stop BEFORE cargo，实际 value_end 若等于 cargo.${car.axis} → 车体会直接走到货物上面（bug）`);
    }
    if (drop && car) {
      console.log(`期望 drop 阶段 ${car.axis} delta = ${drop.world[car.axis].toFixed(2)} (从 cargo 到 drop)`);
    }
    console.groupEnd();
    return { cargo, drop, car, lat, lift };
  }

  function actual() {
    const km = mf.keyframeManager;
    const steps = km.pkfSteps || [];
    if (!steps.length) {
      console.warn('没有 PKF 步骤');
      return;
    }

    const params = {};
    (km.pkfParameters || new Map()).forEach?.((p) => { params[p.id] = p.default; });
    if (km.pkfParameters instanceof Map) {
      km.pkfParameters.forEach((p, id) => { params[id] = p.default; });
    }
    // cargo_width/height/depth 注入
    const sz = km.getCargoSizeParams?.() || {};
    Object.assign(params, sz);
    // fork_anchor_zero_x/y/z 注入（v14.1 #37）—— 读缓存
    const fa = km.getForkAnchorZero?.() || {};
    Object.assign(params, fa);

    console.group('📊 PKF 实际运动（按关节分组，求值到数值）');
    const byJoint = {};
    steps.forEach((s) => {
      byJoint[s.joint] = byJoint[s.joint] || [];
      byJoint[s.joint].push(s);
    });
    Object.entries(byJoint).forEach(([jName, arr]) => {
      const rows = arr.map((s) => {
        let vs, ve;
        try { vs = Function('p', `with(p){return (${s.value_start});}`)(params); } catch (e) { vs = 'ERR:' + e.message; }
        try { ve = Function('p', `with(p){return (${s.value_end});}`)(params); } catch (e) { ve = 'ERR:' + e.message; }
        return {
          t: `${s.t_start}-${s.t_end}s`,
          axis: s.axis,
          start: vs,
          end: ve,
          delta: typeof vs === 'number' && typeof ve === 'number' ? +(ve - vs).toFixed(3) : '?',
          formula_end: s.value_end,
        };
      });
      console.log(`关节 ${jName}:`);
      console.table(rows);
    });
    console.groupEnd();
    return byJoint;
  }

  function markers() {
    const m = markerSnapshot();
    console.group('📍 Marker 世界坐标');
    console.table(m);
    console.groupEnd();
    return m;
  }

  function report() {
    console.log('═══════════ 一键生成动画诊断报告 ═══════════');
    markers();
    plan();
    l1();
    l2();
    actual();
    console.log('═══════════════════════════════════════════');
    console.log('✅ 完整 last response 原文在 window.__mf.lastOneshot');
    console.log('✅ 后端终端（跑 npm run converter 那个）也打印了 AI 原文');
  }

  window.__diagO = { report, l1, l2, plan, actual, markers };
  console.log('✅ 一键诊断已加载：__diagO.report() / l1() / l2() / plan() / actual() / markers()');
})();
