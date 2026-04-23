import * as THREE from 'three';

export class EditorUI {
  constructor(appRoot) {
    this.appRoot = appRoot;
    this.appRoot.innerHTML = this.getTemplate();

    this.fileInput = this.appRoot.querySelector('#asset-input');
    this.importPackageInput = this.appRoot.querySelector('#import-package-input');
    this.loadStatus = this.appRoot.querySelector('#load-status');
    this.objectList = this.appRoot.querySelector('#object-list');
    this.viewport = this.appRoot.querySelector('#viewport');
    this.selectionLabel = this.appRoot.querySelector('#selection-label');

    this.txInput = this.appRoot.querySelector('#tx-input');
    this.tyInput = this.appRoot.querySelector('#ty-input');
    this.tzInput = this.appRoot.querySelector('#tz-input');
    this.ryInput = this.appRoot.querySelector('#ry-input');
    this.clipNameInput = this.appRoot.querySelector('#clip-name-input');
    this.createClipBtn = this.appRoot.querySelector('#create-clip-btn');
    this.clipSelect = this.appRoot.querySelector('#clip-select');

    this.durationInput = this.appRoot.querySelector('#duration-input');
    this.timeInput = this.appRoot.querySelector('#time-input');
    this.timeLabel = this.appRoot.querySelector('#time-label');
    this.playBtn = this.appRoot.querySelector('#play-btn');
    this.keyframeBtn = this.appRoot.querySelector('#keyframe-btn');
    this.keyframeList = this.appRoot.querySelector('#keyframe-list');
    this.aiPromptInput = this.appRoot.querySelector('#ai-prompt-input');
    this.aiGenerateBtn = this.appRoot.querySelector('#ai-generate-btn');
    this.aiIntentInput = this.appRoot.querySelector('#ai-intent-input');
    this.aiDecomposeBtn = this.appRoot.querySelector('#ai-decompose-btn');
    this.aiOneshotBtn = this.appRoot.querySelector('#ai-oneshot-btn');
    this.aiOneshotOutput = this.appRoot.querySelector('#ai-oneshot-output');

    // ── AI 输入双模式（自由文本 / 表格）──
    this.aiModeTextBtn = this.appRoot.querySelector('#ai-mode-text-btn');
    this.aiModeTableBtn = this.appRoot.querySelector('#ai-mode-table-btn');
    this.aiTextModeWrap = this.appRoot.querySelector('#ai-text-mode-wrap');
    this.aiTableModeWrap = this.appRoot.querySelector('#ai-table-mode-wrap');
    this.aiStepRows = this.appRoot.querySelector('#ai-step-rows');
    this.aiAddRowBtn = this.appRoot.querySelector('#ai-add-row-btn');
    this._aiInputMode = 'text'; // 'text' | 'table'
    this._aiTableRows = []; // [{time, op}, ...]
    this.aiResultOutput = this.appRoot.querySelector('#ai-result-output');
    this.aiApplyBtn = this.appRoot.querySelector('#ai-apply-btn');
    this.aiJointChips = this.appRoot.querySelector('#ai-joint-chips');
    // ── PKF 参数区域 DOM 引用 ──
    this.pkfParamList = this.appRoot.querySelector('#pkf-param-list');
    this.pkfAddParamBtn = this.appRoot.querySelector('#pkf-add-param-btn');

    // ── PKF 步骤区域 DOM 引用 ──
    this.pkfStepList = this.appRoot.querySelector('#pkf-step-list');
    this.pkfAddStepBtn = this.appRoot.querySelector('#pkf-add-step-btn');
    this.pkfGenFromKfBtn = this.appRoot.querySelector('#pkf-gen-from-kf-btn');
    this.pkfPreviewBtn = this.appRoot.querySelector('#pkf-preview-btn');
    this.pkfPreviewOutput = this.appRoot.querySelector('#pkf-preview-output');
    this.pkfPlaybackModeInput = this.appRoot.querySelector('#pkf-playback-mode-input');

    // ── Reparent 事件列表 DOM 引用（schema v5）──
    this.reparentEventList = this.appRoot.querySelector('#reparent-event-list');
    // ── Marker UI（schema v6）──
    this.addCargoMarkerBtn = this.appRoot.querySelector('#add-cargo-marker-btn');
    this.addPickupMarkerBtn = this.appRoot.querySelector('#add-pickup-marker-btn');
    this.addDropMarkerBtn = this.appRoot.querySelector('#add-drop-marker-btn');
    this.removeAllMarkersBtn = this.appRoot.querySelector('#remove-all-markers-btn');
    this.markerList = this.appRoot.querySelector('#marker-list');

    this.exportJsonBtn = this.appRoot.querySelector('#export-json-btn');
    this.exportPackageBtn = this.appRoot.querySelector('#export-package-btn');
    this.exportOutput = this.appRoot.querySelector('#export-output');
    this.trajectoryToggleInput = this.appRoot.querySelector('#trajectory-toggle-input');
    this.collapsedTreeNodeIds = new Set();
    this.seenTreeNodeIds = new Set();
    this.treeContextMenu = null;
    this.jointConfigPanel = null;
    this.activeJointConfigNodeId = null;
  }

