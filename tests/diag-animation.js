/**
 * 动画播放诊断脚本
 * ──────────────────────────────────────────────────────────
 * 在时间轴上多个时间点抓取关节状态和节点 transform，
 * 定位"播放时组件掉到地下"的原因。
 *
 * 用法：
 *   1. 配好关节和关键帧
 *   2. F12 → Console，粘贴脚本
 *   3. __diagA.scanClip()  ← 自动扫描当前 clip 的多个时间点
 *   4. 查看输出
 */
(function () {
  'use strict';

  const mf = window.__mf;
  if (!mf?.sceneManager || !mf?.keyframeManager) {
    console.error('❌ window.__mf 未初始化');
    return;
  }

  const THREE = mf.THREE;
  const sm = mf.sceneManager;
  const km = mf.keyframeManager;

  function captureJointNodes() {
    const root = sm.sceneRoot;
    const defs = km.getAllJointDefs();
    return defs.map((d) => {
      let child = null;
      root.traverse((o) => { if (o.uuid === d.childId) child = o; });
      if (!child) return { name: d.name, found: false };
      child.updateMatrixWorld(true);
      const wp = child.getWorldPosition(new THREE.Vector3());
      return {
        name: d.name,
        type: d.type,
        axis: d.axis,
        currentValue: d.currentValue,
        hasBase: !!d.baseTransform,
        worldPos: { x: wp.x, y: wp.y, z: wp.z },
        localPos: { x: child.position.x, y: child.position.y, z: child.position.z },
        baseTx: d.baseTransform?.tx,
        baseTy: d.baseTransform?.ty,
        baseTz: d.baseTransform?.tz,
      };
    });
  }

  window.__diagA = {
    /** 扫描当前 clip 在多个时间点的状态 */
    scanClip(steps = 6) {
      const clip = km.getActiveGlobalClip();
      if (!clip) { console.error('无激活 clip'); return; }

      console.group(`═══ 动画扫描：${clip.clipName}（${clip.duration}s, ${clip.keyframes.length} 关键帧）═══`);

      // 关键帧本身的时间点
      console.group('关键帧原始数据');
      clip.keyframes.forEach((kf, i) => {
        console.log(`  KF${i} t=${kf.time.toFixed(2)}s  jointValues=`, kf.jointValues);
      });
      console.groupEnd();

      // 扫描 0..duration 的多个时间点
      console.group('各时间点关节状态');
      const results = [];
      // 保存当前状态
      const savedValues = km.getAllJointDefs().map((d) => ({ id: d.id, value: d.currentValue }));

      for (let i = 0; i <= steps; i++) {
        const t = (i / steps) * clip.duration;
        km.evaluateAllAt(t);
        km.applyAllJointDrives(sm.sceneRoot);
        const snapshot = captureJointNodes();
        results.push({ t, snapshot });

        console.group(`t=${t.toFixed(2)}s`);
        snapshot.forEach((n) => {
          if (!n.found && n.name) { console.log(`  ❌ ${n.name} 未找到`); return; }
          console.log(
            `  ${n.name}: value=${n.currentValue.toFixed(3)}  ` +
            `worldY=${n.worldPos.y.toFixed(2)}  ` +
            `localPos=(${n.localPos.x.toFixed(2)},${n.localPos.y.toFixed(2)},${n.localPos.z.toFixed(2)})  ` +
            `base=(${n.baseTx?.toFixed(2)},${n.baseTy?.toFixed(2)},${n.baseTz?.toFixed(2)})`,
          );
        });
        console.groupEnd();
      }
      console.groupEnd();

      // 分析：worldY 下降的节点
      console.group('🔍 检测：哪些节点 Y 方向下降？');
      const names = results[0].snapshot.map((n) => n.name);
      names.forEach((name) => {
        const ys = results.map((r) => r.snapshot.find((n) => n.name === name)?.worldPos?.y);
        const yMin = Math.min(...ys.filter((y) => y !== undefined));
        const yMax = Math.max(...ys.filter((y) => y !== undefined));
        const yRange = yMax - yMin;
        if (yRange > 0.5) {
          console.log(`  ${name}: Y从${ys[0]?.toFixed(2)}变化到${ys[ys.length-1]?.toFixed(2)} (范围${yRange.toFixed(2)})`);
        }
      });
      console.groupEnd();

      // 恢复
      savedValues.forEach((s) => {
        const d = km.jointDefinitions.get(s.id);
        if (d) d.currentValue = s.value;
      });
      km.applyAllJointDrives(sm.sceneRoot);
      console.log('✅ 已恢复原始状态');

      console.groupEnd();
      return results;
    },

    /** 单独测试某个时间点 */
    at(t) {
      km.evaluateAllAt(t);
      km.applyAllJointDrives(sm.sceneRoot);
      console.log(`t=${t}s:`);
      console.table(captureJointNodes().map((n) => ({
        name: n.name,
        value: n.currentValue?.toFixed(3),
        worldY: n.worldPos?.y?.toFixed(2),
        localPos: `(${n.localPos?.x?.toFixed(1)},${n.localPos?.y?.toFixed(1)},${n.localPos?.z?.toFixed(1)})`,
      })));
    },

    /** 打印关键帧 */
    keyframes() {
      const clip = km.getActiveGlobalClip();
      if (!clip) { console.error('无激活 clip'); return; }
      console.table(clip.keyframes.map((kf) => ({
        t: kf.time,
        ...kf.jointValues,
      })));
    },
  };

  console.log('✅ 动画诊断工具已加载');
  console.log('  __diagA.keyframes()     查看关键帧原始数据');
  console.log('  __diagA.scanClip()      扫描整个 clip（默认6个时间点）');
  console.log('  __diagA.at(2.5)         测试指定时间点');
})();
