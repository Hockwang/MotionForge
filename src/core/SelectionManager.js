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

  attachViewportSelection(onEmptyClick) {
    const canvas = this.sceneManager.renderer.domElement;
    canvas.addEventListener('pointerdown', (event) => {
      if (event.defaultPrevented) return;
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
