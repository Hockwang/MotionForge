import * as THREE from 'three';

export class SelectionManager {
  constructor(sceneManager) {
    this.sceneManager = sceneManager;
    this.selectedObject = null;
    this.listeners = new Set();
    this.originalMaterialState = new Map();

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
  }

  /**
   * 在视口 canvas 上注册 pointerdown，处理鼠标点击场景对象的拾取
   * 注意：当 TransformControls Gizmo 的某个手柄被 hover 时（axis 非 null），
   * 必须跳过场景选择，把事件让给 TransformControls 自己处理。否则 selectObject
   * 触发的 syncJointGizmo() 会在 TransformControls 完成 pointerdown 流程之前
   * 把 gizmo detach 掉，导致 dragging-changed 无法回到 false，OrbitControls 永久禁用。
   *
   * @param {Function} onEmptyClick - 点击空白处的回调（清除选择）
   */
  attachViewportSelection(onEmptyClick) {
    const canvas = this.sceneManager.renderer.domElement;
    canvas.addEventListener('pointerdown', (event) => {
      if (event.defaultPrevented) return;
      // ── Gizmo hover 守卫 ──
      // TransformControls 在 hover 到任意手柄时会把 axis 设为非 null。
      // 此时不要做场景选择，避免抢走属于 gizmo 的拖动事件。
      if (this.sceneManager.jointGizmo?.axis) return;

      const rect = canvas.getBoundingClientRect();
      this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;

      this.raycaster.setFromCamera(this.pointer, this.sceneManager.camera);
      const root = this.sceneManager.sceneRoot;
      if (!root) return;

      const hits = this.raycaster.intersectObject(root, true);
      const meshHit = hits.find((h) => h.object.isMesh);
      if (!meshHit) {
        onEmptyClick?.();
        return;
      }
      this.selectObject(meshHit.object);
    });
  }

  selectObject(object) {
    if (this.selectedObject === object) return;
    this.clearHighlight(this.selectedObject);
    this.selectedObject = object || null;
    this.applyHighlight(this.selectedObject);
    this.emit();
  }

  clearSelection() {
    this.selectObject(null);
  }

  onSelectionChanged(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  applyHighlight(object) {
    if (!object) return;
    // 只高亮该节点自身的 Mesh（如果它是 Mesh），或其直接子 Mesh（如果它是 Group）
    // 不递归更深层级，避免选中父节点时整棵子树都变色
    const meshes = this._getHighlightMeshes(object);
    meshes.forEach((mesh) => {
      // 共享 material 问题：clone 一份独占的 material，避免改 emissive 影响其他对象
      if (!mesh.userData._ownMaterial) {
        mesh.material = mesh.material.clone();
        mesh.userData._ownMaterial = true;
      }
      const emissive = mesh.material.emissive;
      if (!emissive) return;
      this.originalMaterialState.set(mesh.uuid, emissive.getHex());
      emissive.setHex(0x22d3ee);
      if ('emissiveIntensity' in mesh.material) {
        mesh.material.emissiveIntensity = 0.55;
      }
    });
  }

  clearHighlight(object) {
    if (!object) return;
    const meshes = this._getHighlightMeshes(object);
    meshes.forEach((mesh) => {
      const original = this.originalMaterialState.get(mesh.uuid);
      const emissive = mesh.material?.emissive;
      if (!emissive) return;
      emissive.setHex(original ?? 0x000000);
      if ('emissiveIntensity' in mesh.material) {
        mesh.material.emissiveIntensity = 0.2;
      }
    });
  }

  /**
   * 获取应该被高亮的 Mesh 列表
   * - 如果 object 本身是 Mesh → 只返回它自己
   * - 如果 object 是 Group/Object3D → 返回其直接子 Mesh（不递归）
   */
  _getHighlightMeshes(object) {
    if (!object) return [];
    if (object.isMesh) return [object];
    // Group/Object3D：只取直接子 Mesh
    return (object.children || []).filter((c) => c.isMesh);
  }

  emit() {
    this.listeners.forEach((listener) => listener(this.selectedObject));
  }
}
