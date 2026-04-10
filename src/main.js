import './style.css';
import * as THREE from 'three';
import JSZip from 'jszip';
import { AssetLoader } from './core/AssetLoader.js';
import { KeyframeManager } from './core/KeyframeManager.js';
import { ResultPackageExporter } from './core/ResultPackageExporter.js';
import { SceneManager } from './core/SceneManager.js';
import { SelectionManager } from './core/SelectionManager.js';
import { EditorUI } from './ui/EditorUI.js';

const appRoot = document.querySelector('#app');
const ui = new EditorUI(appRoot);
const sceneManager = new SceneManager(ui.viewport);
const selectionManager = new SelectionManager(sceneManager);
const keyframeManager = new KeyframeManager();
const packageExporter = new ResultPackageExporter();
const assetLoader = new AssetLoader();

let editableObjects = [];
let sceneTreeNodes = [];
let isPlaying = false;
// PKF 播放模式：true 时播放循环用 PKF 公式驱动关节，覆盖关键帧动画
let pkfPlaybackMode = false;
let lastFrameTime = performance.now();
let sourceInfo = {
  fileName: '',
  format: '',
  rawFile: null,
};
const undoStack = [];
const MAX_UNDO = 80;

function worldToUiVector3(vec) {
  return { x: vec.x, y: vec.z, z: vec.y };
}

function uiToWorldVector3(x, y, z) {
  return new THREE.Vector3(x, z, y);
}

function findObjectById(id) {
  if (!id) return null;
  return editableObjects.find((obj) => obj.uuid === id) ?? null;
}

function getSceneNodeById(id) {
  if (!id) return null;
  let found = null;
  sceneManager.sceneRoot?.traverse((obj) => {
    if (obj.uuid === id) found = obj;
  });
  return found;
}

function captureHierarchySnapshot() {
  if (!sceneManager.sceneRoot) return [];
  return editableObjects.map((obj) => {
    const parent = obj.parent;
    const parentId = parent && parent !== sceneManager.sceneRoot ? parent.uuid : null;
    return {
      id: obj.uuid,
      parentId,
      position: { x: obj.position.x, y: obj.position.y, z: obj.position.z },
      quaternion: { x: obj.quaternion.x, y: obj.quaternion.y, z: obj.quaternion.z, w: obj.quaternion.w },
      scale: { x: obj.scale.x, y: obj.scale.y, z: obj.scale.z },
    };
  });
}

function restoreHierarchySnapshot(snapshot) {
  if (!sceneManager.sceneRoot || !Array.isArray(snapshot)) return;
  const map = new Map();
  editableObjects.forEach((obj) => map.set(obj.uuid, obj));
  snapshot.forEach((item) => {
    const obj = map.get(item.id);
    if (!obj) return;
    const parent = item.parentId ? map.get(item.parentId) : sceneManager.sceneRoot;
    if (parent && obj.parent !== parent) parent.add(obj);
    obj.position.set(item.position.x, item.position.y, item.position.z);
    obj.quaternion.set(item.quaternion.x, item.quaternion.y, item.quaternion.z, item.quaternion.w);
    obj.scale.set(item.scale.x, item.scale.y, item.scale.z);
  });
}

function pushUndoSnapshot() {
  undoStack.push({
    selectedObjectId: selectionManager.selectedObject?.uuid || null,
    keyframeState: keyframeManager.serializeState(),
    hierarchyState: captureHierarchySnapshot(),
  });
  if (undoStack.length > MAX_UNDO) undoStack.shift();
}

function undoLastChange() {
  const snapshot = undoStack.pop();
  if (!snapshot) return;
  keyframeManager.restoreState(snapshot.keyframeState);
  restoreHierarchySnapshot(snapshot.hierarchyState);
  const selected = findObjectById(snapshot.selectedObjectId);
  selectionManager.selectObject(selected || null);
  keyframeManager.evaluateAllAt(keyframeManager.currentTime, sceneManager.sceneRoot);
  keyframeManager.applyAllJointDrives(sceneManager.sceneRoot);
  sceneTreeNodes = buildSceneTree(sceneManager.sceneRoot);
  ui.setTime(keyframeManager.currentTime);
  refreshSelectionUI();
  refreshPkfParamsUI(); // Undo 后刷新 PKF 参数列表
  refreshPkfStepsUI();  // Undo 后刷新 PKF 步骤列表
}

function isModelTreeNode(obj) {
  if (!obj || !obj.name) return false;
  if (obj.isLight || obj.isCamera || obj.isBone || obj.type?.includes('Helper')) return false;
  return obj.type === 'Object3D' || obj.type === 'Group' || obj.type === 'Mesh';
}

function collectEditableObjects(root) {
  const list = [];
  root.traverse((obj) => {
    if (isModelTreeNode(obj)) list.push(obj);
  });
  return list;
}

function buildSceneTree(root) {
  if (!root) return [];
  const isDimContainerName = (name) => {
    const lower = String(name || '').toLowerCase();
    return lower === 'scene' || lower === 'world' || lower === 'looks';
  };
  const walk = (node) => {
    const children = node.children
      .map((child) => walk(child))
      .flat()
      .filter(Boolean);
    if (!isModelTreeNode(node)) return children;
    return [
      {
        id: node.uuid,
        name: node.name,
        nodeType: node.type,
        isDimContainer: isDimContainerName(node.name),
        object: node,
        children,
      },
    ];
  };
  return walk(root);
}

/**
 * 在对象被 reparent 后，重新捕获其关节零点姿态
 * 因为 jointDef.baseTransform 存储的是 parent-local 坐标，
 * 换父节点后旧值不再适用，需要用新父节点下的 local 值覆盖。
 * 如果对象本身没有关节定义则跳过。
 * @param {THREE.Object3D} obj - 被 reparent 的对象
 */
function rebindJointBaseTransform(obj) {
  if (!obj) return;
  const def = keyframeManager.getJointDef(obj.uuid);
  if (!def || !def.baseTransform) return;
  keyframeManager.setJointDef(obj.uuid, {
    baseTransform: {
      tx: obj.position.x,
      ty: obj.position.y,
      tz: obj.position.z,
      rx: obj.rotation.x,
      ry: obj.rotation.y,
      rz: obj.rotation.z,
    },
  });
}