  getTemplate() {
    return `
      <div class="editor-shell">
        <aside class="panel left-panel">
          <h2>场景</h2>
          <label class="upload">
            <span>加载资产</span>
            <input id="asset-input" type="file" accept=".usd,.usda,.usdc,.usdz,.fbx,.glb,.gltf" />
          </label>
          <label class="upload">
            <span>导入资产包 ZIP</span>
            <input id="import-package-input" type="file" accept=".zip" />
          </label>
          <p id="load-status" class="hint">尚未加载资产。</p>
          <ul id="object-list" class="object-list"></ul>
        </aside>

        <main class="viewport-wrap">
          <div id="viewport"></div>
        </main>

        <aside class="panel right-panel">
          <h2>变换</h2>
          <p id="selection-label" class="hint">当前选择：无</p>

          <label>X 世界坐标
            <input id="tx-input" type="number" step="0.1" value="0" />
          </label>

          <label>Z 世界坐标（高度）
            <input id="ty-input" type="number" step="0.1" value="0" />
          </label>

          <label>Y 世界坐标（前后）
            <input id="tz-input" type="number" step="0.1" value="0" />
          </label>

          <label>Z 世界旋转（度）
            <input id="ry-input" type="number" step="1" value="0" />
          </label>

          <hr />
          <h2>动画片段</h2>
          <p class="hint">关键帧全局共享：所有有关节定义的对象在同一时间点同步捕获 / 回放。</p>

          <label>新片段名称
            <input id="clip-name-input" type="text" placeholder="例如 open / close" />
          </label>
          <button id="create-clip-btn" type="button">创建片段</button>

          <label>当前片段
            <select id="clip-select"></select>
          </label>

          <hr />
          <h2>关键帧</h2>

          <label>时长（秒）
            <input id="duration-input" type="number" min="1" step="1" value="10" />
          </label>

          <button id="keyframe-btn" type="button">在当前时间添加关键帧</button>
          <ul id="keyframe-list" class="keyframe-list"></ul>

          <hr />
          <h2>AI 动作生成</h2>
          <details id="ai-joint-chips-wrap" class="ai-joint-chips-wrap" open>
            <summary>可用关节（点击插入到输入框）</summary>
            <div id="ai-joint-chips" class="ai-joint-chips">
              <span class="hint">（还没有配置关节）</span>
            </div>
          </details>
          <details id="ai-decompose-wrap" style="margin-bottom:8px" open>
            <summary style="cursor:pointer;font-size:12px;color:#93c5fd;padding:4px 0">🎯 高级意图（一句话生成动画）</summary>
            <textarea id="ai-intent-input" rows="2" placeholder="例如：去 cargo 取货，放到 drop"
              style="width:100%;margin-top:4px"></textarea>
            <div style="display:flex;gap:4px;margin-top:4px">
              <button id="ai-oneshot-btn" type="button" style="flex:2;background:#3b82f6;color:#fff;font-weight:600">🚀 一键生成完整动画</button>
              <button id="ai-decompose-btn" type="button" class="mini-btn" style="flex:1" title="只拆到时间表，不自动生成 PKF">🪄 仅拆解</button>
            </div>
            <p class="hint" style="margin-top:4px">一键生成：自动拆时间表 + 应用 reparent + 生成 PKF + 切到 PKF 播放。失败不影响现有状态。</p>
            <div id="ai-oneshot-output" style="display:none;margin-top:6px;padding:6px;font-size:11px;background:#0f172a;border:1px solid #334155;border-radius:4px"></div>
          </details>
          <div class="ai-mode-toggle">
            <button type="button" id="ai-mode-text-btn" class="ai-mode-btn active">📝 自由文本</button>
            <button type="button" id="ai-mode-table-btn" class="ai-mode-btn">📋 时间表</button>
          </div>
          <label id="ai-text-mode-wrap">自然语言描述
            <textarea id="ai-prompt-input" rows="3" placeholder="例如：@叉齿 抬升 0.3 米，或 叉齿抬升 0.3 米"></textarea>
          </label>
          <div id="ai-table-mode-wrap" style="display:none">
            <p class="hint">每行一个步骤。时间格式：「0-3s」区间 或「4s」瞬时。</p>
            <table class="ai-step-table">
              <thead><tr><th style="width:80px">时间</th><th>操作</th><th style="width:30px"></th></tr></thead>
              <tbody id="ai-step-rows"></tbody>
            </table>
            <button type="button" id="ai-add-row-btn" class="mini-btn" style="width:100%;margin-top:6px">+ 添加行</button>
          </div>
          <button id="ai-generate-btn" type="button" style="margin-top:8px">AI 生成动作</button>
          <pre id="ai-result-output" class="export-output" style="max-height:120px;overflow:auto"></pre>
          <button id="ai-apply-btn" type="button" style="display:none">确认并应用</button>

          <hr />
          <h2>PKF 参数</h2>
          <p class="hint">声明公式中可引用的输入参数，下游填入实际值。</p>
          <div id="pkf-param-list" class="pkf-param-list"></div>
          <button id="pkf-add-param-btn" type="button">添加参数</button>

          <hr />
          <h2>PKF 步骤</h2>
          <p class="hint">每个步骤定义一个关节在时间区间内的运动公式。</p>
          <div id="pkf-step-list" class="pkf-step-list"></div>
          <div class="pkf-step-actions">
            <button id="pkf-add-step-btn" type="button">添加步骤</button>
            <button id="pkf-gen-from-kf-btn" type="button">从关键帧生成</button>
          </div>
          <label style="margin-top:6px;display:flex;align-items:center;gap:6px">
            <input id="pkf-playback-mode-input" type="checkbox" />
            用 PKF 驱动播放（覆盖关键帧动画）
          </label>
          <button id="pkf-preview-btn" type="button" style="margin-top:6px">PKF 预览（当前时间一次性求值）</button>
          <pre id="pkf-preview-output" class="export-output" style="max-height:100px;overflow:auto"></pre>

          <hr />
          <h2>📎 Reparent 事件</h2>
          <p class="hint">时间线上切换对象的 scene graph parent（取货/放货用）。右键场景树节点添加。</p>
          <div id="reparent-event-list" class="pkf-step-list"></div>

          <hr />
          <h2>📍 场景标记</h2>
          <p class="hint">辅助物：货物占位（含尺寸）、取货点、放货点。可被 reparent 拾起；尺寸自动注入 PKF 公式（cargo_width / cargo_height / cargo_depth）。</p>
          <div style="display:flex;gap:4px;margin-bottom:6px;flex-wrap:wrap">
            <button id="add-cargo-marker-btn" type="button" class="mini-btn" style="flex:1;min-width:90px">📦 货物占位</button>
            <button id="add-pickup-marker-btn" type="button" class="mini-btn" style="flex:1;min-width:90px">🟢 取货点</button>
            <button id="add-drop-marker-btn" type="button" class="mini-btn" style="flex:1;min-width:90px">🔴 放货点</button>
            <button id="remove-all-markers-btn" type="button" class="mini-btn danger" style="flex:1;min-width:60px">🗑 清空</button>
          </div>
          <div id="marker-list" class="pkf-step-list"></div>

          <hr />
          <h2>导出</h2>
          <button id="export-json-btn" type="button">导出当前对象动作 JSON</button>
          <button id="export-package-btn" type="button">导出结果包 ZIP</button>
          <pre id="export-output" class="export-output"></pre>
        </aside>

        <footer class="timeline">
          <button id="play-btn" type="button">播放</button>
          <input id="time-input" type="range" min="0" max="10" step="0.01" value="0" />
          <span id="time-label">0.00s / 10.00s</span>
          <label class="trajectory-toggle" title="在 3D 视口叠加 fork/cargo 世界空间轨迹 + console 输出动画信息表">
            <input id="trajectory-toggle-input" type="checkbox" />
            <span>🎨 轨迹</span>
          </label>
        </footer>
      </div>
    `;
  }

  setLoadStatus(text) {
    this.loadStatus.textContent = text;
  }

  setSelectedObject(object) {
    this.selectionLabel.textContent = `当前选择：${object?.name || object?.uuid || '无'}`;
    this._currentSelectedObject = object || null;
    if (object) {
      const worldPos = object.getWorldPosition(new THREE.Vector3());
      const worldQuat = object.getWorldQuaternion(new THREE.Quaternion());
      const worldEuler = new THREE.Euler().setFromQuaternion(worldQuat, 'XYZ');

      this.txInput.value = worldPos.x.toFixed(3);
      this.tyInput.value = worldPos.y.toFixed(3);
      if (this.tzInput) this.tzInput.value = worldPos.z.toFixed(3);
      this.ryInput.value = ((worldEuler.y * 180) / Math.PI).toFixed(2);
    } else {
      this.txInput.value = 0;
      this.tyInput.value = 0;
      if (this.tzInput) this.tzInput.value = 0;
      this.ryInput.value = 0;
    }
  }

  /**
   * 注册 transform 输入框的编辑事件 — 让用户能直接改世界坐标 / 旋转
   * 注意：如果对象有关节驱动，下一帧 applyJointDrive 会覆盖。手动改的对象通常是无关节的（如测试货物）。
   * @param {Function} onChange - (axis, value) => void  axis: 'x' | 'y' | 'z' | 'ry'
   */
  attachTransformEditHandlers(onChange) {
    const apply = (axis, input) => {
      if (!input) return;
      input.addEventListener('change', () => {
        const v = Number(input.value);
        if (Number.isFinite(v) && this._currentSelectedObject) {
          onChange(axis, v);
        }
      });
    };
    apply('x', this.txInput);
    apply('y', this.tyInput);
    apply('z', this.tzInput);
    apply('ry', this.ryInput);
  }

  setClipOptions(clipNames, activeClipName) {
    this.clipSelect.innerHTML = '';
    clipNames.forEach((name) => {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = name;
      if (name === activeClipName) option.selected = true;
      this.clipSelect.appendChild(option);
    });
  }

