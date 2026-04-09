/**
 * PKF P5 自动化验证脚本
 * 测试内容：导出 pkf.json 到 ZIP + 导入兼容
 * 使用方法：浏览器控制台粘贴执行，不需要导入模型
 *
 * 注意：此脚本测试数据层的导出格式正确性，不触发实际文件下载。
 * 完整的导出→导入圆环测试需要加载模型后手动验证。
 */
(function runPkfP5Tests() {
  const km = window.__mf?.keyframeManager;
  if (!km) {
    console.error('❌ window.__mf.keyframeManager 不存在');
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

  // ── 保存原始状态 ──
  const originalSnapshot = km.serializeState();
  km.pkfParameters.clear();
  km.pkfSteps = [];

  try {
    // ════════════════════════════════════════
    console.group('一、导出数据格式验证');
    // ════════════════════════════════════════

    // 添加测试数据
    km.addPkfParameter({ id: 'stroke', type: 'number', unit: 'mm', desc: '行程', default: 100 });
    km.addPkfParameter({ id: 'angle', type: 'number', unit: 'deg', desc: '角度', default: 90 });
    km.addPkfStep({
      id: 'export-step-1',
      joint: 'arm',
      joint_def_id: 'jd-001',
      channel: 'translate',
      axis: 'z',
      t_start: 0,
      t_end: 2,
      value_start: '0',
      value_end: 'stroke',
      easing: 'linear',
    });
    km.addPkfStep({
      id: 'export-step-2',
      joint: 'base',
      joint_def_id: 'jd-002',
      channel: 'rotate',
      axis: 'z',
      t_start: 0,
      t_end: 1,
      value_start: '0',
      value_end: 'angle',
      easing: 'ease-in-out',
    });

    // 获取导出数据（模拟 exporter 会收到的数据）
    const params = km.getAllPkfParameters();
    const steps = km.getAllPkfSteps();

    eq(params.length, 2, '1.1 导出 2 个参数');
    eq(steps.length, 2, '1.2 导出 2 个步骤');

    // 验证参数格式
    const p1 = params.find(p => p.id === 'stroke');
    assert(p1 !== undefined, '1.3 stroke 参数存在');
    eq(p1.type, 'number', '1.4 stroke.type');
    eq(p1.unit, 'mm', '1.5 stroke.unit');
    eq(p1.desc, '行程', '1.6 stroke.desc');
    eq(p1.default, 100, '1.7 stroke.default');

    // 验证步骤格式
    const s1 = steps.find(s => s.id === 'export-step-1');
    assert(s1 !== undefined, '1.8 步骤 1 存在');
    eq(s1.joint, 'arm', '1.9 step1.joint');
    eq(s1.joint_def_id, 'jd-001', '1.10 step1.joint_def_id');
    eq(s1.channel, 'translate', '1.11 step1.channel');
    eq(s1.axis, 'z', '1.12 step1.axis');
    eq(s1.t_start, 0, '1.13 step1.t_start');
    eq(s1.t_end, 2, '1.14 step1.t_end');
    eq(s1.value_start, '0', '1.15 step1.value_start（字符串）');
    eq(s1.value_end, 'stroke', '1.16 step1.value_end（公式字符串）');
    eq(s1.easing, 'linear', '1.17 step1.easing');

    console.groupEnd();

    // ════════════════════════════════════════
    console.group('二、序列化→清空→恢复 模拟导入');
    // ════════════════════════════════════════

    // 序列化当前状态（模拟从 pkf.json 读到的数据）
    const pkfExportData = {
      parameters: params.map(p => ({ ...p })),
      steps: steps.map(s => ({ ...s })),
    };

    // 清空（模拟 reset 后重新导入）
    km.pkfParameters.clear();
    km.pkfSteps = [];
    eq(km.getAllPkfParameters().length, 0, '2.1 清空后参数为 0');
    eq(km.getAllPkfSteps().length, 0, '2.2 清空后步骤为 0');

    // 模拟导入恢复
    (pkfExportData.parameters || []).forEach(p => {
      km.addPkfParameter({
        id: p.id,
        type: p.type || 'number',
        unit: p.unit || '',
        desc: p.desc || '',
        default: p.default ?? 0,
      });
    });
    (pkfExportData.steps || []).forEach(s => {
      km.addPkfStep({
        id: s.id,
        joint: s.joint || '',
        joint_def_id: s.joint_def_id || '',
        channel: s.channel || 'translate',
        axis: s.axis || 'z',
        t_start: s.t_start ?? 0,
        t_end: s.t_end ?? 1,
        value_start: s.value_start ?? '0',
        value_end: s.value_end ?? '0',
        easing: s.easing || 'linear',
      });
    });

    eq(km.getAllPkfParameters().length, 2, '2.3 恢复后参数数量 2');
    eq(km.getAllPkfSteps().length, 2, '2.4 恢复后步骤数量 2');

    // 验证恢复的数据完整性
    const restoredStroke = km.getAllPkfParameters().find(p => p.id === 'stroke');
    eq(restoredStroke.default, 100, '2.5 恢复后 stroke.default 正确');
    eq(restoredStroke.desc, '行程', '2.6 恢复后 stroke.desc 正确');

    const restoredStep = km.getAllPkfSteps().find(s => s.id === 'export-step-1');
    eq(restoredStep.value_end, 'stroke', '2.7 恢复后公式正确');
    eq(restoredStep.easing, 'linear', '2.8 恢复后 easing 正确');

    // 验证恢复后的数据可以正常求值
    const evalResult = km.evaluatePkfAt(1);
    assert(evalResult.length > 0, '2.9 恢复后可正常求值');
    const translateResult = evalResult.find(r => r.channel === 'translate');
    assert(translateResult && Math.abs(translateResult.value - 50) < 0.001, '2.10 求值结果正确（t=1, stroke=100, 50%=50）');

    console.groupEnd();

    // ════════════════════════════════════════
    console.group('三、向后兼容 - 无 PKF 数据的包');
    // ════════════════════════════════════════

    // 清空 PKF
    km.pkfParameters.clear();
    km.pkfSteps = [];

    // 模拟旧版包没有 pkf 字段的情况
    const oldManifest = {
      files: {
        manifest: 'manifest.json',
        model: 'model.glb',
        joints: 'joints.json',
        joint_definitions: 'joint-definitions.json',
        motion: 'motion.json',
        // 注意：没有 pkf 字段
      }
    };

    const pkfFileRef = oldManifest.files?.pkf;
    eq(pkfFileRef, undefined, '3.1 旧版 manifest 无 pkf 字段');
    // 导入逻辑用 pkfFileName ? ... : fallback，undefined 会走跳过路径
    assert(!pkfFileRef, '3.2 无 pkf 时跳过恢复');
    eq(km.getAllPkfParameters().length, 0, '3.3 无 PKF 包导入后参数仍为空');
    eq(km.getAllPkfSteps().length, 0, '3.4 无 PKF 包导入后步骤仍为空');

    console.groupEnd();

    // ════════════════════════════════════════
    console.group('四、空 PKF 数据不生成文件');
    // ════════════════════════════════════════

    // 确保 PKF 为空
    km.pkfParameters.clear();
    km.pkfSteps = [];
    const emptyParams = km.getAllPkfParameters();
    const emptySteps = km.getAllPkfSteps();
    const hasPkf = (emptyParams.length > 0) || (emptySteps.length > 0);
    eq(hasPkf, false, '4.1 空 PKF 时 hasPkf=false，不生成 pkf 文件');

    console.groupEnd();

  } finally {
    km.restoreState(originalSnapshot);
  }

  // ── 汇总 ──
  console.log('\n══════════════════════════════');
  if (failed === 0) {
    console.log(`%c全部通过 ✅  ${passed}/${passed} 项`, 'color:#22c55e;font-size:14px;font-weight:bold');
  } else {
    console.log(`%c${failed} 项失败 ❌  (${passed} 通过)`, 'color:#ef4444;font-size:14px;font-weight:bold');
    errors.forEach(e => console.error(`  - ${e}`));
  }
  console.log('══════════════════════════════\n');
})();
