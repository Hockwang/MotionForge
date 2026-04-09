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
    this.ryInput = this.appRoot.querySelector('#ry-input');
    this.jointEnabledInput = this.appRoot.querySelector('#joint-enabled-input');
    this.translateAxisSelect = this.appRoot.querySelector('#translate-axis-select');
    this.translateValueInput = this.appRoot.querySelector('#translate-value-input');
    this.rotateAxisSelect = this.appRoot.querySelector('#rotate-axis-select');
    this.rotateValueInput = this.appRoot.querySelector('#rotate-value-input');
    this.pivotEnabledInput = this.appRoot.querySelector('#pivot-enabled-input');
    this.jointPanelList = this.appRoot.querySelector('#joint-panel-list');
    this.jointObjectASelect = this.appRoot.querySelector('#joint-object-a-select');
    this.jointObjectBSelect = this.appRoot.querySelector('#joint-object-b-select');
    this.jointFromCenterBtn = this.appRoot.querySelector('#joint-from-center-btn');
    this.jointFromNearestBtn = this.appRoot.querySelector('#joint-from-nearest-btn');
    this.jointSaveCurrentBtn = this.appRoot.querySelector('#joint-save-current-btn');
    this.jointNameInput = this.appRoot.querySelector('#joint-name-input');
    this.jointInfoText = this.appRoot.querySelector('#joint-info-text');
    this.jointFollowAInput = this.appRoot.querySelector('#joint-follow-a-input');
    this.jointXInput = this.appRoot.querySelector('#joint-x-input');
    this.jointYInput = this.appRoot.querySelector('#joint-y-input');
    this.jointZInput = this.appRoot.querySelector('#joint-z-input');
    this.jointApplyBtn = this.appRoot.querySelector('#joint-apply-btn');
    this.jointDeleteBtn = this.appRoot.querySelector('#joint-delete-btn');
    this.pivotXInput = this.jointXInput;
    this.pivotYInput = this.jointYInput;
    this.pivotZInput = this.jointZInput;
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
    this.aiResultOutput = this.appRoot.querySelector('#ai-result-output');
    this.aiApplyBtn = this.appRoot.querySelector('#ai-apply-btn');
    // ── PKF 参数区域 DOM 引用 ──
    this.pkfParamList = this.appRoot.querySelector('#pkf-param-list');
    this.pkfAddParamBtn = this.appRoot.querySelector('#pkf-add-param-btn');

    // ── PKF 步骤区域 DOM 引用 ──
    this.pkfStepList = this.appRoot.querySelector('#pkf-step-list');
    this.pkfAddStepBtn = this.appRoot.querySelector('#pkf-add-step-btn');
    this.pkfGenFromKfBtn = this.appRoot.querySelector('#pkf-gen-from-kf-btn');
    this.pkfPreviewBtn = this.appRoot.querySelector('#pkf-preview-btn');
    this.pkfPreviewOutput = this.appRoot.querySelector('#pkf-preview-output');

    this.exportJsonBtn = this.appRoot.querySelector('#export-json-btn');
    this.exportPackageBtn = this.appRoot.querySelector('#export-package-btn');
    this.exportOutput = this.appRoot.querySelector('#export-output');
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
          <section class="joint-popup">
            <h2>关节面板</h2>
            <label>对象 A
              <select id="joint-object-a-select"></select>
            </label>
            <label>对象 B
              <select id="joint-object-b-select"></select>
            </label>
            <div class="joint-popup-actions">
              <button id="joint-from-center-btn" type="button">中心点中点</button>
              <button id="joint-from-nearest-btn" type="button">最近点中点</button>
            </div>
            <button id="joint-save-current-btn" type="button">保存当前 Pivot 为关节</button>
            <ul id="joint-panel-list" class="joint-panel-list"></ul>

            <hr />
            <p id="joint-info-text" class="hint">当前关节：无</p>
            <label>
              <input id="joint-follow-a-input" type="checkbox" checked />
              跟随对象 A（推荐）
            </label>
            <label>关节名称
              <input id="joint-name-input" type="text" value="" />
            </label>
            <label>X
              <input id="joint-x-input" type="number" step="0.1" value="0" />
            </label>
            <label>Y
              <input id="joint-y-input" type="number" step="0.1" value="0" />
            </label>
            <label>Z
              <input id="joint-z-input" type="number" step="0.1" value="0" />
            </label>
            <div class="joint-popup-actions">
              <button id="joint-apply-btn" type="button">应用到 Pivot</button>
              <button id="joint-delete-btn" type="button">删除关节</button>
            </div>
          </section>
        </main>

        <aside class="panel right-panel">
          <h2>变换</h2>
          <p id="selection-label" class="hint">当前选择：无</p>

          <label>X 世界坐标
            <input id="tx-input" type="number" step="0.1" value="0" readonly />
          </label>

          <label>Z 世界坐标（高度）
            <input id="ty-input" type="number" step="0.1" value="0" readonly />
          </label>

          <label>Z 世界旋转（度）
            <input id="ry-input" type="number" step="1" value="0" readonly />
          </label>

          <hr />
          <h2>动作语义</h2>

          <label>
            <input id="joint-enabled-input" type="checkbox" checked />
            启用关节驱动
          </label>

          <label>平移轴向
            <select id="translate-axis-select">
              <option value="x">x</option>
              <option value="y">y</option>
              <option value="z" selected>z</option>
            </select>
          </label>

          <label>平移值（用于抬升）
            <input id="translate-value-input" type="number" step="0.1" value="0" />
          </label>

          <label>旋转轴向
            <select id="rotate-axis-select">
              <option value="x">x</option>
              <option value="y">y</option>
              <option value="z">z</option>
            </select>
          </label>

          <label>旋转值（度）
            <input id="rotate-value-input" type="number" step="0.1" value="0" />
          </label>

          <label>
            <input id="pivot-enabled-input" type="checkbox" />
            启用旋转中心（Pivot）
          </label>

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
          <label>自然语言描述
            <textarea id="ai-prompt-input" rows="3" placeholder="例如：叉车货叉抬升300毫米，然后旋转90度"></textarea>
          </label>
          <button id="ai-generate-btn" type="button">AI 生成动作</button>
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
          <button id="pkf-preview-btn" type="button" style="margin-top:6px">PKF 预览（用默认值）</button>
          <pre id="pkf-preview-output" class="export-output" style="max-height:100px;overflow:auto"></pre>

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
        </footer>
      </div>
    `;
  }

  setLoadStatus(text) {
    this.loadStatus.textContent = text;
  }

  setSelectedObject(object) {
    this.selectionLabel.textContent = `当前选择：${object?.name || object?.uuid || '无'}`;
    if (object) {
      const worldPos = object.getWorldPosition(new THREE.Vector3());
      const worldQuat = object.getWorldQuaternion(new THREE.Quaternion());
      const worldEuler = new THREE.Euler().setFromQuaternion(worldQuat, 'XYZ');

      this.txInput.value = worldPos.x.toFixed(3);
      this.tyInput.value = worldPos.y.toFixed(3);
      this.ryInput.value = ((worldEuler.y * 180) / Math.PI).toFixed(2);
    } else {
      this.txInput.value = 0;
      this.tyInput.value = 0;
      this.ryInput.value = 0;
    }
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

  setJointObjectOptions(objects, objectAId, objectBId) {
    this.jointObjectASelect.innerHTML = '';
    this.jointObjectBSelect.innerHTML = '';
    if (!objects.length) {
      const optionA = document.createElement('option');
      optionA.value = '';
      optionA.textContent = '无对象';
      const optionB = document.createElement('option');
      optionB.value = '';
      optionB.textContent = '无对象';
      this.jointObjectASelect.appendChild(optionA);
      this.jointObjectBSelect.appendChild(optionB);
      return;
    }

    objects.forEach((obj) => {
      const optionA = document.createElement('option');
      optionA.value = obj.uuid;
      optionA.textContent = obj.name || obj.uuid;
      if (obj.uuid === objectAId) optionA.selected = true;
      this.jointObjectASelect.appendChild(optionA);

      const optionB = document.createElement('option');
      optionB.value = obj.uuid;
      optionB.textContent = obj.name || obj.uuid;
      if (obj.uuid === objectBId) optionB.selected = true;
      this.jointObjectBSelect.appendChild(optionB);
    });
  }

  renderJointPoints(points, activePointId, handlers) {
    this.jointPanelList.innerHTML = '';
    if (!points.length) {
      this.jointPanelList.innerHTML = '<li class="hint">暂无关节点。</li>';
      return;
    }

    points.forEach((point) => {
      const li = document.createElement('li');
      li.className = `joint-point-item ${point.id === activePointId ? 'active' : ''}`;
      li.addEventListener('click', () => handlers?.onSelect?.(point));

      const label = document.createElement('span');
      label.textContent = `${point.name} (${point.x.toFixed(2)}, ${point.y.toFixed(2)}, ${point.z.toFixed(2)})`;

      li.append(label);
      this.jointPanelList.appendChild(li);
    });
  }

  setJointEditor(point) {
    if (!point) {
      this.jointInfoText.textContent = '当前关节：无';
      this.jointFollowAInput.checked = true;
      this.jointNameInput.value = '';
      this.jointXInput.value = '0';
      this.jointYInput.value = '0';
      this.jointZInput.value = '0';
      return;
    }
    this.jointInfoText.textContent = `当前关节：${point.name} (${point.x.toFixed(2)}, ${point.y.toFixed(2)}, ${point.z.toFixed(2)})`;
    this.jointFollowAInput.checked = Boolean(point.followObjectId);
    this.jointNameInput.value = point.name;
    this.jointXInput.value = String(point.x);
    this.jointYInput.value = String(point.y);
    this.jointZInput.value = String(point.z);
  }

  setActiveClipInfo(clip) {
    if (!clip) {
      this.jointEnabledInput.checked = true;
      this.translateAxisSelect.value = 'z';
      this.translateValueInput.value = 0;
      this.rotateAxisSelect.value = 'z';
      this.rotateValueInput.value = 0;
      this.pivotEnabledInput.checked = false;
      this.pivotXInput.value = 0;
      this.pivotYInput.value = 0;
      this.pivotZInput.value = 0;
      this.durationInput.value = 10;
      return;
    }
    this.jointEnabledInput.checked = clip.jointEnabled ?? true;
    this.translateAxisSelect.value = clip.translateAxis;
    this.translateValueInput.value = String(clip.currentTranslateValue ?? 0);
    this.rotateAxisSelect.value = clip.rotateAxis;
    this.rotateValueInput.value = String(clip.currentRotateValue ?? 0);
    this.pivotEnabledInput.checked = clip.pivotEnabled ?? false;
    this.pivotXInput.value = String(clip.pivotX ?? 0);
    this.pivotYInput.value = String(clip.pivotY ?? 0);
    this.pivotZInput.value = String(clip.pivotZ ?? 0);
    this.durationInput.value = String(clip.duration);
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

  renderKeyframes(track, onDelete) {
    this.keyframeList.innerHTML = '';
    if (!track.length) {
      this.keyframeList.innerHTML = '<li class="hint">当前选中对象还没有关键帧。</li>';
      return;
    }

    track.forEach((k) => {
      const li = document.createElement('li');
      li.className = 'keyframe-item';

      const text = document.createElement('span');
      const translateValue = Number.isFinite(k.translateValue) ? k.translateValue : 0;
      const rotateValue = Number.isFinite(k.rotateValue) ? k.rotateValue : 0;
      text.textContent = `t=${k.time.toFixed(2)}秒 | 抬升=${translateValue.toFixed(3)} | 旋转=${rotateValue.toFixed(3)}°`;

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
          <label>X <input class="jc-origin-x" type="number" step="0.01" value="${originX}" /></label>
          <label>Y <input class="jc-origin-y" type="number" step="0.01" value="${originY}" /></label>
          <label>Z <input class="jc-origin-z" type="number" step="0.01" value="${originZ}" /></label>
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

    // Position near the anchor element
    if (anchorRect) {
      panel.style.left = `${anchorRect.right + 8}px`;
      panel.style.top = `${anchorRect.top}px`;
    }

    document.body.appendChild(panel);
    this.jointConfigPanel = panel;

    const typeSelect = panel.querySelector('.jc-type');
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
        limits: {
          min: Number(minInput.value) || -180,
          max: Number(maxInput.value) || 180,
        },
      });
    };

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
