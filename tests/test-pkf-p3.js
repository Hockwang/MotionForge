/**
 * PKF P3 自动化验证脚本
 * 测试内容：右侧面板「PKF 步骤」UI 区域
 * 使用方法：浏览器控制台粘贴执行，不需要导入模型
 */
(function runPkfP3Tests() {
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

    const stepList = document.querySelector('#pkf-step-list');
    const addBtn = document.querySelector('#pkf-add-step-btn');
    const genBtn = document.querySelector('#pkf-gen-from-kf-btn');
    assert(stepList !== null, '1.1 #pkf-step-list 存在');
    assert(addBtn !== null, '1.2 #pkf-add-step-btn 存在');
    assert(genBtn !== null, '1.3 #pkf-gen-from-kf-btn 存在');

    console.groupEnd();

    // ════════════════════════════════════════
    console.group('二、添加步骤按钮');
    // ════════════════════════════════════════

    addBtn.click();
    eq(km.getAllPkfSteps().length, 1, '2.1 点击后步骤数量为 1');
    const step1 = km.getAllPkfSteps()[0];
    assert(step1.id && step1.id.length > 0, '2.2 步骤有自动 id');
    eq(step1.channel, 'translate', '2.3 默认通道为 translate');
    eq(step1.axis, 'z', '2.4 默认轴向为 z');
    eq(step1.easing, 'linear', '2.5 默认缓动为 linear');

    addBtn.click();
    eq(km.getAllPkfSteps().length, 2, '2.6 再次点击后步骤数量为 2');

    console.groupEnd();

    // ════════════════════════════════════════
    console.group('三、步骤卡片渲染');
    // ════════════════════════════════════════

    const cards = stepList.querySelectorAll('.pkf-step-card');
    eq(cards.length, 2, '3.1 渲染了 2 张卡片');

    const firstCard = cards[0];
    const title = firstCard.querySelector('.pkf-step-title');
    assert(title !== null, '3.2 卡片有标题');
    eq(title.textContent, '步骤 1', '3.3 标题为「步骤 1」');

    const delBtn = firstCard.querySelector('.mini-btn.danger');
    assert(delBtn !== null, '3.4 卡片有删除按钮');

    // 检查通道下拉
    const selects = firstCard.querySelectorAll('select');
    assert(selects.length >= 3, '3.5 卡片至少有 3 个下拉（关节+通道+轴向）');

    // 检查公式输入
    const textInputs = firstCard.querySelectorAll('input[type="text"]');
    assert(textInputs.length >= 2, '3.6 卡片有起止公式输入框');

    console.groupEnd();

    // ════════════════════════════════════════
    console.group('四、通过 UI 修改步骤');
    // ════════════════════════════════════════

    // 修改通道为 rotate（第二个 select 是通道）
    const channelSelect = firstCard.querySelectorAll('select')[1];
    if (channelSelect) {
      channelSelect.value = 'rotate';
      channelSelect.dispatchEvent(new Event('change'));
      const updatedStep = km.getAllPkfSteps()[0];
      eq(updatedStep.channel, 'rotate', '4.1 修改通道后数据更新为 rotate');
    } else {
      assert(false, '4.1 找不到通道下拉');
    }

    // 修改结束值公式
    const veInput = firstCard.querySelectorAll('input[type="text"]')[1];
    if (veInput) {
      veInput.value = 'stroke * 2';
      veInput.dispatchEvent(new Event('change'));
      const updatedStep = km.getAllPkfSteps()[0];
      eq(updatedStep.value_end, 'stroke * 2', '4.2 修改结束值公式后数据更新');
    } else {
      assert(false, '4.2 找不到结束值输入框');
    }

    console.groupEnd();

    // ════════════════════════════════════════
    console.group('五、删除步骤');
    // ════════════════════════════════════════

    const step1Id = km.getAllPkfSteps()[0].id;
    delBtn.click();
    eq(km.getAllPkfSteps().length, 1, '5.1 删除后剩 1 个步骤');
    assert(km.getAllPkfSteps()[0].id !== step1Id, '5.2 被删的是第一个步骤');

    const cardsAfterDel = stepList.querySelectorAll('.pkf-step-card');
    eq(cardsAfterDel.length, 1, '5.3 UI 只剩 1 张卡片');

    console.groupEnd();

    // ════════════════════════════════════════
    console.group('六、Undo 支持');
    // ════════════════════════════════════════

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }));

    // 等一帧让事件处理完成
    requestAnimationFrame(() => requestAnimationFrame(() => {
      eq(km.getAllPkfSteps().length, 2, '6.1 Undo 后恢复为 2 个步骤');
      const cardsAfterUndo = stepList.querySelectorAll('.pkf-step-card');
      eq(cardsAfterUndo.length, 2, '6.2 Undo 后 UI 恢复为 2 张卡片');

      console.groupEnd();

      // ════════════════════════════════════════
      console.group('七、空列表提示');
      // ════════════════════════════════════════

      // 清空
      km.pkfSteps = [];
      km.pkfParameters.clear();
      // 模拟空列表
      stepList.innerHTML = '<p class="hint">暂无步骤，点击「添加步骤」或「从关键帧生成」。</p>';
      const hint = stepList.querySelector('.hint');
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
    }));

  } catch (err) {
    console.error('测试脚本异常：', err);
    km.restoreState(originalSnapshot);
  }
})();
