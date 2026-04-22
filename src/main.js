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
  refreshReparentEventList(); // Undo 后刷新 reparent 事件列表
  refreshMarkerList?.(); // Undo 后刷新 marker 列表
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
 * 在对象被 reparent（场景树层级变化）后，清空其关节零点让下一帧懒捕获
 * v5 架构：baseTransform 相对于**关节父级**（不是场景树 parent），
 * 但场景树 parent 变了会影响 worldToLocal 的计算路径，需要重新捕获。
 * @param {THREE.Object3D} obj - 被 reparent 的对象
 */
function rebindJointBaseTransform(obj) {
  if (!obj) return;
  const def = keyframeManager.getJointDef(obj.uuid);
  if (!def) return;
  def.baseTransform = null; // 让 applyJointDrive 在下一帧懒捕获
  delete def._driftWarned;  // F15 修复：base 换了，旧的 drift 警告失效，允许新 drift 再报
}

function refreshObjectTree() {
  ui.renderObjectList(sceneTreeNodes, selectionManager.selectedObject?.uuid, {
    onSelect: (obj) => selectionManager.selectObject(obj),
    getJointLabel: (nodeId) => keyframeManager.getJointDefLabel(nodeId),
    onJointTagClick: (node, event) => {
      const rect = event.target.getBoundingClientRect();
      const currentDef = keyframeManager.getJointDef(node.id);

      // 辅助：根据关节父级 ID 获取对应 THREE 对象
      const getJointParentObj = (parentId) => parentId ? getSceneNodeById(parentId) : null;

      // 辅助：把世界坐标转成关节父级的 local（UI Z-up）
      const worldToJointParentLocal = (worldPoint, jpId) => {
        const jp = getJointParentObj(jpId);
        if (!jp) return worldToUiVector3(worldPoint); // 无关节父级，直接用世界
        jp.updateMatrixWorld(true);
        const local = jp.worldToLocal(worldPoint.clone());
        return worldToUiVector3(local);
      };

      ui.showJointConfigPanel(node.id, node.name, currentDef, rect, {
        // 提供可选 parent 列表（所有可编辑对象）
        getParentOptions: () => editableObjects.map((obj) => ({
          id: obj.uuid,
          name: obj.name || obj.uuid,
        })),

        onChange: (patch) => {
          pushUndoSnapshot();
          const childObj = node.object;
          const existingDef = keyframeManager.getJointDef(node.id);
          const resolvedParentId = patch.parentId !== undefined ? (patch.parentId || null) : (existingDef?.parentId || null);
          const parentChanged = existingDef && existingDef.parentId !== resolvedParentId;
          const isFirstCreate = !existingDef || !existingDef.baseTransform;

          // ── 在任何修改之前，记录 child 当前的世界位置和旋转（用于调试检查）──
          let preWorldPos = null;
          let preWorldQuat = null;
          if (childObj) {
            childObj.updateMatrixWorld(true);
            preWorldPos = childObj.getWorldPosition(new THREE.Vector3()).clone();
            preWorldQuat = childObj.getWorldQuaternion(new THREE.Quaternion()).clone();
          }

          // ── 计算 baseTransform ──
          const bindPatch = {};
          if (isFirstCreate || parentChanged) {
            // 不再用懒捕获——立即从 child 当前世界位置算出相对于**新关节父级**的 local
            // 同时 reset currentValue=0，保证 joint 应用后 child 世界位置不变
            if (childObj) {
              childObj.updateMatrixWorld(true);
              const cwp = childObj.getWorldPosition(new THREE.Vector3());
              const cwq = childObj.getWorldQuaternion(new THREE.Quaternion());
              const jp = resolvedParentId ? getSceneNodeById(resolvedParentId) : null;
              if (jp) {
                jp.updateMatrixWorld(true);
                const posInJP = jp.worldToLocal(cwp.clone());
                const jpQuatInv = jp.getWorldQuaternion(new THREE.Quaternion()).invert();
                const quatInJP = jpQuatInv.multiply(cwq);
                // 用四元数存旋转，避免 Euler 万向锁
                bindPatch.baseTransform = {
                  tx: posInJP.x, ty: posInJP.y, tz: posInJP.z,
                  qx: quatInJP.x, qy: quatInJP.y, qz: quatInJP.z, qw: quatInJP.w,
                };
              } else {
                // 无关节父级 → 用场景树 local（四元数）
                bindPatch.baseTransform = {
                  tx: childObj.position.x, ty: childObj.position.y, tz: childObj.position.z,
                  qx: childObj.quaternion.x, qy: childObj.quaternion.y,
                  qz: childObj.quaternion.z, qw: childObj.quaternion.w,
                };
              }
              bindPatch.currentValue = 0; // reset，保证 value=0 时 child 不动
            }
          }
          // 默认 origin = (0,0,0) in joint parent local
          if (!patch.origin && !existingDef?.origin) {
            bindPatch.origin = { x: 0, y: 0, z: 0 };
          }
          keyframeManager.setJointDef(node.id, {
            ...patch,
            ...bindPatch,
            name: node.name || node.id,
            parentId: resolvedParentId,
            childId: node.id,
          });
          keyframeManager.applyAllJointDrives(sceneManager.sceneRoot);

          // ── 开发期安全检查：操作后世界位置/旋转是否偏移 ──
          if (childObj && preWorldPos && preWorldQuat) {
            childObj.updateMatrixWorld(true);
            const postWorldPos = childObj.getWorldPosition(new THREE.Vector3());
            const postWorldQuat = childObj.getWorldQuaternion(new THREE.Quaternion());
            const posDrift = preWorldPos.distanceTo(postWorldPos);
            const quatDot = Math.abs(preWorldQuat.dot(postWorldQuat));
            const rotDrift = Math.acos(Math.min(quatDot, 1.0)) * 2 * (180 / Math.PI);
            if (posDrift > 0.01 || rotDrift > 1.0) {
              console.warn(
                `[Joint] ⚠ 设置关节后 ${node.name} 偏移！pos=${posDrift.toFixed(4)} rot=${rotDrift.toFixed(1)}°`,
                `\n  pos: (${preWorldPos.x.toFixed(4)},${preWorldPos.y.toFixed(4)},${preWorldPos.z.toFixed(4)}) → (${postWorldPos.x.toFixed(4)},${postWorldPos.y.toFixed(4)},${postWorldPos.z.toFixed(4)})`,
                `\n  parentId: ${resolvedParentId}, isFirstCreate: ${isFirstCreate}, parentChanged: ${parentChanged}`,
              );
            }
          }

          refreshObjectTree();
          syncJointGizmo();
          syncJointOriginMarker(node.id);
          refreshAiJointChips();
        },

        // parent 下拉变化（emitChange 紧跟其后，onChange 里已处理 baseTransform 重算）
        onParentChanged: () => {},

        onValueChange: (value) => {
          keyframeManager.setJointValue(node.id, value);
          keyframeManager.applyJointDrive(node.id, sceneManager.sceneRoot, true);
        },

        onOriginFromBbox: (callback) => {
          const childObj = node.object;
          if (!childObj) return;
          const def = keyframeManager.getJointDef(node.id);
          const box = new THREE.Box3().setFromObject(childObj);
          if (box.isEmpty()) return;
          const center = box.getCenter(new THREE.Vector3());
          const worldBottom = new THREE.Vector3(center.x, box.min.y, center.z);
          const uiOrigin = worldToJointParentLocal(worldBottom, def?.parentId);
          callback(uiOrigin.x, uiOrigin.y, uiOrigin.z);
          syncJointOriginMarker(node.id);
        },

        onOriginFromCenter: (callback) => {
          const childObj = node.object;
          if (!childObj) return;
          const def = keyframeManager.getJointDef(node.id);
          const box = new THREE.Box3().setFromObject(childObj);
          if (box.isEmpty()) return;
          const worldCenter = box.getCenter(new THREE.Vector3());
          const uiOrigin = worldToJointParentLocal(worldCenter, def?.parentId);
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

    // ── v5: Reparent 事件（时间线驱动的运行时 scene graph 切换）──
    // getCurrentTime / getReparentCandidates：UI 渲染右键子菜单时调用
    getCurrentTime: () => keyframeManager.currentTime,
    getReparentCandidates: (node) => {
      // 返回所有命名对象名字（排除自己），作为 attach 候选父级
      if (!node?.object) return [];
      return editableObjects
        .filter((o) => o.name && o !== node.object)
        .map((o) => o.name);
    },
    // 点击子菜单某个候选 → 直接 attach（不再弹输入框）
    onReparentAttachTo: (node, targetName) => {
      if (!node?.object?.name) {
        alert('该对象没有名字，无法添加 reparent 事件（跨 roundtrip 需要 name）');
        return;
      }
      pushUndoSnapshot();
      keyframeManager.addReparentEvent(keyframeManager.currentTime, node.object.name, targetName);
      keyframeManager.applyReparentEventsAtTime(keyframeManager.currentTime, sceneManager.sceneRoot);
      refreshReparentEventList();
      refreshObjectTree();
      ui.setLoadStatus(`已在 t=${keyframeManager.currentTime.toFixed(2)}s 把 "${node.object.name}" attach 到 "${targetName}"`);
    },

    onReparentDetach: (node) => {
      if (!node?.object?.name) {
        alert('该对象没有名字，无法添加 reparent 事件');
        return;
      }
      pushUndoSnapshot();
      keyframeManager.addReparentEvent(keyframeManager.currentTime, node.object.name, null);
      keyframeManager.applyReparentEventsAtTime(keyframeManager.currentTime, sceneManager.sceneRoot);
      refreshReparentEventList();
      refreshObjectTree();
    },

    onReparentClearAll: (node) => {
      if (!node?.object?.name) return;
      pushUndoSnapshot();
      const removed = keyframeManager.removeAllReparentEventsForChild(node.object.name);
      if (removed > 0) {
        keyframeManager.applyReparentEventsAtTime(keyframeManager.currentTime, sceneManager.sceneRoot);
        refreshReparentEventList();
        refreshObjectTree();
      }
    },
  });
}

function refreshReparentEventList() {
  const events = keyframeManager.getReparentEvents();
  ui.renderReparentEvents(events, {
    onDelete: (eventId) => {
      pushUndoSnapshot();
      keyframeManager.removeReparentEvent(eventId);
      keyframeManager.applyReparentEventsAtTime(keyframeManager.currentTime, sceneManager.sceneRoot);
      refreshReparentEventList();
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
  // origin 在**关节父级**的 local 空间（UI Z-up），不是场景树 parent
  const localOrigin = uiToWorldVector3(
    def.origin?.x ?? 0,
    def.origin?.y ?? 0,
    def.origin?.z ?? 0,
  );
  const jointParent = def.parentId ? getSceneNodeById(def.parentId) : null;
  if (jointParent) {
    jointParent.updateMatrixWorld(true);
    const worldOrigin = jointParent.localToWorld(localOrigin.clone());
    sceneManager.setPivotMarker(worldOrigin);
  } else {
    // 无关节父级 → origin 当世界坐标
    sceneManager.setPivotMarker(localOrigin);
  }
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
    // v5: 记录初始 scene graph parent 快照（reparent 事件循环时还原用）
    keyframeManager.snapshotOriginalParents(root);
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
    // v5 修复：导出时已归零关节 + GLB 存的是自然状态，alignObjectToGround 正常运行即可。
    // （之前用 skipAlign:true 是因为 GLB 烘焙了已驱动的 transform + 对齐偏移，现在不需要了）
    sceneManager.setSceneRoot(root);

    // v5 修复：GLTFExporter 会把根节点改名为 "AuxScene"，恢复为原始名字
    // 优先用导出时保存的 root_name（如 FBX 源的 "Scene"）→ 保证 parent_name="Scene"
    // 的关节 roundtrip 后能找到父级。旧 ZIP 没有 root_name → 兜底到文件名
    const originalFileName = manifest.source?.file_name || modelFileName;
    const originalRootName = manifest.source?.root_name || originalFileName;
    if (root.name !== originalRootName) {
      root.name = originalRootName;
    }

    editableObjects = collectEditableObjects(root);
    sceneTreeNodes = buildSceneTree(root);
    keyframeManager.reset();
    // v5: 记录初始 scene graph parent 快照
    keyframeManager.snapshotOriginalParents(root);
    undoStack.length = 0;

    const objectsByName = new Map();
    editableObjects.forEach((obj) => {
      if (obj.name) objectsByName.set(obj.name, obj);
    });

    sourceInfo = {
      fileName: originalFileName,
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
        // ── v5 修复：用 parent_name 按名字解析关节父级 ──
        // 之前用 childObj.parent（总是 scene parent / 无名包装），会丢失链式关系。
        // 现在优先按 parent_name 在 objectsByName 里查找实际逻辑父级。
        let resolvedParentObj = null;
        if (d.parent_name) {
          resolvedParentObj = objectsByName.get(d.parent_name) || null;
        }
        if (!resolvedParentObj) {
          // 兜底：scene parent（无名包装），保持独立关节可用
          resolvedParentObj = childObj?.parent || null;
        }
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
          role: d.role || '', // 语义角色（v6+ 字段，老 ZIP 没有时为空）
          origin: useOrigin,
          limits: { min: d.limits?.min ?? -180, max: d.limits?.max ?? 180 },
          parentId: resolvedParentObj?.uuid || null,
          childId: nodeId,
          currentValue: useCurrentValue,
          // v5 修复：清空 baseTransform，让 applyJointDrive 懒捕获重建。
          // 导出时 GLB 是零位态，懒捕获从零位态建立正确的 base。
          baseTransform: null,
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
            // v5: 恢复 reparent 事件（v4 及以前 ZIP 没有这个字段 → 空数组）
            reparentEvents: (clipData.reparent_events || []).map((e) => ({
              event_id: e.event_id || `rev_imp_${Math.random().toString(36).slice(2, 8)}`,
              t: Number(e.t) || 0,
              child_name: String(e.child_name || ''),
              new_parent_name: e.new_parent_name === undefined ? null : e.new_parent_name,
            })).sort((a, b) => a.t - b.t),
          };
          keyframeManager.globalClips.set(clipName, newClip);
        });
        if (!keyframeManager.globalClips.size) {
          keyframeManager.globalClips.set('default', { clipName: 'default', duration: 10, keyframes: [], reparentEvents: [] });
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

    // ── schema v6: 恢复场景标记 metadata ──
    // GLB 里已经有 marker 对象（按 name 在 scene 里），这里只要补 type/size/color 元数据
    // 旧 ZIP（v4/v5）没有 scene_markers 字段 → 跳过，行为同之前
    keyframeManager.sceneMarkers.clear();
    (manifest.scene_markers || []).forEach((m) => {
      keyframeManager.sceneMarkers.set(m.id, {
        id: m.id,
        name: m.name,
        type: m.type,
        size: m.size ? { ...m.size } : null,
        color: m.color || null,
      });
    });

    selectionManager.clearSelection();

    // ── v5 修复：两阶段应用关节，保证链式关节的 base 在零位捕获 ──
    // 问题：如果父级 joint 的 currentValue 非零，拓扑排序会先驱动父级 → 父级移动
    //       → 子级 lazy capture 捕获的是"父级驱动态"下的相对位置（错误 base）
    //       → 播放动画时父级回零位，子级相对下沉
    // 解决：先把所有 value 清零 → applyDrives 让所有 joint 在零位懒捕获 base
    //      → 再恢复真实 value → 正常驱动
    const savedImportValues = keyframeManager.getAllJointDefs().map((d) => ({
      id: d.id,
      value: d.currentValue,
    }));
    savedImportValues.forEach((s) => {
      const d = keyframeManager.jointDefinitions.get(s.id);
      if (d) d.currentValue = 0;
    });
    keyframeManager.applyAllJointDrives(sceneManager.sceneRoot);
    savedImportValues.forEach((s) => {
      const d = keyframeManager.jointDefinitions.get(s.id);
      if (d) d.currentValue = s.value;
    });

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
    refreshReparentEventList(); // 刷新 reparent 事件列表
    refreshMarkerList(); // 刷新 marker 列表
    refreshAiJointChips(); // 刷新 AI 面板的关节 chips
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
// PKF 错误"已警告"集合：避免播放时每帧 60 次刷屏
// key 形式：`${step_id}|${reason}` — reason 变了或换步骤会重新警告一次
const _pkfWarnedKeys = new Set();
function applyPkfAtTime(t) {
  // 建立 name → def 的索引
  const defByName = new Map();
  keyframeManager.jointDefinitions.forEach((d) => {
    if (d.name) defByName.set(d.name, d);
  });

  // 循环播放修复：每帧先把所有 PKF 触及的关节重置为 0
  // 原因：evaluatePkfAt 对未开始的步骤不输出 result（joint 未触及），
  //      如果不重置，循环回到 t=0 时未开始的关节仍保留上一轮末态 → 视觉"卡顿 + 瞬回"
  // 之后 results.forEach 按步骤时间顺序覆写：active 的按插值，completed 的保持 value_end
  keyframeManager.pkfSteps.forEach((step) => {
    let def = step.joint_def_id ? keyframeManager.jointDefinitions.get(step.joint_def_id) : null;
    if (!def && step.joint) def = defByName.get(step.joint);
    if (def) def.currentValue = 0;
  });

  const results = keyframeManager.evaluatePkfAt(t);
  results.forEach((r) => {
    // 公式求值出错：白名单拒绝、参数缺失等 → 警告并跳过
    if (r.error) {
      const key = `${r.step_id}|formula:${r.error}`;
      if (!_pkfWarnedKeys.has(key)) {
        _pkfWarnedKeys.add(key);
        console.warn(`[PKF] 步骤 "${r.joint || r.step_id}" 公式求值失败：${r.error}`);
      }
      return;
    }
    // 先按 uuid 查，失败再按名字
    let def = r.joint_def_id ? keyframeManager.jointDefinitions.get(r.joint_def_id) : null;
    if (!def && r.joint) def = defByName.get(r.joint);
    // 关节查找失败：joint 名拼错、关节被删、AI 输出截断（#10 收紧后会落到这里）
    if (!def) {
      const key = `${r.step_id}|missing:${r.joint}`;
      if (!_pkfWarnedKeys.has(key)) {
        _pkfWarnedKeys.add(key);
        console.warn(`[PKF] 步骤找不到关节 "${r.joint}"（step_id=${r.step_id}），该步骤将被跳过`);
      }
      return;
    }
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
  // v5: reparent 事件先应用（切 scene graph parent），再驱动关节
  // 顺序很重要——joint 计算用最新的 scene graph
  keyframeManager.applyReparentEventsAtTime(keyframeManager.currentTime, sceneManager.sceneRoot);
  keyframeManager.applyAllJointDrives(sceneManager.sceneRoot);
  sceneManager.render();
  requestAnimationFrame(loop);
}

selectionManager.attachViewportSelection(() => selectionManager.clearSelection());
selectionManager.onSelectionChanged(refreshSelectionUI);

// 让"变换"面板的输入框能直接编辑世界坐标 / 旋转
// 主要给"测试货物"这类无关节对象用，关节对象改了下一帧会被 applyJointDrive 覆盖
ui.attachTransformEditHandlers((axis, value) => {
  const obj = selectionManager.selectedObject;
  if (!obj) return;
  pushUndoSnapshot();
  obj.updateMatrixWorld(true);
  if (axis === 'x' || axis === 'y' || axis === 'z') {
    // 世界坐标 → scene parent local
    const parent = obj.parent;
    if (!parent) return;
    parent.updateMatrixWorld(true);
    const targetWorld = obj.getWorldPosition(new THREE.Vector3());
    if (axis === 'x') targetWorld.x = value;
    else if (axis === 'y') targetWorld.y = value;
    else targetWorld.z = value;
    const localTarget = parent.worldToLocal(targetWorld.clone());
    obj.position.copy(localTarget);
  } else if (axis === 'ry') {
    // 世界 Y 轴旋转（度）→ local 四元数
    const parent = obj.parent;
    if (!parent) return;
    parent.updateMatrixWorld(true);
    const rad = (value * Math.PI) / 180;
    const targetWorldQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rad, 0));
    const parentWorldQuatInv = parent.getWorldQuaternion(new THREE.Quaternion()).invert();
    obj.quaternion.copy(parentWorldQuatInv.multiply(targetWorldQuat));
  }
  // 如果有关节，rebind base（位置/旋转变了，原 base 失效）
  rebindJointBaseTransform(obj);
  refreshSelectionUI();
});

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
  // v5: seek 时同步应用 reparent 事件（立即反馈，不等下一帧）
  keyframeManager.applyReparentEventsAtTime(keyframeManager.currentTime, sceneManager.sceneRoot);
  ui.updateTimelineLabel(keyframeManager.currentTime, getCurrentDuration());
  refreshSelectionUI();
});

ui.playBtn.addEventListener('click', () => {
  // 切到"开始播放"时：如果当前时间已到/接近末尾，回到 0 重放一遍
  // 避免出现"先从中间位置播后半段，再环回 0 播前半段"的观感
  if (!isPlaying) {
    const duration = getCurrentDuration();
    if (keyframeManager.currentTime >= duration - 1e-3) {
      keyframeManager.currentTime = 0;
      if (pkfPlaybackMode) {
        applyPkfAtTime(0);
      } else {
        keyframeManager.evaluateAllAt(0, sceneManager.sceneRoot);
      }
      ui.setTime(0);
      ui.updateTimelineLabel(0, duration);
    }
  }
  isPlaying = !isPlaying;
  ui.setPlayState(isPlaying);
});

// 「在当前时间添加关键帧」：不再依赖选中对象，全局捕获所有 jointDef 当前状态
ui.keyframeBtn.addEventListener('click', () => {
  pushUndoSnapshot();
  keyframeManager.addKeyframe(keyframeManager.currentTime);
  refreshSelectionUI();
});

// ══════════════════════════════════════════════════════════════
//  AI 生成 PKF
// ══════════════════════════════════════════════════════════════
const AI_SERVICE_URL = import.meta.env.VITE_AI_SERVICE_URL || 'http://localhost:8091';
let pendingAiPkf = null;

/**
 * 采集场景里所有命名对象的世界坐标，给 AI 看。
 * AI 用这个解析"到 cargo 位置" / "@cargo" 这种引用 —— 把坐标当参数 default 填进去。
 * 过滤灯光/相机/Helper，不然会塞一堆 noise。
 *
 * ⚠️ 轴系转换：Three.js 内部 Y-up，但 AI prompt 用 UI Z-up 约定（z=高度，y=前后）。
 * UI 的"Z 高度"写到 threejs.y，"Y 前后"写到 threejs.z（见 EditorUI.js #ty/#tz-input）。
 * 所以发给 AI 时必须 swap y/z，否则 drop.z 会被当成高度（其实是前后距离）。
 */
function collectSceneForAi() {
  const scene = [];
  if (sceneManager.sceneRoot) {
    sceneManager.sceneRoot.updateMatrixWorld(true);
    sceneManager.sceneRoot.traverse((o) => {
      if (!o.name || o.isLight || o.isCamera || o.type?.includes('Helper')) return;
      const wp = o.getWorldPosition(new THREE.Vector3());
      // threejs (y-up) → ui/AI (z-up)：swap y 和 z
      scene.push({ name: o.name, position: { x: wp.x, y: wp.z, z: wp.y } });
    });
  }
  return scene;
}

/**
 * v14.1 (#37): 临时把所有关节归零 → 算 fork_anchor_zero → 恢复关节值。
 * 必须在"零位"状态下算，否则 anchor 位置会受当前动画位移污染。
 * 结果既 return 也被 KeyframeManager 缓存（供 buildDefaultParamValues 复用）。
 */
function snapshotForkAnchorZero() {
  const saved = keyframeManager.getAllJointDefs().map((d) => ({ id: d.id, value: d.currentValue }));
  try {
    saved.forEach((s) => {
      const d = keyframeManager.jointDefinitions.get(s.id);
      if (d) d.currentValue = 0;
    });
    keyframeManager.applyAllJointDrives(sceneManager.sceneRoot);
    return keyframeManager.computeForkAnchorZero(sceneManager.sceneRoot);
  } finally {
    saved.forEach((s) => {
      const d = keyframeManager.jointDefinitions.get(s.id);
      if (d) d.currentValue = s.value;
    });
    keyframeManager.applyAllJointDrives(sceneManager.sceneRoot);
  }
}

/**
 * #47：attach 前必须三维都到位，否则 snap-attach 会把 cargo 瞬间拉到 fork 位置 → 视觉跳变。
 * AI 生成的 PKF 经常漏某个方向（多半是门架升降）。此函数检查 x/y/z 三维目标位移，
 * 缺失的自动注入一段 step；找不到对应 role 关节则加 warning。
 *
 * @param {Object} pkf    {parameters, steps, warnings?}（会 mutate）
 * @param {Object} ctx    {sceneList, forkAnchorZero, reparentEvents}（UI Z-up）
 * @returns {Object} 同一个 pkf（方便链式）
 */
function ensurePkfCoversAttachPoint(pkf, ctx) {
  if (!pkf || typeof pkf !== 'object') return pkf;
  const events = ctx?.reparentEvents || [];
  const attachEvent = events.find((e) => e.new_parent_name);
  if (!attachEvent) return pkf; // 没 attach event 就无对齐要求
  const tAttach = Number(attachEvent.t) || 0;
  const cargoName = attachEvent.child_name;
  const cargoObj = (ctx?.sceneList || []).find((o) => o.name === cargoName);
  if (!cargoObj) return pkf;
  const { fork_anchor_zero_x: fax, fork_anchor_zero_y: fay, fork_anchor_zero_z: faz } = ctx?.forkAnchorZero || {};
  if (fax === undefined || fay === undefined || faz === undefined) return pkf;

  // #49：fork_anchor_zero_z 是叉齿底面，z 公式要减 cargo_height/2 让 cargo 底面对齐
  const cargoSize = keyframeManager.getCargoSizeParams?.() || {};
  const cargoHeight = cargoSize.cargo_height ?? 0;
  const approachGapParam = (pkf.parameters || []).find((p) => p.id === 'approach_gap');
  const approachGap = approachGapParam ? Number(approachGapParam.default) || 0 : 0;

  // attach 前各维目标位移（UI Z-up 世界位移，直接作为 joint value）
  const target = {
    x: cargoObj.position.x - fax,
    y: cargoObj.position.y - fay - approachGap,
    z: cargoObj.position.z - cargoHeight / 2 - faz,
  };

  const THRESHOLD = 0.05; // 小于 5cm 视为已对齐，不注入
  const warnings = Array.isArray(pkf.warnings) ? pkf.warnings : (pkf.warnings = []);
  const rolesByDim = {
    x: ['车体横移', '叉齿侧移'],
    y: ['车体前进'],
    z: ['门架升降'],
  };
  const allDefs = keyframeManager.getAllJointDefs();
  if (!Array.isArray(pkf.steps)) pkf.steps = [];

  for (const dim of ['x', 'y', 'z']) {
    if (Math.abs(target[dim]) < THRESHOLD) continue;
    const candidateRoles = rolesByDim[dim];
    const joint = allDefs.find((d) => candidateRoles.includes(d.role));
    if (!joint) {
      warnings.push(
        `⚠️ 缺 role=${candidateRoles.join('/')} 的关节，attach 时 cargo ${dim} 方向可能跳 ${target[dim].toFixed(2)}m`,
      );
      continue;
    }
    const covered = pkf.steps.some((s) => (
      s.joint === joint.name && Number(s.t_end) <= tAttach + 0.01
    ));
    if (covered) continue;
    pkf.steps.push({
      joint: joint.name,
      channel: joint.type === 'revolute' ? 'rotate' : 'translate',
      axis: joint.axis || 'z',
      t_start: 0,
      t_end: tAttach,
      value_start: '0',
      value_end: String(+target[dim].toFixed(3)),
      easing: 'ease-in-out',
    });
    warnings.push(
      `🔧 自动补 ${dim} 方向 step: ${joint.name} 0→${target[dim].toFixed(3)}（AI 漏写；attach 前已到位）`,
    );
  }
  return pkf;
}

/**
 * 请求后端 /api/generate-pkf 接口
 * 传入当前关节定义列表 + 场景对象世界坐标 + 用户自然语言描述，返回 { parameters, steps } PKF 格式
 * @param {string} prompt - 用户的动作描述
 * @returns {Promise<{parameters: Array, steps: Array}>}
 */
async function requestAiGeneratePkf(prompt) {
  // 把当前关节定义精简后传给后端
  // role 字段（语义角色）让 AI 按意图匹配，不靠 axis 硬猜
  const joints = keyframeManager.getAllJointDefs()
    .filter((d) => d.type === 'revolute' || d.type === 'prismatic')
    .map((d) => ({ name: d.name, type: d.type, axis: d.axis, role: d.role || '' }));

  // scene: 场景里所有对象的世界坐标。AI 用它解析"走到 cargo 位置"，把坐标当参数 default
  const scene = collectSceneForAi();
  // v14.1 (#37): 叉齿零位锚点（世界坐标），AI 用 value_end = cargo_pos_y - fork_anchor_zero_y - approach_gap
  const forkAnchorZero = snapshotForkAnchorZero();

  const response = await fetch(`${AI_SERVICE_URL}/api/generate-pkf`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, joints, scene, fork_anchor_zero: forkAnchorZero }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `AI 服务返回 ${response.status}`);
  }
  return response.json();
}

/**
 * 把 AI 返回的 PKF 数据写入 keyframeManager
 * 清空现有 PKF（参数 + 步骤），用 AI 生成的替换
 * @param {{parameters: Array, steps: Array}} pkfData
 */
function applyAiPkf(pkfData) {
  if (!pkfData?.parameters || !pkfData?.steps) return;
  pushUndoSnapshot();

  // 建立 name → uuid 映射
  const defByName = new Map();
  keyframeManager.getAllJointDefs().forEach((d) => {
    if (d.name) defByName.set(d.name, d.id);
  });

  // 清空现有 PKF 数据
  keyframeManager.pkfParameters.clear();
  keyframeManager.pkfSteps = [];

  // 写入 AI 生成的参数
  pkfData.parameters.forEach((p) => {
    keyframeManager.addPkfParameter({
      id: p.id || `param_${Math.random().toString(36).slice(2, 6)}`,
      type: p.type || 'number',
      unit: p.unit || '',
      desc: p.desc || '',
      default: p.default ?? 0,
    });
  });

  // 写入 AI 生成的步骤，同时用 name 查当前 joint_def_id
  pkfData.steps.forEach((s) => {
    keyframeManager.addPkfStep({
      joint: s.joint || '',
      joint_def_id: defByName.get(s.joint) || '',
      channel: s.channel || 'translate',
      axis: s.axis || 'z',
      t_start: s.t_start ?? 0,
      t_end: s.t_end ?? 1,
      value_start: String(s.value_start ?? '0'),
      value_end: String(s.value_end ?? '0'),
      easing: s.easing || 'linear',
    });
  });

  // 自动把时间线时长贴到最后一步 t_end（避免循环播放时"停顿 1 秒 → 瞬跳回原点"）
  // 额外 +0.5s 让末态留一眼，不至于瞬间 wrap
  const maxEnd = pkfData.steps.reduce((m, s) => Math.max(m, Number(s.t_end) || 0), 0);
  if (maxEnd > 0) {
    const newDuration = maxEnd + 0.5;
    keyframeManager.setClipDuration(newDuration);
    ui.setTimelineRange(newDuration);
  }

  refreshPkfParamsUI();
  refreshPkfStepsUI();
  refreshSelectionUI();
}

// ── AI 输入双模式 toggle 接线 ──
ui.aiModeTextBtn?.addEventListener('click', () => ui.setAiInputMode('text'));
ui.aiModeTableBtn?.addEventListener('click', () => ui.setAiInputMode('table'));
ui.aiAddRowBtn?.addEventListener('click', () => ui.addAiTableRow());

// ── L1: 高级意图 → 时间表 ──
ui.aiDecomposeBtn?.addEventListener('click', async () => {
  const intent = ui.aiIntentInput?.value?.trim();
  if (!intent) {
    alert('请先在"高级意图"框里写一句话');
    return;
  }
  // #38 修复：复用 collectSceneForAi()，保证 Y↔Z swap 和一键生成主链路一致
  // 历史：此处曾有自己的采集逻辑，发 threejs Y-up 坐标给 L1 → AI 空间理解和主路径分叉
  const scene = collectSceneForAi();
  // 关节列表（含 role）
  const joints = keyframeManager.getAllJointDefs()
    .filter((d) => d.type === 'revolute' || d.type === 'prismatic')
    .map((d) => ({ name: d.name, type: d.type, axis: d.axis, role: d.role || '' }));

  ui.aiDecomposeBtn.disabled = true;
  ui.aiDecomposeBtn.textContent = '🪄 拆解中...';
  try {
    const forkAnchorZeroDecompose = snapshotForkAnchorZero();
    const resp = await fetch(`${AI_SERVICE_URL}/api/decompose-intent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent, scene, joints, fork_anchor_zero: forkAnchorZeroDecompose }),
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      alert(`拆解失败：${body.error || resp.statusText}`);
      return;
    }
    if (!body.rows?.length) {
      alert('AI 没返回任何行，请换种说法重试');
      return;
    }
    // 切到表格模式 + 填入行
    ui.setAiInputMode('table');
    ui.setAiTableRows(body.rows);
    ui.setLoadStatus(`已拆解为 ${body.rows.length} 行时间表，请检查后点 "AI 生成动作"`);
  } catch (err) {
    alert(`请求失败：${err.message}`);
  } finally {
    ui.aiDecomposeBtn.disabled = false;
    ui.aiDecomposeBtn.textContent = '🪄 仅拆解';
  }
});

// ══════════════════════════════════════════════════════════════
//  v14: 🚀 一键生成完整动画（L1 → apply reparent → L2 → 播放）
// ══════════════════════════════════════════════════════════════

ui.aiOneshotBtn?.addEventListener('click', async () => {
  const intent = ui.aiIntentInput?.value?.trim();
  if (!intent) {
    alert('请先在"高级意图"框里写一句话');
    return;
  }
  const out = ui.aiOneshotOutput;
  const setOut = (html, color) => {
    if (!out) return;
    out.style.display = 'block';
    out.style.color = color || '#94a3b8';
    out.innerHTML = html;
  };

  const originalBtnText = ui.aiOneshotBtn.textContent;
  ui.aiOneshotBtn.disabled = true;

  try {
    pushUndoSnapshot();

    // ── Step 1: L1 拆解 ──
    ui.aiOneshotBtn.textContent = '1/4 AI 拆解意图...';
    setOut('🪄 Step 1: 让 AI 拆解时间表...', '#93c5fd');

    const scene = collectSceneForAi();
    // v14.1 (#37): 叉齿零位锚点世界坐标（若无 reparent event 则为 {}，AI 退化用 approach_gap）
    const forkAnchorZero = snapshotForkAnchorZero();
    const joints = keyframeManager.getAllJointDefs()
      .filter((d) => d.type === 'revolute' || d.type === 'prismatic')
      .map((d) => ({ name: d.name, type: d.type, axis: d.axis, role: d.role || '' }));

    const l1Resp = await fetch(`${AI_SERVICE_URL}/api/decompose-intent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ intent, scene, joints, fork_anchor_zero: forkAnchorZero }),
    });
    const l1Body = await l1Resp.json().catch(() => ({}));
    window.__mf = window.__mf || {};
    window.__mf.lastOneshot = { intent, scene, joints, fork_anchor_zero: forkAnchorZero, l1: l1Body };
    if (!l1Resp.ok || !l1Body.rows?.length) {
      throw new Error(`L1 拆解失败: ${l1Body.error || l1Resp.statusText || '无行返回'}`);
    }

    const rowsMsg = `✅ L1: ${l1Body.rows.length} 行时间表 + ${l1Body.reparent_events?.length || 0} 个 reparent 事件`;
    const warningsMsg = (l1Body.warnings?.length)
      ? `<br>⚠️ AI 警告:<br>${l1Body.warnings.map((w) => `· ${w}`).join('<br>')}`
      : '';
    setOut(`${rowsMsg}${warningsMsg}<br>🪄 Step 2: 应用 reparent...`, '#93c5fd');

    // ── Step 2: 填表格 + 应用 reparent 事件 ──
    ui.setAiInputMode('table');
    ui.setAiTableRows(l1Body.rows);

    // 先清空当前 clip 的旧 reparent 事件（避免叠加）
    const existingEvents = keyframeManager.getReparentEvents();
    existingEvents.forEach((e) => keyframeManager.removeReparentEvent(e.event_id));

    // 应用新的 reparent events
    // F16 修复：同时校验 new_parent_name（null = 回到世界根，合法；否则必须是场景对象）
    //          否则 AI 瞎编 parent 名（常见：用 role 代替对象名）→ computeForkAnchorZero 返回 {} → L2 退化错误
    let appliedReparents = 0;
    const skippedReparents = [];
    (l1Body.reparent_events || []).forEach((e) => {
      const childOk = !!sceneManager.sceneRoot?.getObjectByName(e.child_name);
      const parentOk = e.new_parent_name === null
        || !!sceneManager.sceneRoot?.getObjectByName(e.new_parent_name);
      if (childOk && parentOk) {
        keyframeManager.addReparentEvent(e.t, e.child_name, e.new_parent_name);
        appliedReparents++;
      } else {
        skippedReparents.push(
          `t=${e.t}s ${e.child_name} → ${e.new_parent_name || '(世界根)'}`
          + ` [${!childOk ? 'child 不存在' : ''}${!childOk && !parentOk ? ' + ' : ''}${!parentOk ? 'parent 不存在' : ''}]`,
        );
      }
    });
    if (skippedReparents.length) {
      console.warn('[oneshot] 忽略无效 reparent 事件：\n  ' + skippedReparents.join('\n  '));
    }
    refreshReparentEventList();

    // ── Step 3: L2 生成 PKF ──
    ui.aiOneshotBtn.textContent = '3/4 AI 生成 PKF...';
    setOut(`${rowsMsg}${warningsMsg}<br>✅ 已应用 ${appliedReparents} 个 reparent 事件<br>🪄 Step 3: 生成 PKF 公式...`, '#93c5fd');

    const l2Prompt = ui.serializeAiTable();
    // v14.1 (#37): L2 调用前重算 fork_anchor_zero —— L1 刚应用了 reparent events，现在才有 fork 信息
    // 解决"首次 🚀 需要跑两次才生效"的问题
    const forkAnchorZeroForL2 = snapshotForkAnchorZero();
    const l2Resp = await fetch(`${AI_SERVICE_URL}/api/generate-pkf`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: l2Prompt, joints, scene, fork_anchor_zero: forkAnchorZeroForL2 }),
    });
    const l2Body = await l2Resp.json().catch(() => ({}));
    if (window.__mf?.lastOneshot) {
      window.__mf.lastOneshot.l2Prompt = l2Prompt;
      window.__mf.lastOneshot.l2 = l2Body;
    }
    if (!l2Resp.ok) {
      throw new Error(`L2 PKF 生成失败: ${l2Body.error || l2Resp.statusText}`);
    }

    // #47 兜底：AI 若漏了某个方向的 step，自动注入 → 保证 attach 瞬间零 teleport
    ensurePkfCoversAttachPoint(l2Body, {
      sceneList: scene,
      forkAnchorZero: forkAnchorZeroForL2,
      reparentEvents: l1Body.reparent_events || [],
    });
    if (window.__mf?.lastOneshot) window.__mf.lastOneshot.l2Patched = l2Body;

    // 应用 PKF（和现有 ai-apply-btn 逻辑一致）
    if (Array.isArray(l2Body.parameters)) {
      keyframeManager.pkfParameters.clear();
      l2Body.parameters.forEach((p) => {
        keyframeManager.addPkfParameter({
          id: p.id,
          type: p.type || 'number',
          unit: p.unit || '',
          desc: p.desc || '',
          default: p.default ?? 0,
        });
      });
    }
    if (Array.isArray(l2Body.steps)) {
      keyframeManager.pkfSteps = [];
      l2Body.steps.forEach((s) => {
        const def = keyframeManager.getAllJointDefs().find((d) => d.name === s.joint);
        keyframeManager.addPkfStep({
          joint: s.joint || '',
          joint_def_id: def?.id || '',
          channel: s.channel || 'translate',
          axis: s.axis || 'z',
          t_start: Number(s.t_start) || 0,
          t_end: Number(s.t_end) || 1,
          value_start: String(s.value_start ?? '0'),
          value_end: String(s.value_end ?? '0'),
          easing: s.easing || 'linear',
        });
      });
    }
    // 自动把时间线时长贴到最后一步 t_end（+ 0.5s buffer），避免循环边界瞬跳回原点
    // 同时考虑 reparent events 的 t（虽然通常 ≤ steps，但保险一点）
    const stepMaxEnd = (l2Body.steps || []).reduce((m, s) => Math.max(m, Number(s.t_end) || 0), 0);
    const eventMaxT = (l1Body.reparent_events || []).reduce((m, e) => Math.max(m, Number(e.t) || 0), 0);
    const maxEnd = Math.max(stepMaxEnd, eventMaxT);
    if (maxEnd > 0) {
      const newDuration = maxEnd + 0.5;
      keyframeManager.setClipDuration(newDuration);
      ui.setTimelineRange(newDuration);
    }

    refreshPkfParamsUI();
    refreshPkfStepsUI();

    // ── Step 4: 切到 PKF 播放 + 从 0 开始 ──
    ui.aiOneshotBtn.textContent = '4/4 切 PKF 播放...';
    pkfPlaybackMode = true;
    if (ui.pkfPlaybackModeInput) ui.pkfPlaybackModeInput.checked = true;
    keyframeManager.currentTime = 0;
    applyPkfAtTime(0);
    keyframeManager.applyReparentEventsAtTime(0, sceneManager.sceneRoot);
    keyframeManager.applyAllJointDrives(sceneManager.sceneRoot);

    setOut(
      `${rowsMsg}${warningsMsg}<br>`
      + `✅ 已应用 ${appliedReparents} 个 reparent 事件<br>`
      + `✅ PKF: ${l2Body.parameters?.length || 0} 参数 / ${l2Body.steps?.length || 0} 步骤<br>`
      + `✅ 已切到 PKF 播放，按"播放"键开始`,
      '#34d399',
    );
    ui.setLoadStatus('🚀 一键生成完成！按下方"播放"键看动画');
  } catch (err) {
    setOut(`❌ ${err.message}`, '#f87171');
    console.error('[Oneshot]', err);
  } finally {
    ui.aiOneshotBtn.disabled = false;
    ui.aiOneshotBtn.textContent = originalBtnText;
  }
});