  hideTreeContextMenu() {
    if (!this.treeContextMenu) return;
    this.treeContextMenu.remove();
    this.treeContextMenu = null;
  }

  showTreeContextMenu(x, y, node, handlers, treeNodes, selectedId) {
    this.hideTreeContextMenu();
    const menu = document.createElement('div');
    menu.className = 'tree-context-menu';
    menu.style.left = `${x}px`;
    menu.style.top = `${y}px`;

    const insertGroupBtn = document.createElement('button');
    insertGroupBtn.type = 'button';
    insertGroupBtn.textContent = '插入空节点（作为父级）';
    insertGroupBtn.addEventListener('click', () => {
      handlers?.onInsertGroup?.(node.object);
      this.hideTreeContextMenu();
    });
    menu.appendChild(insertGroupBtn);

    const moveRootBtn = document.createElement('button');
    moveRootBtn.type = 'button';
    moveRootBtn.textContent = '移至顶层';
    moveRootBtn.addEventListener('click', () => {
      handlers?.onMoveToRoot?.(node.object);
      this.hideTreeContextMenu();
      this.renderObjectList(treeNodes, selectedId, handlers);
    });
    menu.appendChild(moveRootBtn);

    // ── v5: Reparent 事件（取货/放货用）──
    // 在当前时间点把该对象 attach 到另一个对象下，或 detach 回世界根
    // UI：展开候选父级列表（直接点目标，不用输入序号）
    const attachLabel = document.createElement('div');
    attachLabel.textContent = `📎 在 t=${(handlers?.getCurrentTime?.() ?? 0).toFixed(2)}s attach 到：`;
    attachLabel.style.cssText = 'padding: 6px 8px; color: #93c5fd; font-size: 11px; background: #0f172a;';
    menu.appendChild(attachLabel);

    const attachListWrap = document.createElement('div');
    attachListWrap.style.cssText = 'max-height: 180px; overflow-y: auto; border-bottom: 1px solid #334155;';

    const candidates = (handlers?.getReparentCandidates?.(node) || []);
    if (!candidates.length) {
      const empty = document.createElement('div');
      empty.textContent = '(没有可选父级)';
      empty.style.cssText = 'padding: 4px 8px; font-size: 11px; color: #94a3b8;';
      attachListWrap.appendChild(empty);
    } else {
      candidates.forEach((name) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = name;
        btn.style.cssText = 'display: block; width: 100%; text-align: left; padding: 4px 12px; font-size: 12px;';
        btn.addEventListener('click', () => {
          this.hideTreeContextMenu();
          handlers?.onReparentAttachTo?.(node, name);
        });
        attachListWrap.appendChild(btn);
      });
    }
    menu.appendChild(attachListWrap);

    const detachBtn = document.createElement('button');
    detachBtn.type = 'button';
    detachBtn.textContent = '📌 在当前时间 detach（挂回世界根）';
    detachBtn.addEventListener('click', () => {
      this.hideTreeContextMenu();
      handlers?.onReparentDetach?.(node);
    });
    menu.appendChild(detachBtn);

    const clearReparentBtn = document.createElement('button');
    clearReparentBtn.type = 'button';
    clearReparentBtn.textContent = '❌ 删除此对象所有 reparent 事件';
    clearReparentBtn.addEventListener('click', () => {
      this.hideTreeContextMenu();
      handlers?.onReparentClearAll?.(node);
    });
    menu.appendChild(clearReparentBtn);