function refreshObjectTree() {
  ui.renderObjectList(sceneTreeNodes, selectionManager.selectedObject?.uuid, {
    onSelect: (obj) => selectionManager.selectObject(obj),
    getJointLabel: (nodeId) => keyframeManager.getJointDefLabel(nodeId),
    onJointTagClick: (node, event) => {
      const rect = event.target.getBoundingClientRect();
      const currentDef = keyframeManager.getJointDef(node.id);
      const parentId = node.object?.parent?.uuid || null;
      ui.showJointConfigPanel(node.id, node.name, currentDef, rect, {
        onChange: (patch) => {
          pushUndoSnapshot();
          // ── 首次创建关节时捕获零点姿态 ──
          // baseTransform：记录对象当前 local 姿态作为零点，applyJointDrive(currentValue=0)
          //               把对象设回该姿态，视觉上不动；之后拖 Joint Value 才产生运动。
          // origin（URDF 风格）：parent-local 空间，默认 (0,0,0)。这意味着旋转中心在
          //                      父节点的局部原点。如果用了 onInsertGroup 插了父级 group，
          //                      newGroup 的 (0,0,0) 就是子对象原本的连接点，正好。
          //                      用户可用「子对象底部/中心」按钮改为其他 parent-local 位置。
          const existingDef = keyframeManager.getJointDef(node.id);
          const bindPatch = {};
          if ((!existingDef || !existingDef.baseTransform) && node.object) {
            const obj = node.object;
            bindPatch.baseTransform = {
              tx: obj.position.x,
              ty: obj.position.y,
              tz: obj.position.z,
              rx: obj.rotation.x,
              ry: obj.rotation.y,
              rz: obj.rotation.z,
            };
            // 默认 origin = parent-local (0,0,0)
            if (!patch.origin && !existingDef?.origin) {
              bindPatch.origin = { x: 0, y: 0, z: 0 };
            }
          }
          keyframeManager.setJointDef(node.id, {
            ...patch,
            ...bindPatch,
            name: node.name || node.id,
            parentId,
            childId: node.id,
          });
          keyframeManager.applyAllJointDrives(sceneManager.sceneRoot);
          refreshObjectTree();
          syncJointGizmo();
          syncJointOriginMarker(node.id);
        },
        onValueChange: (value) => {
          keyframeManager.setJointValue(node.id, value);
          keyframeManager.applyJointDrive(node.id, sceneManager.sceneRoot);
        },
        onOriginFromBbox: (callback) => {
          // 把世界点转成 parent 的「刚性坐标系」（rotation + translation，无 scale）
          // 不能用 parent.worldToLocal——它会乘 parent.matrixWorld^-1 包含 scale 1/0.001=1000，
          // 数字会爆炸。这里只用 quat 和 position，确保数字保持世界米单位。
          const childObj = node.object;
          if (!childObj) return;
          const parent = childObj.parent;
          if (!parent) return;
          const box = new THREE.Box3().setFromObject(childObj);
          if (box.isEmpty()) return;
          const center = box.getCenter(new THREE.Vector3());
          const worldBottom = new THREE.Vector3(center.x, box.min.y, center.z);
          parent.updateMatrixWorld(true);
          const parentQuat = parent.getWorldQuaternion(new THREE.Quaternion());
          const parentPos = parent.getWorldPosition(new THREE.Vector3());
          // worldPoint - parentPos → 用父旋转的逆 → parent-rigid frame
          const offset = worldBottom.clone().sub(parentPos);
          const local = offset.applyQuaternion(parentQuat.clone().invert());
          const uiOrigin = worldToUiVector3(local);
          callback(uiOrigin.x, uiOrigin.y, uiOrigin.z);
          syncJointOriginMarker(node.id);
        },
        onOriginFromCenter: (callback) => {
          const childObj = node.object;
          if (!childObj) return;
          const parent = childObj.parent;
          if (!parent) return;
          const box = new THREE.Box3().setFromObject(childObj);
          if (box.isEmpty()) return;
          const worldCenter = box.getCenter(new THREE.Vector3());
          parent.updateMatrixWorld(true);
          const parentQuat = parent.getWorldQuaternion(new THREE.Quaternion());
          const parentPos = parent.getWorldPosition(new THREE.Vector3());
          const offset = worldCenter.clone().sub(parentPos);
          const local = offset.applyQuaternion(parentQuat.clone().invert());
          const uiOrigin = worldToUiVector3(local);
          callback(uiOrigin.x, uiOrigin.y, uiOrigin.z);
          syncJointOriginMarker(node.id);
        },
      });
      syncJointOriginMarker(node.id);
    },
    onMove: ({ draggedId, targetId, mode }) => {
      const dragged = getSceneNodeById(draggedId);
      const target = getSceneNodeById(targetId);
      if (!dragged || !target || dragged === target) return;

      let cursor = target;
      while (cursor) {
        if (cursor === dragged) return;
        cursor = cursor.parent;
      }

      pushUndoSnapshot();
      if (mode === 'child') {
        target.attach(dragged);
      } else {
        const siblingParent = target.parent || sceneManager.sceneRoot;
        siblingParent.attach(dragged);
        const siblings = siblingParent.children;
        const targetIndex = siblings.indexOf(target);
        const draggedIndex = siblings.indexOf(dragged);
        if (targetIndex >= 0 && draggedIndex >= 0) {
          siblings.splice(draggedIndex, 1);
          const insertionIndex = mode === 'before' ? targetIndex : targetIndex + 1;
          siblings.splice(Math.max(0, insertionIndex), 0, dragged);
        }
      }

      // reparent 后刷新关节零点
      rebindJointBaseTransform(dragged);

      sceneTreeNodes = buildSceneTree(sceneManager.sceneRoot);
      refreshObjectTree();
      refreshSelectionUI();
    },
    onInsertGroup: (obj) => {
      if (!obj) return;
      pushUndoSnapshot();
      const parent = obj.parent || sceneManager.sceneRoot;
      const idx = parent.children.indexOf(obj);

      // 创建插入的父级 group：**只继承 translation**，rotation 和 scale 留给子对象
      // 这样 newGroup 的 local 坐标系和 parent 的 local 坐标系**只差一个平移**，
      // 后续 origin 在 newGroup-local 空间下就是世界距离尺度，不会被 scale/rotation 扭曲。
      // 数学：newGroup(T) * obj(R*S) = T*R*S = original obj.matrix ✓ 世界变换不变
      const newGroup = new THREE.Group();
      newGroup.name = `${obj.name || 'node'}_joint_group`;
      newGroup.position.copy(obj.position);
      // newGroup.quaternion 保持 identity（默认）
      // newGroup.scale 保持 (1,1,1)（默认）

      // Remove obj from parent, add group in its place
      parent.remove(obj);
      parent.add(newGroup);

      // 把 obj 放到 newGroup 下，**只重置 position 为 (0,0,0)**，
      // rotation 和 scale 保留原样，让世界变换跟原来等价
      obj.position.set(0, 0, 0);
      // obj.quaternion 保留
      // obj.scale 保留
      newGroup.add(obj);

      // Restore sibling order: put newGroup at the original index
      if (idx >= 0) {
        const siblings = parent.children;
        const groupIdx = siblings.indexOf(newGroup);
        if (groupIdx >= 0 && groupIdx !== idx) {
          siblings.splice(groupIdx, 1);
          siblings.splice(Math.min(idx, siblings.length), 0, newGroup);
        }
      }

      // 重要：reparent 后必须刷新关节零点，否则 applyJointDrive 会把对象
      // 设到基于旧父节点的 local 坐标，视觉上"飞走"
      rebindJointBaseTransform(obj);

      editableObjects = collectEditableObjects(sceneManager.sceneRoot);
      sceneTreeNodes = buildSceneTree(sceneManager.sceneRoot);
      refreshObjectTree();
      refreshSelectionUI();
    },
    onMoveToRoot: (obj) => {
      if (!obj || obj.parent === sceneManager.sceneRoot) return;
      pushUndoSnapshot();
      sceneManager.sceneRoot.attach(obj);
      rebindJointBaseTransform(obj); // reparent 后刷新关节零点
      sceneTreeNodes = buildSceneTree(sceneManager.sceneRoot);
      refreshObjectTree();
      refreshSelectionUI();
    },
  });
}

