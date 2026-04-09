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
let lastFrameTime = performance.now();
let sourceInfo = {
  fileName: '',
  format: '',
  rawFile: null,
};
let jointObjectAId = null;
let jointObjectBId = null;
let jointPoints = [];
let activeJointPointId = null;
let motionValueEditSnapshotCaptured = false;
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

function worldFromJointPoint(point) {
  if (point?.followObjectId && point?.followOffset) {
    const owner = findObjectById(point.followObjectId);
    if (owner) {
      const ownerWorld = owner.getWorldPosition(new THREE.Vector3());
      return ownerWorld.add(
        new THREE.Vector3(point.followOffset.x ?? 0, point.followOffset.y ?? 0, point.followOffset.z ?? 0),
      );
    }
  }
  // Legacy compatibility: old points used local-space follow (will rotate with object).
  if (point?.followObjectId && point?.local) {
    const owner = findObjectById(point.followObjectId);
    if (owner) {
      return owner.localToWorld(new THREE.Vector3(point.local.x, point.local.y, point.local.z));
    }
  }
  return new THREE.Vector3(point?.x ?? 0, point?.y ?? 0, point?.z ?? 0);
}

function mapJointPointsForDisplay(points) {
  return points.map((point) => {
    const effectivePivot = getEffectivePivotForJoint(point);
    const world = effectivePivot || worldFromJointPoint(point);
    const uiPoint = worldToUiVector3(world);
    return {
      ...point,
      x: uiPoint.x,
      y: uiPoint.y,
      z: uiPoint.z,
    };
  });
}

function mapJointPointsForRender(points) {
  return points.map((point) => {
    const effectivePivot = getEffectivePivotForJoint(point);
    if (effectivePivot) {
      return { ...point, x: effectivePivot.x, y: effectivePivot.y, z: effectivePivot.z };
    }
    const world = worldFromJointPoint(point);
    return { ...point, x: world.x, y: world.y, z: world.z };
  });
}

function mapUiAxisToWorldAxis(axis) {
  if (axis === 'z') return 'y';
  if (axis === 'y') return 'z';
  return 'x';
}

function getSelectedClipPivotWorld() {
  const selected = selectionManager.selectedObject;
  if (!selected) return null;
  const clip = keyframeManager.getActiveClip(selected);
  if (!clip?.pivotEnabled) return null;
  return new THREE.Vector3(clip.pivotX, clip.pivotY, clip.pivotZ);
}

function getEffectivePivotForJoint(point) {
  if (!point) return null;
  const owner = point.followObjectId ? findObjectById(point.followObjectId) : null;
  if (!owner) return null;
  const clip = keyframeManager.getActiveClip(owner);
  if (!clip?.pivotEnabled || !Number.isFinite(clip.pivotX)) return null;

  const pivot = new THREE.Vector3(clip.pivotX, clip.pivotY, clip.pivotZ);
  const worldAxis = mapUiAxisToWorldAxis(clip.translateAxis);
  pivot[worldAxis] += clip.currentTranslateValue ?? 0;
  return pivot;
}

function pushUndoSnapshot() {
  undoStack.push({
    selectedObjectId: selectionManager.selectedObject?.uuid || null,
    keyframeState: keyframeManager.serializeState(),
    jointPoints: jointPoints.map((p) => ({ ...p })),
    hierarchyState: captureHierarchySnapshot(),
    activeJointPointId,
    jointObjectAId,
    jointObjectBId,
  });
  if (undoStack.length > MAX_UNDO) undoStack.shift();
}

function undoLastChange() {
  const snapshot = undoStack.pop();
  if (!snapshot) return;
  keyframeManager.restoreState(snapshot.keyframeState);
  restoreHierarchySnapshot(snapshot.hierarchyState);
  jointPoints = (snapshot.jointPoints || []).map((p) => ({ ...p }));
  activeJointPointId = snapshot.activeJointPointId || null;
  jointObjectAId = snapshot.jointObjectAId || null;
  jointObjectBId = snapshot.jointObjectBId || null;
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
          keyframeManager.setJointDef(node.id, {
            ...patch,
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
          // Set origin to bottom-center of child's bounding box (UI convention)
          const childObj = node.object;
          if (!childObj) return;
          const box = new THREE.Box3().setFromObject(childObj);
          if (box.isEmpty()) return;
          const center = box.getCenter(new THREE.Vector3());
          const uiOrigin = worldToUiVector3(new THREE.Vector3(center.x, box.min.y, center.z));
          callback(uiOrigin.x, uiOrigin.y, uiOrigin.z);
          syncJointOriginMarker(node.id);
        },
        onOriginFromCenter: (callback) => {
          // Set origin to center of child's bounding box (UI convention)
          const childObj = node.object;
          if (!childObj) return;
          const box = new THREE.Box3().setFromObject(childObj);
          if (box.isEmpty()) return;
          const center = box.getCenter(new THREE.Vector3());
          const uiOrigin = worldToUiVector3(center);
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

      sceneTreeNodes = buildSceneTree(sceneManager.sceneRoot);
      refreshObjectTree();
      refreshSelectionUI();
    },
    onInsertGroup: (obj) => {
      if (!obj) return;
      pushUndoSnapshot();
      const parent = obj.parent || sceneManager.sceneRoot;
      const idx = parent.children.indexOf(obj);

      // Create group with same local transform as the child
      const newGroup = new THREE.Group();
      newGroup.name = `${obj.name || 'node'}_joint_group`;
      newGroup.position.copy(obj.position);
      newGroup.quaternion.copy(obj.quaternion);
      newGroup.scale.copy(obj.scale);

      // Remove obj from parent, add group in its place
      parent.remove(obj);
      parent.add(newGroup);

      // Put obj under group with identity local transform
      obj.position.set(0, 0, 0);
      obj.quaternion.identity();
      obj.scale.set(1, 1, 1);
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

      editableObjects = collectEditableObjects(sceneManager.sceneRoot);
      sceneTreeNodes = buildSceneTree(sceneManager.sceneRoot);
      refreshObjectTree();
      refreshSelectionUI();
    },
    onMoveToRoot: (obj) => {
      if (!obj || obj.parent === sceneManager.sceneRoot) return;
      pushUndoSnapshot();
      sceneManager.sceneRoot.attach(obj);
      sceneTreeNodes = buildSceneTree(sceneManager.sceneRoot);
      refreshObjectTree();
      refreshSelectionUI();
    },
  });
}

