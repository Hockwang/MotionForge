/**
 * 关节完整性诊断脚本
 * ──────────────────────────────────────────────────────────
 * 检查导入后关节定义的 parentId / childId 是否能在场景树中找到对应对象，
 * 以及 insertedGroup（关节父级包装 Group）是否在 GLB roundtrip 中丢失。
 *
 * 用法：
 *   1. 导入 ZIP 后，F12 打开 Console
 *   2. 粘贴本脚本，回车
 *   3. 输入 __diagJ.check()
 *   4. 查看输出
 */
(function () {
  'use strict';

  const mf = window.__mf;
  if (!mf || !mf.sceneManager || !mf.keyframeManager) {
    console.error('❌ window.__mf 未初始化');
    return;
  }

  const THREE = mf.THREE;
  const sm = mf.sceneManager;
  const km = mf.keyframeManager;

  /** 打印场景树结构（带深度） */
  function printTree(obj, depth = 0, maxDepth = 6) {
    if (depth > maxDepth) return;
    if (obj.isLight || obj.isCamera) return;
    if (obj.type && obj.type.includes('Helper')) return;

    const indent = '  '.repeat(depth);
    const tag = obj.type === 'Mesh' ? '◆' : obj.type === 'Group' ? '📁' : '○';
    const nameStr = obj.name || `(${obj.type})`;
    const childCount = (obj.children || []).filter(
      (c) => !c.isLight && !c.isCamera && !(c.type || '').includes('Helper'),
    ).length;
    console.log(`${indent}${tag} ${nameStr}  [${obj.type}]  uuid=${obj.uuid.slice(0, 8)}  children=${childCount}`);

    (obj.children || []).forEach((c) => printTree(c, depth + 1, maxDepth));
  }

  window.__diagJ = {
    check() {
      const root = sm.sceneRoot;
      if (!root) { console.error('sceneRoot 为空'); return; }

      const defs = km.getAllJointDefs();

      // 建 nodeMap
      const nodeMap = new Map();
      root.traverse((obj) => nodeMap.set(obj.uuid, obj));

      console.group('═══ 关节完整性检查 ═══');

      // ── 1. 场景树结构 ──
      console.group('① 场景树结构');
      printTree(root);
      console.groupEnd();

      // ── 2. editableObjects ──
      const editables = mf.editableObjects();
      console.group('② editableObjects');
      console.log(`共 ${editables.length} 个可编辑对象：`);
      editables.forEach((obj) => {
        console.log(`  ${obj.name || '(unnamed)'} [${obj.type}] uuid=${obj.uuid.slice(0, 8)} parent=${obj.parent?.name || obj.parent?.type || '(无)'}`);
      });
      console.groupEnd();

      // ── 3. 关节定义完整性 ──
      console.group('③ 关节定义完整性');
      console.log(`共 ${defs.length} 个关节定义`);

      defs.forEach((def) => {
        const childObj = nodeMap.get(def.childId);
        const parentObj = def.parentId ? nodeMap.get(def.parentId) : null;

        const childFound = !!childObj;
        const parentFound = def.parentId ? !!parentObj : true; // 无 parentId 算 OK

        const childName = childObj?.name || childObj?.type || '???';
        const parentName = parentObj?.name || parentObj?.type || '???';
        const sceneParentName = childObj?.parent?.name || childObj?.parent?.type || '???';
        const sceneParentUUID = childObj?.parent?.uuid?.slice(0, 8) || '???';

        const status = childFound && parentFound ? '✓' : '❌';
        console.log(
          `${status} ${def.name}:`,
          `\n    childId=${def.childId?.slice(0, 8)} → ${childFound ? childName : '❌ 未找到'}`,
          `\n    parentId=${def.parentId?.slice(0, 8) || '(无)'} → ${def.parentId ? (parentFound ? parentName : '❌ 未找到') : '(无父级)'}`,
          `\n    sceneParent=${sceneParentName} uuid=${sceneParentUUID}`,
          `\n    parentId === sceneParent? ${def.parentId === childObj?.parent?.uuid}`,
          `\n    type=${def.type} axis=${def.axis} value=${def.currentValue}`,
          `\n    baseTransform=${def.baseTransform ? 'YES' : 'null (待懒捕获)'}`,
        );

        if (!childFound) {
          console.warn(`    ⚠ childId ${def.childId?.slice(0, 8)} 在场景树中不存在！关节无法工作。`);
        }
        if (def.parentId && !parentFound) {
          console.warn(`    ⚠ parentId ${def.parentId?.slice(0, 8)} 在场景树中不存在！关节父级丢失。`);
          // 尝试通过 child 的 sceneParent 找到可能的替代
          if (childObj?.parent) {
            console.log(`    💡 建议：可以用 child 的 sceneParent (${sceneParentName} uuid=${sceneParentUUID}) 作为替代`);
          }
        }
      });
      console.groupEnd();

      // ── 4. 关节链分析 ──
      console.group('④ 关节链分析');
      defs.forEach((def) => {
        // 检查此关节的 parentId 是否是另一个关节的 childId
        const parentJoint = defs.find((d) => d.childId === def.parentId);
        if (parentJoint) {
          console.log(`  ${def.name} ← 依赖 → ${parentJoint.name} (链式关节)`);
        }
      });
      // 检查独立关节
      const independent = defs.filter((d) => !defs.some((other) => other.childId === d.parentId));
      console.log(`独立关节（无上游）: ${independent.map((d) => d.name).join(', ')}`);
      console.groupEnd();

      // ── 5. 名字匹配检查 ──
      console.group('⑤ 按名字查找替代');
      defs.forEach((def) => {
        const childObj = nodeMap.get(def.childId);
        if (childObj) return; // 已找到，跳过

        // 按名字找
        let byName = null;
        root.traverse((obj) => {
          if (obj.name === def.name) byName = obj;
        });
        if (byName) {
          console.log(`  ${def.name}: childId 失效，但按名字找到 uuid=${byName.uuid.slice(0, 8)}`);
        } else {
          console.warn(`  ${def.name}: childId 失效，按名字也找不到！`);
        }
      });
      console.groupEnd();

      // ── 总结 ──
      const brokenChild = defs.filter((d) => !nodeMap.get(d.childId));
      const brokenParent = defs.filter((d) => d.parentId && !nodeMap.get(d.parentId));
      console.group('🏁 总结');
      console.log(`关节总数: ${defs.length}`);
      console.log(`childId 失效: ${brokenChild.length} 个 ${brokenChild.length ? '→ ' + brokenChild.map((d) => d.name).join(', ') : ''}`);
      console.log(`parentId 失效: ${brokenParent.length} 个 ${brokenParent.length ? '→ ' + brokenParent.map((d) => d.name).join(', ') : ''}`);
      if (brokenChild.length === 0 && brokenParent.length === 0) {
        console.log('✅ 所有关节引用完整');
      } else {
        console.warn('❌ 有关节引用断裂，需要修复 UUID 映射');
      }
      console.groupEnd();

      console.groupEnd();
    },
  };

  console.log('✅ 关节完整性诊断工具已加载');
  console.log('用法: __diagJ.check()');
})();
