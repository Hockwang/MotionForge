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
      // marker 的视觉由 Group + 多个子 mesh 组成（球/柱/圆盘），子 mesh 本身没 name
      // 点到任意子 mesh 都应该选到整个 marker Group —— 向上走找带 markerId 的祖先
      let target = meshHit.object;
      let cur = target;
      while (cur) {
        if (cur.userData?.markerId) { target = cur; break; }
        cur = cur.parent;
      }
      this.selectObject(target);
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
      // F62: 共享 material 问题——clone 一份独占，避免改 emissive 影响其他对象
      // 多材质 mesh（glTF multi-primitive 合并后常见）的 material 是数组，逐个 clone
      if (!mesh.userData._ownMaterial) {
        mesh.material = Array.isArray(mesh.material)
          ? mesh.material.map((m) => m.clone())
          : mesh.material.clone();
        mesh.userData._ownMaterial = true;
      }
      this._forEachMaterial(mesh, (mat, subIndex) => {
        const emissive = mat?.emissive;
        if (!emissive) return;
        // #40 (F6)：存完整原始状态（colorHex + intensity），不只是颜色
        // F62：多材质时按 ${uuid}:${idx} 存多份，避免互相覆盖
        this.originalMaterialState.set(this._matKey(mesh.uuid, subIndex), {
          colorHex: emissive.getHex(),
          intensity: 'emissiveIntensity' in mat ? mat.emissiveIntensity : null,
        });
        emissive.setHex(0x22d3ee);
        if ('emissiveIntensity' in mat) mat.emissiveIntensity = 0.55;
      });
    });
  }

  clearHighlight(object) {
    if (!object) return;
    const meshes = this._getHighlightMeshes(object);
    meshes.forEach((mesh) => {
      this._forEachMaterial(mesh, (mat, subIndex) => {
        const snap = this.originalMaterialState.get(this._matKey(mesh.uuid, subIndex));
        const emissive = mat?.emissive;
        if (!emissive) return;
        // #40：恢复完整原始状态（兼容老 Map 里存的是 hex 数字）
        if (snap && typeof snap === 'object' && 'colorHex' in snap) {
          emissive.setHex(snap.colorHex);
          if (snap.intensity !== null && 'emissiveIntensity' in mat) {
            mat.emissiveIntensity = snap.intensity;
          }
        } else {
          emissive.setHex(typeof snap === 'number' ? snap : 0x000000);
          if ('emissiveIntensity' in mat) mat.emissiveIntensity = 0.2;
        }
        this.originalMaterialState.delete(this._matKey(mesh.uuid, subIndex));
      });
    });
  }

  /**
   * 释放对象上的 clone material（和关联的原始状态记录）。
   * 调用时机：对象从场景移除前（见 F6，SceneManager.setSceneRoot 统一调）
   * F62：多材质 mesh 逐个 dispose
   * @param {THREE.Object3D} object
   */
  disposeHighlightResources(object) {
    if (!object) return;
    object.traverse?.((o) => {
      if (!o.isMesh) return;
      if (o.userData?._ownMaterial && o.material) {
        if (Array.isArray(o.material)) {
          o.material.forEach((m) => m?.dispose?.());
        } else {
          o.material.dispose();
        }
        o.userData._ownMaterial = false;
      }
      // 清掉该 mesh 所有 sub-material 的状态记录
      this._forEachMaterial(o, (_mat, subIndex) => {
        this.originalMaterialState.delete(this._matKey(o.uuid, subIndex));
      });
    });
  }

  // F62 辅助：统一处理 single / array material；subIndex=-1 表示单材质
  _forEachMaterial(mesh, fn) {
    const m = mesh.material;
    if (!m) return;
    if (Array.isArray(m)) {
      m.forEach((sub, i) => fn(sub, i));
    } else {
      fn(m, -1);
    }
  }

  _matKey(uuid, subIndex) {
    return subIndex < 0 ? uuid : `${uuid}:${subIndex}`;
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