function getCurrentDuration() {
  const selected = selectionManager.selectedObject;
  if (!selected) return 10;
  return keyframeManager.getClipDuration(selected);
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
    // Don't call applyJointDrive here — gizmo is already moving the object.
    // Just update the UI slider.
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
  if (!id) {
    // Don't clear — leave existing pivot marker from old joint system
    return;
  }
  const def = keyframeManager.getJointDef(id);
  if (!def || def.type === 'none' || def.type === 'fixed') return;
  // Convert UI origin to world coordinates and show marker
  const worldOrigin = uiToWorldVector3(
    def.origin?.x ?? 0,
    def.origin?.y ?? 0,
    def.origin?.z ?? 0,
  );
  sceneManager.setPivotMarker(worldOrigin);
}

function refreshSelectionUI() {
  const selected = selectionManager.selectedObject;
  ui.setSelectedObject(selected);
  refreshJointPanel();
  syncJointGizmo();

  if (!selected) {
    ui.setClipOptions([], null);
    ui.setActiveClipInfo(null);
    ui.renderKeyframes([]);
    ui.setTimelineRange(10);
    ui.updateTimelineLabel(keyframeManager.currentTime, 10);
    refreshObjectTree();
    return;
  }

  const clipNames = keyframeManager.getClipNames(selected);
  const activeClip = keyframeManager.getActiveClip(selected);
  ui.setClipOptions(clipNames, activeClip?.clipName);
  if (activeClip) {
    const uiPivot = worldToUiVector3(new THREE.Vector3(activeClip.pivotX, activeClip.pivotY, activeClip.pivotZ));
    ui.setActiveClipInfo({
      ...activeClip,
      pivotX: uiPivot.x,
      pivotY: uiPivot.y,
      pivotZ: uiPivot.z,
    });
  } else {
    ui.setActiveClipInfo(null);
  }
  const handleDeleteKeyframe = (keyframe) => {
    pushUndoSnapshot();
    keyframeManager.removeKeyframe(selected, keyframe.time);
    keyframeManager.evaluateObjectAt(selected, keyframeManager.currentTime);
    ui.setSelectedObject(selected);
    refreshSelectionUI();
  };
  ui.renderKeyframes(keyframeManager.getTrack(selected), handleDeleteKeyframe);

  const duration = getCurrentDuration();
  if (keyframeManager.currentTime > duration) {
    keyframeManager.currentTime = duration;
    ui.setTime(duration);
  }
  ui.setTimelineRange(duration);
  ui.updateTimelineLabel(keyframeManager.currentTime, duration);
  updatePivotMarkerFromInputs();
  refreshObjectTree();
}

function refreshJointPanel() {
  if (!editableObjects.length) {
    jointObjectAId = null;
    jointObjectBId = null;
    activeJointPointId = null;
    ui.setJointObjectOptions([], null, null);
    ui.renderJointPoints([], null, null);
    ui.setJointEditor(null);
    sceneManager.clearPivotMarker();
    return;
  }

  if (!jointObjectAId || !findObjectById(jointObjectAId)) {
    jointObjectAId = editableObjects[0].uuid;
  }
  const secondCandidate = editableObjects.find((obj) => obj.uuid !== jointObjectAId);
  if (!jointObjectBId || !findObjectById(jointObjectBId) || jointObjectBId === jointObjectAId) {
    jointObjectBId = secondCandidate?.uuid || jointObjectAId;
  }
  ui.setJointObjectOptions(editableObjects, jointObjectAId, jointObjectBId);

  if (!jointPoints.length) {
    activeJointPointId = null;
    ui.renderJointPoints([], null, null);
    ui.setJointEditor(null);
    sceneManager.clearPivotMarker();
    return;
  }
  if (!activeJointPointId || !jointPoints.some((p) => p.id === activeJointPointId)) {
    activeJointPointId = jointPoints[0].id;
  }
  const displayPoints = mapJointPointsForDisplay(jointPoints);
  const renderPoints = mapJointPointsForRender(jointPoints);
  const activePoint = displayPoints.find((p) => p.id === activeJointPointId) || null;
  const activeWorldPoint = renderPoints.find((p) => p.id === activeJointPointId) || null;
  ui.renderJointPoints(displayPoints, activeJointPointId, {
    onSelect: (point) => {
      activeJointPointId = point.id;
      refreshJointPanel();
    },
  });
  sceneManager.renderJointMarkers(renderPoints, activeJointPointId);
  ui.setJointEditor(activePoint);
  if (activeWorldPoint) {
    sceneManager.setPivotMarker(new THREE.Vector3(activeWorldPoint.x, activeWorldPoint.y, activeWorldPoint.z));
  } else {
    sceneManager.clearPivotMarker();
  }
}