function getCurrentDuration() {
  // 全局 clip 时长，与选择无关
  return keyframeManager.getClipDuration();
}

function syncJointGizmo() {
  const selected = selectionManager.selectedObject;
  if (!selected) {
    sceneManager.hideJointGizmo();
    return;
  }
  const def = keyframeManager.getJointDef(selected.uuid);
  if (!def || def.type === 'none' || def.type === 'fixed') {
    sceneManager.hideJointGizmo();
    return;
  }
  const mode = def.type === 'revolute' ? 'rotate' : 'translate';
  const baseValue = def.currentValue;
  sceneManager.jointGizmoOnDragStart = () => {
    pushUndoSnapshot();
    // Protect: prevent applyJointDrive from overwriting gizmo transforms during drag
    keyframeManager._gizmoDraggingNodeId = selected.uuid;
  };
  sceneManager.jointGizmoOnDragEnd = () => {
    keyframeManager._gizmoDraggingNodeId = null;
    // Re-apply drive to sync final state from currentValue
    keyframeManager.applyJointDrive(selected.uuid, sceneManager.sceneRoot);
  };
  sceneManager.showJointGizmo(selected, mode, def.axis, (deltaValue) => {
    const newValue = baseValue + deltaValue;
    keyframeManager.setJointValue(selected.uuid, newValue);
    // 关键：强制调用 applyJointDrive 覆盖 TransformControls 的 local 写入
    // 让 fork 每一帧都处于「绕 def.origin 旋转 currentValue 度」的正确姿态
    // 不这样做的话，TransformControls 只会绕 fork 自身 pivot 旋转，视觉上错位，
    // 拖动结束才 snap 到正确位置 → 表现为"离散跳变"
    keyframeManager.applyJointDrive(selected.uuid, sceneManager.sceneRoot, true);
    // 更新关节配置面板的滑条
    if (ui.activeJointConfigNodeId === selected.uuid && ui.jointConfigPanel) {
      const slider = ui.jointConfigPanel.querySelector('.jc-value-slider');
      const numInput = ui.jointConfigPanel.querySelector('.jc-value-number');
      const clamped = keyframeManager.getJointDef(selected.uuid)?.currentValue ?? 0;
      if (slider) slider.value = clamped;
      if (numInput) numInput.value = clamped.toFixed(1);
    }
  });
}

function syncJointOriginMarker(nodeId) {
  const id = nodeId || ui.activeJointConfigNodeId;
  if (!id) return;
  const def = keyframeManager.getJointDef(id);
  if (!def || def.type === 'none' || def.type === 'fixed') return;
  // origin 是 parent 的「刚性坐标系」（rotation + translation，无 scale）
  // 转世界：parentPos + parentQuat * originLocal
  const childObj = getSceneNodeById(id);
  if (!childObj) return;
  const parent = childObj.parent;
  if (!parent) return;
  parent.updateMatrixWorld(true);
  // UI Z-up → Three.js Y-up
  const localOrigin = uiToWorldVector3(
    def.origin?.x ?? 0,
    def.origin?.y ?? 0,
    def.origin?.z ?? 0,
  );
  const parentQuat = parent.getWorldQuaternion(new THREE.Quaternion());
  const parentPos = parent.getWorldPosition(new THREE.Vector3());
  const worldOrigin = localOrigin.applyQuaternion(parentQuat).add(parentPos);
  sceneManager.setPivotMarker(worldOrigin);
}

/**
 * 刷新选择相关 UI（变换显示、关节 gizmo、关键帧列表）
 * 注意：关键帧现在是全局的，不再依赖当前选中对象。
 *      只有 gizmo / 关节配置等是 per-selection 的。
 */
function refreshSelectionUI() {
  const selected = selectionManager.selectedObject;
  ui.setSelectedObject(selected);
  syncJointGizmo();

  // 全局 clip 列表（不再 per-object）
  const clipNames = keyframeManager.getClipNames();
  ui.setClipOptions(clipNames, keyframeManager.activeClipName);

  // 全局关键帧列表（不依赖选中对象）
  const handleDeleteKeyframe = (keyframe) => {
    pushUndoSnapshot();
    keyframeManager.removeKeyframe(keyframe.time);
    keyframeManager.evaluateAllAt(keyframeManager.currentTime, sceneManager.sceneRoot);
    refreshSelectionUI();
  };
  // 把关节定义传给 UI，让 keyframe 能用 jointDef.name 显示
  const jointDefs = keyframeManager.getAllJointDefs();
  ui.renderKeyframes(keyframeManager.getKeyframes(), handleDeleteKeyframe, jointDefs);

  const duration = getCurrentDuration();
  if (keyframeManager.currentTime > duration) {
    keyframeManager.currentTime = duration;
    ui.setTime(duration);
  }
  ui.setTimelineRange(duration);
  ui.updateTimelineLabel(keyframeManager.currentTime, duration);
  ui.durationInput.value = String(duration);
  refreshObjectTree();
}

async function handleAssetFile(file) {
  if (!file) return;
  ui.setLoadStatus(`准备加载 ${file.name}...`);

  try {
    const root = await assetLoader.loadFromFile(file, (status) => {
      ui.setLoadStatus(`${file.name}：${status}`);
    });
    ui.setLoadStatus(`正在构建场景节点...`);
    sceneManager.setSceneRoot(root);
    editableObjects = collectEditableObjects(root);
    sceneTreeNodes = buildSceneTree(root);
    keyframeManager.reset();
    undoStack.length = 0;
    sourceInfo = {
      fileName: file.name,
      format: (file.name.split('.').pop() || '').toLowerCase(),
      rawFile: file,
    };
    selectionManager.clearSelection();
    ui.setLoadStatus(`已加载 ${file.name}。可编辑对象：${editableObjects.length}`);
    refreshObjectTree();
  } catch (error) {
    ui.setLoadStatus(`加载失败：${error.message}`);
  }
}

