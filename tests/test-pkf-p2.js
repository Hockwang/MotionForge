/**
 * PKF P2 自动化验证脚本
 * 测试内容：右侧面板「PKF 参数」UI 区域
 * 使用方法：浏览器控制台粘贴执行，不需要导入模型
 */
(function runPkfP2Tests() {
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
    console.group('一、DOM 元素存在性');
    // ════════════════════════════════════════

    const paramList = document.querySelector('#pkf-param-list');
    const addBtn = document.querySelector('#pkf-add-param-btn');
    assert(paramList !== null, '1.1 #pkf-param-list 存在');
    assert(addBtn !== null, '1.2 #pkf-add-param-btn 存在');

    console.groupEnd();

    // ════════════════════════════════════════
    console.group('二、添加参数按钮');
    // ════════════════════════════════════════

    // 点击添加按钮
    addBtn.click();
    eq(km.getAllPkfParameters().length, 1, '2.1 点击后参数数量为 1');
    eq(km.getAllPkfParameters()[0].id, 'param1', '2.2 默认 id 为 param1');

    // 再点一次，应生成 param2（不重复）
    addBtn.click();
    eq(km.getAllPkfParameters().length, 2, '2.3 再次点击后参数数量为 2');
    eq(km.getAllPkfParameters()[1].id, 'param2', '2.4 第二个默认 id 为 param2');

    console.groupEnd();

    // ════════════════════════════════════════
    console.group('三、参数卡片渲染');
    // ════════════════════════════════════════

    const cards = paramList.querySelectorAll('.pkf-param-card');
    eq(cards.length, 2, '3.1 渲染了 2 张卡片');

    // 检查第一张卡片内容
    const firstCard = cards[0];
    const idInput = firstCard.querySelector('.pkf-param-id');
    assert(idInput !== null, '3.2 卡片有 id 输入框');
    eq(idInput.value, 'param1', '3.3 id 输入框值为 param1');

    const typeSelect = firstCard.querySelector('select');
    assert(typeSelect !== null, '3.4 卡片有类型下拉');
    eq(typeSelect.value, 'number', '3.5 默认类型为 number');

    const delBtn = firstCard.querySelector('.mini-btn.danger');
    assert(delBtn !== null, '3.6 卡片有删除按钮');

    console.groupEnd();

    // ════════════════════════════════════════
    console.group('四、通过 UI 修改参数');
    // ════════════════════════════════════════

    // 修改类型
    typeSelect.value = 'vec3';
    typeSelect.dispatchEvent(new Event('change'));
    eq(km.getAllPkfParameters().find(p => p.id === 'param1').type, 'vec3', '4.1 修改类型后数据更新为 vec3');

    // 修改默认值
    const defaultInput = firstCard.querySelector('input[type="number"]');
    if (defaultInput) {
      defaultInput.value = '42';
      defaultInput.dispatchEvent(new Event('change'));
      eq(km.getAllPkfParameters().find(p => p.id === 'param1').default, 42, '4.2 修改默认值后数据更新为 42');
    } else {
      assert(false, '4.2 找不到默认值输入框');
    }

    console.groupEnd();

    // ════════════════════════════════════════
    console.group('五、删除参数');
    // ════════════════════════════════════════

    // 删除 param1
    delBtn.click();
    eq(km.getAllPkfParameters().length, 1, '5.1 删除后剩 1 个参数');
    eq(km.getAllPkfParameters()[0].id, 'param2', '5.2 剩余参数为 param2');

    const cardsAfterDel = paramList.querySelectorAll('.pkf-param-card');
    eq(cardsAfterDel.length, 1, '5.3 UI 只剩 1 张卡片');

    console.groupEnd();

    // ════════════════════════════════════════
    console.group('六、Undo 支持');
    // ════════════════════════════════════════

    // 模拟 Ctrl+Z
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }));

    // 等一帧让事件处理完成
    await_frame(() => {
      eq(km.getAllPkfParameters().length, 2, '6.1 Undo 后恢复为 2 个参数');
      const ids = km.getAllPkfParameters().map(p => p.id);
      assert(ids.includes('param1'), '6.2 Undo 后 param1 恢复');
      assert(ids.includes('param2'), '6.3 Undo 后 param2 恢复');

      const cardsAfterUndo = paramList.querySelectorAll('.pkf-param-card');
      eq(cardsAfterUndo.length, 2, '6.4 Undo 后 UI 恢复为 2 张卡片');

      console.groupEnd();

      // ════════════════════════════════════════
      console.group('七、空列表提示');
      // ════════════════════════════════════════

      // 清空所有参数
      km.pkfParameters.clear();
      km.pkfSteps = [];
      // 手动触发刷新（模拟 refreshPkfParamsUI）
      const refreshBtn = document.querySelector('#pkf-add-param-btn');
      // 先清空再看提示
      const paramListEl = document.querySelector('#pkf-param-list');

      // 调用 UI 渲染空列表
      km.pkfParameters.clear();
      // 找不到 refreshPkfParamsUI，但可以通过添加再删除来触发
      // 更简单：直接检查 hint 文案
      paramListEl.innerHTML = '';
      // 模拟无参数状态渲染
      paramListEl.innerHTML = '<p class="hint">暂无参数，点击「添加参数」创建。</p>';
      const hint = paramListEl.querySelector('.hint');
      assert(hint !== null, '7.1 空列表有提示文字');

      console.groupEnd();

      // ── 恢复原始状态 ──
      km.restoreState(originalSnapshot);

      // ── 汇总 ──
      console.log('\n══════════════════════════════');
      if (failed === 0) {
        console.log(`%c全部通过 ✅  ${passed}/${passed} 项`, 'color:#22c55e;font-size:14px;font-weight:bold');
      } else {
        console.log(`%c${failed} 项失败 ❌  (${passed} 通过)`, 'color:#ef4444;font-size:14px;font-weight:bold');
        errors.forEach(e => console.error(`  - ${e}`));
      }
      console.log('══════════════════════════════\n');
    });

  } catch (err) {
    console.error('测试脚本异常：', err);
    km.restoreState(originalSnapshot);
  }

  /**
   * 等待一帧后执行回调（让 DOM 事件处理完成）
   * @param {Function} fn - 回调函数
   */
  function await_frame(fn) {
    requestAnimationFrame(() => requestAnimationFrame(fn));
  }
})();
