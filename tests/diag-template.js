/**
 * 叉车 14 段模板诊断脚本（mvp3）
 *
 * 用法：
 *   1. npm run dev + npm run converter
 *   2. 场景里布好 cargo + drop + 车体前进/门架升降 role 关节 + attach reparent event
 *   3. 点 🚀 一键生成 → 选"确定（模板）"
 *   4. 粘贴本文件到 Chrome Console
 *   5. __diagTpl.all()                    → 一把梭跑 6 个检测
 *      __diagTpl.compiled()               → 只看 compileTemplate 的产物
 *      __diagTpl.formulas()               → 逐段 eval value_end 公式，对比关节 limits
 *      __diagTpl.reparentTiming()         → attach/detach 时间是否在段 3/11 末尾
 *      __diagTpl.cascadeCheck()           → value_start 是否严格等于同 role 上一段 value_end
 *      __diagTpl.loopBoundary()           → 循环回 t=0 时 cargo 是否回到原位
 *      __diagTpl.playbackSample(times)    → 按时间采样 cargo / fork 的世界位置曲线
 */
(() => {
  const mf = window.__mf;
  if (!mf) {
    console.error('[diag-template] window.__mf 未就绪，先加载模型 + 点 🚀');
    return;
  }
  const THREE = mf.THREE;
  const km = mf.keyframeManager;
  const sm = mf.sceneManager;

  const fmt = (v) => (typeof v === 'number' ? v.toFixed(3) : v);
  const v3 = (v) => `(${fmt(v.x)}, ${fmt(v.y)}, ${fmt(v.z)})`;

  // ── 工具：公式求值（复用 PKF 内部逻辑的简化版）──
  function evalFormula(expr, paramValues) {
    if (typeof expr !== 'string') return { value: Number(expr) || 0, error: null };
    const trimmed = expr.trim();
    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return { value: Number(trimmed), error: null };
    try {
      const names = Object.keys(paramValues);
      const values = names.map((n) => paramValues[n]);
      // eslint-disable-next-line no-new-func
      const fn = new Function(...names, `return (${trimmed});`);
      return { value: Number(fn(...values)), error: null };
    } catch (err) {
      return { value: NaN, error: err.message };
    }
  }

  const diag = {

    // ═══ 0. 基础健康检查 ═══════════════════════════════════════════
    health() {
      console.group('🏥 0. 模板路径基础健康');
      const meta = km._pkfTemplateMeta;
      const last = mf.lastTemplate;
      console.log('_pkfTemplateMeta:', meta);
      console.log('window.__mf.lastTemplate 存在:', !!last);
      if (!meta) console.warn('⛔ _pkfTemplateMeta 为空 → 当前 PKF 不是模板路径生成');
      if (!last) console.warn('⛔ lastTemplate 缺失 → 本次 session 未触发过模板');
      if (meta?.template_version !== 1) console.warn('⚠️ template_version 不是 1:', meta?.template_version);
      console.log('当前 PKF steps 数:', km.pkfSteps.length);
      console.log('当前 reparent events:', km.getReparentEvents());
      console.groupEnd();
      return { meta, last, steps: km.pkfSteps.length };
    },

    // ═══ 1. 编译产物（参数 / 步骤 / 事件）════════════════════════════
    compiled() {
      console.group('📦 1. 编译产物');
      const last = mf.lastTemplate;
      if (!last?.compiled) {
        console.error('⛔ 无 lastTemplate.compiled');
        console.groupEnd();
        return;
      }
      const c = last.compiled;
      console.log('rhythm:', last.rhythm?.name, '（', last.rhythm?.segments?.length, '段）');
      console.log('meta:', c.meta);
      console.log('参数共', c.parameters.length, '条:');
      console.table(c.parameters.map((p) => ({
        id: p.id,
        default: typeof p.default === 'number' ? fmt(p.default) : p.default,
        unit: p.unit || '',
      })));
      console.log('步骤共', c.steps.length, '条:');
      console.table(c.steps.map((s) => ({
        seg: s.template_segment,
        name: s.template_segment_name,
        joint: s.joint,
        t_start: fmt(s.t_start),
        t_end: fmt(s.t_end),
        value_start: s.value_start,
        value_end: s.value_end,
        easing: s.easing,
      })));
      console.log('reparent events:', c.reparent_events);
      console.groupEnd();
      return c;
    },

    // ═══ 2. attach/detach 时间是否在段 3/11 末尾 ═══════════════════
    reparentTiming() {
      console.group('⏰ 2. reparent 时间对齐检查');
      const last = mf.lastTemplate;
      if (!last?.compiled) { console.error('⛔ 无编译结果'); console.groupEnd(); return; }
      const c = last.compiled;
      const seg3 = c.steps.find((s) => s.template_segment === 3);
      const seg11 = c.steps.find((s) => s.template_segment === 11);
      const attach = c.reparent_events.find((e) => e.new_parent_name);
      const detach = c.reparent_events.find((e) => e.new_parent_name === null);
      const results = [
        { 项: 'attach.t', 期望: fmt(seg3?.t_end), 实际: fmt(attach?.t), OK: Math.abs((seg3?.t_end ?? 0) - (attach?.t ?? 0)) < 0.01 },
        { 项: 'detach.t', 期望: fmt(seg11?.t_end), 实际: fmt(detach?.t), OK: Math.abs((seg11?.t_end ?? 0) - (detach?.t ?? 0)) < 0.01 },
        { 项: 'attach.child_name', 期望: '(cargo)', 实际: attach?.child_name || '(缺)', OK: !!attach?.child_name },
        { 项: 'attach.new_parent_name', 期望: '(fork 对象)', 实际: attach?.new_parent_name || '(缺)', OK: !!attach?.new_parent_name },
        { 项: 'detach.new_parent_name', 期望: 'null（回世界根）', 实际: String(detach?.new_parent_name), OK: detach?.new_parent_name === null },
      ];
      console.table(results);
      const allOk = results.every((r) => r.OK);
      console.log(allOk ? '✅ reparent 时间全部对齐' : '❌ 有对齐错误，检查 compileTemplate');
      console.groupEnd();
      return allOk;
    },

    // ═══ 3. value_start 是否严格级联（同 role 上一段的 value_end）═══
    cascadeCheck() {
      console.group('🔗 3. value_start 级联检查');
      const last = mf.lastTemplate;
      if (!last?.compiled) { console.error('⛔ 无编译结果'); console.groupEnd(); return; }
      const steps = last.compiled.steps;
      const prevByRole = new Map();
      const problems = [];
      steps.forEach((s) => {
        const role = s.joint; // 按 joint name 分组
        const expected = prevByRole.get(role) ?? '0';
        const actual = s.value_start;
        if (String(expected) !== String(actual)) {
          problems.push({
            seg: s.template_segment,
            joint: s.joint,
            期望: String(expected),
            实际: String(actual),
          });
        }
        prevByRole.set(role, s.value_end);
      });
      if (problems.length === 0) {
        console.log('✅ 所有段 value_start 严格等于上一段同 joint 的 value_end');
      } else {
        console.error(`❌ ${problems.length} 处级联错乱:`);
        console.table(problems);
      }
      console.groupEnd();
      return problems.length === 0;
    },

    // ═══ 4. 逐段 eval value_end 公式 + 检查关节 limits ═══════════════
    formulas() {
      console.group('🧮 4. 逐段公式求值 + 关节限位检查');
      const last = mf.lastTemplate;
      if (!last?.compiled) { console.error('⛔ 无编译结果'); console.groupEnd(); return; }
      const paramValues = {};
      last.compiled.parameters.forEach((p) => { paramValues[p.id] = p.default; });
      // 叠加运行时自动注入（cargo size + fork_anchor_zero）
      Object.assign(paramValues, km.getCargoSizeParams ? km.getCargoSizeParams() : {});
      Object.assign(paramValues, km.getForkAnchorZero ? km.getForkAnchorZero() : {});

      const defs = km.getAllJointDefs();
      const rows = [];
      let limitViolations = 0;
      last.compiled.steps.forEach((s) => {
        const { value, error } = evalFormula(s.value_end, paramValues);
        const def = defs.find((d) => d.name === s.joint);
        const limits = def?.limits || { min: -Infinity, max: Infinity };
        const clamped = value < limits.min || value > limits.max;
        if (clamped) limitViolations++;
        rows.push({
          seg: s.template_segment,
          joint: s.joint,
          公式: s.value_end,
          求值: error ? `❌ ${error}` : fmt(value),
          min: fmt(limits.min),
          max: fmt(limits.max),
          超限: clamped ? '⚠️' : '',
        });
      });
      console.table(rows);
      if (limitViolations > 0) {
        console.warn(`⚠️ ${limitViolations} 段目标超出关节限位，运行时会被钳位 → 动作不到位`);
      } else {
        console.log('✅ 所有段目标在关节限位范围内');
      }
      console.log('当前使用的参数值:', paramValues);
      console.groupEnd();
      return { rows, limitViolations };
    },

    // ═══ 5. 循环边界：seek 到 t=0 时 cargo 应在原位 ══════════════════
    loopBoundary() {
      console.group('🔁 5. 循环边界：seek t=0 后 cargo 位置');
      const last = mf.lastTemplate;
      if (!last?.compiled) { console.error('⛔ 无编译结果'); console.groupEnd(); return; }
      const cargoName = last.compiled.reparent_events.find((e) => e.new_parent_name)?.child_name;
      if (!cargoName) { console.error('⛔ 无 attach 事件，找不到 cargo'); console.groupEnd(); return; }

      const cargo = sm.sceneRoot.getObjectByName(cargoName);
      if (!cargo) { console.error(`⛔ 场景找不到 ${cargoName}`); console.groupEnd(); return; }

      // 保存当前状态
      const savedTime = km.currentTime;
      const origSnap = km.originalWorldTransforms?.get(cargoName);

      sm.sceneRoot.updateMatrixWorld(true);
      const beforePos = cargo.getWorldPosition(new THREE.Vector3());
      const beforeParent = cargo.parent?.name || '(root)';

      // seek 到 t=0
      km.applyReparentEventsAtTime(0, sm.sceneRoot);
      sm.sceneRoot.updateMatrixWorld(true);
      const atZeroPos = cargo.getWorldPosition(new THREE.Vector3());
      const atZeroParent = cargo.parent?.name || '(root)';

      // 和 originalWorldTransforms 对比
      const drift = origSnap ? atZeroPos.clone().sub(origSnap.pos).length() : null;

      console.log('当前时间:', savedTime.toFixed(3));
      console.log('操作前 cargo:', v3(beforePos), 'parent=', beforeParent);
      console.log('seek t=0 后 cargo:', v3(atZeroPos), 'parent=', atZeroParent);
      if (origSnap) {
        console.log('快照中的原始世界位置:', v3(origSnap.pos));
        console.log('偏移:', fmt(drift), 'm', drift > 0.01 ? '❌ 未回原位！' : '✅');
      } else {
        console.warn('⚠️ originalWorldTransforms 无快照 —— 模型可能未加载完或 snapshot 未调');
      }

      // 恢复
      km.applyReparentEventsAtTime(savedTime, sm.sceneRoot);

      console.groupEnd();
      return { drift };
    },

    // ═══ 6. 播放采样：每段末尾 cargo 和 fork 的世界位置 ═════════════
    playbackSample(times) {
      console.group('🎬 6. 播放时间采样');
      const last = mf.lastTemplate;
      if (!last?.compiled) { console.error('⛔ 无编译结果'); console.groupEnd(); return; }
      const cargoName = last.compiled.reparent_events.find((e) => e.new_parent_name)?.child_name;
      const forkName = last.compiled.reparent_events.find((e) => e.new_parent_name)?.new_parent_name;
      const cargo = cargoName ? sm.sceneRoot.getObjectByName(cargoName) : null;
      const fork = forkName ? sm.sceneRoot.getObjectByName(forkName) : null;

      // 默认采样：每段 t_end（共 14 个）
      const sampleTimes = Array.isArray(times) && times.length
        ? times
        : last.compiled.steps.map((s) => s.t_end);

      const savedTime = km.currentTime;
      const rows = [];
      sampleTimes.forEach((t) => {
        // 复用 main.js 的 applyPkfAtTime 逻辑：先算 PKF 再应用 reparent
        if (typeof window.applyPkfAtTime === 'function') window.applyPkfAtTime(t);
        km.currentTime = t;
        // 驱动关节到 t 的状态（只在 PKF 播放模式 / 或自己 evaluate）
        const pkfResults = km.evaluatePkfAt(t) || [];
        pkfResults.forEach((r) => {
          const d = km.jointDefinitions.get(r.joint_def_id);
          if (d) d.currentValue = r.value;
        });
        km.applyAllJointDrives(sm.sceneRoot);
        km.applyReparentEventsAtTime(t, sm.sceneRoot);
        sm.sceneRoot.updateMatrixWorld(true);

        const cargoWp = cargo ? cargo.getWorldPosition(new THREE.Vector3()) : null;
        const forkWp = fork ? fork.getWorldPosition(new THREE.Vector3()) : null;
        const cargoParent = cargo?.parent?.name || '(root)';

        // 距离（fork 承载面近似用 fork.worldPos；严格讲还要加 fork_anchor_zero 偏移）
        const dz = cargoWp && forkWp ? cargoWp.y - forkWp.y : null; // threejs Y-up

        rows.push({
          t: fmt(t),
          cargo: cargoWp ? v3(cargoWp) : '-',
          fork: forkWp ? v3(forkWp) : '-',
          parent: cargoParent,
          'dy(世界)': dz !== null ? fmt(dz) : '-',
        });
      });
      console.table(rows);

      // 恢复到原时间
      km.currentTime = savedTime;
      if (typeof window.applyPkfAtTime === 'function') window.applyPkfAtTime(savedTime);
      km.applyAllJointDrives(sm.sceneRoot);
      km.applyReparentEventsAtTime(savedTime, sm.sceneRoot);

      console.log('关注点：');
      console.log(' - attach 瞬间（段 3 t_end）前后 cargo 世界坐标应**连续**，parent 从 (root) 切到 fork');
      console.log(' - detach 瞬间（段 11 t_end）前后 cargo 世界坐标应**连续**，parent 从 fork 切回 (root)');
      console.log(' - 若 attach/detach 处 cargo 坐标跳变 > 0.05m → 零瞬移承诺破坏，需查原因');
      console.groupEnd();
      return rows;
    },

    // ═══ 7. 可视化轨迹：在 3D 视口里画出 fork / cargo 走过的路径 ═════
    drawTrajectory({ samples = 200, showSegmentMarkers = true } = {}) {
      console.group('🎨 7. 轨迹可视化');
      const last = mf.lastTemplate;
      if (!last?.compiled) { console.error('⛔ 无编译结果'); console.groupEnd(); return; }

      // 先清掉之前画的
      this.clearTrajectory();

      const cargoName = last.compiled.reparent_events.find((e) => e.new_parent_name)?.child_name;
      const forkName = last.compiled.reparent_events.find((e) => e.new_parent_name)?.new_parent_name;
      const cargo = cargoName ? sm.sceneRoot.getObjectByName(cargoName) : null;
      const fork = forkName ? sm.sceneRoot.getObjectByName(forkName) : null;
      if (!cargo || !fork) {
        console.error('⛔ 找不到 cargo 或 fork 对象');
        console.groupEnd();
        return;
      }

      const duration = last.compiled.meta.total_duration || 12;
      const savedTime = km.currentTime;
      const savedJointValues = km.getAllJointDefs().map((d) => ({ id: d.id, v: d.currentValue }));

      const forkPts = [];
      const cargoPts = [];
      const attachIdx = []; // 记录 cargo parent 切换的采样索引
      let lastCargoParent = null;

      for (let i = 0; i <= samples; i++) {
        const t = (i / samples) * duration;
        // 算 PKF 关节值并驱动
        const pkfResults = km.evaluatePkfAt(t) || [];
        pkfResults.forEach((r) => {
          const d = km.jointDefinitions.get(r.joint_def_id);
          if (d) d.currentValue = r.value;
        });
        km.applyAllJointDrives(sm.sceneRoot);
        km.applyReparentEventsAtTime(t, sm.sceneRoot);
        sm.sceneRoot.updateMatrixWorld(true);

        forkPts.push(fork.getWorldPosition(new THREE.Vector3()));
        cargoPts.push(cargo.getWorldPosition(new THREE.Vector3()));
        const pname = cargo.parent?.name || '(root)';
        if (lastCargoParent !== null && pname !== lastCargoParent) attachIdx.push(i);
        lastCargoParent = pname;
      }

      // 构建可视化 group
      const group = new THREE.Group();
      group.name = '__diagTpl_trajectory';
      group.userData.__isDiagTrajectory = true;

      // fork 轨迹：蓝色
      const forkGeom = new THREE.BufferGeometry().setFromPoints(forkPts);
      const forkMat = new THREE.LineBasicMaterial({ color: 0x3b82f6 });
      const forkLine = new THREE.Line(forkGeom, forkMat);
      forkLine.name = 'fork_trajectory';
      group.add(forkLine);

      // cargo 轨迹：橙色
      const cargoGeom = new THREE.BufferGeometry().setFromPoints(cargoPts);
      const cargoMat = new THREE.LineBasicMaterial({ color: 0xf97316 });
      const cargoLine = new THREE.Line(cargoGeom, cargoMat);
      cargoLine.name = 'cargo_trajectory';
      group.add(cargoLine);

      // 段边界球（每段 t_end 一个）
      if (showSegmentMarkers) {
        const sphereGeom = new THREE.SphereGeometry(0.04, 8, 8);
        last.compiled.steps.forEach((s) => {
          const t = s.t_end;
          const idx = Math.round((t / duration) * samples);
          // fork 位置
          if (forkPts[idx]) {
            const sphere = new THREE.Mesh(sphereGeom, new THREE.MeshBasicMaterial({ color: 0x2563eb }));
            sphere.position.copy(forkPts[idx]);
            sphere.name = `seg${s.template_segment}_fork_end`;
            group.add(sphere);
          }
          // cargo 位置
          if (cargoPts[idx]) {
            const sphere = new THREE.Mesh(sphereGeom, new THREE.MeshBasicMaterial({ color: 0xea580c }));
            sphere.position.copy(cargoPts[idx]);
            sphere.name = `seg${s.template_segment}_cargo_end`;
            group.add(sphere);
          }
        });
      }

      // attach/detach 点加大球（更显眼）
      const bigGeom = new THREE.SphereGeometry(0.08, 16, 16);
      const events = last.compiled.reparent_events;
      events.forEach((ev) => {
        const idx = Math.round((ev.t / duration) * samples);
        if (!cargoPts[idx]) return;
        const color = ev.new_parent_name ? 0xdc2626 : 0x16a34a; // 红=attach 绿=detach
        const sphere = new THREE.Mesh(bigGeom, new THREE.MeshBasicMaterial({ color }));
        sphere.position.copy(cargoPts[idx]);
        sphere.name = ev.new_parent_name ? 'attach_marker' : 'detach_marker';
        group.add(sphere);
      });

      sm.sceneRoot.add(group);

      // ── 文字版轨迹表：每段 t_end 的坐标，方便把结果贴给外部排查 ──
      const textRows = last.compiled.steps.map((s) => {
        const idx = Math.round((s.t_end / duration) * samples);
        const fp = forkPts[idx];
        const cp = cargoPts[idx];
        return {
          seg: s.template_segment,
          name: s.template_segment_name,
          joint: s.joint,
          t_end: fmt(s.t_end),
          value_end: s.value_end,
          'fork(threejs)': fp ? `(${fmt(fp.x)}, ${fmt(fp.y)}, ${fmt(fp.z)})` : '-',
          'cargo(threejs)': cp ? `(${fmt(cp.x)}, ${fmt(cp.y)}, ${fmt(cp.z)})` : '-',
          'cargo-fork.dy': (fp && cp) ? fmt(cp.y - fp.y) : '-',
        };
      });
      console.table(textRows);

      // 恢复状态
      savedJointValues.forEach((s) => {
        const d = km.jointDefinitions.get(s.id);
        if (d) d.currentValue = s.v;
      });
      km.currentTime = savedTime;
      km.applyAllJointDrives(sm.sceneRoot);
      km.applyReparentEventsAtTime(savedTime, sm.sceneRoot);

      console.log(`✅ 已绘制 ${samples + 1} 采样点 + 14 段文字表`);
      console.log('图例：');
      console.log('  🔵 蓝线 = fork 承载面世界轨迹，🔵 小球 = 每段 t_end 时 fork 位置');
      console.log('  🟠 橙线 = cargo 世界轨迹，🟠 小球 = 每段 t_end 时 cargo 位置');
      console.log('  🔴 大红球 = attach 瞬间 cargo 位置');
      console.log('  🟢 大绿球 = detach 瞬间 cargo 位置');
      console.log(`  检测到 cargo parent 切换 ${attachIdx.length} 次 (预期 2：attach + detach)`);
      console.log('坐标是 Three.js Y-up（y=高度 up）。UI 里显示的 z 对应这里的 y。');
      console.log('清除：__diagTpl.clearTrajectory()');
      console.groupEnd();
      return { samples, forkPts, cargoPts, textRows };
    },

    // ═══ 清除已绘制的轨迹 ═════════════════════════════════════════════
    clearTrajectory() {
      const toRemove = [];
      sm.sceneRoot.traverse((o) => {
        if (o.userData?.__isDiagTrajectory) toRemove.push(o);
      });
      toRemove.forEach((o) => {
        o.parent?.remove(o);
        o.traverse((n) => {
          n.geometry?.dispose?.();
          if (Array.isArray(n.material)) n.material.forEach((m) => m.dispose?.());
          else n.material?.dispose?.();
        });
      });
      return toRemove.length;
    },

    // ═══ 全部跑 ═══════════════════════════════════════════════════
    all() {
      console.clear();
      console.log('═══════════════════════════════════════════════════');
      console.log('  叉车 14 段模板诊断（__diagTpl.all）');
      console.log('═══════════════════════════════════════════════════');
      this.health();
      this.compiled();
      this.reparentTiming();
      this.cascadeCheck();
      this.formulas();
      this.loopBoundary();
      this.playbackSample();
      console.log('═══════════════════════════════════════════════════');
      console.log('✅ 诊断完毕。看 console.warn / error 找问题点。');
    },
  };

  window.__diagTpl = diag;
  console.log('[diag-template] 已注册 window.__diagTpl');
  console.log('  __diagTpl.all()                一把梭 6 项');
  console.log('  __diagTpl.compiled()           看编译产物');
  console.log('  __diagTpl.reparentTiming()     时间对齐');
  console.log('  __diagTpl.cascadeCheck()       value_start 级联');
  console.log('  __diagTpl.formulas()           公式求值 + 限位');
  console.log('  __diagTpl.loopBoundary()       循环回零验证');
  console.log('  __diagTpl.playbackSample([t1, t2, ...])  时间采样');
  console.log('  __diagTpl.drawTrajectory()     🎨 在 3D 视口画出 fork/cargo 轨迹');
  console.log('  __diagTpl.clearTrajectory()    清掉已画的轨迹');
})();