async function handleImportPackage(file) {
  if (!file) return;
  ui.setLoadStatus(`正在读取资产包 ${file.name}...`);

  try {
    const zipData = await file.arrayBuffer();
    const zip = await JSZip.loadAsync(zipData);

    const manifestFile =
      zip.file('manifest.json') || Object.values(zip.files).find((f) => /^manifest-.*\.json$/i.test(f.name));
    if (!manifestFile) throw new Error('资产包中缺少 manifest.json');
    const manifest = JSON.parse(await manifestFile.async('string'));

    const modelFileName = manifest.files?.model;
    const modelZipEntry = modelFileName ? zip.file(modelFileName) : null;
    if (!modelZipEntry) throw new Error(`资产包中缺少模型文件: ${modelFileName || '(未指定)'}`);

    ui.setLoadStatus('正在加载模型...');
    const modelBuffer = await modelZipEntry.async('arraybuffer');
    const modelBlob = new Blob([modelBuffer]);
    const modelFile = new File([modelBlob], modelFileName, { type: 'application/octet-stream' });

    const root = await assetLoader.loadFromFile(modelFile, (status) => {
      ui.setLoadStatus(`${modelFileName}：${status}`);
    });
    sceneManager.setSceneRoot(root);
    editableObjects = collectEditableObjects(root);
    sceneTreeNodes = buildSceneTree(root);
    keyframeManager.reset();
    undoStack.length = 0;

    const objectsByName = new Map();
    editableObjects.forEach((obj) => {
      if (obj.name) objectsByName.set(obj.name, obj);
    });

    sourceInfo = {
      fileName: manifest.source?.file_name || modelFileName,
      format: manifest.source?.format || 'glb',
      rawFile: modelFile,
    };

    // ── 检测老格式 ZIP ──
    // v1: joints.json 是关节点空间锚点；joint-definitions.json 是 FK 关节定义
    // v2: joints.json 是 FK 关节定义；origin 是世界坐标
    // v3: origin 是 parent-local（URDF 风格），motion 是全局 keyframes schema
    // v4: model.glb 由 GLTFExporter 序列化，包含运行时插入的 group。
    //     origin 语义改为「父刚性坐标系」（parent rigid frame，无 scale）
    const schemaVersion = manifest.schema_version || 1;
    const hasLegacyJointDefsFile = !!manifest.files?.joint_definitions;
    // v < 4：origin / 场景树状态都不兼容当前代码，导入后 reset 关节定义
    const needsOriginReset = schemaVersion < 4;
    if (schemaVersion < 2 || hasLegacyJointDefsFile) {
      alert(
        '该资产包使用旧版关节格式（v1），新版编辑器不支持自动迁移。\n\n' +
        '模型加载正常；请重新在场景树中配置关节定义。'
      );
    } else if (needsOriginReset) {
      alert(
        '该资产包是旧版本（v' + schemaVersion + '），关节坐标语义已变更。\n\n' +
        '已自动重置所有关节的 origin 和 currentValue 为 0；并且旧版本不包含运行时插入的父级 group，' +
        '需要重新插入父级 + 用「子对象底部 / 中心」拾取原点。'
      );
    }

    // Restore joint definitions (FK layer-tree joints) — v2 stored under "joints"
    keyframeManager.jointDefinitions.clear();
    const jointsFileName = manifest.files?.joints;
    // v2 优先：joints-{ts}.json 直接是 FK 关节定义
    // v1 兜底：尝试老的 joint-definitions-{ts}.json
    let jointsFile = jointsFileName ? zip.file(jointsFileName) : null;
    if (!jointsFile) {
      jointsFile = Object.values(zip.files).find((f) => /^joints-.*\.json$/i.test(f.name)) || null;
    }
    if (!jointsFile && hasLegacyJointDefsFile) {
      jointsFile = zip.file(manifest.files.joint_definitions)
        || Object.values(zip.files).find((f) => /^joint-definitions.*\.json$/i.test(f.name));
    }
    if (jointsFile) {
      // Build path-based lookup for fallback matching
      const objectsByPath = new Map();
      editableObjects.forEach((obj) => {
        const path = getScenePath(obj);
        if (path) objectsByPath.set(path, obj);
      });

      const data = JSON.parse(await jointsFile.async('string'));
      // v2+ 用 definitions 数组；v1 老 joints.json 用 joints 数组（关节点，跳过它）
      const definitionsArr = Array.isArray(data.definitions) ? data.definitions : [];
      definitionsArr.forEach((d) => {
        // Priority: 1) name match, 2) scene_path match, 3) fallback to stored id
        let childObj = d.name ? objectsByName.get(d.name) : null;
        if (!childObj && d.scene_path) {
          childObj = objectsByPath.get(d.scene_path) || null;
        }
        const nodeId = childObj?.uuid || d.child_id || d.id;
        const parentObj = childObj?.parent;
        // v < 3：origin 是世界坐标，新代码当 parent-local 解读会错位 → 强制 reset
        // currentValue 也 reset 为 0，避免一加载就处于奇怪的姿态
        const useOrigin = needsOriginReset
          ? { x: 0, y: 0, z: 0 }
          : { x: d.origin?.x ?? 0, y: d.origin?.y ?? 0, z: d.origin?.z ?? 0 };
        const useCurrentValue = needsOriginReset ? 0 : (d.current_value ?? 0);
        keyframeManager.setJointDef(nodeId, {
          name: d.name || '',
          type: d.type || 'none',
          axis: d.axis || 'y',
          origin: useOrigin,
          limits: { min: d.limits?.min ?? -180, max: d.limits?.max ?? 180 },
          parentId: parentObj?.uuid || d.parent_id || null,
          childId: nodeId,
          currentValue: useCurrentValue,
          // v < 3 同样 reset baseTransform，让新代码懒捕获，匹配新模型当前 local 姿态
          baseTransform: needsOriginReset ? null : (d.base_transform || null),
        });
      });
    }

    // ── 恢复 motion.json（v2 schema：全局 clips + jointValues 关键帧） ──
    // 老 schema (v1) 是 per-object channels.translate/rotate/joint，不再支持
    const motionFileName = manifest.files?.motion || 'motion.json';
    const motionFile = zip.file(motionFileName) || zip.file('motion.json');
    let oldMotionDetected = false;
    if (motionFile) {
      const motionData = JSON.parse(await motionFile.async('string'));
      const clipsArr = motionData.clips || [];

      // 检测格式：v2 用 keyframes[].joint_values，v1 用 channels.translate/rotate
      const isV2 = clipsArr.length > 0 && clipsArr[0].keyframes && Array.isArray(clipsArr[0].keyframes)
        && clipsArr[0].keyframes.length > 0 && clipsArr[0].keyframes[0].joint_values !== undefined;
      const isV1 = !isV2 && clipsArr.length > 0 && clipsArr[0].channels !== undefined;

      if (isV1) {
        oldMotionDetected = true;
      }

      if (isV2) {
        // 清空默认 clip，从导入的数据重建全局 clips
        keyframeManager.globalClips.clear();
        // 建立 jointDef name → id 的映射，用于把导出时的 name 转回当前 uuid
        const jointDefIdByName = new Map();
        keyframeManager.getAllJointDefs().forEach((d) => {
          if (d.name) jointDefIdByName.set(d.name, d.id);
        });
        clipsArr.forEach((clipData) => {
          const clipName = clipData.clip_name || 'default';
          const newClip = {
            clipName,
            duration: Math.max(0.1, Number(clipData.duration) || 10),
            keyframes: (clipData.keyframes || []).map((k) => {
              // joint_values 是 { defName: number }，转成当前 jointDef id
              const jv = {};
              const src = k.joint_values || {};
              Object.entries(src).forEach(([defName, value]) => {
                const id = jointDefIdByName.get(defName);
                if (id !== undefined && value !== null && value !== undefined) {
                  jv[id] = Number(value);
                }
              });
              return { time: Number(k.t ?? k.time ?? 0), jointValues: jv };
            }).sort((a, b) => a.time - b.time),
          };
          keyframeManager.globalClips.set(clipName, newClip);
        });
        if (!keyframeManager.globalClips.size) {
          keyframeManager.globalClips.set('default', { clipName: 'default', duration: 10, keyframes: [] });
        }
        keyframeManager.activeClipName = clipsArr[0]?.clip_name || keyframeManager.globalClips.keys().next().value;
      }
    }
    // v1 检测到时给一次提示（不阻止其他数据加载）
    if (oldMotionDetected) {
      alert('该资产包使用旧版 motion.json 格式（per-object channels），已忽略关键帧数据。\n请重新配置关节并重新加关键帧。');
    }

    // ── 恢复 PKF 数据（向后兼容：旧包无 pkf 字段时跳过）──
    const pkfFileName = manifest.files?.pkf;
    const pkfFile = pkfFileName
      ? zip.file(pkfFileName)
      : Object.values(zip.files).find((f) => /^pkf-.*\.json$/i.test(f.name));
    let restoredPkfParams = 0;
    let restoredPkfSteps = 0;
    if (pkfFile) {
      const pkfData = JSON.parse(await pkfFile.async('string'));
      // 恢复参数
      (pkfData.parameters || []).forEach((p) => {
        keyframeManager.addPkfParameter({
          id: p.id,
          type: p.type || 'number',
          unit: p.unit || '',
          desc: p.desc || '',
          default: p.default ?? 0,
        });
      });
      restoredPkfParams = (pkfData.parameters || []).length;
      // 恢复步骤：用 joint 名字查当前 jointDef，重建 joint_def_id
      // pkf.json v4+ 只存 joint 名字；joint_def_id 是运行时 uuid，导入后才填充
      const jointDefIdByName = new Map();
      keyframeManager.getAllJointDefs().forEach((d) => {
        if (d.name) jointDefIdByName.set(d.name, d.id);
      });
      (pkfData.steps || []).forEach((s) => {
        const resolvedDefId = jointDefIdByName.get(s.joint) || s.joint_def_id || '';
        keyframeManager.addPkfStep({
          id: s.id,
          joint: s.joint || '',
          joint_def_id: resolvedDefId,
          channel: s.channel || 'translate',
          axis: s.axis || 'z',
          t_start: s.t_start ?? 0,
          t_end: s.t_end ?? 1,
          value_start: s.value_start ?? '0',
          value_end: s.value_end ?? '0',
          easing: s.easing || 'linear',
        });
      });
      restoredPkfSteps = (pkfData.steps || []).length;
    }

    selectionManager.clearSelection();
    keyframeManager.evaluateAllAt(0, sceneManager.sceneRoot);
    keyframeManager.applyAllJointDrives(sceneManager.sceneRoot);

    // 全局 clip + 关键帧统计（重构后是项目级，与对象数无关）
    const restoredClipCount = keyframeManager.globalClips.size;
    let restoredKfCount = 0;
    keyframeManager.globalClips.forEach((c) => { restoredKfCount += c.keyframes.length; });

    // 状态信息包含 PKF 统计
    const pkfInfo = (restoredPkfParams || restoredPkfSteps)
      ? `，PKF 参数：${restoredPkfParams}，PKF 步骤：${restoredPkfSteps}`
      : '';
    ui.setLoadStatus(
      `已导入资产包。对象：${editableObjects.length}，片段：${restoredClipCount}，关键帧：${restoredKfCount}${pkfInfo}`,
    );
    refreshObjectTree();
    refreshPkfParamsUI();  // 刷新 PKF 参数 UI
    refreshPkfStepsUI();   // 刷新 PKF 步骤 UI
  } catch (error) {
    ui.setLoadStatus(`导入资产包失败：${error.message}`);
  }
}

