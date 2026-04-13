/**
 * 零位态诊断脚本
 * ──────────────────────────────────────────────────────────
 * 在不修改源代码的情况下，模拟"导出零位态"的流程，
 * 检查 applyJointDrive(value=0) 是否能正确还原模型到零位。
 *
 * 用法：
 *   1. 加载模型，配好关节，设好驱动值
 *   2. F12 → Console，粘贴本脚本
 *   3. __diagZ.snapshot('before')   ← 记录当前状态
 *   4. __diagZ.testZeroPose()       ← 模拟零位态（设value=0 + applyDrives）
 *   5. __diagZ.snapshot('zeroKeepBase') ← 记录零位态（保留base）
 *   6. __diagZ.testZeroPoseClearBase()  ← 模拟零位态（清空base + applyDrives）
 *   7. __diagZ.snapshot('zeroClearBase') ← 记录零位态（清空base）
 *   8. __diagZ.restore()            ← 恢复到原始状态
 *   9. __diagZ.compare()            ← 对比分析
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

  const snapshots = {};
  let savedState = null;

  function collectNodes(root) {
    const nodes = [];
    root.traverse((obj) => {
      if (obj.isLight || obj.isCamera) return;
      if (obj.type?.includes('Helper')) return;
      nodes.push(obj);
    });
    return nodes;
  }

  function captureTransforms(root) {
    const nodes = collectNodes(root);
    return nodes.map((obj) => {
      obj.updateMatrixWorld(true);
      const wp = obj.getWorldPosition(new THREE.Vector3());
      const wq = obj.getWorldQuaternion(new THREE.Quaternion());
      return {
        name: obj.name || `(${obj.type})`,
        uuid: obj.uuid.slice(0, 8),
        worldPos: { x: wp.x, y: wp.y, z: wp.z },
        worldQuat: { x: wq.x, y: wq.y, z: wq.z, w: wq.w },
        localPos: { x: obj.position.x, y: obj.position.y, z: obj.position.z },
        localQuat: { x: obj.quaternion.x, y: obj.quaternion.y, z: obj.quaternion.z, w: obj.quaternion.w },
      };
    });
  }

  function captureJointState() {
    return km.getAllJointDefs().map((d) => ({
      id: d.id,
      name: d.name,
      currentValue: d.currentValue,
      baseTransform: d.baseTransform ? { ...d.baseTransform } : null,
      type: d.type,
      axis: d.axis,
    }));
  }

  function diffTransforms(a, b) {
    const results = [];
    const bByName = new Map(b.map((n) => [n.name + '_' + n.uuid, n]));
    // 也用 uuid 匹配
    const bByUuid = new Map(b.map((n) => [n.uuid, n]));

    a.forEach((an) => {
      const bn = bByName.get(an.name + '_' + an.uuid) || bByUuid.get(an.uuid);
      if (!bn) { results.push({ name: an.name, status: '丢失' }); return; }

      const dx = an.worldPos.x - bn.worldPos.x;
      const dy = an.worldPos.y - bn.worldPos.y;
      const dz = an.worldPos.z - bn.worldPos.z;
      const posDrift = Math.sqrt(dx * dx + dy * dy + dz * dz);

      const dot = Math.abs(
        an.worldQuat.x * bn.worldQuat.x + an.worldQuat.y * bn.worldQuat.y +
        an.worldQuat.z * bn.worldQuat.z + an.worldQuat.w * bn.worldQuat.w,
      );
      const rotDrift = Math.acos(Math.min(dot, 1.0)) * 2 * (180 / Math.PI);

      if (posDrift > 0.001 || rotDrift > 0.1) {
        results.push({ name: an.name, posDrift, rotDrift });
      }
    });
    return results;
  }

  window.__diagZ = {
    /** 记录快照 */
    snapshot(label) {
      const root = sm.sceneRoot;
      if (!root) { console.error('sceneRoot 为空'); return; }

      snapshots[label] = {
        transforms: captureTransforms(root),
        joints: captureJointState(),
        timestamp: new Date().toISOString(),
      };
      const joints = snapshots[label].joints;
      console.log(`📸 [${label}] ${snapshots[label].transforms.length} 个节点`);
      console.log('  关节值:', joints.map((j) => `${j.name}=${j.currentValue.toFixed(4)}`).join(', '));
      console.log('  baseTransform:', joints.map((j) => `${j.name}=${j.baseTransform ? 'YES' : 'null'}`).join(', '));
    },

    /** 保存当前状态（用于后续恢复） */
    _saveState() {
      const root = sm.sceneRoot;
      savedState = {
        joints: captureJointState(),
        // 保存每个关节 child 的 local position/quaternion
        childTransforms: km.getAllJointDefs().map((d) => {
          let c = null;
          root.traverse((obj) => { if (obj.uuid === d.childId) c = obj; });
          if (!c) return { id: d.id, found: false };
          return {
            id: d.id,
            found: true,
            pos: { x: c.position.x, y: c.position.y, z: c.position.z },
            quat: { x: c.quaternion.x, y: c.quaternion.y, z: c.quaternion.z, w: c.quaternion.w },
          };
        }),
      };
    },

    /** 方案 A：设 value=0，保留 base，applyDrives */
    testZeroPose() {
      console.group('🔧 方案 A：value=0 + 保留 base');
      this._saveState();

      const defs = km.getAllJointDefs();
      defs.forEach((d) => { d.currentValue = 0; });
      km.applyAllJointDrives(sm.sceneRoot);

      console.log('已设所有 value=0 并 applyDrives（保留 base）');
      defs.forEach((d) => {
        console.log(`  ${d.name}: value=${d.currentValue}, base=${d.baseTransform ? 'YES' : 'null'}`);
      });
      console.log('👉 现在运行 __diagZ.snapshot("zeroKeepBase") 记录状态');
      console.groupEnd();
    },

    /** 方案 B：设 value=0，清空 base，applyDrives（懒捕获） */
    testZeroPoseClearBase() {
      console.group('🔧 方案 B：value=0 + 清空 base');
      if (!savedState) this._saveState();

      const defs = km.getAllJointDefs();
      defs.forEach((d) => {
        d.currentValue = 0;
        d.baseTransform = null;
      });
      km.applyAllJointDrives(sm.sceneRoot);

      console.log('已设所有 value=0 + 清空 base 并 applyDrives');
      defs.forEach((d) => {
        console.log(`  ${d.name}: value=${d.currentValue}, base=${d.baseTransform ? 'YES(懒捕获)' : 'null'}`);
      });
      console.log('👉 现在运行 __diagZ.snapshot("zeroClearBase") 记录状态');
      console.groupEnd();
    },

    /** 方案 C：不通过关节系统，直接把关节 child 的 position/quaternion 恢复到不被关节驱动的"自然状态" */
    testNaturalPose() {
      console.group('🔧 方案 C：跳过关节系统，直接检查自然位置');
      if (!savedState) this._saveState();

      const root = sm.sceneRoot;
      const defs = km.getAllJointDefs();

      // 对每个关节的 child，打印：当前 local pos vs parent 的 local origin
      defs.forEach((d) => {
        let child = null, parent = null;
        root.traverse((obj) => {
          if (obj.uuid === d.childId) child = obj;
          if (obj.uuid === d.parentId) parent = obj;
        });
        if (!child) { console.log(`  ${d.name}: child 未找到`); return; }

        const sceneParent = child.parent;
        console.log(`  ${d.name} (${d.type} ${d.axis}):`);
        console.log(`    child.position = (${child.position.x.toFixed(2)}, ${child.position.y.toFixed(2)}, ${child.position.z.toFixed(2)})`);
        console.log(`    child.quaternion = (${child.quaternion.x.toFixed(4)}, ${child.quaternion.y.toFixed(4)}, ${child.quaternion.z.toFixed(4)}, ${child.quaternion.w.toFixed(4)})`);
        if (parent) {
          console.log(`    jointParent.position = (${parent.position.x.toFixed(2)}, ${parent.position.y.toFixed(2)}, ${parent.position.z.toFixed(2)})`);
          console.log(`    jointParent === sceneParent: ${parent === sceneParent}`);
        }
        if (d.baseTransform) {
          const b = d.baseTransform;
          console.log(`    base.pos = (${b.tx.toFixed(2)}, ${b.ty.toFixed(2)}, ${b.tz.toFixed(2)})`);
          console.log(`    base.quat = (${b.qx.toFixed(4)}, ${b.qy.toFixed(4)}, ${b.qz.toFixed(4)}, ${b.qw.toFixed(4)})`);
          // 检查 base.pos 和 child.position 是否一致
          const posMatch = Math.abs(b.tx - child.position.x) < 0.01
            && Math.abs(b.ty - child.position.y) < 0.01
            && Math.abs(b.tz - child.position.z) < 0.01;
          console.log(`    base.pos ≈ child.position? ${posMatch ? '✅ YES' : '❌ NO (差异：' + Math.sqrt((b.tx-child.position.x)**2 + (b.ty-child.position.y)**2 + (b.tz-child.position.z)**2).toFixed(4) + ')'}`);
        }
      });

      console.log('👉 现在运行 __diagZ.snapshot("natural") 记录状态');
      console.groupEnd();
    },

    /** 恢复到原始状态 */
    restore() {
      if (!savedState) { console.error('没有保存的状态可恢复'); return; }

      const root = sm.sceneRoot;

      // 恢复关节定义
      savedState.joints.forEach((saved) => {
        const def = km.jointDefinitions.get(saved.id);
        if (!def) return;
        def.currentValue = saved.currentValue;
        def.baseTransform = saved.baseTransform;
      });

      // 恢复 child transform
      savedState.childTransforms.forEach((saved) => {
        if (!saved.found) return;
        let c = null;
        root.traverse((obj) => { if (obj.uuid === saved.id) c = obj; });
        if (!c) return;
        c.position.set(saved.pos.x, saved.pos.y, saved.pos.z);
        c.quaternion.set(saved.quat.x, saved.quat.y, saved.quat.z, saved.quat.w);
      });

      km.applyAllJointDrives(root);
      console.log('✅ 已恢复到原始状态');
    },

    /** 对比所有快照 */
    compare() {
      const labels = Object.keys(snapshots);
      if (labels.length < 2) {
        console.error('需要至少 2 个快照。请按顺序运行 snapshot, testXxx, snapshot...');
        return;
      }

      console.group('═══ 零位态对比分析 ═══');

      // 两两对比
      for (let i = 0; i < labels.length; i++) {
        for (let j = i + 1; j < labels.length; j++) {
          const la = labels[i], lb = labels[j];
          const diffs = diffTransforms(snapshots[la].transforms, snapshots[lb].transforms);
          console.group(`${la} vs ${lb}`);
          if (diffs.length === 0) {
            console.log('✅ 完全一致');
          } else {
            console.warn(`⚠ ${diffs.length} 个节点有差异：`);
            diffs.forEach((d) => {
              if (d.status === '丢失') {
                console.log(`  ❌ ${d.name} 丢失`);
              } else {
                console.log(`  ⚠ ${d.name}: pos=${d.posDrift.toFixed(4)} rot=${d.rotDrift.toFixed(1)}°`);
              }
            });
          }
          console.groupEnd();
        }
      }

      console.groupEnd();
    },

    /** 查看原始数据 */
    raw() { return { snapshots, savedState }; },
  };

  console.log('');
  console.log('✅ 零位态诊断工具已加载');
  console.log('');
  console.log('操作步骤：');
  console.log('  1. __diagZ.snapshot("before")         ← 记录当前状态');
  console.log('  2. __diagZ.testNaturalPose()          ← 检查关节自然位置');
  console.log('  3. __diagZ.testZeroPose()              ← 方案A：value=0 保留base');
  console.log('  4. __diagZ.snapshot("zeroKeepBase")    ← 记录方案A结果');
  console.log('  5. __diagZ.restore()                   ← 恢复');
  console.log('  6. __diagZ.testZeroPoseClearBase()     ← 方案B：value=0 清空base');
  console.log('  7. __diagZ.snapshot("zeroClearBase")   ← 记录方案B结果');
  console.log('  8. __diagZ.restore()                   ← 恢复');
  console.log('  9. __diagZ.compare()                   ← 对比所有方案');
  console.log('');
})();