function syncJointMarkerVisuals() {
  if (!jointPoints.length) {
    sceneManager.renderJointMarkers([], null);
    return;
  }
  const renderPoints = mapJointPointsForRender(jointPoints);
  sceneManager.renderJointMarkers(renderPoints, activeJointPointId);

  const activeRenderPoint = renderPoints.find((p) => p.id === activeJointPointId) || null;
  if (activeRenderPoint) {
    sceneManager.setPivotMarker(new THREE.Vector3(activeRenderPoint.x, activeRenderPoint.y, activeRenderPoint.z));
  }
}

function updatePivotMarkerFromInputs() {
  const selected = selectionManager.selectedObject;
  if (!selected || !ui.pivotEnabledInput.checked) {
    sceneManager.clearPivotMarker();
    return;
  }
  const x = Number(ui.pivotXInput.value);
  const y = Number(ui.pivotYInput.value);
  const z = Number(ui.pivotZInput.value);
  if (![x, y, z].every(Number.isFinite)) {
    sceneManager.clearPivotMarker();
    return;
  }
  const worldPivot = uiToWorldVector3(x, y, z);
  sceneManager.setPivotMarker(worldPivot);
}

function setPivotInputsAndApply(x, y, z, recordUndo = true) {
  if (recordUndo) pushUndoSnapshot();
  const uiPivot = worldToUiVector3(new THREE.Vector3(x, y, z));
  ui.pivotEnabledInput.checked = true;
  ui.pivotXInput.value = Number(uiPivot.x).toFixed(3);
  ui.pivotYInput.value = Number(uiPivot.y).toFixed(3);
  ui.pivotZInput.value = Number(uiPivot.z).toFixed(3);
  applyClipConfigFromUI(false, true);
}