    document.body.appendChild(menu);
    this.treeContextMenu = menu;
    const close = (e) => {
      if (menu.contains(e.target)) return;
      this.hideTreeContextMenu();
      document.removeEventListener('pointerdown', close, true);
    };
    setTimeout(() => document.addEventListener('pointerdown', close, true), 0);
  }

  renderObjectList(treeNodes, selectedId, handlers) {
    this.objectList.innerHTML = '';
    if (!treeNodes.length) {
      this.objectList.innerHTML = '<li class="hint">没有可编辑对象</li>';
      return;
    }

    const renderNode = (node, depth = 0) => {
      const li = document.createElement('li');
      li.className = `tree-node ${node.id === selectedId ? 'selected' : ''}`;

      const row = document.createElement('div');
      row.className = 'tree-node-row';

      const hasChildren = Boolean(node.children?.length);
      if (!this.seenTreeNodeIds.has(node.id)) {
        this.seenTreeNodeIds.add(node.id);
        if (hasChildren && depth >= 2) this.collapsedTreeNodeIds.add(node.id);
      }

      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'tree-toggle-btn';
      if (hasChildren) {
        const collapsed = this.collapsedTreeNodeIds.has(node.id);
        toggle.textContent = collapsed ? '▶' : '▼';
        toggle.addEventListener('click', (event) => {
          event.stopPropagation();
          if (collapsed) this.collapsedTreeNodeIds.delete(node.id);
          else this.collapsedTreeNodeIds.add(node.id);
          this.renderObjectList(treeNodes, selectedId, handlers);
        });
      } else {
        toggle.textContent = '';
        toggle.disabled = true;
      }

      const indent = document.createElement('span');
      indent.className = 'tree-indent';
      for (let i = 0; i < depth; i += 1) {
        const guide = document.createElement('span');
        guide.className = `tree-guide ${i === depth - 1 ? 'elbow' : ''}`;
        indent.appendChild(guide);
      }
      const icon = document.createElement('span');
      icon.className = 'tree-node-icon';
      icon.textContent = node.nodeType === 'Mesh' ? '🔷' : '📁';
      const label = document.createElement('span');
      label.className = `tree-node-label ${node.isDimContainer ? 'dim' : ''}`;
      label.textContent = node.name || node.id;

      // Joint tag (non-root nodes only)
      const jointTag = document.createElement('span');
      const jointLabel = handlers?.getJointLabel?.(node.id) || '无';
      jointTag.className = `tree-joint-tag ${jointLabel !== '无' ? 'active' : ''}`;
      jointTag.textContent = jointLabel;
      jointTag.title = '点击配置关节类型';
      jointTag.addEventListener('click', (event) => {
        event.stopPropagation();
        handlers?.onJointTagClick?.(node, event);
      });

      row.append(indent, toggle, icon, label, jointTag);
      li.append(row);
      li.addEventListener('click', () => handlers?.onSelect?.(node.object));

      li.draggable = true;
      li.addEventListener('dragstart', (event) => {
        event.dataTransfer?.setData('text/plain', node.id);
        event.dataTransfer.effectAllowed = 'move';
      });
      li.addEventListener('dragover', (event) => {
        event.preventDefault();
        const rect = li.getBoundingClientRect();
        const y = event.clientY - rect.top;
        li.classList.remove('drop-as-child', 'drop-as-sibling-top', 'drop-as-sibling-bottom');
        if (y < 6) li.classList.add('drop-as-sibling-top');
        else if (y > rect.height - 6) li.classList.add('drop-as-sibling-bottom');
        else li.classList.add('drop-as-child');
      });
      li.addEventListener('dragleave', () => {
        li.classList.remove('drop-as-child', 'drop-as-sibling-top', 'drop-as-sibling-bottom');
      });
      li.addEventListener('drop', (event) => {
        event.preventDefault();
        const draggedId = event.dataTransfer?.getData('text/plain');
        li.classList.remove('drop-as-child', 'drop-as-sibling-top', 'drop-as-sibling-bottom');
        if (!draggedId || draggedId === node.id) return;
        const rect = li.getBoundingClientRect();
        const y = event.clientY - rect.top;
        if (y < 6) handlers?.onMove?.({ draggedId, targetId: node.id, mode: 'before' });
        else if (y > rect.height - 6) handlers?.onMove?.({ draggedId, targetId: node.id, mode: 'after' });
        else handlers?.onMove?.({ draggedId, targetId: node.id, mode: 'child' });
      });
      li.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        this.showTreeContextMenu(event.clientX, event.clientY, node, handlers, treeNodes, selectedId);
      });

      this.objectList.appendChild(li);
      const collapsed = this.collapsedTreeNodeIds.has(node.id);
      if (hasChildren && !collapsed) {
        node.children.forEach((child) => renderNode(child, depth + 1));
      }
    };

    treeNodes.forEach((n) => renderNode(n, 0));
  }

  /**
   * 渲染全局关键帧列表
   * 每个 keyframe 显示为一行：时间 + 所有关节状态汇总
   * @param {Array<{time:number, jointValues:Object}>} keyframes
   * @param {Function} onDelete
   * @param {Array<{id, name, type}>} jointDefs - 关节定义列表，用于把 id 转成可读 name
   */
  renderKeyframes(keyframes, onDelete, jointDefs = []) {
    this.keyframeList.innerHTML = '';
    if (!keyframes || !keyframes.length) {
      this.keyframeList.innerHTML = '<li class="hint">当前片段没有关键帧。拖动 gizmo 或 Joint Value 滑条改变关节状态后，点「在当前时间添加关键帧」。</li>';
      return;
    }

    // 构建 id → 显示名映射
    const nameById = new Map();
    jointDefs.forEach((d) => nameById.set(d.id, d.name || d.id.slice(0, 8)));

    keyframes.forEach((k) => {
      const li = document.createElement('li');
      li.className = 'keyframe-item';

      const text = document.createElement('span');
      const jvEntries = Object.entries(k.jointValues || {});
      // 把所有关节状态格式化成 "name=value" 的逗号串；最多显示 3 个，超出折叠
      const formatted = jvEntries
        .map(([id, val]) => {
          const name = nameById.get(id) || id.slice(0, 8);
          return `${name}=${Number(val).toFixed(2)}`;
        });
      const summary = formatted.length === 0
        ? '（空）'
        : formatted.length <= 3
          ? formatted.join(', ')
          : `${formatted.slice(0, 3).join(', ')} … (+${formatted.length - 3})`;
      text.textContent = `t=${k.time.toFixed(2)}s | ${summary}`;
      // 完整内容放 title，鼠标悬停可查看
      if (formatted.length) text.title = formatted.join('\n');

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'keyframe-delete-btn';
      delBtn.textContent = '删除';
      delBtn.addEventListener('click', () => onDelete?.(k));

      li.appendChild(text);
      li.appendChild(delBtn);
      this.keyframeList.appendChild(li);
    });
  }

  updateTimelineLabel(current, duration) {
    this.timeLabel.textContent = `${current.toFixed(2)}s / ${duration.toFixed(2)}s`;
  }

  setTimelineRange(duration) {
    this.timeInput.max = String(duration);
  }

  setTime(value) {
    this.timeInput.value = String(value);
  }

  setPlayState(isPlaying) {
    this.playBtn.textContent = isPlaying ? '暂停' : '播放';
  }

  /**
   * 渲染 PKF 参数列表
   * 每个参数显示为一张可编辑的卡片，包含 id、类型、单位、默认值、描述，以及删除按钮。
   * @param {Array<Object>} parameters - 参数对象数组（来自 keyframeManager.getAllPkfParameters()）
   * 渲染 AI 面板上方的关节 chips（可点击插入到 prompt）
   * @param {Array<{name,type,axis,role}>} jointDefs - 当前所有 revolute/prismatic 关节定义
   */
  renderAiJointChips(jointDefs) {
    if (!this.aiJointChips) return;
    this.aiJointChips.innerHTML = '';
    const usableDefs = (jointDefs || []).filter((d) => d.type === 'revolute' || d.type === 'prismatic');
    if (!usableDefs.length) {
      const hint = document.createElement('span');
      hint.className = 'hint';
      hint.textContent = '（还没有配置关节）';
      this.aiJointChips.appendChild(hint);
      return;
    }
    usableDefs.forEach((d) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ai-joint-chip';
      // 按钮文字：name 为主，role 作为副标题显示
      const roleLabel = d.role ? ` · ${d.role}` : '';
      btn.textContent = `${d.name}${roleLabel}`;
      btn.title = `点击插入 @${d.name} 到输入框`;
      btn.addEventListener('click', () => {
        this._insertIntoAiPrompt(`@${d.name} `);
      });
      this.aiJointChips.appendChild(btn);
    });
  }

  /** 把文本插入到 ai-prompt-input 的光标位置（如无光标则追加到末尾） */
  /** 切换 AI 输入模式 */
  setAiInputMode(mode) {
    if (mode !== 'text' && mode !== 'table') return;
    this._aiInputMode = mode;
    if (mode === 'text') {
      this.aiTextModeWrap.style.display = '';
      this.aiTableModeWrap.style.display = 'none';
      this.aiModeTextBtn.classList.add('active');
      this.aiModeTableBtn.classList.remove('active');
    } else {
      this.aiTextModeWrap.style.display = 'none';
      this.aiTableModeWrap.style.display = '';
      this.aiModeTextBtn.classList.remove('active');
      this.aiModeTableBtn.classList.add('active');
      // 第一次切到表格 mode，给一个空行作为模板
      if (!this._aiTableRows.length) {
        this._aiTableRows.push({ time: '0-3s', op: '' });
        this._renderAiTableRows();
      }
    }
  }

  getAiInputMode() {
    return this._aiInputMode;
  }

  /** 表格模式：序列化成 markdown 表格字符串 */
  serializeAiTable() {
    const rows = this._aiTableRows.filter((r) => r.time?.trim() && r.op?.trim());
    if (!rows.length) return '';
    let md = '请按下面的时间表生成 PKF 动作步骤：\n\n';
    md += '| 时间 | 操作 |\n|---|---|\n';
    rows.forEach((r) => {
      md += `| ${r.time.trim()} | ${r.op.trim()} |\n`;
    });
    md += '\n要求：\n';
    md += '- 每行一个 PKF step。"4s" 表示瞬时点（持续 0.1s 即可）；"0-3s" 是区间\n';
    md += '- 操作描述里"附着到 X"或"脱离"是 reparent 类操作，**不要**输出为 PKF step（用户会手工加 reparent 事件）\n';
    md += '- 关节匹配按 role 语义，axis/channel 按关节 type 推断\n';
    return md;
  }

  /** 表格行内部数据访问（main.js 用） */
  getAiTableRows() {
    return [...this._aiTableRows];
  }

  /** 添加新行 */
  addAiTableRow() {
    this._aiTableRows.push({ time: '', op: '' });
    this._renderAiTableRows();
  }

  /** 整体替换表格内容（L1 拆解后填入用） */
  setAiTableRows(rows) {
    this._aiTableRows = (rows || []).map((r) => ({
      time: String(r.time || '').trim(),
      op: String(r.op || '').trim(),
    }));
    this._renderAiTableRows();
  }

  /** 渲染表格行 */
  _renderAiTableRows() {
    if (!this.aiStepRows) return;
    this.aiStepRows.innerHTML = '';
    this._aiTableRows.forEach((row, idx) => {
      const tr = document.createElement('tr');

      const tdTime = document.createElement('td');
      const inpTime = document.createElement('input');
      inpTime.type = 'text';
      inpTime.value = row.time;
      inpTime.placeholder = '0-3s';
      inpTime.addEventListener('input', () => { row.time = inpTime.value; });
      tdTime.appendChild(inpTime);

      const tdOp = document.createElement('td');
      const inpOp = document.createElement('input');
      inpOp.type = 'text';
      inpOp.value = row.op;
      inpOp.placeholder = '操作描述（自然语言）';
      inpOp.addEventListener('input', () => { row.op = inpOp.value; });
      tdOp.appendChild(inpOp);

      const tdDel = document.createElement('td');
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'mini-btn danger';
      delBtn.textContent = '✕';
      delBtn.style.padding = '2px 6px';
      delBtn.addEventListener('click', () => {
        this._aiTableRows.splice(idx, 1);
        this._renderAiTableRows();
      });
      tdDel.appendChild(delBtn);

      tr.appendChild(tdTime);
      tr.appendChild(tdOp);
      tr.appendChild(tdDel);
      this.aiStepRows.appendChild(tr);
    });
  }

  _insertIntoAiPrompt(text) {
    const ta = this.aiPromptInput;
    if (!ta) return;
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? ta.value.length;
    const before = ta.value.slice(0, start);
    const after = ta.value.slice(end);
    ta.value = before + text + after;
    // 重新聚焦 + 光标放在插入文本之后
    ta.focus();
    const cursor = start + text.length;
    ta.setSelectionRange(cursor, cursor);
  }

  /**
   * @param {Object} handlers - 事件回调
   * @param {Function} handlers.onUpdate  - (id, patch) => void  修改参数字段
   * @param {Function} handlers.onDelete  - (id) => void         删除参数
   */
  renderPkfParameters(parameters, handlers) {
    this.pkfParamList.innerHTML = '';

    // 无参数时显示提示
    if (!parameters || !parameters.length) {
      this.pkfParamList.innerHTML = '<p class="hint">暂无参数，点击「添加参数」创建。</p>';
      return;
    }

    parameters.forEach((param) => {
      // ── 每个参数一张卡片 ──
      const card = document.createElement('div');
      card.className = 'pkf-param-card';

      // 第一行：id（可编辑） + 删除按钮
      const headerRow = document.createElement('div');
      headerRow.className = 'pkf-param-header';

      const idInput = document.createElement('input');
      idInput.type = 'text';
      idInput.className = 'pkf-param-id';
      idInput.value = param.id;
      idInput.title = '参数 ID（公式中引用的变量名）';
      // 失焦时提交改名
      idInput.addEventListener('change', () => {
        const newId = idInput.value.trim();
        if (newId && newId !== param.id) {
          handlers?.onUpdate?.(param.id, { id: newId });
        } else {
          idInput.value = param.id; // 还原，防止清空
        }
      });

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'mini-btn danger';
      delBtn.textContent = '删除';
      delBtn.addEventListener('click', () => handlers?.onDelete?.(param.id));

      headerRow.append(idInput, delBtn);

      // 第二行：类型 + 单位 + 默认值（三列横排）
      const fieldsRow = document.createElement('div');
      fieldsRow.className = 'pkf-param-fields';

      // 类型下拉
      const typeLabel = document.createElement('label');
      typeLabel.className = 'pkf-field';
      typeLabel.textContent = '类型';
      const typeSelect = document.createElement('select');
      typeSelect.innerHTML = `
        <option value="number" ${param.type === 'number' ? 'selected' : ''}>number</option>
        <option value="vec3" ${param.type === 'vec3' ? 'selected' : ''}>vec3</option>
      `;
      typeSelect.addEventListener('change', () => {
        handlers?.onUpdate?.(param.id, { type: typeSelect.value });
      });
      typeLabel.appendChild(typeSelect);

      // 单位输入
      const unitLabel = document.createElement('label');
      unitLabel.className = 'pkf-field';
      unitLabel.textContent = '单位';
      const unitInput = document.createElement('input');
      unitInput.type = 'text';
      unitInput.value = param.unit || '';
      unitInput.placeholder = 'mm / deg';
      unitInput.addEventListener('change', () => {
        handlers?.onUpdate?.(param.id, { unit: unitInput.value });
      });
      unitLabel.appendChild(unitInput);

      // 默认值输入
      const defaultLabel = document.createElement('label');
      defaultLabel.className = 'pkf-field';
      defaultLabel.textContent = '默认值';
      const defaultInput = document.createElement('input');
      defaultInput.type = 'number';
      defaultInput.step = 'any';
      defaultInput.value = param.default ?? 0;
      defaultInput.addEventListener('change', () => {
        handlers?.onUpdate?.(param.id, { default: Number(defaultInput.value) || 0 });
      });
      defaultLabel.appendChild(defaultInput);

      fieldsRow.append(typeLabel, unitLabel, defaultLabel);

      // 第三行：描述
      const descLabel = document.createElement('label');
      descLabel.className = 'pkf-field pkf-field-full';
      descLabel.textContent = '描述';
      const descInput = document.createElement('input');
      descInput.type = 'text';
      descInput.value = param.desc || '';
      descInput.placeholder = '参数用途说明';
      descInput.addEventListener('change', () => {
        handlers?.onUpdate?.(param.id, { desc: descInput.value });
      });
      descLabel.appendChild(descInput);

      card.append(headerRow, fieldsRow, descLabel);
      this.pkfParamList.appendChild(card);
    });
  }

  /**
   * 渲染 PKF 步骤列表
   * 每个步骤显示为一张可编辑的卡片，包含关节、通道、轴向、时间区间、起止公式、缓动。
   * @param {Array<Object>} steps      - 步骤对象数组（来自 keyframeManager.getAllPkfSteps()）
   * @param {Array<Object>} jointDefs  - 关节定义数组（用于关节下拉选项）
   * @param {Object} handlers          - 事件回调
   * @param {Function} handlers.onUpdate - (stepId, patch) => void  修改步骤字段
   * @param {Function} handlers.onDelete - (stepId) => void         删除步骤
   */
  /**
   * 渲染 Reparent 事件列表（schema v5）
   * @param {Array} events - [{ event_id, t, child_name, new_parent_name }, ...]
   * @param {Object} handlers
   * @param {Function} handlers.onDelete - (eventId) => void
   */
  /**
   * 渲染场景标记列表（schema v6）
   * @param {Array} markers - keyframeManager.getAllMarkers() 的结果
   * @param {Object} handlers
   * @param {Function} handlers.onSelect - (markerName) => void  点 marker 名字 → 选中视口对象
   * @param {Function} handlers.onSizeChange - (markerId, axis, value) => void  cargo 改尺寸
   * @param {Function} handlers.onRename - (markerId, newName) => void
   * @param {Function} handlers.onDelete - (markerId) => void
   */
  renderMarkerList(markers, handlers) {
    if (!this.markerList) return;
    this.markerList.innerHTML = '';

    if (!markers || !markers.length) {
      this.markerList.innerHTML = '<p class="hint">还没有场景标记。点上面按钮添加。</p>';
      return;
    }

    markers.forEach((m) => {
      const card = document.createElement('div');
      card.className = 'pkf-step-card';

      // 标题行：name 输入 + 类型标签 + 删除
      const header = document.createElement('div');
      header.className = 'pkf-step-header';
      const nameWrap = document.createElement('div');
      nameWrap.style.cssText = 'display:flex;align-items:center;gap:6px;flex:1';

      const typeIcon = m.type === 'cargo' ? '📦' : (m.type === 'pickup' ? '🟢' : '🔴');
      const icon = document.createElement('span');
      icon.textContent = typeIcon;
      icon.style.cssText = 'cursor:pointer;font-size:14px';
      icon.title = '点击在视口选中';
      icon.addEventListener('click', () => handlers?.onSelect?.(m.name));
      nameWrap.appendChild(icon);

      const nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.value = m.name;
      nameInput.style.cssText = 'flex:1;padding:3px 6px;font-size:12px;font-weight:600';
      nameInput.addEventListener('change', () => {
        const newName = nameInput.value.trim();
        if (newName && newName !== m.name) handlers?.onRename?.(m.id, newName);
      });
      nameWrap.appendChild(nameInput);

      header.appendChild(nameWrap);

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'mini-btn danger';
      delBtn.textContent = '删除';
      delBtn.addEventListener('click', () => handlers?.onDelete?.(m.id));
      header.appendChild(delBtn);
      card.appendChild(header);

      // cargo 类型才显示尺寸编辑
      if (m.type === 'cargo' && m.size) {
        const sizeRow = document.createElement('div');
        sizeRow.style.cssText = 'display:flex;gap:4px;margin-top:6px';
        ['w', 'h', 'd'].forEach((axis) => {
          const label = axis === 'w' ? '宽' : (axis === 'h' ? '高' : '深');
          const wrap = document.createElement('label');
          wrap.style.cssText = 'flex:1;font-size:10px';
          wrap.textContent = `${label} (m)`;
          const input = document.createElement('input');
          input.type = 'number';
          input.step = '0.05';
          input.value = String(m.size[axis] ?? 0.5);
          input.style.cssText = 'width:100%;font-size:11px;padding:3px 4px';
          input.addEventListener('change', () => {
            handlers?.onSizeChange?.(m.id, axis, Number(input.value));
          });
          wrap.appendChild(input);
          sizeRow.appendChild(wrap);
        });
        card.appendChild(sizeRow);

        const hint = document.createElement('p');
        hint.className = 'hint';
        hint.style.cssText = 'margin-top:4px;font-size:10px';
        hint.textContent = `公式可引用：cargo_width=${m.size.w}, cargo_height=${m.size.h}, cargo_depth=${m.size.d}`;
        card.appendChild(hint);
      }

      this.markerList.appendChild(card);
    });
  }

  renderReparentEvents(events, handlers) {
    if (!this.reparentEventList) return;
    this.reparentEventList.innerHTML = '';

    if (!events || !events.length) {
      this.reparentEventList.innerHTML = '<p class="hint">暂无 reparent 事件。右键场景树节点 →「📎 在当前时间 attach 到...」添加。</p>';
      return;
    }

    events.forEach((ev) => {
      const card = document.createElement('div');
      card.className = 'pkf-step-card';

      const header = document.createElement('div');
      header.className = 'pkf-step-header';
      const title = document.createElement('span');
      title.className = 'pkf-step-title';
      const target = ev.new_parent_name === null ? '世界根' : ev.new_parent_name;
      title.textContent = `t=${Number(ev.t).toFixed(2)}s  ${ev.child_name} → ${target}`;
      header.appendChild(title);

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'mini-btn danger';
      delBtn.textContent = '删除';
      delBtn.addEventListener('click', () => handlers?.onDelete?.(ev.event_id));
      header.appendChild(delBtn);

      card.appendChild(header);
      this.reparentEventList.appendChild(card);
    });
  }

  renderPkfSteps(steps, jointDefs, handlers) {
    this.pkfStepList.innerHTML = '';

    // 无步骤时显示提示
    if (!steps || !steps.length) {
      this.pkfStepList.innerHTML = '<p class="hint">暂无步骤，点击「添加步骤」或「从关键帧生成」。</p>';
      return;
    }

    steps.forEach((step, index) => {
      // ── 每个步骤一张卡片 ──
      const card = document.createElement('div');
      card.className = 'pkf-step-card';

      // 标题行：序号 + 删除按钮
      const headerRow = document.createElement('div');
      headerRow.className = 'pkf-step-header';
      const title = document.createElement('span');
      title.className = 'pkf-step-title';
      title.textContent = `步骤 ${index + 1}`;
      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'mini-btn danger';
      delBtn.textContent = '删除';
      delBtn.addEventListener('click', () => handlers?.onDelete?.(step.id));
      headerRow.append(title, delBtn);

      // 第一行：关节选择 + 通道 + 轴向（三列）
      const row1 = document.createElement('div');
      row1.className = 'pkf-step-row3';

      // 关节下拉（列出所有关节定义）
      const jointLabel = document.createElement('label');
      jointLabel.className = 'pkf-field';
      jointLabel.textContent = '关节';
      const jointSelect = document.createElement('select');
      // 第一项：空选项
      const emptyOpt = document.createElement('option');
      emptyOpt.value = '';
      emptyOpt.textContent = '（选择关节）';
      jointSelect.appendChild(emptyOpt);
      // 从关节定义生成选项
      (jointDefs || []).forEach((jd) => {
        const opt = document.createElement('option');
        opt.value = jd.id;
        opt.textContent = jd.name || jd.id;
        if (jd.id === step.joint_def_id) opt.selected = true;
        jointSelect.appendChild(opt);
      });
      jointSelect.addEventListener('change', () => {
        const selectedDef = (jointDefs || []).find((jd) => jd.id === jointSelect.value);
        handlers?.onUpdate?.(step.id, {
          joint_def_id: jointSelect.value,
          joint: selectedDef?.name || jointSelect.value,
        });
      });
      jointLabel.appendChild(jointSelect);

      // 通道下拉
      const chLabel = document.createElement('label');
      chLabel.className = 'pkf-field';
      chLabel.textContent = '通道';
      const chSelect = document.createElement('select');
      chSelect.innerHTML = `
        <option value="translate" ${step.channel === 'translate' ? 'selected' : ''}>平移</option>
        <option value="rotate" ${step.channel === 'rotate' ? 'selected' : ''}>旋转</option>
      `;
      chSelect.addEventListener('change', () => {
        handlers?.onUpdate?.(step.id, { channel: chSelect.value });
      });
      chLabel.appendChild(chSelect);

      // 轴向下拉
      const axLabel = document.createElement('label');
      axLabel.className = 'pkf-field';
      axLabel.textContent = '轴向';
      const axSelect = document.createElement('select');
      axSelect.innerHTML = `
        <option value="x" ${step.axis === 'x' ? 'selected' : ''}>X</option>
        <option value="y" ${step.axis === 'y' ? 'selected' : ''}>Y</option>
        <option value="z" ${step.axis === 'z' ? 'selected' : ''}>Z</option>
      `;
      axSelect.addEventListener('change', () => {
        handlers?.onUpdate?.(step.id, { axis: axSelect.value });
      });
      axLabel.appendChild(axSelect);

      row1.append(jointLabel, chLabel, axLabel);

      // 第二行：t_start + t_end + easing（三列）
      const row2 = document.createElement('div');
      row2.className = 'pkf-step-row3';

      const tsLabel = document.createElement('label');
      tsLabel.className = 'pkf-field';
      tsLabel.textContent = '起始时间';
      const tsInput = document.createElement('input');
      tsInput.type = 'number';
      tsInput.step = '0.1';
      tsInput.value = step.t_start ?? 0;
      tsInput.addEventListener('change', () => {
        handlers?.onUpdate?.(step.id, { t_start: Number(tsInput.value) || 0 });
      });
      tsLabel.appendChild(tsInput);

      const teLabel = document.createElement('label');
      teLabel.className = 'pkf-field';
      teLabel.textContent = '结束时间';
      const teInput = document.createElement('input');
      teInput.type = 'number';
      teInput.step = '0.1';
      teInput.value = step.t_end ?? 1;
      teInput.addEventListener('change', () => {
        handlers?.onUpdate?.(step.id, { t_end: Number(teInput.value) || 0 });
      });
      teLabel.appendChild(teInput);

      const easLabel = document.createElement('label');
      easLabel.className = 'pkf-field';
      easLabel.textContent = '缓动';
      const easSelect = document.createElement('select');
      easSelect.innerHTML = `
        <option value="linear" ${step.easing === 'linear' ? 'selected' : ''}>线性</option>
        <option value="ease-in" ${step.easing === 'ease-in' ? 'selected' : ''}>缓入</option>
        <option value="ease-out" ${step.easing === 'ease-out' ? 'selected' : ''}>缓出</option>
        <option value="ease-in-out" ${step.easing === 'ease-in-out' ? 'selected' : ''}>缓入缓出</option>
      `;
      easSelect.addEventListener('change', () => {
        handlers?.onUpdate?.(step.id, { easing: easSelect.value });
      });
      easLabel.appendChild(easSelect);

      row2.append(tsLabel, teLabel, easLabel);

      // 第三行：value_start + value_end（两列公式输入）
      const row3 = document.createElement('div');
      row3.className = 'pkf-step-row2';

      const vsLabel = document.createElement('label');
      vsLabel.className = 'pkf-field';
      vsLabel.textContent = '起始值公式';
      const vsInput = document.createElement('input');
      vsInput.type = 'text';
      vsInput.value = step.value_start || '0';
      vsInput.placeholder = '例如 0';
      vsInput.addEventListener('change', () => {
        handlers?.onUpdate?.(step.id, { value_start: vsInput.value });
      });
      vsLabel.appendChild(vsInput);

      const veLabel = document.createElement('label');
      veLabel.className = 'pkf-field';
      veLabel.textContent = '结束值公式';
      const veInput = document.createElement('input');
      veInput.type = 'text';
      veInput.value = step.value_end || '0';
      veInput.placeholder = '例如 stroke * 0.5';
      veInput.addEventListener('change', () => {
        handlers?.onUpdate?.(step.id, { value_end: veInput.value });
      });
      veLabel.appendChild(veInput);

      row3.append(vsLabel, veLabel);

      card.append(headerRow, row1, row2, row3);
      this.pkfStepList.appendChild(card);
    });
  }

  hideJointConfigPanel() {
    if (this.jointConfigPanel) {
      this.jointConfigPanel.remove();
      this.jointConfigPanel = null;
    }
    this.activeJointConfigNodeId = null;
  }

  showJointConfigPanel(nodeId, nodeName, currentDef, anchorRect, handlers) {
    this.hideJointConfigPanel();
    this.activeJointConfigNodeId = nodeId;

    const panel = document.createElement('div');
    panel.className = 'joint-config-panel';

    const type = currentDef?.type || 'none';
    const axis = currentDef?.axis || 'y';
    const limMin = currentDef?.limits?.min ?? -180;
    const limMax = currentDef?.limits?.max ?? 180;
    const curVal = currentDef?.currentValue ?? 0;
    const originX = currentDef?.origin?.x ?? 0;
    const originY = currentDef?.origin?.y ?? 0;
    const originZ = currentDef?.origin?.z ?? 0;
    const isFixed = type === 'fixed';
    const isNone = type === 'none';
    const showDrive = !isFixed && !isNone;
    const currentParentId = currentDef?.parentId || '';
    const currentRole = currentDef?.role || '';

    // 预定义 role 词汇表（动作语义标签）— 供 AI 按意图匹配关节
    // 用户也可以选"其他"手写自定义 role
    const PREDEFINED_ROLES = [
      '车体前进', '车体转向', '门架升降', '门架横移',
      '叉齿前伸', '叉齿侧移', '叉齿旋转',
      '夹爪开合', '臂段旋转',
    ];
    const isCustomRole = currentRole && !PREDEFINED_ROLES.includes(currentRole);
    const roleOptionsHtml = PREDEFINED_ROLES
      .map((r) => `<option value="${r}" ${r === currentRole ? 'selected' : ''}>${r}</option>`)
      .join('');

    // 从 handlers 获取可选的 parent 节点列表（所有可编辑对象，排除自己）
    const parentOptions = handlers?.getParentOptions?.() || [];

    // 生成 parent 下拉选项
    const parentOptionsHtml = parentOptions
      .filter((opt) => opt.id !== nodeId) // 排除自己
      .map((opt) => `<option value="${opt.id}" ${opt.id === currentParentId ? 'selected' : ''}>${opt.name}</option>`)
      .join('');

    panel.innerHTML = `
      <div class="joint-config-header">
        <span>关节配置: ${nodeName || nodeId}</span>
        <button type="button" class="joint-config-close">✕</button>
      </div>
      <label>类型
        <select class="jc-type">
          <option value="none" ${type === 'none' ? 'selected' : ''}>无</option>
          <option value="revolute" ${type === 'revolute' ? 'selected' : ''}>旋转 (Revolute)</option>
          <option value="prismatic" ${type === 'prismatic' ? 'selected' : ''}>平移 (Prismatic)</option>
          <option value="fixed" ${type === 'fixed' ? 'selected' : ''}>固定 (Fixed)</option>
        </select>
      </label>
      <div class="jc-parent-group" style="${isNone ? 'display:none' : ''}">
        <label>关节父级（运动跟随谁）
          <select class="jc-parent">
            <option value="">（无 / 世界）</option>
            ${parentOptionsHtml}
          </select>
        </label>
      </div>
      <div class="jc-role-group" style="${isNone ? 'display:none' : ''}">
        <label>关节角色（AI 按语义匹配）
          <select class="jc-role">
            <option value="" ${currentRole === '' ? 'selected' : ''}>（未设置）</option>
            ${roleOptionsHtml}
            <option value="__custom__" ${isCustomRole ? 'selected' : ''}>其他 (自定义)</option>
          </select>
        </label>
        <input class="jc-role-custom" type="text" placeholder="自定义角色名，如 液压杆伸缩"
               value="${isCustomRole ? currentRole : ''}"
               style="${isCustomRole ? '' : 'display:none'}; width: 100%; margin-top: 4px;" />
      </div>
      <div class="jc-axis-group" style="${isFixed || isNone ? 'display:none' : ''}">
        <label>轴向
          <select class="jc-axis">
            <option value="x" ${axis === 'x' ? 'selected' : ''}>X</option>
            <option value="y" ${axis === 'y' ? 'selected' : ''}>Y</option>
            <option value="z" ${axis === 'z' ? 'selected' : ''}>Z</option>
          </select>
        </label>
        <label>最小值
          <input class="jc-min" type="number" step="1" value="${limMin}" />
        </label>
        <label>最大值
          <input class="jc-max" type="number" step="1" value="${limMax}" />
        </label>
      </div>
      <div class="jc-origin-group" style="${showDrive ? '' : 'display:none'}">
        <div class="jc-origin-label">关节原点 (Origin)</div>
        <div class="jc-origin-row">
          <label>X <input class="jc-origin-x" type="number" step="1" value="${originX}" /></label>
          <label>Y <input class="jc-origin-y" type="number" step="1" value="${originY}" /></label>
          <label>Z <input class="jc-origin-z" type="number" step="1" value="${originZ}" /></label>
        </div>
        <div class="jc-origin-actions">
          <button type="button" class="jc-origin-from-bbox">子对象底部</button>
          <button type="button" class="jc-origin-from-center">子对象中心</button>
        </div>
      </div>
      <div class="jc-drive-group" style="${showDrive ? '' : 'display:none'}">
        <label>Joint Value
          <input class="jc-value-slider" type="range" min="${limMin}" max="${limMax}" step="0.1" value="${curVal}" />
        </label>
        <input class="jc-value-number" type="number" step="0.1" value="${curVal}" />
      </div>
    `;

    // Position near the anchor element（先设一个初值，下面再夹紧到视口）
    if (anchorRect) {
      panel.style.left = `${anchorRect.right + 8}px`;
      panel.style.top = `${anchorRect.top}px`;
    }

    document.body.appendChild(panel);
    this.jointConfigPanel = panel;

    // 夹紧到视口范围内：当锚点靠近底部/右侧时，panel 不能溢出屏幕
    // 必须在 appendChild 后测量，因为未挂到 DOM 时高度为 0
    if (anchorRect) {
      const margin = 8;
      const rect = panel.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let left = anchorRect.right + margin;
      let top = anchorRect.top;
      // 右溢出：改放到锚点左侧
      if (left + rect.width > vw - margin) {
        left = Math.max(margin, anchorRect.left - rect.width - margin);
      }
      // 底溢出：上移直到底边贴视口，仍不够则顶边贴视口（面板太高时露出顶部）
      if (top + rect.height > vh - margin) {
        top = Math.max(margin, vh - rect.height - margin);
      }
      panel.style.left = `${left}px`;
      panel.style.top = `${top}px`;
    }

    const typeSelect = panel.querySelector('.jc-type');
    const parentSelect = panel.querySelector('.jc-parent');
    const parentGroup = panel.querySelector('.jc-parent-group');
    const roleSelect = panel.querySelector('.jc-role');
    const roleCustomInput = panel.querySelector('.jc-role-custom');
    const roleGroup = panel.querySelector('.jc-role-group');
    const axisSelect = panel.querySelector('.jc-axis');
    const minInput = panel.querySelector('.jc-min');
    const maxInput = panel.querySelector('.jc-max');
    const axisGroup = panel.querySelector('.jc-axis-group');
    const originGroup = panel.querySelector('.jc-origin-group');
    const originXInput = panel.querySelector('.jc-origin-x');
    const originYInput = panel.querySelector('.jc-origin-y');
    const originZInput = panel.querySelector('.jc-origin-z');
    const originFromBboxBtn = panel.querySelector('.jc-origin-from-bbox');
    const originFromCenterBtn = panel.querySelector('.jc-origin-from-center');
    const driveGroup = panel.querySelector('.jc-drive-group');
    const valueSlider = panel.querySelector('.jc-value-slider');
    const valueNumber = panel.querySelector('.jc-value-number');
    const closeBtn = panel.querySelector('.joint-config-close');

    const updateDriveVisibility = (newType) => {
      const showAxis = newType !== 'fixed' && newType !== 'none';
      axisGroup.style.display = showAxis ? '' : 'none';
      originGroup.style.display = showAxis ? '' : 'none';
      driveGroup.style.display = showAxis ? '' : 'none';
      if (parentGroup) parentGroup.style.display = newType === 'none' ? 'none' : '';
      if (roleGroup) roleGroup.style.display = newType === 'none' ? 'none' : '';
    };

    // 读取当前选中的 role（如果选了"其他"就读文本框，否则读下拉值）
    const readRole = () => {
      if (!roleSelect) return '';
      if (roleSelect.value === '__custom__') {
        return (roleCustomInput?.value || '').trim();
      }
      return roleSelect.value;
    };

    const getOrigin = () => ({
      x: Number(originXInput.value) || 0,
      y: Number(originYInput.value) || 0,
      z: Number(originZInput.value) || 0,
    });

    const emitChange = () => {
      const newType = typeSelect.value;
      updateDriveVisibility(newType);
      handlers?.onChange?.({
        type: newType,
        axis: axisSelect.value,
        origin: getOrigin(),
        parentId: parentSelect?.value || null,
        role: readRole(),
        limits: {
          min: Number(minInput.value) || -180,
          max: Number(maxInput.value) || 180,
        },
      });
    };

    // role 下拉 / 自定义输入联动
    if (roleSelect) {
      roleSelect.addEventListener('change', () => {
        const showCustom = roleSelect.value === '__custom__';
        if (roleCustomInput) {
          roleCustomInput.style.display = showCustom ? '' : 'none';
          if (showCustom) roleCustomInput.focus();
        }
        emitChange();
      });
    }
    if (roleCustomInput) {
      roleCustomInput.addEventListener('input', emitChange);
      roleCustomInput.addEventListener('change', emitChange);
    }

    // parent 下拉变化时也 emit
    if (parentSelect) {
      parentSelect.addEventListener('change', () => {
        // 切换 parent 后需要重新捕获 baseTransform
        handlers?.onParentChanged?.(parentSelect.value || null);
        emitChange();
      });
    }

    // Update slider range when limits change
    const syncSliderRange = () => {
      const newMin = Number(minInput.value) || -180;
      const newMax = Number(maxInput.value) || 180;
      valueSlider.min = newMin;
      valueSlider.max = newMax;
    };

    typeSelect.addEventListener('change', emitChange);
    axisSelect.addEventListener('change', emitChange);
    minInput.addEventListener('change', () => { syncSliderRange(); emitChange(); });
    maxInput.addEventListener('change', () => { syncSliderRange(); emitChange(); });
    // 同时监听 'input'（每次按键都触发）和 'change'（blur 时触发）
    // 让用户改 X/Y/Z 数值时立即看到 origin marker 移动 + 关节驱动跟着重算
    originXInput.addEventListener('input', emitChange);
    originYInput.addEventListener('input', emitChange);
    originZInput.addEventListener('input', emitChange);
    originXInput.addEventListener('change', emitChange);
    originYInput.addEventListener('change', emitChange);
    originZInput.addEventListener('change', emitChange);

    originFromBboxBtn.addEventListener('click', () => {
      handlers?.onOriginFromBbox?.((x, y, z) => {
        originXInput.value = x.toFixed(3);
        originYInput.value = y.toFixed(3);
        originZInput.value = z.toFixed(3);
        emitChange();
      });
    });
    originFromCenterBtn.addEventListener('click', () => {
      handlers?.onOriginFromCenter?.((x, y, z) => {
        originXInput.value = x.toFixed(3);
        originYInput.value = y.toFixed(3);
        originZInput.value = z.toFixed(3);
        emitChange();
      });
    });
    // Joint value drive events
    valueSlider.addEventListener('input', () => {
      const v = Number(valueSlider.value);
      valueNumber.value = v.toFixed(1);
      handlers?.onValueChange?.(v);
    });
    valueNumber.addEventListener('change', () => {
      const v = Number(valueNumber.value);
      valueSlider.value = v;
      handlers?.onValueChange?.(v);
    });

    closeBtn.addEventListener('click', () => this.hideJointConfigPanel());

    // Close on outside click (delayed to avoid immediate close)
    const closeOnOutside = (e) => {
      if (panel.contains(e.target)) return;
      this.hideJointConfigPanel();
      document.removeEventListener('pointerdown', closeOnOutside, true);
    };
    setTimeout(() => document.addEventListener('pointerdown', closeOnOutside, true), 0);
  }
}