// ── AI 生成按钮事件 ──
ui.aiGenerateBtn.addEventListener('click', async () => {
  // 根据模式拼 prompt：自由文本直接读 textarea，表格模式序列化成 markdown
  let prompt;
  if (ui.getAiInputMode() === 'table') {
    prompt = ui.serializeAiTable();
    if (!prompt) {
      ui.aiResultOutput.textContent = '请至少添加一行有效的时间表（时间 + 操作描述）。';
      return;
    }
  } else {
    prompt = ui.aiPromptInput.value.trim();
    if (!prompt) {
      ui.aiResultOutput.textContent = '请输入动作描述。';
      return;
    }
  }
  const jointDefs = keyframeManager.getAllJointDefs().filter(
    (d) => d.type === 'revolute' || d.type === 'prismatic',
  );
  if (!jointDefs.length) {
    ui.aiResultOutput.textContent = '请先在场景树中配置关节定义（旋转/平移），AI 才能生成 PKF。';
    return;
  }
  ui.aiGenerateBtn.disabled = true;
  ui.aiResultOutput.textContent = '正在请求 AI 生成 PKF...';
  ui.aiApplyBtn.style.display = 'none';
  pendingAiPkf = null;
  try {
    const result = await requestAiGeneratePkf(prompt);
    pendingAiPkf = result;
    // 预览生成结果
    const paramPreview = (result.parameters || [])
      .map((p) => `  ${p.id} = ${p.default}${p.unit ? ' ' + p.unit : ''} (${p.desc || ''})`)
      .join('\n');
    const stepPreview = (result.steps || [])
      .map((s, i) => `  ${i + 1}. [${s.joint}] ${s.channel}.${s.axis} : ${s.value_start} → ${s.value_end} (${s.t_start}s~${s.t_end}s, ${s.easing})`)
      .join('\n');
    ui.aiResultOutput.textContent = `参数:\n${paramPreview || '  (无)'}\n\n步骤:\n${stepPreview || '  (无)'}`;
    if ((result.parameters?.length || result.steps?.length)) ui.aiApplyBtn.style.display = '';
  } catch (error) {
    ui.aiResultOutput.textContent = `AI 请求失败：${error.message}`;
  } finally {
    ui.aiGenerateBtn.disabled = false;
  }
});

