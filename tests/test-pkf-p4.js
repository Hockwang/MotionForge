/**
 * PKF P4 自动化验证脚本
 * 测试内容：公式安全求值 + PKF 预览 + 缓动函数
 * 使用方法：浏览器控制台粘贴执行，不需要导入模型
 */
(function runPkfP4Tests() {
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

  function near(a, b, epsilon, name) {
    assert(Math.abs(a - b) < epsilon, `${name}  (got: ${a}, expected: ~${b}, epsilon: ${epsilon})`);
  }

  // ── 保存原始状态 ──
  const originalSnapshot = km.serializeState();
  km.pkfParameters.clear();
  km.pkfSteps = [];

  try {
    // ════════════════════════════════════════
    console.group('一、公式安全求值 - 基础运算');
    // ════════════════════════════════════════

    let r;

    r = km.evaluatePkfFormula('0', {});
    eq(r.value, 0, '1.1 常量 0');
    eq(r.error, null, '1.1a 无错误');

    r = km.evaluatePkfFormula('42', {});
    eq(r.value, 42, '1.2 常量 42');

    r = km.evaluatePkfFormula('3 + 7', {});
    eq(r.value, 10, '1.3 加法 3+7=10');

    r = km.evaluatePkfFormula('10 * 2.5', {});
    eq(r.value, 25, '1.4 乘法 10*2.5=25');

    r = km.evaluatePkfFormula('100 / 4 - 5', {});
    eq(r.value, 20, '1.5 除法减法 100/4-5=20');

    r = km.evaluatePkfFormula('(2 + 3) * 4', {});
    eq(r.value, 20, '1.6 括号 (2+3)*4=20');

    r = km.evaluatePkfFormula('-10', {});
    eq(r.value, -10, '1.7 负数 -10');

    console.groupEnd();

    // ════════════════════════════════════════
    console.group('二、公式安全求值 - 参数引用');
    // ════════════════════════════════════════

    r = km.evaluatePkfFormula('stroke', { stroke: 100 });
    eq(r.value, 100, '2.1 单参数引用');

    r = km.evaluatePkfFormula('stroke * 0.5', { stroke: 200 });
    eq(r.value, 100, '2.2 参数乘法');

    r = km.evaluatePkfFormula('stroke + angle', { stroke: 100, angle: 45 });
    eq(r.value, 145, '2.3 多参数相加');

    r = km.evaluatePkfFormula('stroke * 2 + angle / 3', { stroke: 10, angle: 30 });
    eq(r.value, 30, '2.4 复合表达式');

    console.groupEnd();

    // ════════════════════════════════════════
    console.group('三、公式安全求值 - Math 函数');
    // ════════════════════════════════════════

    r = km.evaluatePkfFormula('abs(-5)', {});
    eq(r.value, 5, '3.1 abs(-5)=5');

    r = km.evaluatePkfFormula('round(3.7)', {});
    eq(r.value, 4, '3.2 round(3.7)=4');

    r = km.evaluatePkfFormula('max(10, 20)', {});
    eq(r.value, 20, '3.3 max(10,20)=20');

    r = km.evaluatePkfFormula('min(stroke, 50)', { stroke: 30 });
    eq(r.value, 30, '3.4 min(stroke,50)=30');

    r = km.evaluatePkfFormula('sqrt(16)', {});
    eq(r.value, 4, '3.5 sqrt(16)=4');

    r = km.evaluatePkfFormula('PI', {});
    near(r.value, Math.PI, 0.0001, '3.6 PI 常量');

    console.groupEnd();

    // ════════════════════════════════════════
    console.group('四、公式安全求值 - 安全拒绝');
    // ════════════════════════════════════════

    r = km.evaluatePkfFormula('alert(1)', {});
    assert(r.error !== null, '4.1 拒绝 alert()');

    r = km.evaluatePkfFormula('window.location', {});
    assert(r.error !== null, '4.2 拒绝 window');

    r = km.evaluatePkfFormula('eval("1")', {});
    assert(r.error !== null, '4.3 拒绝 eval');

    r = km.evaluatePkfFormula('x = 1', {});
    assert(r.error !== null, '4.4 拒绝赋值 =');

    r = km.evaluatePkfFormula('console.log(1)', {});
    assert(r.error !== null, '4.5 拒绝 console');

    r = km.evaluatePkfFormula('require("fs")', {});
    assert(r.error !== null, '4.6 拒绝 require');

    r = km.evaluatePkfFormula('', {});
    eq(r.value, 0, '4.7 空公式返回 0');
    eq(r.error, null, '4.7a 空公式无错误');

    console.groupEnd();

    // ════════════════════════════════════════
    console.group('五、缓动函数');
    // ════════════════════════════════════════

    near(km._applyEasing(0, 'linear'), 0, 0.001, '5.1 linear(0)=0');
    near(km._applyEasing(0.5, 'linear'), 0.5, 0.001, '5.2 linear(0.5)=0.5');
    near(km._applyEasing(1, 'linear'), 1, 0.001, '5.3 linear(1)=1');

    near(km._applyEasing(0, 'ease-in'), 0, 0.001, '5.4 ease-in(0)=0');
    near(km._applyEasing(0.5, 'ease-in'), 0.25, 0.001, '5.5 ease-in(0.5)=0.25');
    near(km._applyEasing(1, 'ease-in'), 1, 0.001, '5.6 ease-in(1)=1');

    near(km._applyEasing(0, 'ease-out'), 0, 0.001, '5.7 ease-out(0)=0');
    near(km._applyEasing(0.5, 'ease-out'), 0.75, 0.001, '5.8 ease-out(0.5)=0.75');
    near(km._applyEasing(1, 'ease-out'), 1, 0.001, '5.9 ease-out(1)=1');

    near(km._applyEasing(0, 'ease-in-out'), 0, 0.001, '5.10 ease-in-out(0)=0');
    near(km._applyEasing(0.5, 'ease-in-out'), 0.5, 0.001, '5.11 ease-in-out(0.5)=0.5');
    near(km._applyEasing(1, 'ease-in-out'), 1, 0.001, '5.12 ease-in-out(1)=1');

    console.groupEnd();

    // ════════════════════════════════════════
    console.group('六、evaluatePkfAt 完整预览');
    // ════════════════════════════════════════

    // 准备参数和步骤
    km.addPkfParameter({ id: 'stroke', type: 'number', default: 100 });
    km.addPkfStep({
      id: 'preview-test-1',
      joint: 'arm',
      joint_def_id: 'jd-test',
      channel: 'translate',
      axis: 'z',
      t_start: 0,
      t_end: 2,
      value_start: '0',
      value_end: 'stroke',
      easing: 'linear',
    });

    // t=0: 起始值
    let results = km.evaluatePkfAt(0);
    eq(results.length, 1, '6.1 t=0 有 1 个结果');
    near(results[0].value, 0, 0.001, '6.2 t=0 值为 0');

    // t=1: 中间值（线性插值 50%）
    results = km.evaluatePkfAt(1);
    near(results[0].value, 50, 0.001, '6.3 t=1 值为 50（stroke=100 的 50%）');

    // t=2: 结束值
    results = km.evaluatePkfAt(2);
    near(results[0].value, 100, 0.001, '6.4 t=2 值为 100');

    // t=3: 超出范围，无结果
    results = km.evaluatePkfAt(3);
    eq(results.length, 0, '6.5 t=3 超出范围，无结果');

    // 用覆盖值
    results = km.evaluatePkfAt(2, { stroke: 200 });
    near(results[0].value, 200, 0.001, '6.6 参数覆盖 stroke=200，t=2 值为 200');

    console.groupEnd();

    // ════════════════════════════════════════
    console.group('七、预览按钮 DOM');
    // ════════════════════════════════════════

    const previewBtn = document.querySelector('#pkf-preview-btn');
    const previewOutput = document.querySelector('#pkf-preview-output');
    assert(previewBtn !== null, '7.1 预览按钮存在');
    assert(previewOutput !== null, '7.2 预览输出区存在');

    // 点击预览
    previewBtn.click();
    assert(previewOutput.textContent.length > 0, '7.3 点击后有输出');
    assert(previewOutput.textContent.includes('预览时间'), '7.4 输出包含预览时间');

    console.groupEnd();

  } finally {
    // ── 恢复原始状态 ──
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
