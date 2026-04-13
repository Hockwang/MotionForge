/**
 * 导出/导入 roundtrip 诊断脚本
 * 用法：
 *   1. 加载 GLB，配好关节和关键帧
 *   2. 控制台粘贴本脚本 → 调用 window.__diagRT.snapshot('before')
 *   3. 导出 ZIP
 *   4. 导入刚才的 ZIP
 *   5. 调用 window.__diagRT.snapshot('after')
 *   6. 调用 window.__diagRT.diff() → 输出结构差异
 */
(function () {
  const sm = window.__mf?.sceneManager;
  const km = window.__mf?.keyframeManager;
  if (!sm || !km) { console.error('❌ __mf 未初始化'); return; }

  const snapshots = {};

  function captureTree(obj, depth = 0) {
    const info = {
      name: obj.name || '(unnamed)',
      type: obj.type,
      uuid: obj.uuid.slice(0, 8),
      childCount: obj.children?.length || 0,
      depth,
      children: [],
    };
    (obj.children || []).forEach((c) => {
      // 跳过 helper 对象（gizmo 等）
      if (c.type?.includes('Helper') || c.isLight || c.isCamera) return;
      info.children.push(captureTree(c, depth + 1));
    });
    return info;
  }

  function printTree(node, indent = '') {
    const tag = node.type === 'Mesh' ? '◆' : node.type === 'Group' ? '📁' : '○';
    console.log(`${indent}${tag} ${node.name} [${node.type}] (${node.childCount} children) uuid=${node.uuid}`);
    node.children.forEach((c) => printTree(c, indent + '  '));
  }

  function flattenNames(node, prefix = '') {
    const path = prefix ? `${prefix}/${node.name}` : node.name;
    const result = [{ path, type: node.type, depth: node.depth }];
    node.children.forEach((c) => {
      result.push(...flattenNames(c, path));
    });
    return result;
  }

  window.__diagRT = {
    snapshot(label) {
      const root = sm.sceneRoot;
      if (!root) { console.error('sceneRoot 为空'); return; }

      const tree = captureTree(root);
      const jointDefs = km.getAllJointDefs().map((d) => ({
        name: d.name, type: d.type, axis: d.axis,
        parentId: d.parentId?.slice(0, 8),
        childId: d.childId?.slice(0, 8),
        currentValue: d.currentValue,
        hasBase: !!d.baseTransform,
      }));
      const clips = [];
      km.globalClips.forEach((clip) => {
        clips.push({
          name: clip.clipName,
          duration: clip.duration,
          kfCount: clip.keyframes.length,
          kfTimes: clip.keyframes.map((k) => k.time),
          jointNames: clip.keyframes.length > 0
            ? Object.keys(clip.keyframes[0].jointValues || {})
            : [],
        });
      });

      snapshots[label] = { tree, jointDefs, clips, timestamp: new Date().toISOString() };

      console.group(`📸 快照 [${label}]`);
      console.log('sceneRoot:', root.name, root.type);
      console.log('场景树:');
      printTree(tree);
      console.log('关节定义:', jointDefs);
      console.log('动画片段:', clips);
      console.groupEnd();
    },

    diff() {
      const before = snapshots.before;
      const after = snapshots.after;
      if (!before || !after) {
        console.error('请先调用 snapshot("before") 和 snapshot("after")');
        return;
      }

      console.group('🔍 Roundtrip 差异分析');

      // 对比场景树结构
      const beforeNames = flattenNames(before.tree);
      const afterNames = flattenNames(after.tree);
      console.group('场景树结构');
      console.log(`导出前 ${beforeNames.length} 个节点, 导入后 ${afterNames.length} 个节点`);

      const beforePaths = new Set(beforeNames.map((n) => n.path));
      const afterPaths = new Set(afterNames.map((n) => n.path));
      const added = afterNames.filter((n) => !beforePaths.has(n.path));
      const removed = beforeNames.filter((n) => !afterPaths.has(n.path));
      if (added.length) console.warn('新增节点路径:', added.map((n) => n.path));
      if (removed.length) console.warn('丢失节点路径:', removed.map((n) => n.path));
      if (!added.length && !removed.length) console.log('✓ 节点路径完全一致');

      // 对比根节点
      console.log(`根节点 before: ${before.tree.name} [${before.tree.type}]`);
      console.log(`根节点 after:  ${after.tree.name} [${after.tree.type}]`);
      if (before.tree.name !== after.tree.name || before.tree.type !== after.tree.type) {
        console.warn('⚠ 根节点不一致！');
      }

      // 对比深度
      const beforeDepths = beforeNames.map((n) => `${n.path}@${n.depth}`);
      const afterDepths = afterNames.map((n) => `${n.path}@${n.depth}`);
      const depthChanges = afterNames.filter((n) => {
        const match = beforeNames.find((b) => b.path.endsWith(n.path.split('/').pop()));
        return match && match.depth !== n.depth;
      });
      if (depthChanges.length) console.warn('深度变化的节点:', depthChanges);
      console.groupEnd();

      // 对比关节定义
      console.group('关节定义');
      console.log(`before: ${before.jointDefs.length} 个, after: ${after.jointDefs.length} 个`);
      before.jointDefs.forEach((bd) => {
        const ad = after.jointDefs.find((d) => d.name === bd.name);
        if (!ad) {
          console.warn(`⚠ 关节 ${bd.name} 导入后丢失`);
        } else if (bd.type !== ad.type || bd.axis !== ad.axis) {
          console.warn(`⚠ 关节 ${bd.name} 属性变化: type ${bd.type}→${ad.type}, axis ${bd.axis}→${ad.axis}`);
        } else {
          console.log(`✓ ${bd.name}: type=${bd.type} value=${bd.currentValue}→${ad.currentValue}`);
        }
      });
      console.groupEnd();

      // 对比动画片段
      console.group('动画片段');
      before.clips.forEach((bc) => {
        const ac = after.clips.find((c) => c.name === bc.name);
        if (!ac) {
          console.warn(`⚠ 片段 ${bc.name} 导入后丢失`);
        } else {
          console.log(`${bc.name}: 关键帧 ${bc.kfCount}→${ac.kfCount}, 时间点 [${bc.kfTimes}]→[${ac.kfTimes}]`);
          console.log(`  jointNames before: [${bc.jointNames}]`);
          console.log(`  jointNames after:  [${ac.jointNames}]`);
          if (bc.jointNames.join(',') !== ac.jointNames.join(',')) {
            console.warn('  ⚠ 关键帧引用的关节名不一致！');
          }
        }
      });
      console.groupEnd();

      console.groupEnd();
    },
  };

  console.log('✅ Roundtrip 诊断工具已加载。用法:');
  console.log('  1. 导出前: __diagRT.snapshot("before")');
  console.log('  2. 导出 ZIP → 导入 ZIP');
  console.log('  3. 导入后: __diagRT.snapshot("after")');
  console.log('  4. 对比:   __diagRT.diff()');
})();
