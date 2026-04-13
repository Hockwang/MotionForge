/**
 * GLB Roundtrip Transform 诊断脚本
 * ──────────────────────────────────────────────────────────
 * 用于定位"导出 ZIP → 导入 ZIP"后模型变形的根因。
 *
 * ═══════════════════════════════════════════════════════════
 *  操作步骤（请严格按顺序执行）
 * ═══════════════════════════════════════════════════════════
 *
 *  ❶ 打开 MotionForge，加载模型（例如三向车 GLB）
 *  ❷ 添加关节、设置一些驱动值（例如旋转 30°、平移 0.5）
 *  ❸ 按 F12 打开浏览器 DevTools → Console 标签
 *  ❹ 把本脚本完整粘贴到 Console 里，按回车
 *     → 看到 "✅ Roundtrip Transform 诊断工具已加载" 说明成功
 *
 *  ❺ 在 Console 输入：
 *       __diagT.phaseA()
 *     → 会打印 "驱动态" 和 "零位态" 的节点 transform 表格
 *     → 完成后画面自动恢复到刚才的样子（不影响你的编辑）
 *
 *  ❻ 正常点击"导出结果包"按钮，导出 ZIP 文件
 *
 *  ❼ 正常点击"导入结果包"按钮，选择刚才导出的 ZIP 文件
 *     → 等导入完成（场景树左侧刷新）
 *
 *  ❽ 在 Console 输入：
 *       __diagT.phaseB()
 *     → 打印导入后的节点 transform
 *
 *  ❾ 在 Console 输入：
 *       __diagT.phaseC()
 *     → 把导入后的所有关节重置到 value=0，打印零位态 transform
 *
 *  ❿ 在 Console 输入：
 *       __diagT.compare()
 *     → 自动对比 4 组数据，输出结论和详细差异表格
 *     → 根据输出可以判定是 "double-apply"、"GLB 有损" 还是其他原因
 *
 * ═══════════════════════════════════════════════════════════
 *  输出解读
 * ═══════════════════════════════════════════════════════════
 *
 *  compare() 会输出一张对比表，每个节点显示：
 *    - 导入态 vs 驱动态 的位置/旋转差异
 *    - 导入零位 vs 原始零位 的差异
 *
 *  结论判定：
 *    ┌──────────────────────┬──────────────────────┬────────────────────────────────┐
 *    │ 导入态 ≈ 驱动态？   │ 导入零位 ≈ 原始零位？│ 结论                           │
 *    ├──────────────────────┼──────────────────────┼────────────────────────────────┤
 *    │ Yes                  │ Yes                  │ GLB 忠实 + double-apply        │
 *    │ Yes                  │ No                   │ GLB 忠实 + 序列化有轻微损失    │
 *    │ No                   │ Yes                  │ 导入流程改变了 transform       │
 *    │ No                   │ No                   │ GLB 序列化/反序列化有损         │
 *    └──────────────────────┴──────────────────────┴────────────────────────────────┘
 *
 * ═══════════════════════════════════════════════════════════
 */
