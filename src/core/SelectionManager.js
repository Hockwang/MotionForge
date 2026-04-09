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
    if (!object?.isMesh || !object.material) return;

    const material = object.material;
    const emissive = material.emissive;
    if (!emissive) return;

    this.originalMaterialState.set(object.uuid, emissive.getHex());
    emissive.setHex(0x22d3ee);
    if ('emissiveIntensity' in material) {
      material.emissiveIntensity = 0.55;
    }
  }

  clearHighlight(object) {
    if (!object?.isMesh || !object.material) return;

    const original = this.originalMaterialState.get(object.uuid);
    const emissive = object.material.emissive;
    if (!emissive) return;

    emissive.setHex(original ?? 0x000000);
    if ('emissiveIntensity' in object.material) {
      object.material.emissiveIntensity = 0.2;
    }
  }

  emit() {
    this.listeners.forEach((listener) => listener(this.selectedObject));
  }
}