function toFiniteOr(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function computeCenterMidpoint(objectA, objectB) {
  const boxA = new THREE.Box3().setFromObject(objectA);
  const boxB = new THREE.Box3().setFromObject(objectB);
  const centerA = boxA.getCenter(new THREE.Vector3());
  const centerB = boxB.getCenter(new THREE.Vector3());
  return centerA.add(centerB).multiplyScalar(0.5);
}

function computeNearestMidpoint(objectA, objectB) {
  const boxA = new THREE.Box3().setFromObject(objectA);
  const boxB = new THREE.Box3().setFromObject(objectB);
  const centerA = boxA.getCenter(new THREE.Vector3());
  const centerB = boxB.getCenter(new THREE.Vector3());

  const onA = boxA.clampPoint(centerB, new THREE.Vector3());
  const onB = boxB.clampPoint(centerA, new THREE.Vector3());
  return onA.add(onB).multiplyScalar(0.5);
}

function applyClipConfigFromUI(recordUndo = false, forceNewPivot = false) {
  const object = selectionManager.selectedObject;
  if (!object) return;
  if (recordUndo) pushUndoSnapshot();

  let worldPivot;
  const existingClip = keyframeManager.getActiveClip(object);
  const activeJoint = activeJointPointId ? jointPoints.find((p) => p.id === activeJointPointId) : null;
  if (ui.pivotEnabledInput.checked) {
    if (!forceNewPivot && existingClip?.pivotEnabled && Number.isFinite(existingClip.pivotX)) {
      worldPivot = new THREE.Vector3(existingClip.pivotX, existingClip.pivotY, existingClip.pivotZ);
    } else if (activeJoint) {
      worldPivot = worldFromJointPoint(activeJoint);
    } else {
      const pivotInputX = Number(ui.pivotXInput.value);
      const pivotInputY = Number(ui.pivotYInput.value);
      const pivotInputZ = Number(ui.pivotZInput.value);
      worldPivot = uiToWorldVector3(
        Number.isFinite(pivotInputX) ? pivotInputX : 0,
        Number.isFinite(pivotInputY) ? pivotInputY : 0,
        Number.isFinite(pivotInputZ) ? pivotInputZ : 0,
      );
    }
    const uiPivot = worldToUiVector3(worldPivot);
    ui.pivotXInput.value = uiPivot.x.toFixed(3);
    ui.pivotYInput.value = uiPivot.y.toFixed(3);
    ui.pivotZInput.value = uiPivot.z.toFixed(3);
  } else {
    const pivotInputX = Number(ui.pivotXInput.value);
    const pivotInputY = Number(ui.pivotYInput.value);
    const pivotInputZ = Number(ui.pivotZInput.value);
    worldPivot = uiToWorldVector3(
      Number.isFinite(pivotInputX) ? pivotInputX : 0,
      Number.isFinite(pivotInputY) ? pivotInputY : 0,
      Number.isFinite(pivotInputZ) ? pivotInputZ : 0,
    );
  }

  keyframeManager.updateActiveClipConfig(object, {
    jointEnabled: ui.jointEnabledInput.checked,
    translateAxis: ui.translateAxisSelect.value,
    translateValue: ui.translateValueInput.value,
    rotateAxis: ui.rotateAxisSelect.value,
    rotateValue: ui.rotateValueInput.value,
    pivotEnabled: ui.pivotEnabledInput.checked,
    pivotX: worldPivot.x,
    pivotY: worldPivot.y,
    pivotZ: worldPivot.z,
    duration: ui.durationInput.value,
  });
  keyframeManager.applyCurrentChannelValues(object);
  ui.setSelectedObject(object);
  const duration = getCurrentDuration();
  if (keyframeManager.currentTime > duration) {
    keyframeManager.currentTime = duration;
    ui.setTime(duration);
  }
  ui.setTimelineRange(duration);
  ui.updateTimelineLabel(keyframeManager.currentTime, duration);
  updatePivotMarkerFromInputs();
  refreshSelectionUI();
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
    jointPoints = [];
    activeJointPointId = null;
    jointObjectAId = null;
    jointObjectBId = null;
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

    // Restore joints
    jointPoints = [];
    activeJointPointId = null;
    jointObjectAId = null;
    jointObjectBId = null;

    const jointsFileName = manifest.files?.joints || 'joints.json';
    const jointsFile = zip.file(jointsFileName) || zip.file('joints.json');
    if (jointsFile) {
      const jointsData = JSON.parse(await jointsFile.async('string'));
      (jointsData.joints || []).forEach((j) => {
        const followObj = j.follow_object ? objectsByName.get(j.follow_object) : null;
        const pos = j.position || [0, 0, 0];
        const offset = j.offset_from_object_origin || j.follow_offset || null;
        jointPoints.push({
          id: j.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          name: j.name || '关节',
          x: pos[0] ?? 0,
          y: pos[1] ?? 0,
          z: pos[2] ?? 0,
          followObjectId: followObj?.uuid || null,
          followOffset: offset ? { x: offset[0] ?? 0, y: offset[1] ?? 0, z: offset[2] ?? 0 } : null,
          local: null,
        });
      });
      if (jointPoints.length) activeJointPointId = jointPoints[0].id;
    }

    // Restore joint definitions (FK layer-tree joints)
    keyframeManager.jointDefinitions.clear();
    const jointDefsFileName = manifest.files?.joint_definitions;
    const jointDefsFile = jointDefsFileName
      ? zip.file(jointDefsFileName)
      : Object.values(zip.files).find((f) => /^joint-definitions.*\.json$/i.test(f.name));
    if (jointDefsFile) {
      // Build path-based lookup for fallback matching
      const objectsByPath = new Map();
      editableObjects.forEach((obj) => {
        const path = getScenePath(obj);
        if (path) objectsByPath.set(path, obj);
      });

      const jointDefsData = JSON.parse(await jointDefsFile.async('string'));
      (jointDefsData.definitions || []).forEach((d) => {
        // Priority: 1) name match, 2) scene_path match, 3) fallback to stored id
        let childObj = d.name ? objectsByName.get(d.name) : null;
        if (!childObj && d.scene_path) {
          childObj = objectsByPath.get(d.scene_path) || null;
        }
        const nodeId = childObj?.uuid || d.child_id || d.id;
        const parentObj = childObj?.parent;
        keyframeManager.setJointDef(nodeId, {
          name: d.name || '',
          type: d.type || 'none',
          axis: d.axis || 'y',
          origin: { x: d.origin?.x ?? 0, y: d.origin?.y ?? 0, z: d.origin?.z ?? 0 },
          limits: { min: d.limits?.min ?? -180, max: d.limits?.max ?? 180 },
          parentId: parentObj?.uuid || d.parent_id || null,
          childId: nodeId,
          currentValue: d.current_value ?? 0,
        });
      });
    }

    // Restore clips & keyframes
    const motionFileName = manifest.files?.motion || 'motion.json';
    const motionFile = zip.file(motionFileName) || zip.file('motion.json');
    if (motionFile) {
      const motionData = JSON.parse(await motionFile.async('string'));
      (motionData.clips || []).forEach((clipData) => {
        const obj = objectsByName.get(clipData.object);
        if (!obj) return;

        const objectData = keyframeManager.ensureObjectData(obj);
        if (!objectData) return;

        const clipName = clipData.clip_name || 'default';
        let clip;
        if (objectData.clips.has(clipName)) {
          clip = objectData.clips.get(clipName);
        } else {
          keyframeManager.createClip(obj, clipName);
          clip = objectData.clips.get(clipName);
        }
        if (!clip) return;

        keyframeManager.setActiveClip(obj, clipName);

        const translateChannel = clipData.channels?.translate || null;
        const rotateChannel = clipData.channels?.rotate || null;
        clip.translateAxis = translateChannel?.axis || clipData.translate_axis || 'z';
        clip.rotateAxis = rotateChannel?.axis || clipData.rotate_axis || 'z';
        clip.duration = clipData.duration || 10;
        clip.jointEnabled = true;

        if (clipData.pivot) {
          clip.pivotEnabled = true;
          clip.pivotX = clipData.pivot[0] ?? 0;
          clip.pivotY = clipData.pivot[1] ?? 0;
          clip.pivotZ = clipData.pivot[2] ?? 0;
        }

        const legacyFrames = clipData.keyframes || [];
        const translateSamples = translateChannel?.samples || [];
        const rotateSamples = rotateChannel?.samples || [];
        if (translateSamples.length || rotateSamples.length) {
          const timeSet = new Set();
          translateSamples.forEach((s) => timeSet.add(Number(s.t)));
          rotateSamples.forEach((s) => timeSet.add(Number(s.t)));
          const sortedTimes = [...timeSet].filter(Number.isFinite).sort((a, b) => a - b);
          clip.keyframes = sortedTimes.map((t) => {
            const tSample = translateSamples.find((s) => Number(s.t) === t);
            const rSample = rotateSamples.find((s) => Number(s.t) === t);
            return {
              time: t,
              translateValue: Number(tSample?.value ?? 0),
              rotateValue: Number(rSample?.value ?? 0),
            };
          });
        } else {
          clip.keyframes = legacyFrames.map((k) => ({
            time: k.t ?? 0,
            translateValue: k.translate ?? 0,
            rotateValue: k.rotate ?? 0,
          }));
        }
        clip.keyframes.sort((a, b) => a.time - b.time);

        if (clip.keyframes.length) {
          clip.currentTranslateValue = clip.keyframes[0].translateValue;
          clip.currentRotateValue = clip.keyframes[0].rotateValue;
        }
      });
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
      // 恢复步骤
      (pkfData.steps || []).forEach((s) => {
        keyframeManager.addPkfStep({
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
      restoredPkfSteps = (pkfData.steps || []).length;
    }

    selectionManager.clearSelection();
    keyframeManager.evaluateAllAt(0, sceneManager.sceneRoot);
    keyframeManager.applyAllJointDrives(sceneManager.sceneRoot);

    const restoredClipCount = editableObjects.reduce((sum, obj) => {
      const data = keyframeManager.ensureObjectData(obj);
      return sum + (data ? data.clips.size : 0);
    }, 0);
    const restoredKfCount = editableObjects.reduce((sum, obj) => {
      const data = keyframeManager.ensureObjectData(obj);
      if (!data) return sum;
      let count = 0;
      data.clips.forEach((c) => { count += c.keyframes.length; });
      return sum + count;
    }, 0);

    // 状态信息包含 PKF 统计
    const pkfInfo = (restoredPkfParams || restoredPkfSteps)
      ? `，PKF 参数：${restoredPkfParams}，PKF 步骤：${restoredPkfSteps}`
      : '';
    ui.setLoadStatus(
      `已导入资产包。对象：${editableObjects.length}，关节：${jointPoints.length}，片段：${restoredClipCount}，关键帧：${restoredKfCount}${pkfInfo}`,
    );
    refreshObjectTree();
    refreshJointPanel();
    refreshPkfParamsUI();  // 刷新 PKF 参数 UI
    refreshPkfStepsUI();   // 刷新 PKF 步骤 UI
  } catch (error) {
    ui.setLoadStatus(`导入资产包失败：${error.message}`);
  }
}

function updateTimeline(deltaSeconds) {
  if (!isPlaying) return;

  const duration = getCurrentDuration();
  const next = (keyframeManager.currentTime + deltaSeconds) % duration;
  keyframeManager.evaluateAllAt(next, sceneManager.sceneRoot);
  ui.setTime(keyframeManager.currentTime);
  ui.updateTimelineLabel(keyframeManager.currentTime, duration);
}

function loop(now) {
  const deltaSeconds = (now - lastFrameTime) / 1000;
  lastFrameTime = now;

  updateTimeline(deltaSeconds);
  keyframeManager.applyAllJointDrives(sceneManager.sceneRoot);
  syncJointMarkerVisuals();
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

sceneManager.renderer.domElement.addEventListener(
  'pointerdown',
  (event) => {
    const pointId = sceneManager.pickJointMarker(event.clientX, event.clientY);
    if (!pointId) return;
    event.preventDefault();
    event.stopPropagation();
    activeJointPointId = pointId;
    refreshJointPanel();
  },
  true,
);

ui.jointObjectASelect.addEventListener('change', () => {
  jointObjectAId = ui.jointObjectASelect.value || null;
  if (jointObjectAId === jointObjectBId) {
    const candidate = editableObjects.find((obj) => obj.uuid !== jointObjectAId);
    jointObjectBId = candidate?.uuid || jointObjectAId;
  }
  refreshJointPanel();
});
ui.jointObjectBSelect.addEventListener('change', () => {
  jointObjectBId = ui.jointObjectBSelect.value || null;
  if (jointObjectAId === jointObjectBId) {
    const candidate = editableObjects.find((obj) => obj.uuid !== jointObjectBId);
    jointObjectAId = candidate?.uuid || jointObjectBId;
  }
  refreshJointPanel();
});

ui.jointEnabledInput.addEventListener('change', () => applyClipConfigFromUI(true));
ui.translateAxisSelect.addEventListener('change', () => applyClipConfigFromUI(true));
ui.rotateAxisSelect.addEventListener('change', () => applyClipConfigFromUI(true));
ui.pivotEnabledInput.addEventListener('change', () => applyClipConfigFromUI(true, true));
ui.pivotXInput.addEventListener('change', () => applyClipConfigFromUI(true, true));
ui.pivotYInput.addEventListener('change', () => applyClipConfigFromUI(true, true));
ui.pivotZInput.addEventListener('change', () => applyClipConfigFromUI(true, true));
ui.translateValueInput.addEventListener('input', () => applyClipConfigFromUI(false));
ui.rotateValueInput.addEventListener('input', () => applyClipConfigFromUI(false));
ui.translateValueInput.addEventListener('focus', () => {
  if (motionValueEditSnapshotCaptured) return;
  pushUndoSnapshot();
  motionValueEditSnapshotCaptured = true;
});
ui.rotateValueInput.addEventListener('focus', () => {
  if (motionValueEditSnapshotCaptured) return;
  pushUndoSnapshot();
  motionValueEditSnapshotCaptured = true;
});
ui.translateValueInput.addEventListener('blur', () => {
  motionValueEditSnapshotCaptured = false;
});
ui.rotateValueInput.addEventListener('blur', () => {
  motionValueEditSnapshotCaptured = false;
});
ui.translateValueInput.addEventListener('change', () => applyClipConfigFromUI(false));
ui.rotateValueInput.addEventListener('change', () => applyClipConfigFromUI(false));

ui.durationInput.addEventListener('change', () => applyClipConfigFromUI(true));

ui.createClipBtn.addEventListener('click', () => {
  const object = selectionManager.selectedObject;
  if (!object) {
    ui.exportOutput.textContent = '请先选择对象再创建片段。';
    return;
  }
  pushUndoSnapshot();
  keyframeManager.createClip(object, ui.clipNameInput.value);
  ui.clipNameInput.value = '';
  refreshSelectionUI();
});

ui.clipSelect.addEventListener('change', () => {
  const object = selectionManager.selectedObject;
  if (!object) return;
  pushUndoSnapshot();
  keyframeManager.setActiveClip(object, ui.clipSelect.value);
  keyframeManager.applyCurrentChannelValues(object);
  ui.setSelectedObject(object);
  refreshSelectionUI();
});

ui.jointFromCenterBtn.addEventListener('click', () => {
  const objectA = findObjectById(jointObjectAId);
  const objectB = findObjectById(jointObjectBId);
  if (!objectA || !objectB || objectA.uuid === objectB.uuid) {
    ui.exportOutput.textContent = '请在关节面板中选择两个不同对象。';
    return;
  }
  const pivot = computeCenterMidpoint(objectA, objectB);
  setPivotInputsAndApply(pivot.x, pivot.y, pivot.z, true);
});

ui.jointFromNearestBtn.addEventListener('click', () => {
  const objectA = findObjectById(jointObjectAId);
  const objectB = findObjectById(jointObjectBId);
  if (!objectA || !objectB || objectA.uuid === objectB.uuid) {
    ui.exportOutput.textContent = '请在关节面板中选择两个不同对象。';
    return;
  }
  const pivot = computeNearestMidpoint(objectA, objectB);
  setPivotInputsAndApply(pivot.x, pivot.y, pivot.z, true);
});

ui.jointSaveCurrentBtn.addEventListener('click', () => {
  const x = Number(ui.pivotXInput.value);
  const y = Number(ui.pivotYInput.value);
  const z = Number(ui.pivotZInput.value);
  if (![x, y, z].every(Number.isFinite)) {
    ui.exportOutput.textContent = 'Pivot 坐标无效，无法保存关节点。';
    return;
  }
  const worldPivot = uiToWorldVector3(x, y, z);
  pushUndoSnapshot();
  const nextIndex = jointPoints.length + 1;
  const created = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: `关节${nextIndex}`,
    x: worldPivot.x,
    y: worldPivot.y,
    z: worldPivot.z,
    followObjectId: jointObjectAId || null,
    local: null,
  };
  if (created.followObjectId) {
    const owner = findObjectById(created.followObjectId);
    if (owner) {
      const ownerWorld = owner.getWorldPosition(new THREE.Vector3());
      created.followOffset = {
        x: worldPivot.x - ownerWorld.x,
        y: worldPivot.y - ownerWorld.y,
        z: worldPivot.z - ownerWorld.z,
      };
      created.local = null;
    }
  }
  jointPoints = [...jointPoints, created];
  activeJointPointId = created.id;
  refreshJointPanel();
});

ui.jointApplyBtn.addEventListener('click', () => {
  const selected = selectionManager.selectedObject;
  if (!activeJointPointId) return;
  pushUndoSnapshot();
  const nextFollowObjectId = ui.jointFollowAInput.checked ? jointObjectAId : null;
  const existing = jointPoints.find((p) => p.id === activeJointPointId);
  const currentWorld = existing ? worldFromJointPoint(existing) : new THREE.Vector3(0, 0, 0);
  const uiCurrent = worldToUiVector3(currentWorld);
  const uiX = toFiniteOr(ui.jointXInput.value, uiCurrent.x);
  const uiY = toFiniteOr(ui.jointYInput.value, uiCurrent.y);
  const uiZ = toFiniteOr(ui.jointZInput.value, uiCurrent.z);
  const worldPoint = uiToWorldVector3(uiX, uiY, uiZ);
  jointPoints = jointPoints.map((p) =>
    p.id === activeJointPointId
      ? {
          ...p,
          name: (ui.jointNameInput.value || '').trim() || p.name,
          x: Number.isFinite(worldPoint.x) ? worldPoint.x : p.x,
          y: Number.isFinite(worldPoint.y) ? worldPoint.y : p.y,
          z: Number.isFinite(worldPoint.z) ? worldPoint.z : p.z,
          followObjectId: nextFollowObjectId,
          followOffset:
            nextFollowObjectId && findObjectById(nextFollowObjectId)
              ? (() => {
                  const owner = findObjectById(nextFollowObjectId);
                  const ownerWorld = owner.getWorldPosition(new THREE.Vector3());
                  return {
                    x: worldPoint.x - ownerWorld.x,
                    y: worldPoint.y - ownerWorld.y,
                    z: worldPoint.z - ownerWorld.z,
                  };
                })()
              : null,
          local: null,
        }
      : p,
  );
  const activeRawPoint = jointPoints.find((p) => p.id === activeJointPointId);
  if (activeRawPoint) {
    const worldPoint = worldFromJointPoint(activeRawPoint);
    setPivotInputsAndApply(worldPoint.x, worldPoint.y, worldPoint.z, false);
  }
  if (selected) applyClipConfigFromUI(false);
  refreshJointPanel();
});

ui.jointDeleteBtn.addEventListener('click', () => {
  if (!activeJointPointId) return;
  pushUndoSnapshot();
  jointPoints = jointPoints.filter((p) => p.id !== activeJointPointId);
  activeJointPointId = null;
  refreshJointPanel();
});

ui.timeInput.addEventListener('input', () => {
  const t = Number(ui.timeInput.value);
  keyframeManager.evaluateAllAt(t, sceneManager.sceneRoot);
  ui.updateTimelineLabel(keyframeManager.currentTime, getCurrentDuration());
  refreshSelectionUI();
});

ui.playBtn.addEventListener('click', () => {
  isPlaying = !isPlaying;
  ui.setPlayState(isPlaying);
});

ui.keyframeBtn.addEventListener('click', () => {
  if (!selectionManager.selectedObject) return;
  pushUndoSnapshot();
  keyframeManager.addKeyframe(selectionManager.selectedObject, keyframeManager.currentTime);
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

function applyAiSteps(steps) {
  if (!steps?.length) return;
  pushUndoSnapshot();
  const objectsByName = new Map();
  editableObjects.forEach((obj) => {
    if (obj.name) objectsByName.set(obj.name, obj);
  });
  let accumulatedTime = 0;
  const stepDuration = 2;
  steps.forEach((step) => {
    const obj = objectsByName.get(step.part);
    if (!obj) return;
    const clipName = `ai_${step.action}_${step.axis}`;
    const objectData = keyframeManager.ensureObjectData(obj);
    if (!objectData.clips.has(clipName)) keyframeManager.createClip(obj, clipName);
    keyframeManager.setActiveClip(obj, clipName);
    const clip = objectData.clips.get(clipName);
    clip.jointEnabled = true;
    clip.duration = Math.max(clip.duration, accumulatedTime + stepDuration);
    if (step.action === 'translate') {
      clip.translateAxis = step.axis || 'z';
      clip.keyframes = [
        { time: accumulatedTime, translateValue: 0, rotateValue: 0 },
        { time: accumulatedTime + stepDuration, translateValue: step.value ?? 0, rotateValue: 0 },
      ];
    } else if (step.action === 'rotate') {
      clip.rotateAxis = step.axis || 'z';
      clip.keyframes = [
        { time: accumulatedTime, translateValue: 0, rotateValue: 0 },
        { time: accumulatedTime + stepDuration, translateValue: 0, rotateValue: step.value ?? 0 },
      ];
    }
    accumulatedTime += stepDuration;
  });
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

function buildExportJointPoints() {
  return jointPoints.map((p) => {
    const owner = p.followObjectId ? findObjectById(p.followObjectId) : null;
    return {
      ...p,
      followObjectName: owner?.name || null,
    };
  });
}

function buildExportClips() {
  const raw = keyframeManager.exportForObjects(editableObjects);
  return raw
    .filter((obj) => obj.keyframes.length > 0)
    .map((obj) => ({
      object_id: obj.object_id,
      object_name: obj.object_name,
      clip_name: obj.clip_name,
      translate_axis: obj.channels?.translate?.axis ?? 'z',
      rotate_axis: obj.channels?.rotate?.axis ?? 'z',
      pivot_enabled: obj.pivot?.enabled ?? false,
      pivot_x: obj.pivot?.x ?? 0,
      pivot_y: obj.pivot?.y ?? 0,
      pivot_z: obj.pivot?.z ?? 0,
      duration: obj.duration,
      keyframes: obj.keyframes,
    }));
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
 * 「从关键帧生成」按钮：读取当前所有对象的关键帧数据，
 * 为每个有关键帧的 clip 生成对应的 PKF 步骤（translate + rotate）。
 * 公式值直接使用关键帧的固定数值（用户可后续手动改为参数公式）。
 */
ui.pkfGenFromKfBtn.addEventListener('click', () => {
  const clips = buildExportClips();
  if (!clips.length) {
    alert('没有关键帧数据可生成。请先为对象添加关键帧。');
    return;
  }
  pushUndoSnapshot();

  // 查找对象对应的关节定义 id（如果有的话）
  const allJointDefs = keyframeManager.getAllJointDefs();

  clips.forEach((clip) => {
    // 尝试匹配关节定义
    const matchedDef = allJointDefs.find((jd) => jd.childId === clip.object_id) || null;
    const kfs = clip.keyframes || [];
    if (kfs.length < 2) return; // 至少需要两个关键帧才能生成步骤

    // 为相邻关键帧对生成步骤
    for (let i = 0; i < kfs.length - 1; i++) {
      const kfA = kfs[i];
      const kfB = kfs[i + 1];

      // 平移通道：如果值有变化则生成步骤
      if (kfA.translate_value !== kfB.translate_value) {
        keyframeManager.addPkfStep({
          joint: clip.object_name || '',
          joint_def_id: matchedDef?.id || '',
          channel: 'translate',
          axis: clip.translate_axis || 'z',
          t_start: kfA.t,
          t_end: kfB.t,
          value_start: String(kfA.translate_value ?? 0),
          value_end: String(kfB.translate_value ?? 0),
          easing: 'linear',
        });
      }

      // 旋转通道：如果值有变化则生成步骤
      if (kfA.rotate_value !== kfB.rotate_value) {
        keyframeManager.addPkfStep({
          joint: clip.object_name || '',
          joint_def_id: matchedDef?.id || '',
          channel: 'rotate',
          axis: clip.rotate_axis || 'z',
          t_start: kfA.t,
          t_end: kfB.t,
          value_start: String(kfA.rotate_value ?? 0),
          value_end: String(kfB.rotate_value ?? 0),
          easing: 'linear',
        });
      }
    }
  });

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

  results.forEach((r) => {
    const status = r.error ? `⚠ ${r.error}` : `= ${r.value.toFixed(4)}`;
    lines.push(`[${r.joint || r.joint_def_id}] ${r.channel}.${r.axis} ${status}`);
    if (r.error) hasError = true;

    // 尝试驱动对应的关节定义
    if (!r.error && r.joint_def_id && sceneManager.sceneRoot) {
      const def = keyframeManager.jointDefinitions.get(r.joint_def_id);
      if (def) {
        // 临时设置关节值并应用驱动
        def.currentValue = r.value;
        keyframeManager.applyJointDrive(def, sceneManager.sceneRoot);
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
  const joints = buildExportJointPoints();
  if (!clips.length && !joints.length) {
    ui.exportOutput.textContent = '没有可导出的数据，请先创建关节或添加关键帧。';
    return;
  }
  ui.exportOutput.textContent = JSON.stringify({ joints, clips }, null, 2);
});

ui.exportPackageBtn.addEventListener('click', async () => {
  const clips = buildExportClips();
  const joints = buildExportJointPoints();

  if (!clips.length && !joints.length) {
    ui.exportOutput.textContent = '没有可导出的数据，请先创建关节或添加关键帧。';
    return;
  }

  try {
    const { manifest } = await packageExporter.exportZip({
      sourceFileName: sourceInfo.fileName,
      sourceFormat: sourceInfo.format,
      rawModelFile: sourceInfo.rawFile,
      jointPoints: joints,
      jointDefinitions: keyframeManager.getAllJointDefs().map((d) => {
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

window.__mf = { sceneManager, keyframeManager, selectionManager, editableObjects: () => editableObjects };

ui.setTimelineRange(10);
ui.updateTimelineLabel(0, 10);
refreshSelectionUI();
requestAnimationFrame(loop);