/**
 * 用 PKF 步骤驱动所有关节定义到指定时间点
 * 遍历每一步：求值起止公式，在 [t_start, t_end] 区间内按缓动插值，
 * 把结果写入对应 jointDefinition.currentValue。
 * 查找策略：优先 joint_def_id（uuid），失败则按 joint 名字 fallback。
 * 这样即使 PKF 步骤从 pkf.json 导入后 uuid 变了，只要名字还在就能正确驱动。
 *
 * @param {number} t - 当前时间（秒）
 */
function applyPkfAtTime(t) {
  const results = keyframeManager.evaluatePkfAt(t);
  // 建立 name → def 的索引（fallback 用）
  const defByName = new Map();
  keyframeManager.jointDefinitions.forEach((d) => {
    if (d.name) defByName.set(d.name, d);
  });
  results.forEach((r) => {
    if (r.error) return;
    // 先按 uuid 查，失败再按名字
    let def = r.joint_def_id ? keyframeManager.jointDefinitions.get(r.joint_def_id) : null;
    if (!def && r.joint) def = defByName.get(r.joint);
    if (!def) return;
    def.currentValue = r.value;
  });
}

function updateTimeline(deltaSeconds) {
  if (!isPlaying) return;

  const duration = getCurrentDuration();
  const next = (keyframeManager.currentTime + deltaSeconds) % duration;

  if (pkfPlaybackMode) {
    // PKF 模式：跳过关键帧求值，用 PKF 公式驱动关节
    keyframeManager.currentTime = next;
    applyPkfAtTime(next);
  } else {
    // 原有模式：用 motion.json 关键帧求值
    keyframeManager.evaluateAllAt(next, sceneManager.sceneRoot);
  }

  ui.setTime(keyframeManager.currentTime);
  ui.updateTimelineLabel(keyframeManager.currentTime, duration);
}