// ── 确认并应用 AI 生成的 PKF ──
ui.aiApplyBtn.addEventListener('click', () => {
  if (!pendingAiPkf) return;
  applyAiPkf(pendingAiPkf);
  ui.aiResultOutput.textContent = `已应用 AI 生成的 PKF：${pendingAiPkf.parameters?.length || 0} 个参数，${pendingAiPkf.steps?.length || 0} 个步骤。\n\n可在下方 PKF 区域编辑公式，或勾选「用 PKF 驱动播放」预览动画。`;
  ui.aiApplyBtn.style.display = 'none';
  pendingAiPkf = null;
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
      // v5: reparent 事件（原样透传到 exporter，内部字段已经是 name 形式）
      reparent_events: (clip.reparentEvents || []).map((e) => ({ ...e })),
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
/** 刷新 AI 面板的关节 chips（跟随 jointDefs 变化） */
function refreshAiJointChips() {
  ui.renderAiJointChips(keyframeManager.getAllJointDefs());
}

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
// 初始渲染一次 Reparent 事件列表（空）
refreshReparentEventList();
// 初始渲染一次 marker 列表（空）
refreshMarkerList();

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

// ══════════════════════════════════════════════════════════════
//  场景标记 Marker（schema v6）：货物占位 / 取货点 / 放货点
//  统一通过 KeyframeManager.sceneMarkers 管理，视觉由 SceneManager.createMarkerObject 渲染
// ══════════════════════════════════════════════════════════════

/**
 * 添加一个 marker：在 KeyframeManager 注册数据 + 在 sceneRoot 加视觉对象
 * @param {string} type - 'cargo' | 'pickup' | 'drop'
 */
function addMarkerOfType(type) {
  if (!sceneManager.sceneRoot) {
    alert('请先加载一个模型');
    return;
  }
  // 自动生成唯一名字（确保不和场景已有对象重名）
  const baseName = type === 'cargo' ? 'cargo' : (type === 'pickup' ? 'pickup' : 'drop');
  let n = 1;
  let name = baseName;
  while (sceneManager.sceneRoot.getObjectByName(name)) {
    n += 1;
    name = `${baseName}_${n}`;
  }

  pushUndoSnapshot();
  // 1. 在 KeyframeManager 注册数据
  const marker = keyframeManager.addMarker({ name, type });
  // 2. 创建视觉对象
  const obj = sceneManager.createMarkerObject(marker);
  if (!obj) return;
  // 3. 默认位置：世界原点前方
  obj.position.set(1, type === 'cargo' ? (marker.size?.h ?? 0.5) / 2 : 0, 1);
  sceneManager.sceneRoot.add(obj);

  keyframeManager.snapshotOriginalParents(sceneManager.sceneRoot);
  editableObjects = collectEditableObjects(sceneManager.sceneRoot);
  sceneTreeNodes = buildSceneTree(sceneManager.sceneRoot);
  refreshObjectTree();
  refreshMarkerList();
  ui.setLoadStatus(`已添加 ${type === 'cargo' ? '货物占位' : (type === 'pickup' ? '取货点' : '放货点')}：${name}`);
}

/**
 * 删除一个 marker：从场景里移除视觉对象 + 从 KeyframeManager 移除数据 + 清掉相关 reparent 事件
 * @param {string} id
 * @param {Object} [opts]
 * @param {boolean} [opts.skipUndoSnapshot=false] — bulk 删除时外层已 push，内层不再 push（F8 修复）
 */
function removeMarkerById(id, { skipUndoSnapshot = false } = {}) {
  const m = keyframeManager.getMarker(id);
  if (!m) return;
  if (!skipUndoSnapshot) pushUndoSnapshot();
  // 找视觉对象
  const obj = sceneManager.sceneRoot?.getObjectByName(m.name);
  if (obj) {
    obj.parent?.remove(obj);
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      (Array.isArray(obj.material) ? obj.material : [obj.material]).forEach((mt) => mt.dispose?.());
    }
    obj.traverse?.((c) => {
      if (c.geometry) c.geometry.dispose();
      if (c.material) {
        (Array.isArray(c.material) ? c.material : [c.material]).forEach((mt) => mt.dispose?.());
      }
    });
  }
  keyframeManager.removeMarker(id);
  keyframeManager.removeAllReparentEventsForChild(m.name);
  keyframeManager.snapshotOriginalParents(sceneManager.sceneRoot);
  editableObjects = collectEditableObjects(sceneManager.sceneRoot);
  sceneTreeNodes = buildSceneTree(sceneManager.sceneRoot);
  refreshObjectTree();
  refreshMarkerList();
  refreshReparentEventList();
}

ui.addCargoMarkerBtn?.addEventListener('click', () => addMarkerOfType('cargo'));
ui.addPickupMarkerBtn?.addEventListener('click', () => addMarkerOfType('pickup'));
ui.addDropMarkerBtn?.addEventListener('click', () => addMarkerOfType('drop'));

ui.removeAllMarkersBtn?.addEventListener('click', () => {
  const ids = keyframeManager.getAllMarkers().map((m) => m.id);
  if (!ids.length) {
    ui.setLoadStatus('场景里没有标记');
    return;
  }
  if (!confirm(`确认清空所有 ${ids.length} 个场景标记？`)) return;
  // F8 修复：bulk delete 走**单次** undo snapshot，撤销时一步回退，不是 N 步
  pushUndoSnapshot();
  ids.forEach((id) => removeMarkerById(id, { skipUndoSnapshot: true }));
});

function refreshMarkerList() {
  ui.renderMarkerList(keyframeManager.getAllMarkers(), {
    onSelect: (markerName) => {
      const obj = sceneManager.sceneRoot?.getObjectByName(markerName);
      if (obj) selectionManager.selectObject(obj);
    },
    onSizeChange: (id, axis, value) => {
      pushUndoSnapshot();
      const m = keyframeManager.updateMarker(id, { size: { [axis]: value } });
      if (m) {
        const obj = sceneManager.sceneRoot?.getObjectByName(m.name);
        sceneManager.updateMarkerObject(obj, m);
      }
      refreshMarkerList(); // 刷 hint 文字
    },
    onRename: (id, newName) => {
      const m = keyframeManager.getMarker(id);
      if (!m) return;
      // 检查重名
      if (sceneManager.sceneRoot?.getObjectByName(newName)) {
        alert(`场景里已有名字为 "${newName}" 的对象`);
        refreshMarkerList();
        return;
      }
      pushUndoSnapshot();
      const oldName = m.name;
      keyframeManager.updateMarker(id, { name: newName });
      // 同步 scene 对象 name
      const obj = sceneManager.sceneRoot?.getObjectByName(oldName);
      if (obj) obj.name = newName;
      // 同步 reparent 事件里的 child_name 引用
      const events = keyframeManager.getReparentEvents();
      events.forEach((e) => {
        if (e.child_name === oldName) e.child_name = newName;
        if (e.new_parent_name === oldName) e.new_parent_name = newName;
      });
      keyframeManager.snapshotOriginalParents(sceneManager.sceneRoot);
      editableObjects = collectEditableObjects(sceneManager.sceneRoot);
      sceneTreeNodes = buildSceneTree(sceneManager.sceneRoot);
      refreshObjectTree();
      refreshMarkerList();
      refreshReparentEventList();
    },
    onDelete: (id) => removeMarkerById(id),
  });
}

ui.exportPackageBtn.addEventListener('click', async () => {
  const clips = buildExportClips();
  const jointDefs = keyframeManager.getAllJointDefs();

  if (!clips.length && !jointDefs.length) {
    ui.exportOutput.textContent = '没有可导出的数据，请先创建关节或添加关键帧。';
    return;
  }

  // ── 导出前：保存状态，归零 + 清选中 + reparent 回初始 ──
  const savedSelection = selectionManager.selectedObject;
  const savedValues = [];
  const savedTime = keyframeManager.currentTime;
  try {
    // 清除选中（防止 emissive 烘焙进 GLB）
    selectionManager.clearSelection();

    // v5: reparent 状态重置到 t=0（所有对象回到 originalParent）
    // 否则 GLB 会烘焙"当前时间点的 scene graph"，导入后 originalParentMap 错乱
    keyframeManager.applyReparentEventsAtTime(0, sceneManager.sceneRoot);

    // 方案A 归零：保留 baseTransform，只设 value=0
    // GLTFExporter 烘焙当前 transform → 必须是零位态
    jointDefs.forEach((def) => {
      savedValues.push({ id: def.id, currentValue: def.currentValue });
      def.currentValue = 0;
    });
    keyframeManager.applyAllJointDrives(sceneManager.sceneRoot);

    const { manifest } = await packageExporter.exportZip({
      sourceFileName: sourceInfo.fileName,
      sourceFormat: sourceInfo.format,
      sceneRoot: sceneManager.sceneRoot,
      jointDefinitions: jointDefs.map((d) => {
        const childObj = getSceneNodeById(d.childId);
        const parentObj = d.parentId ? getSceneNodeById(d.parentId) : null;
        return {
          ...d,
          currentValue: 0,
          scenePath: childObj ? getScenePath(childObj) : null,
          parentName: parentObj?.name || null,
        };
      }),
      clips,
      pkfParameters: keyframeManager.getAllPkfParameters(),
      pkfSteps: keyframeManager.getAllPkfSteps(),
      sceneMarkers: keyframeManager.getAllMarkers(),
    });

    ui.exportOutput.textContent = `已导出结果包 ZIP。\n${JSON.stringify(manifest, null, 2)}`;
  } catch (error) {
    ui.exportOutput.textContent = `导出 ZIP 失败：${error.message}`;
  } finally {
    // ── 不管成功失败，一定恢复关节值 + 选中状态 ──
    // 没有 finally 的话，GLTFExporter 抛异常会卡在"全关节零位 + 无选中"状态
    savedValues.forEach((saved) => {
      const def = keyframeManager.getJointDef(saved.id);
      if (def) def.currentValue = saved.currentValue;
    });
    // v5: 把 reparent 状态还原到导出前的时间点（保持用户当前视图）
    keyframeManager.applyReparentEventsAtTime(savedTime, sceneManager.sceneRoot);
    keyframeManager.applyAllJointDrives(sceneManager.sceneRoot);
    if (savedSelection) {
      selectionManager.selectObject(savedSelection);
    }
  }
});

window.addEventListener('resize', () => sceneManager.resize());

// 禁用 Ctrl+滚轮的页面缩放：左右面板没有 wheel 监听 → 走浏览器默认行为
// → 整个 CSS Grid 被缩放，"左右面板间隔越来越远"。全局吞掉即可，3D 视口已有自己的滚轮处理。
// passive: false 必须显式声明，否则 Chrome 忽略 preventDefault。
window.addEventListener('wheel', (event) => {
  if (event.ctrlKey) event.preventDefault();
}, { passive: false });

window.addEventListener('keydown', (event) => {
  const isUndo = (event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'z';
  if (!isUndo) return;
  event.preventDefault();
  undoLastChange();
});

// 调试钩子：浏览器控制台可用 __mf 访问内部状态
// __mf.getJointDefs() 返回当前所有关节定义的快照副本
window.__mf = {
  THREE,
  sceneManager,
  keyframeManager,
  selectionManager,
  editableObjects: () => editableObjects,
  getJointDefs: () => keyframeManager.getAllJointDefs(),
};

ui.setTimelineRange(10);
ui.updateTimelineLabel(0, 10);
refreshSelectionUI();
refreshAiJointChips();
requestAnimationFrame(loop);
