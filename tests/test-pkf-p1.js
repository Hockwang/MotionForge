/**
 * PKF P1 自动化验证脚本
 * 使用方法：浏览器控制台粘贴执行，或 import 后调用 runPkfP1Tests()
 * 不需要导入模型，打开页面即可运行
 */
(function runPkfP1Tests() {
  const km = window.__mf?.keyframeManager;
  if (!km) {
    console.error('❌ window.__mf.keyframeManager 不存在，请确认页面已加载');
    return;
  }

  let passed = 0;
  let failed = 0;
  const errors = [];

  function assert(condition, name) {
    if (condition) {
      passed++;
      console.log(`  ✅ ${name}`);
    } else {
      failed++;
      errors.push(name);
      console.error(`  ❌ ${name}`);
    }
  }

  function eq(a, b, name) {
    assert(a === b, `${name}  (got: ${JSON.stringify(a)}, expected: ${JSON.stringify(b)})`);
  }

  // ── 保存原始状态，测试结束后恢复 ──
  const originalSnapshot = km.serializeState();

  // 清空 PKF 数据，确保干净起点
  km.pkfParameters.clear();
  km.pkfSteps = [];

  try {
    // ════════════════════════════════════════
    console.group('一、PKF 参数 CRUD');
    // ════════════════════════════════════════

    eq(km.getAllPkfParameters().length, 0, '1.1 初始参数为空');

    const p1 = km.addPkfParameter({ id: 'stroke', type: 'number', unit: 'mm', desc: '行程', default: 100 });
    assert(p1 !== null && p1.id === 'stroke', '1.2 添加 stroke 参数');
    eq(p1.type, 'number', '1.2a type 正确');
    eq(p1.unit, 'mm', '1.2b unit 正确');
    eq(p1.default, 100, '1.2c default 正确');

    const p2 = km.addPkfParameter({ id: 'angle', type: 'number', unit: 'deg', desc: '旋转角度', default: 90 });
    assert(p2 !== null && p2.id === 'angle', '1.3 添加 angle 参数');

    eq(km.getAllPkfParameters().length, 2, '1.4 参数数量为 2');

    eq(km.addPkfParameter({ id: 'stroke', type: 'vec3' }), null, '1.5 重复 id 被拒绝');

    eq(km.addPkfParameter({ type: 'number' }), null, '1.6 空 id 被拒绝');
    eq(km.addPkfParameter(null), null, '1.6a null 被拒绝');
    eq(km.addPkfParameter({}), null, '1.6b 空对象被拒绝');

    eq(km.updatePkfParameter('stroke', { default: 200, desc: '行程距离' }), true, '1.7 修改普通字段');
    const updated = km.getAllPkfParameters().find(p => p.id === 'stroke');
    eq(updated.default, 200, '1.7a default 已更新');
    eq(updated.desc, '行程距离', '1.7b desc 已更新');
    eq(updated.unit, 'mm', '1.7c unit 未被改动');

    eq(km.updatePkfParameter('no_such', { default: 1 }), false, '1.8 修改不存在的参数返回 false');

    eq(km.removePkfParameter('angle'), true, '1.9 删除 angle');
    eq(km.getAllPkfParameters().length, 1, '1.9a 剩余 1 个参数');

    eq(km.removePkfParameter('angle'), false, '1.10 重复删除返回 false');

    console.groupEnd();

    // ════════════════════════════════════════
    console.group('二、PKF 步骤 CRUD');
    // ════════════════════════════════════════

    eq(km.getAllPkfSteps().length, 0, '2.1 初始步骤为空');

    const s1 = km.addPkfStep({
      id: 'step1', joint: 'arm', joint_def_id: 'jd-001',
      channel: 'rotate', axis: 'z',
      t_start: 0, t_end: 1,
      value_start: '0', value_end: 'stroke * 0.5',
      easing: 'linear',
    });
    eq(s1.id, 'step1', '2.2 添加 step1');
    eq(s1.joint, 'arm', '2.2a joint 正确');
    eq(s1.value_end, 'stroke * 0.5', '2.2b value_end 是字符串公式');

    const s2 = km.addPkfStep({ joint: 'base', channel: 'translate', value_end: 'stroke' });
    assert(s2.id && s2.id !== 'step1', '2.3 自动生成 id');
    eq(s2.axis, 'z', '2.3a 默认 axis=z');
    eq(s2.t_start, 0, '2.3b 默认 t_start=0');
    eq(s2.t_end, 1, '2.3c 默认 t_end=1');
    eq(s2.easing, 'linear', '2.3d 默认 easing=linear');
    eq(s2.value_start, '0', '2.3e 默认 value_start="0"');

    eq(km.getAllPkfSteps().length, 2, '2.3f 步骤数量为 2');

    eq(km.updatePkfStep('step1', { value_end: 'stroke * 0.8', easing: 'ease-in-out' }), true, '2.4 修改步骤');
    const s1u = km.getAllPkfSteps().find(s => s.id === 'step1');
    eq(s1u.value_end, 'stroke * 0.8', '2.4a value_end 已更新');
    eq(s1u.easing, 'ease-in-out', '2.4b easing 已更新');
    eq(s1u.joint, 'arm', '2.4c joint 未被改动');

    eq(km.updatePkfStep('no_such', { axis: 'x' }), false, '2.5 修改不存在步骤返回 false');

    eq(km.removePkfStep('step1'), true, '2.6 删除 step1');
    eq(km.getAllPkfSteps().length, 1, '2.6a 剩余 1 个步骤');

    eq(km.removePkfStep('step1'), false, '2.7 重复删除返回 false');

    console.groupEnd();

    // ════════════════════════════════════════
    console.group('三、参数改名 → 步骤公式自动更新');
    // ════════════════════════════════════════

    km.addPkfStep({ id: 'rename-test', value_start: 'stroke', value_end: 'stroke * 2 + stroke' });

    eq(km.updatePkfParameter('stroke', { id: 'travel' }), true, '3.1 stroke 改名为 travel');
    eq(km.getAllPkfParameters()[0].id, 'travel', '3.2 参数 id 已变为 travel');

    const rt = km.getAllPkfSteps().find(s => s.id === 'rename-test');
    eq(rt.value_start, 'travel', '3.3 value_start 中 stroke→travel');
    eq(rt.value_end, 'travel * 2 + travel', '3.4 value_end 中所有 stroke→travel');

    km.addPkfParameter({ id: 'speed', default: 50 });
    eq(km.updatePkfParameter('travel', { id: 'speed' }), false, '3.5 改名到已存在 id 被拒绝');
    assert(km.getAllPkfParameters().some(p => p.id === 'travel'), '3.5a travel 仍存在');
    assert(km.getAllPkfParameters().some(p => p.id === 'speed'), '3.5b speed 仍存在');

    console.groupEnd();

    // ════════════════════════════════════════
    console.group('四、序列化 / 反序列化');
    // ════════════════════════════════════════

    const snapshot = km.serializeState();

    assert(Array.isArray(snapshot.pkfParameters), '4.1 快照含 pkfParameters');
    assert(Array.isArray(snapshot.pkfSteps), '4.2 快照含 pkfSteps');
    eq(snapshot.pkfParameters.length, 2, '4.3 快照参数数量 2');
    assert(snapshot.pkfSteps.length >= 2, '4.4 快照步骤数量 >= 2');

    // 破坏当前数据
    km.pkfParameters.clear();
    km.pkfSteps = [];
    eq(km.getAllPkfParameters().length, 0, '4.5 清空后参数为 0');
    eq(km.getAllPkfSteps().length, 0, '4.6 清空后步骤为 0');

    // 恢复
    km.restoreState(snapshot);
    eq(km.getAllPkfParameters().length, 2, '4.7 恢复后参数数量 2');
    assert(km.getAllPkfSteps().length >= 2, '4.8 恢复后步骤数量 >= 2');

    const restoredTravel = km.getAllPkfParameters().find(p => p.id === 'travel');
    assert(restoredTravel !== undefined, '4.9 恢复后 travel 参数存在');

    const restoredRt = km.getAllPkfSteps().find(s => s.id === 'rename-test');
    eq(restoredRt?.value_end, 'travel * 2 + travel', '4.10 恢复后公式正确');

    // 深拷贝隔离
    km.updatePkfParameter('speed', { default: 999 });
    const snapshotSpeed = snapshot.pkfParameters.find(p => p.id === 'speed');
    eq(snapshotSpeed.default, 50, '4.11 深拷贝隔离：快照未被修改');

    console.groupEnd();

    // ════════════════════════════════════════
    console.group('五、reset 清空');
    // ════════════════════════════════════════

    km.reset();
    eq(km.getAllPkfParameters().length, 0, '5.1 reset 后参数为空');
    eq(km.getAllPkfSteps().length, 0, '5.2 reset 后步骤为空');

    console.groupEnd();

  } finally {
    // ── 恢复原始状态，不污染编辑器 ──
    km.restoreState(originalSnapshot);
  }

  // ════════════════════════════════════════
  console.log('\n══════════════════════════════');
  if (failed === 0) {
    console.log(`%c全部通过 ✅  ${passed}/${passed} 项`, 'color:#22c55e;font-size:14px;font-weight:bold');
  } else {
    console.log(`%c${failed} 项失败 ❌  (${passed} 通过)`, 'color:#ef4444;font-size:14px;font-weight:bold');
    console.log('失败项：');
    errors.forEach(e => console.error(`  - ${e}`));
  }
  console.log('══════════════════════════════\n');
})();