function loop(now) {
  const deltaSeconds = (now - lastFrameTime) / 1000;
  lastFrameTime = now;

  updateTimeline(deltaSeconds);
  keyframeManager.applyAllJointDrives(sceneManager.sceneRoot);
  sceneManager.render();
  requestAnimationFrame(loop);
}

selectionManager.attachViewportSelection(() => selectionManager.clearSelection());
selectionManager.onSelectionChanged(refreshSelectionUI);

ui.fileInput.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  handleAssetFile(file);
});

ui.importPackageInput.addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  handleImportPackage(file);
});

// ── 全局动画片段管理 ──

ui.durationInput.addEventListener('change', () => {
  pushUndoSnapshot();
  keyframeManager.setClipDuration(Number(ui.durationInput.value) || 10);
  const duration = getCurrentDuration();
  if (keyframeManager.currentTime > duration) {
    keyframeManager.currentTime = duration;
    ui.setTime(duration);
  }
  ui.setTimelineRange(duration);
  ui.updateTimelineLabel(keyframeManager.currentTime, duration);
});

ui.createClipBtn.addEventListener('click', () => {
  pushUndoSnapshot();
  const created = keyframeManager.createClip(ui.clipNameInput.value);
  keyframeManager.setActiveClip(created);
  ui.clipNameInput.value = '';
  refreshSelectionUI();
});

ui.clipSelect.addEventListener('change', () => {
  pushUndoSnapshot();
  keyframeManager.setActiveClip(ui.clipSelect.value);
  // 切片段后立即在当前时间求值，让对象同步到新片段的状态
  keyframeManager.evaluateAllAt(keyframeManager.currentTime, sceneManager.sceneRoot);
  refreshSelectionUI();
});

ui.timeInput.addEventListener('input', () => {
  const t = Number(ui.timeInput.value);
  if (pkfPlaybackMode) {
    // PKF 模式：用公式驱动关节
    keyframeManager.currentTime = t;
    applyPkfAtTime(t);
  } else {
    // 关键帧模式：插值所有 jointDef 的 jointValue
    keyframeManager.evaluateAllAt(t, sceneManager.sceneRoot);
  }
  ui.updateTimelineLabel(keyframeManager.currentTime, getCurrentDuration());
  refreshSelectionUI();
});

ui.playBtn.addEventListener('click', () => {
  isPlaying = !isPlaying;
  ui.setPlayState(isPlaying);
});

// 「在当前时间添加关键帧」：不再依赖选中对象，全局捕获所有 jointDef 当前状态
ui.keyframeBtn.addEventListener('click', () => {
  pushUndoSnapshot();
  keyframeManager.addKeyframe(keyframeManager.currentTime);
  refreshSelectionUI();
});

const AI_SERVICE_URL = import.meta.env.VITE_AI_SERVICE_URL || 'http://localhost:8091';
let pendingAiSteps = null;

async function requestAiTask(prompt) {
  const objectNames = editableObjects.map((obj) => obj.name || obj.uuid);
  const response = await fetch(`${AI_SERVICE_URL}/api/understand-task`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, objects: objectNames }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `AI 服务返回 ${response.status}`);
  }
  return response.json();
}

/**
 * 把 AI 返回的步骤转化为全局关键帧
 * 每个 step 形如 { part, action, axis, value }；找到对应对象的 jointDef
 * 把 value 写入对应 jointDef 的 jointValue 字段，构建 t=0 → t=末尾 的关键帧序列。
 */
function applyAiSteps(steps) {
  if (!steps?.length) return;
  pushUndoSnapshot();
  const objectsByName = new Map();
  editableObjects.forEach((obj) => {
    if (obj.name) objectsByName.set(obj.name, obj);
  });

  // 切到 / 创建一个 ai 片段
  const clipName = 'ai_generated';
  if (!keyframeManager.getClipNames().includes(clipName)) {
    keyframeManager.createClip(clipName);
  }
  keyframeManager.setActiveClip(clipName);

  const stepDuration = 2;
  let accumulatedTime = 0;
  // 累计每个 jointDef 的"上一刻状态"，用于在新时间点生成完整的 jointValues 快照
  const accumState = {};
  keyframeManager.getAllJointDefs().forEach((d) => { accumState[d.id] = 0; });

  // t=0 的零状态关键帧
  keyframeManager.addKeyframe(0);

  steps.forEach((step) => {
    const obj = objectsByName.get(step.part);
    if (!obj) return;
    const def = keyframeManager.getJointDef(obj.uuid);
    if (!def) return; // AI 指向的对象没有关节定义，跳过
    accumulatedTime += stepDuration;
    accumState[def.id] = step.value ?? 0;
    // 在累计时间点添加全局关键帧前，把 def.currentValue 同步到 accumState 再 addKeyframe 抓取
    Object.entries(accumState).forEach(([id, val]) => {
      const d = keyframeManager.jointDefinitions.get(id);
      if (d) d.currentValue = val;
    });
    keyframeManager.addKeyframe(accumulatedTime);
  });

  // 同步时长 + 求值 t=0
  keyframeManager.setClipDuration(Math.max(10, accumulatedTime + 1));
  keyframeManager.evaluateAllAt(0, sceneManager.sceneRoot);
  selectionManager.clearSelection();
  refreshSelectionUI();
  refreshObjectTree();
}

ui.aiGenerateBtn.addEventListener('click', async () => {
  const prompt = ui.aiPromptInput.value.trim();
  if (!prompt) {
    ui.aiResultOutput.textContent = '请输入动作描述。';
    return;
  }
  if (!editableObjects.length) {
    ui.aiResultOutput.textContent = '请先加载模型。';
    return;
  }
  ui.aiGenerateBtn.disabled = true;
  ui.aiResultOutput.textContent = '正在请求 AI 解析...';
  ui.aiApplyBtn.style.display = 'none';
  pendingAiSteps = null;
  try {
    const result = await requestAiTask(prompt);
    pendingAiSteps = result.steps || [];
    const preview = pendingAiSteps
      .map((s, i) => `${i + 1}. ${s.part}: ${s.action} ${s.axis} ${s.value}${s.unit || ''}`)
      .join('\n');
    ui.aiResultOutput.textContent = preview || '(AI 未返回有效步骤)';
    if (pendingAiSteps.length) ui.aiApplyBtn.style.display = '';
  } catch (error) {
    ui.aiResultOutput.textContent = `AI 请求失败：${error.message}`;
  } finally {
    ui.aiGenerateBtn.disabled = false;
  }
});