(function () {
  'use strict';

  const mf = window.__mf;
  if (!mf || !mf.sceneManager || !mf.keyframeManager) {
    console.error('❌ window.__mf 未初始化，请确保 MotionForge 已加载完成');
    return;
  }

  const THREE = mf.THREE;
  const sm = mf.sceneManager;
  const km = mf.keyframeManager;

  if (!THREE) {
    console.error('❌ window.__mf.THREE 未找到，请确保 main.js 已暴露 THREE');
    return;
  }

  // ── 存储 4 组快照 ──
  const snapshots = {};

  // ── 工具函数 ──

  /** 收集场景树中所有有意义的节点（跳过灯光/相机/Helper） */
  function collectNodes(root) {
    const nodes = [];
    if (!root) return nodes;
    root.traverse((obj) => {
      if (obj.isLight || obj.isCamera) return;
      if (obj.type && obj.type.includes('Helper')) return;
      nodes.push(obj);
    });
    return nodes;
  }

  /** 构建节点路径（从 root 到当前节点的 name 链） */
  function getNodePath(obj, root) {
    const parts = [];
    let cur = obj;
    while (cur && cur !== root?.parent) {
      parts.unshift(cur.name || `(${cur.type})`);
      cur = cur.parent;
    }
    return parts.join('/');
  }

  /** 抓取所有节点的 worldPosition + worldQuaternion */
  function captureTransforms(root) {
    const nodes = collectNodes(root);
    const result = [];
    nodes.forEach((obj) => {
      obj.updateMatrixWorld(true);
      const wp = obj.getWorldPosition(new THREE.Vector3());
      const wq = obj.getWorldQuaternion(new THREE.Quaternion());
      const lp = obj.position.clone();
      const lq = obj.quaternion.clone();
      result.push({
        name: obj.name || `(${obj.type})`,
        uuid: obj.uuid.slice(0, 8),
        path: getNodePath(obj, root),
        worldPos: { x: wp.x, y: wp.y, z: wp.z },
        worldQuat: { x: wq.x, y: wq.y, z: wq.z, w: wq.w },
        localPos: { x: lp.x, y: lp.y, z: lp.z },
        localQuat: { x: lq.x, y: lq.y, z: lq.z, w: lq.w },
      });
    });
    return result;
  }

  /** 抓取关节定义快照 */
  function captureJointDefs() {
    return km.getAllJointDefs().map((d) => ({
      name: d.name,
      id: d.id?.slice(0, 8),
      type: d.type,
      axis: d.axis,
      currentValue: d.currentValue,
      parentId: d.parentId?.slice(0, 8),
      childId: d.childId?.slice(0, 8),
      hasBase: !!d.baseTransform,
      origin: d.origin ? { x: d.origin.x, y: d.origin.y, z: d.origin.z } : null,
    }));
  }

  /** 暂存并重置所有关节到 value=0 */
  function resetAllJointsToZero() {
    const saved = [];
    km.getAllJointDefs().forEach((def) => {
      saved.push({ id: def.id, value: def.currentValue });
      def.currentValue = 0;
    });
    km.applyAllJointDrives(sm.sceneRoot);
    return saved;
  }

  /** 恢复关节值 */
  function restoreJointValues(saved) {
    saved.forEach(({ id, value }) => {
      const def = km.jointDefinitions.get(id);
      if (def) def.currentValue = value;
    });
    km.applyAllJointDrives(sm.sceneRoot);
  }

  /** 计算两个 transform 快照之间的差异 */
  function computeDiff(snapshotA, snapshotB, labelA, labelB) {
    // 按 path 或 name 匹配
    const results = [];
    const bByPath = new Map(snapshotB.map((n) => [n.path, n]));
    const bByName = new Map(snapshotB.map((n) => [n.name, n]));

    snapshotA.forEach((a) => {
      const b = bByPath.get(a.path) || bByName.get(a.name);
      if (!b) {
        results.push({
          name: a.name,
          path: a.path,
          status: '❌ 丢失',
          posDrift: NaN,
          rotDrift: NaN,
        });
        return;
      }

      // 位置差异（欧氏距离）
      const dx = a.worldPos.x - b.worldPos.x;
      const dy = a.worldPos.y - b.worldPos.y;
      const dz = a.worldPos.z - b.worldPos.z;
      const posDrift = Math.sqrt(dx * dx + dy * dy + dz * dz);

      // 旋转差异（四元数点积 → 角度）
      const dot = Math.abs(
        a.worldQuat.x * b.worldQuat.x +
        a.worldQuat.y * b.worldQuat.y +
        a.worldQuat.z * b.worldQuat.z +
        a.worldQuat.w * b.worldQuat.w,
      );
      const rotDrift = Math.acos(Math.min(dot, 1.0)) * 2 * (180 / Math.PI);

      results.push({
        name: a.name,
        path: a.path,
        status: (posDrift < 0.01 && rotDrift < 1.0) ? '✓' : '⚠',
        posDrift,
        rotDrift,
      });
    });

    // 检查 B 中有但 A 中没有的节点
    const aByPath = new Set(snapshotA.map((n) => n.path));
    const aByName = new Set(snapshotA.map((n) => n.name));
    snapshotB.forEach((b) => {
      if (!aByPath.has(b.path) && !aByName.has(b.name)) {
        results.push({
          name: b.name,
          path: b.path,
          status: '➕ 新增',
          posDrift: NaN,
          rotDrift: NaN,
        });
      }
    });

    return results;
  }

  /** 打印差异表格 */
  function printDiffTable(diffs, title) {
    console.group(title);
    const problems = diffs.filter((d) => d.status !== '✓');
    const ok = diffs.filter((d) => d.status === '✓');

    if (problems.length === 0) {
      console.log(`✅ 全部 ${diffs.length} 个节点匹配（pos < 0.01, rot < 1°）`);
    } else {
      console.warn(`⚠ ${problems.length}/${diffs.length} 个节点有差异：`);
      console.table(
        problems.map((d) => ({
          状态: d.status,
          节点: d.name,
          路径: d.path,
          位置偏移: isNaN(d.posDrift) ? '-' : d.posDrift.toFixed(4),
          旋转偏移: isNaN(d.rotDrift) ? '-' : d.rotDrift.toFixed(1) + '°',
        })),
      );
    }
    if (ok.length > 0) {
      console.log(`✓ ${ok.length} 个节点完全匹配`);
    }
    console.groupEnd();
  }

  /** 打印节点名字变化 */
  function printNameChanges(snapshotA, snapshotB, labelA, labelB) {
    console.group(`节点名字对比 (${labelA} → ${labelB})`);
    const namesA = snapshotA.map((n) => n.path).sort();
    const namesB = snapshotB.map((n) => n.path).sort();

    const setA = new Set(namesA);
    const setB = new Set(namesB);

    const removed = namesA.filter((p) => !setB.has(p));
    const added = namesB.filter((p) => !setA.has(p));

    if (removed.length === 0 && added.length === 0) {
      console.log(`✅ 节点路径完全一致（${namesA.length} 个节点）`);
    } else {
      if (removed.length > 0) {
        console.warn(`导入后丢失的路径 (${removed.length}):`);
        removed.forEach((p) => console.log(`  ❌ ${p}`));
      }
      if (added.length > 0) {
        console.warn(`导入后新增的路径 (${added.length}):`);
        added.forEach((p) => console.log(`  ➕ ${p}`));
      }
    }
    console.groupEnd();
  }

  // ── 主要 API ──

  window.__diagT = {
    /**
     * 阶段 A：导出前调用
     * 抓取"驱动态"和"零位态"两组快照
     */
    phaseA() {
      const root = sm.sceneRoot;
      if (!root) { console.error('sceneRoot 为空'); return; }

      console.group('═══ Phase A：导出前快照 ═══');

      // ① 驱动态快照
      const driven = captureTransforms(root);
      const joints = captureJointDefs();
      snapshots.A_driven = driven;
      snapshots.A_joints = joints;
      console.log(`📸 驱动态：${driven.length} 个节点，${joints.length} 个关节`);
      console.log('关节当前值:', joints.map((j) => `${j.name}=${j.currentValue}`).join(', '));

      // ② 临时重置到零位
      const saved = resetAllJointsToZero();

      // ③ 零位态快照
      const zero = captureTransforms(root);
      snapshots.A_zero = zero;
      console.log(`📸 零位态：${zero.length} 个节点`);

      // ④ 恢复
      restoreJointValues(saved);
      console.log('✅ 已恢复关节值，画面不变');

      // 显示驱动态 vs 零位态差异（确认关节确实改变了 transform）
      const driveEffect = computeDiff(zero, driven, '零位', '驱动');
      const affected = driveEffect.filter((d) => d.status !== '✓');
      if (affected.length > 0) {
        console.log(`关节影响了 ${affected.length} 个节点的 transform：`);
        affected.forEach((d) => {
          console.log(`  ${d.name}: pos偏移=${d.posDrift.toFixed(4)} rot偏移=${d.rotDrift.toFixed(1)}°`);
        });
      } else {
        console.log('（关节对 transform 没有影响 — 可能所有值都是 0）');
      }

      console.groupEnd();
      console.log('');
      console.log('👉 现在请导出 ZIP，然后导入 ZIP，再运行 __diagT.phaseB()');
    },

    /**
     * 阶段 B：导入后立即调用（不要手动操作任何东西）
     * 抓取导入后的当前状态
     */
    phaseB() {
      const root = sm.sceneRoot;
      if (!root) { console.error('sceneRoot 为空'); return; }
      if (!snapshots.A_driven) { console.error('请先运行 phaseA()'); return; }

      console.group('═══ Phase B：导入后快照 ═══');

      const imported = captureTransforms(root);
      const joints = captureJointDefs();
      snapshots.B_imported = imported;
      snapshots.B_joints = joints;
      console.log(`📸 导入态：${imported.length} 个节点，${joints.length} 个关节`);
      console.log('关节当前值:', joints.map((j) => `${j.name}=${j.currentValue}`).join(', '));

      // 快速预览：导入态 vs 驱动态
      printNameChanges(snapshots.A_driven, imported, '导出前', '导入后');
      printDiffTable(
        computeDiff(snapshots.A_driven, imported, '导出前驱动态', '导入态'),
        '导入态 vs 导出前驱动态（预览）',
      );

      console.groupEnd();
      console.log('');
      console.log('👉 现在运行 __diagT.phaseC()');
    },

    /**
     * 阶段 C：导入后重置关节到零位
     * 抓取导入后的零位状态
     */
    phaseC() {
      const root = sm.sceneRoot;
      if (!root) { console.error('sceneRoot 为空'); return; }
      if (!snapshots.B_imported) { console.error('请先运行 phaseB()'); return; }

      console.group('═══ Phase C：导入后零位快照 ═══');

      // 重置到零位（不恢复，因为这是诊断用）
      resetAllJointsToZero();

      const importedZero = captureTransforms(root);
      snapshots.C_importedZero = importedZero;
      console.log(`📸 导入零位态：${importedZero.length} 个节点`);

      // 快速预览：导入零位 vs 原始零位
      printDiffTable(
        computeDiff(snapshots.A_zero, importedZero, '原始零位', '导入零位'),
        '导入零位 vs 原始零位（预览）',
      );

      console.groupEnd();
      console.log('');
      console.log('👉 现在运行 __diagT.compare() 查看完整分析');
    },

    /**
     * 综合对比 + 结论
     */
    compare() {
      if (!snapshots.A_driven || !snapshots.A_zero || !snapshots.B_imported || !snapshots.C_importedZero) {
        console.error('请先按顺序运行 phaseA() → 导出 → 导入 → phaseB() → phaseC()');
        return;
      }

      console.group('═══════════════════════════════════════════');
      console.group('═══ 综合对比分析 ═══');

      // ── 对比 1：导入态 vs 导出前驱动态 ──
      const diff1 = computeDiff(snapshots.A_driven, snapshots.B_imported, '驱动态', '导入态');
      printDiffTable(diff1, '① 导入态 vs 导出前驱动态');
      const match1 = diff1.filter((d) => d.status === '✓').length;
      const total1 = diff1.length;
      const importMatchesDriven = match1 === total1;

      // ── 对比 2：导入零位 vs 原始零位 ──
      const diff2 = computeDiff(snapshots.A_zero, snapshots.C_importedZero, '原始零位', '导入零位');
      printDiffTable(diff2, '② 导入零位 vs 原始零位');
      const match2 = diff2.filter((d) => d.status === '✓').length;
      const total2 = diff2.length;
      const zeroMatchesZero = match2 === total2;

      // ── 对比 3：导入态 vs 原始零位（检测 double-apply 的量级）──
      const diff3 = computeDiff(snapshots.A_zero, snapshots.B_imported, '原始零位', '导入态');
      printDiffTable(diff3, '③ 导入态 vs 原始零位（检测是否叠加了两倍驱动）');

      // ── 对比 4：节点名字 / 数量变化 ──
      printNameChanges(snapshots.A_driven, snapshots.B_imported, '导出前', '导入后');

      // ── 关节定义对比 ──
      console.group('④ 关节定义对比');
      const jA = snapshots.A_joints;
      const jB = snapshots.B_joints;
      console.log(`导出前 ${jA.length} 个关节，导入后 ${jB.length} 个关节`);
      jA.forEach((a) => {
        const b = jB.find((j) => j.name === a.name);
        if (!b) {
          console.warn(`  ❌ 关节 ${a.name} 导入后丢失`);
        } else {
          const same = a.type === b.type && a.axis === b.axis && a.currentValue === b.currentValue;
          console.log(
            `  ${same ? '✓' : '⚠'} ${a.name}: type=${a.type}→${b.type} axis=${a.axis}→${b.axis} value=${a.currentValue}→${b.currentValue} base=${a.hasBase}→${b.hasBase}`,
          );
        }
      });
      console.groupEnd();

      // ── 结论 ──
      console.group('🏁 结论');

      if (importMatchesDriven && zeroMatchesZero) {
        console.log('诊断：GLB 忠实保存 + double-apply');
        console.log('原因：GLB 烘焙了关节驱动后的 transform，导入后 applyJointDrive 再次施加 → 双重叠加');
        console.log('修复方向：导出前先重置关节到零位 → 序列化 GLB → 恢复关节值');
      } else if (importMatchesDriven && !zeroMatchesZero) {
        console.log('诊断：GLB 忠实保存 + 零位有偏差');
        console.log('原因：GLB roundtrip 本身改变了某些节点的 transform（可能是精度损失或 name 冲突）');
        console.log('需要进一步排查哪些节点的零位不一致');
      } else if (!importMatchesDriven && zeroMatchesZero) {
        console.log('诊断：导入流程改变了 transform');
        console.log('GLB 零位忠实，但导入后的最终状态与导出前不同');
        console.log('可能原因：导入流程中某个步骤（alignObjectToGround、re-apply 等）引入了偏移');
      } else {
        console.log('诊断：GLB 序列化/反序列化有损');
        console.log('零位态和驱动态都不匹配，GLTFExporter/GLTFLoader roundtrip 改变了场景结构');
        console.log('需要对比具体哪些节点差异最大');
      }

      // 额外检查：导入态偏移量是否约等于"驱动态 vs 零位态"差异的 2 倍？
      const driveEffect = computeDiff(snapshots.A_zero, snapshots.A_driven, '零位', '驱动');
      const importVsZero = diff3;
      let doubleCount = 0;
      let checkCount = 0;
      driveEffect.forEach((de) => {
        if (de.status !== '✓' && !isNaN(de.posDrift) && de.posDrift > 0.01) {
          const iz = importVsZero.find((d) => d.name === de.name);
          if (iz && !isNaN(iz.posDrift)) {
            checkCount++;
            const ratio = iz.posDrift / de.posDrift;
            if (ratio > 1.5 && ratio < 2.5) {
              doubleCount++;
              console.log(`  ↪ ${de.name}: 驱动偏移=${de.posDrift.toFixed(3)}, 导入偏移=${iz.posDrift.toFixed(3)}, 比值=${ratio.toFixed(2)} ≈ 2x`);
            }
          }
        }
      });
      if (checkCount > 0) {
        console.log(`偏移量 ≈ 2 倍的节点: ${doubleCount}/${checkCount} (${doubleCount === checkCount ? '✅ 确认 double-apply' : '部分匹配，可能混合原因'})`);
      }

      console.groupEnd();
      console.groupEnd();
      console.groupEnd();
    },

    /** 查看原始快照数据（debug 用） */
    raw() { return snapshots; },
  };

  console.log('');
  console.log('✅ Roundtrip Transform 诊断工具已加载');
  console.log('');
  console.log('操作步骤：');
  console.log('  1. 确保模型已加载、关节已配好、有驱动值（不全为 0）');
  console.log('  2. __diagT.phaseA()    ← 导出前快照');
  console.log('  3. 正常导出 ZIP');
  console.log('  4. 正常导入刚才的 ZIP');
  console.log('  5. __diagT.phaseB()    ← 导入后快照');
  console.log('  6. __diagT.phaseC()    ← 重置关节到零位');
  console.log('  7. __diagT.compare()   ← 查看完整分析和结论');
  console.log('');
})();
