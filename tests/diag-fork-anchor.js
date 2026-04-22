// diag-fork-anchor.js — #47 调查：为什么叉齿下沉穿地、cargo 飘空
// 用法：Chrome Console 粘贴 → __diagFA.run()
(() => {
  const THREE = window.__mf?.THREE;
  const km = window.__mf?.keyframeManager;
  const sm = window.__mf?.sceneManager;
  if (!THREE || !km || !sm?.sceneRoot) {
    console.error('❌ __mf 未就绪');
    return;
  }

  const fmt = (v) => (typeof v === 'number' ? v.toFixed(3) : v);
  const v3 = (v) => `(${fmt(v.x)}, ${fmt(v.y)}, ${fmt(v.z)})`;

  const diag = {
    /** 关键信息一把梭 */
    run() {
      console.group('🔍 #47 诊断：fork_anchor_zero / snap 对齐 / PKF 求值');

      // 1. 当前 reparent event 找 attach target
      const events = km.getActiveGlobalClip()?.reparentEvents || [];
      const attachEvent = events.find((e) => e.new_parent_name);
      console.log('1️⃣ Attach event:', attachEvent);
      if (!attachEvent) {
        console.warn('⛔ 无 attach event → fork_anchor_zero 没意义');
        console.groupEnd();
        return;
      }

      // 2. 找叉齿对象 + 它的所有 mesh 子代 bbox
      const forkObj = sm.sceneRoot.getObjectByName(attachEvent.new_parent_name);
      if (!forkObj) {
        console.error(`⛔ 找不到 attach 目标 ${attachEvent.new_parent_name}`);
        console.groupEnd();
        return;
      }
      sm.sceneRoot.updateMatrixWorld(true);

      console.log(`2️⃣ 叉齿对象: ${forkObj.name} (type=${forkObj.type})`);
      const meshes = [];
      forkObj.traverse((o) => {
        if (!o.isMesh) return;
        const box = new THREE.Box3().setFromObject(o);
        if (box.isEmpty()) return;
        meshes.push({
          name: o.name || '(unnamed)',
          uuid: o.uuid.slice(0, 8),
          min: box.min.clone(),
          max: box.max.clone(),
          center: box.getCenter(new THREE.Vector3()),
          size: box.getSize(new THREE.Vector3()),
        });
      });
      meshes.sort((a, b) => a.min.y - b.min.y);
      console.log('3️⃣ 叉齿子树所有 mesh（按 min.y 升序，_findForkTineMesh 会挑 [0]）:');
      console.table(meshes.map((m) => ({
        name: m.name,
        uuid: m.uuid,
        'min.y': fmt(m.min.y),
        'max.y': fmt(m.max.y),
        'center.y': fmt(m.center.y),
        'size.y': fmt(m.size.y),
        min: v3(m.min),
        max: v3(m.max),
      })));

      // 3. 当前 _findForkTineMesh 的选择
      const tineMesh = km._findForkTineMesh(forkObj) || forkObj;
      const tineBox = new THREE.Box3().setFromObject(tineMesh);
      console.log(`4️⃣ _findForkTineMesh 挑到: ${tineMesh.name || '(unnamed)'}`);
      console.log(`   bbox.min = ${v3(tineBox.min)}`);
      console.log(`   bbox.max = ${v3(tineBox.max)}`);
      console.log(`   bbox.center = ${v3(tineBox.getCenter(new THREE.Vector3()))}`);
      console.log(`   bbox.size = ${v3(tineBox.getSize(new THREE.Vector3()))}`);

      // 4. fork_anchor_zero（关节归零状态下算 —— 模拟 snapshotForkAnchorZero）
      console.log('5️⃣ 临时归零算 fork_anchor_zero...');
      const saved = km.getAllJointDefs().map((d) => ({ id: d.id, value: d.currentValue }));
      saved.forEach((s) => {
        const d = km.jointDefinitions.get(s.id);
        if (d) d.currentValue = 0;
      });
      km.applyAllJointDrives(sm.sceneRoot);
      km.invalidateForkAnchorZero();
      const anchor = km.computeForkAnchorZero(sm.sceneRoot);
      console.log(`   fork_anchor_zero (UI Z-up):`, anchor);

      // 同时记录零位时 tine mesh 的 bbox
      const zeroBox = new THREE.Box3().setFromObject(tineMesh);
      console.log(`   零位时 tine bbox.max.y (threejs) = ${fmt(zeroBox.max.y)} → 即 UI z`);
      console.log(`   零位时 tine bbox.center.y (threejs) = ${fmt(zeroBox.getCenter(new THREE.Vector3()).y)}`);

      // 还原
      saved.forEach((s) => {
        const d = km.jointDefinitions.get(s.id);
        if (d) d.currentValue = s.value;
      });
      km.applyAllJointDrives(sm.sceneRoot);

      // 5. Cargo marker 信息
      let cargoMarker = null;
      for (const m of km.sceneMarkers.values()) {
        if (m.type === 'cargo') { cargoMarker = m; break; }
      }
      if (cargoMarker) {
        console.log(`6️⃣ cargo marker: name=${cargoMarker.name}, size=`, cargoMarker.size);
        const cargoObj = sm.sceneRoot.getObjectByName(cargoMarker.name);
        if (cargoObj) {
          cargoObj.updateMatrixWorld(true);
          const cp = cargoObj.getWorldPosition(new THREE.Vector3());
          console.log(`   cargo world pos (threejs Y-up): ${v3(cp)}`);
          console.log(`   cargo UI Z-up: (${fmt(cp.x)}, ${fmt(cp.z)}, ${fmt(cp.y)})`);
        }
      } else {
        console.warn('⚠️ 没有 cargo marker');
      }

      // 6. PKF 当前 steps（筛 attach 前的）
      const tAttach = Number(attachEvent.t) || 0;
      console.log(`7️⃣ Attach 时间 t=${tAttach}s，attach 前的 PKF steps:`);
      const preAttachSteps = (km.pkfSteps || []).filter((s) => Number(s.t_end) <= tAttach + 0.01);
      console.table(preAttachSteps.map((s) => ({
        joint: s.joint,
        channel: s.channel,
        axis: s.axis,
        t: `${s.t_start}-${s.t_end}`,
        value_start: s.value_start,
        value_end: s.value_end,
      })));

      // 7. 在 attach 时间求值，看每个关节会 set 到什么 value
      console.log(`8️⃣ 在 t=${tAttach}s 求值 PKF（看 attach 瞬间各关节实际值）:`);
      const results = km.evaluatePkfAt(tAttach);
      console.table(results.map((r) => {
        const def = km.jointDefinitions.get(r.joint_def_id);
        return {
          joint: def?.name || r.joint_def_id,
          role: def?.role || '',
          value: fmt(r.value),
          error: r.error || '',
        };
      }));

      // 8. 在 attach 时间算 attach 后 cargo 预期位置
      if (cargoMarker) {
        const tineMeshNow = km._findForkTineMesh(forkObj) || forkObj;
        const tineBoxNow = new THREE.Box3().setFromObject(tineMeshNow);
        const centerNow = tineBoxNow.getCenter(new THREE.Vector3());
        const cargoHalfH = (cargoMarker.size?.h ?? 0) / 2;
        const expectedCargoWorld = new THREE.Vector3(
          centerNow.x,
          tineBoxNow.max.y + cargoHalfH,
          centerNow.z,
        );
        console.log(`9️⃣ t=${tAttach} 时 tine bbox.max.y (threejs) = ${fmt(tineBoxNow.max.y)}`);
        console.log(`   snap 后 cargo 预期世界位置 (threejs): ${v3(expectedCargoWorld)}`);
        console.log(`   即 UI Z-up: (x=${fmt(expectedCargoWorld.x)}, y=${fmt(expectedCargoWorld.z)}, z=${fmt(expectedCargoWorld.y)})`);
      }

      console.log('✅ 诊断完毕');
      console.groupEnd();
    },

    /** 只看 _findForkTineMesh 的候选列表（对比模型里哪个才是真叉齿） */
    listForkSubmeshes() {
      const events = km.getActiveGlobalClip()?.reparentEvents || [];
      const attachEvent = events.find((e) => e.new_parent_name);
      if (!attachEvent) return console.warn('无 attach event');
      const forkObj = sm.sceneRoot.getObjectByName(attachEvent.new_parent_name);
      if (!forkObj) return console.error('找不到 fork');
      sm.sceneRoot.updateMatrixWorld(true);
      const rows = [];
      forkObj.traverse((o) => {
        if (!o.isMesh) return;
        const box = new THREE.Box3().setFromObject(o);
        if (box.isEmpty()) return;
        const size = box.getSize(new THREE.Vector3());
        rows.push({
          name: o.name || '(unnamed)',
          'min.y': fmt(box.min.y),
          'max.y': fmt(box.max.y),
          'size.x': fmt(size.x),
          'size.y': fmt(size.y),
          'size.z': fmt(size.z),
          ratio_flat: fmt(Math.max(size.x, size.z) / (size.y || 0.001)), // 扁平度
        });
      });
      rows.sort((a, b) => parseFloat(a['min.y']) - parseFloat(b['min.y']));
      console.log('叉齿子树所有 mesh（按 min.y 升序；ratio_flat 大 = 水平扁平 = 更像叉齿）');
      console.table(rows);
    },
  };

  window.__diagFA = diag;
  console.log('✅ diag-fork-anchor 已加载。运行：__diagFA.run() 或 __diagFA.listForkSubmeshes()');
})();