ui.aiApplyBtn.addEventListener('click', () => {
  if (!pendingAiSteps?.length) return;
  applyAiSteps(pendingAiSteps);
  ui.aiResultOutput.textContent = `已应用 ${pendingAiSteps.length} 个动作步骤。`;
  ui.aiApplyBtn.style.display = 'none';
  pendingAiSteps = null;
});

function getScenePath(obj) {
  const parts = [];
  let cur = obj;
  while (cur && cur !== sceneManager.sceneRoot) {
    parts.unshift(cur.name || cur.uuid);
    cur = cur.parent;
  }
  return parts.join('/');
}

/**
 * 构建导出 motion.json 用的全局 clips 数据
 * v2 schema: 每个 clip 有 duration + keyframes，每个 keyframe 有 jointValues 字典
 * jointValues 的 key 在导出时从 jointDef.id (uuid) 转成 jointDef.name（更稳定）
 */
function buildExportClips() {
  // 建立 jointDef.id → name 映射
  const idToName = new Map();
  keyframeManager.getAllJointDefs().forEach((d) => {
    if (d.name) idToName.set(d.id, d.name);
  });

  const clipsArr = [];
  keyframeManager.globalClips.forEach((clip) => {
    clipsArr.push({
      clip_name: clip.clipName,
      duration: clip.duration,
      keyframes: clip.keyframes.map((k) => {
        // 把 jointValues 的 key 从 uuid 转成 name
        const jvByName = {};
        Object.entries(k.jointValues || {}).forEach(([id, val]) => {
          const name = idToName.get(id);
          if (name) jvByName[name] = val;
        });
        return { t: k.time, joint_values: jvByName };
      }),
    });
  });
  return clipsArr;
}

// ══════════════════════════════════════════════════════════════
//  PKF 参数 UI 接线
// ══════════════════════════════════════════════════════════════

/**
 * 刷新右侧面板的 PKF 参数列表
 * 从 keyframeManager 获取最新参数，传给 UI 渲染，并绑定修改/删除回调
 */
function refreshPkfParamsUI() {
  const params = keyframeManager.getAllPkfParameters();
  ui.renderPkfParameters(params, {
    /**
     * 修改参数字段回调
     * @param {string} id    - 被修改的参数 id
     * @param {Object} patch - 要更新的字段
     */
    onUpdate: (id, patch) => {
      pushUndoSnapshot(); // 修改前保存快照，支持 Ctrl+Z
      const ok = keyframeManager.updatePkfParameter(id, patch);
      if (!ok) {
        // 修改失败（比如改名冲突），撤回快照并提示
        undoStack.pop();
        alert(`参数更新失败：ID "${patch.id || id}" 可能已存在。`);
      }
      refreshPkfParamsUI(); // 无论成功失败都刷新，确保 UI 与数据一致
    },
    /**
     * 删除参数回调
     * @param {string} id - 要删除的参数 id
     */
    onDelete: (id) => {
      pushUndoSnapshot();
      keyframeManager.removePkfParameter(id);
      refreshPkfParamsUI();
    },
  });
}

/**
 * 「添加参数」按钮：创建一个带默认值的新参数
 * 自动生成不重复的 id（param1, param2, ...）
 */
ui.pkfAddParamBtn.addEventListener('click', () => {
  pushUndoSnapshot();
  // 生成不重复的默认 id
  let idx = 1;
  while (keyframeManager.getAllPkfParameters().some((p) => p.id === `param${idx}`)) {
    idx++;
  }
  keyframeManager.addPkfParameter({
    id: `param${idx}`,
    type: 'number',
    unit: '',
    desc: '',
    default: 0,
  });
  refreshPkfParamsUI();
});

// 初始渲染一次 PKF 参数列表
refreshPkfParamsUI();

// ══════════════════════════════════════════════════════════════
//  PKF 步骤 UI 接线
// ══════════════════════════════════════════════════════════════

/**
 * 刷新右侧面板的 PKF 步骤列表
 * 从 keyframeManager 获取最新步骤和关节定义，传给 UI 渲染
 */
function refreshPkfStepsUI() {
  const steps = keyframeManager.getAllPkfSteps();
  const jointDefs = keyframeManager.getAllJointDefs();
  ui.renderPkfSteps(steps, jointDefs, {
    /**
     * 修改步骤字段回调
     * @param {string} stepId - 步骤 id
     * @param {Object} patch  - 要更新的字段
     */
    onUpdate: (stepId, patch) => {
      pushUndoSnapshot();
      keyframeManager.updatePkfStep(stepId, patch);
      refreshPkfStepsUI();
    },
    /**
     * 删除步骤回调
     * @param {string} stepId - 步骤 id
     */
    onDelete: (stepId) => {
      pushUndoSnapshot();
      keyframeManager.removePkfStep(stepId);
      refreshPkfStepsUI();
    },
  });
}

/**
 * 「添加步骤」按钮：创建一个带默认值的空步骤
 */
ui.pkfAddStepBtn.addEventListener('click', () => {
  pushUndoSnapshot();
  keyframeManager.addPkfStep({});
  refreshPkfStepsUI();
});

/**
 * 「从关键帧生成」按钮：把当前 clip 的全局关键帧转换成 PKF 步骤骨架
 * 新流程（v4 全局 keyframes）：
 *   - 当前 clip 的 keyframes 是 [{t, jointValues: {defId: number}}]
 *   - 对每个关节，取它在各帧中的值序列，相邻两帧如果值不同就生成一个 step
 *   - step.channel 由 jointDef.type 决定（revolute → rotate，prismatic → translate）
 *   - step.axis 取 jointDef.axis
 *   - value_start / value_end 填当前具体数字（字符串），用户后续手动改成 "stroke"、"angle" 等参数引用
 *   - **不删除已有的 PKF steps**，而是追加
 */
