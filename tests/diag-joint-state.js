/**
 * 关节状态诊断脚本
 * 用法：先在编辑器里加载 GLB → 插入叉齿父级 → 设旋转关节
 *      然后复制本脚本贴到浏览器控制台运行
 *      把输出整段复制回来给我看
 */
(function diagJointState() {
  const km = window.__mf?.keyframeManager;
  const sm = window.__mf?.sceneManager;
  if (!km || !sm) {
    console.error('❌ window.__mf 未初始化');
    return;
  }

  // 从现有对象的构造器拿 Vector3 / Quaternion（避免 THREE 全局未导出）
  const Vector3 = sm.camera.position.constructor;
  const Quaternion = sm.camera.quaternion.constructor;

  // 手动算 fork 的世界 bbox（不依赖 THREE.Box3）
  function computeWorldBBox(obj) {
    obj.updateMatrixWorld(true);
    const min = new Vector3(Infinity, Infinity, Infinity);
    const max = new Vector3(-Infinity, -Infinity, -Infinity);
    obj.traverse((o) => {
      if (!o.isMesh || !o.geometry) return;
      const geom = o.geometry;
      if (!geom.boundingBox) geom.computeBoundingBox();
      const bb = geom.boundingBox;
      // 8 个角点
      const corners = [
        new Vector3(bb.min.x, bb.min.y, bb.min.z),
        new Vector3(bb.min.x, bb.min.y, bb.max.z),
        new Vector3(bb.min.x, bb.max.y, bb.min.z),
        new Vector3(bb.min.x, bb.max.y, bb.max.z),
        new Vector3(bb.max.x, bb.min.y, bb.min.z),
        new Vector3(bb.max.x, bb.min.y, bb.max.z),
        new Vector3(bb.max.x, bb.max.y, bb.min.z),
        new Vector3(bb.max.x, bb.max.y, bb.max.z),
      ];
      corners.forEach((c) => {
        c.applyMatrix4(o.matrixWorld);
        min.x = Math.min(min.x, c.x); min.y = Math.min(min.y, c.y); min.z = Math.min(min.z, c.z);
        max.x = Math.max(max.x, c.x); max.y = Math.max(max.y, c.y); max.z = Math.max(max.z, c.z);
      });
    });
    return { min, max, isEmpty: () => min.x === Infinity };
  }

  // 工具：把数字保留 4 位有效数字
  const f = (n) => (typeof n === 'number' ? n.toFixed(4) : String(n));
  const v3 = (v) => `(${f(v.x)}, ${f(v.y)}, ${f(v.z)})`;
  const q = (q) => `(${f(q.x)}, ${f(q.y)}, ${f(q.z)}, w=${f(q.w)})`;
  const m4 = (m) => {
    const e = m.elements;
    return [
      `[${f(e[0])}, ${f(e[4])}, ${f(e[8])}, ${f(e[12])}]`,
      `[${f(e[1])}, ${f(e[5])}, ${f(e[9])}, ${f(e[13])}]`,
      `[${f(e[2])}, ${f(e[6])}, ${f(e[10])}, ${f(e[14])}]`,
      `[${f(e[3])}, ${f(e[7])}, ${f(e[11])}, ${f(e[15])}]`,
    ].join('\n  ');
  };

  // 找叉齿对象（按名字模糊匹配）
  let fork = null;
  sm.sceneRoot?.traverse((obj) => {
    if (obj.name && (obj.name === '叉齿004' || obj.name.includes('叉齿004') && !obj.name.includes('joint_group'))) {
      if (!fork) fork = obj;
    }
  });
  if (!fork) {
    console.error('❌ 找不到叉齿004，请确认对象名');
    console.log('场景中所有对象名:');
    sm.sceneRoot?.traverse((obj) => {
      if (obj.name) console.log('  -', obj.name);
    });
    return;
  }

  console.log('\n══════════════════════════════════════════');
  console.log('  关节状态诊断报告');
  console.log('══════════════════════════════════════════\n');

  // ── 1. 父链 ──
  console.group('① 父链结构（自下而上）');
  let cur = fork;
  let depth = 0;
  while (cur) {
    const indent = '  '.repeat(depth);
    console.log(`${indent}↑ ${cur.name || '(unnamed)'} [${cur.type}] uuid=${cur.uuid.slice(0, 8)}`);
    cur = cur.parent;
    depth++;
    if (depth > 20) break;
  }
  console.groupEnd();

  // ── 2. fork 自己的 local transform ──
  console.group('② fork 自身 local transform');
  console.log('position:', v3(fork.position));
  console.log('quaternion:', q(fork.quaternion));
  console.log('scale:', v3(fork.scale));
  fork.updateMatrix();
  console.log('matrix:\n  ' + m4(fork.matrix));
  console.groupEnd();

  // ── 3. fork 的世界 transform ──
  console.group('③ fork 世界 transform');
  fork.updateMatrixWorld(true);
  const worldPos = new Vector3();
  const worldQuat = new Quaternion();
  const worldScale = new Vector3();
  fork.matrixWorld.decompose(worldPos, worldQuat, worldScale);
  console.log('worldPosition:', v3(worldPos));
  console.log('worldQuaternion:', q(worldQuat));
  console.log('worldScale:', v3(worldScale));
  console.log('matrixWorld:\n  ' + m4(fork.matrixWorld));
  console.groupEnd();

  // ── 4. parent 的 transform ──
  const parent = fork.parent;
  if (parent) {
    console.group('④ parent (' + (parent.name || 'unnamed') + ') transform');
    console.log('local position:', v3(parent.position));
    console.log('local quaternion:', q(parent.quaternion));
    console.log('local scale:', v3(parent.scale));
    parent.updateMatrixWorld(true);
    const pwPos = new Vector3();
    const pwQuat = new Quaternion();
    const pwScale = new Vector3();
    parent.matrixWorld.decompose(pwPos, pwQuat, pwScale);
    console.log('worldPosition:', v3(pwPos));
    console.log('worldQuaternion:', q(pwQuat));
    console.log('worldScale:', v3(pwScale));
    console.log('matrixWorld:\n  ' + m4(parent.matrixWorld));
    console.groupEnd();
  } else {
    console.log('④ parent: 无');
  }

  // ── 5. fork 的世界 bbox ──
  console.group('⑤ fork 世界 bbox（用于「子对象底部/中心」按钮）');
  const box = computeWorldBBox(fork);
  if (box.isEmpty()) {
    console.log('bbox 为空（fork 没有可渲染几何）');
  } else {
    console.log('worldMin:', v3(box.min));
    console.log('worldMax:', v3(box.max));
    const center = new Vector3(
      (box.min.x + box.max.x) / 2,
      (box.min.y + box.max.y) / 2,
      (box.min.z + box.max.z) / 2,
    );
    console.log('worldCenter:', v3(center));
    const worldBottom = new Vector3(center.x, box.min.y, center.z);
    console.log('worldBottom (center.x, min.y, center.z):', v3(worldBottom));

    if (parent) {
      // 模拟「子对象底部」按钮：parent.worldToLocal(worldBottom)
      const localBottom = parent.worldToLocal(worldBottom.clone());
      console.log('parent.worldToLocal(worldBottom):', v3(localBottom));
      // UI 约定（Z-up）转换：worldToUiVector3 是交换 y/z
      const uiBottom = { x: localBottom.x, y: localBottom.z, z: localBottom.y };
      console.log('UI Z-up (交换 y/z) → 显示在面板的值:', `(${f(uiBottom.x)}, ${f(uiBottom.y)}, ${f(uiBottom.z)})`);

      // 模拟「子对象中心」按钮
      const localCenter = parent.worldToLocal(center.clone());
      console.log('parent.worldToLocal(center):', v3(localCenter));
      const uiCenter = { x: localCenter.x, y: localCenter.z, z: localCenter.y };
      console.log('UI 面板显示的中心值:', `(${f(uiCenter.x)}, ${f(uiCenter.y)}, ${f(uiCenter.z)})`);
    }
  }
  console.groupEnd();

  // ── 6. 关节定义 ──
  const def = km.jointDefinitions.get(fork.uuid);
  if (def) {
    console.group('⑥ jointDefinition for fork');
    console.log('id:', def.id.slice(0, 8));
    console.log('name:', def.name);
    console.log('type:', def.type);
    console.log('axis:', def.axis);
    console.log('limits:', def.limits);
    console.log('currentValue:', f(def.currentValue));
    console.log('origin (UI Z-up parent-local):', def.origin);
    console.log('baseTransform:', def.baseTransform);

    // 把 origin 反推回世界坐标
    if (def.origin && parent) {
      const originLocal = new Vector3(
        def.origin.x ?? 0,
        def.origin.z ?? 0,  // UI Z → Three.js Y
        def.origin.y ?? 0,  // UI Y → Three.js Z
      );
      console.log('  ↪ originLocal (Three.js Y-up parent-local):', v3(originLocal));
      const originWorld = originLocal.clone().applyMatrix4(parent.matrixWorld);
      console.log('  ↪ originWorld (世界坐标):', v3(originWorld));
    }
    console.groupEnd();
  } else {
    console.log('⑥ jointDefinition: 无（叉齿没设关节）');
  }

  // ── 7. 全部 jointDefinitions ──
  console.group('⑦ 所有关节定义');
  km.jointDefinitions.forEach((d) => {
    const obj = (() => {
      let found = null;
      sm.sceneRoot?.traverse((o) => { if (o.uuid === d.id) found = o; });
      return found;
    })();
    console.log(`- ${d.name || d.id.slice(0, 8)} | type=${d.type} axis=${d.axis} value=${f(d.currentValue)} | obj=${obj?.name || '?'}`);
    console.log(`    origin=${JSON.stringify(d.origin)}`);
    console.log(`    baseTransform=${d.baseTransform ? JSON.stringify(d.baseTransform).slice(0, 100) : 'null'}`);
  });
  console.groupEnd();

  console.log('\n══════════════════════════════════════════');
  console.log('  诊断结束。请复制以上全部输出回传');
  console.log('══════════════════════════════════════════\n');
})();