ui.pkfGenFromKfBtn.addEventListener('click', () => {
  const clip = keyframeManager.getActiveGlobalClip();
  if (!clip || !clip.keyframes || clip.keyframes.length < 2) {
    alert('当前动画片段关键帧不足（至少 2 帧）。\n请先拖 gizmo 改变关节状态并点「在当前时间添加关键帧」。');
    return;
  }
  const jointDefs = keyframeManager.getAllJointDefs();
  if (!jointDefs.length) {
    alert('没有关节定义。请先在场景树为节点配置关节（旋转/平移）。');
    return;
  }

  pushUndoSnapshot();

  // 按时间排序的关键帧
  const sortedKfs = [...clip.keyframes].sort((a, b) => a.time - b.time);

  let generatedCount = 0;

  // 为每个关节定义独立生成 step 序列
  jointDefs.forEach((def) => {
    if (def.type !== 'revolute' && def.type !== 'prismatic') return; // fixed/none 跳过
    // 提取该关节在每帧的值（若某帧没捕获该关节则用 null）
    const samples = sortedKfs.map((k) => ({
      t: k.time,
      value: k.jointValues?.[def.id] ?? null,
    }));
    // 过滤掉 null，保留该关节有数据的时间点
    const withValues = samples.filter((s) => s.value !== null && s.value !== undefined);
    if (withValues.length < 2) return; // 该关节没有足够数据

    const channel = def.type === 'revolute' ? 'rotate' : 'translate';

    // 相邻对生成 step（值相同的区间也生成，保持完整时间线）
    for (let i = 0; i < withValues.length - 1; i++) {
      const a = withValues[i];
      const b = withValues[i + 1];
      keyframeManager.addPkfStep({
        joint: def.name || def.id,
        joint_def_id: def.id, // 运行时 uuid，导出时会被剥离
        channel,
        axis: def.axis || 'z',
        t_start: a.t,
        t_end: b.t,
        value_start: String(a.value),
        value_end: String(b.value),
        easing: 'linear',
      });
      generatedCount++;
    }
  });

  if (generatedCount === 0) {
    alert('没有可生成的步骤。可能所有关节在关键帧中都没有捕获状态。');
  } else {
    alert(
      `已生成 ${generatedCount} 个 PKF 步骤（具体数值）。\n\n` +
      '下一步：在"PKF 步骤"区域编辑每个步骤，把 value_start / value_end 里的固定数字替换成参数引用（如 "stroke" 或 "angle * 0.5"）。',
    );
  }
  refreshPkfStepsUI();
});

// 初始渲染一次 PKF 步骤列表
refreshPkfStepsUI();

// ══════════════════════════════════════════════════════════════
//  PKF 预览
// ══════════════════════════════════════════════════════════════

/**
 * 「PKF 预览」按钮：用参数默认值求值所有步骤，显示结果并驱动关节
 * 使用当前时间轴时间进行求值，结果显示在输出面板中
 */
/**
 * 「用 PKF 驱动播放」开关
 * 切换播放循环和时间轴拖动的求值来源（PKF 公式 vs 关键帧）
 */
ui.pkfPlaybackModeInput.addEventListener('change', () => {
  pkfPlaybackMode = ui.pkfPlaybackModeInput.checked;
  // 切换后立即用当前时间重新求值，让视口同步
  const t = keyframeManager.currentTime;
  if (pkfPlaybackMode) {
    applyPkfAtTime(t);
  } else {
    keyframeManager.evaluateAllAt(t, sceneManager.sceneRoot);
  }
});

ui.pkfPreviewBtn.addEventListener('click', () => {
  const steps = keyframeManager.getAllPkfSteps();
  if (!steps.length) {
    ui.pkfPreviewOutput.textContent = '没有 PKF 步骤可预览。';
    return;
  }

  // 用当前时间轴时间进行求值
  const t = keyframeManager.currentTime;
  const results = keyframeManager.evaluatePkfAt(t);

  // 构建输出文本
  const lines = [`预览时间: ${t.toFixed(2)}s`, `参数值: ${JSON.stringify(keyframeManager.buildDefaultParamValues())}`, ''];
  let hasError = false;

  // 建立 name → def 索引（fallback）
  const defByName = new Map();
  keyframeManager.jointDefinitions.forEach((d) => {
    if (d.name) defByName.set(d.name, d);
  });

  results.forEach((r) => {
    const status = r.error ? `⚠ ${r.error}` : `= ${r.value.toFixed(4)}`;
    lines.push(`[${r.joint || r.joint_def_id}] ${r.channel}.${r.axis} ${status}`);
    if (r.error) hasError = true;

    // 查找关节定义：先 uuid 后 name
    if (!r.error && sceneManager.sceneRoot) {
      let def = r.joint_def_id ? keyframeManager.jointDefinitions.get(r.joint_def_id) : null;
      if (!def && r.joint) def = defByName.get(r.joint);
      if (def) {
        def.currentValue = r.value;
        keyframeManager.applyJointDrive(def.id, sceneManager.sceneRoot);
      }
    }
  });

  if (!results.length) {
    lines.push(`（当前时间 ${t.toFixed(2)}s 没有活跃的步骤）`);
  }

  ui.pkfPreviewOutput.textContent = lines.join('\n');
  if (hasError) {
    ui.pkfPreviewOutput.style.borderColor = '#f87171';
  } else {
    ui.pkfPreviewOutput.style.borderColor = '#334155';
  }
});

ui.exportJsonBtn.addEventListener('click', () => {
  const clips = buildExportClips();
  const jointDefs = keyframeManager.getAllJointDefs();
  if (!clips.length && !jointDefs.length) {
    ui.exportOutput.textContent = '没有可导出的数据，请先创建关节或添加关键帧。';
    return;
  }
  ui.exportOutput.textContent = JSON.stringify({ jointDefs, clips }, null, 2);
});

ui.exportPackageBtn.addEventListener('click', async () => {
  const clips = buildExportClips();
  const jointDefs = keyframeManager.getAllJointDefs();

  if (!clips.length && !jointDefs.length) {
    ui.exportOutput.textContent = '没有可导出的数据，请先创建关节或添加关键帧。';
    return;
  }

  try {
    const { manifest } = await packageExporter.exportZip({
      sourceFileName: sourceInfo.fileName,
      sourceFormat: sourceInfo.format,
      // v4: 传 sceneRoot 让 GLTFExporter 序列化当前场景树（含 onInsertGroup 修改）
      sceneRoot: sceneManager.sceneRoot,
      jointDefinitions: jointDefs.map((d) => {
        const obj = getSceneNodeById(d.childId);
        return { ...d, scenePath: obj ? getScenePath(obj) : null };
      }),
      clips,
      // PKF 数据（参数化关键帧公式）
      pkfParameters: keyframeManager.getAllPkfParameters(),
      pkfSteps: keyframeManager.getAllPkfSteps(),
    });
    ui.exportOutput.textContent = `已导出结果包 ZIP。\n${JSON.stringify(manifest, null, 2)}`;
  } catch (error) {
    ui.exportOutput.textContent = `导出 ZIP 失败：${error.message}`;
  }
});

window.addEventListener('resize', () => sceneManager.resize());
window.addEventListener('keydown', (event) => {
  const isUndo = (event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'z';
  if (!isUndo) return;
  event.preventDefault();
  undoLastChange();
});

// 调试钩子：浏览器控制台可用 __mf 访问内部状态
// __mf.getJointDefs() 返回当前所有关节定义的快照副本
window.__mf = {
  sceneManager,
  keyframeManager,
  selectionManager,
  editableObjects: () => editableObjects,
  getJointDefs: () => keyframeManager.getAllJointDefs(),
};

ui.setTimelineRange(10);
ui.updateTimelineLabel(0, 10);
refreshSelectionUI();
requestAnimationFrame(loop);
