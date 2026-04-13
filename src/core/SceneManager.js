import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';

export class SceneManager {
  constructor(viewportEl) {
    this.viewportEl = viewportEl;
    this.sceneRoot = null;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x585858);

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.1, 1000);
    this.camera.position.set(5, 4, 6);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.viewportEl.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.target.set(0, 1, 0);

    this.addDefaultLights();
    this.addHelpers();
    this.addPivotMarker();
    this.initJointGizmo();
    this.resize();
  }

  addDefaultLights() {
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.65));

    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(6, 8, 6);
    this.scene.add(key);
  }

  addHelpers() {
    // THREE.Color 不支持 alpha，用预算好的实色（背景 #585858 上的视觉效果等价于半透明灰）
    const grid = new THREE.GridHelper(20, 20, 0x6a6a6a, 0x626262);
    grid.position.y = 0;
    this.scene.add(grid);
  }

  addPivotMarker() {
    this.pivotMarker = new THREE.Group();

    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(0.08, 16, 16),
      new THREE.MeshBasicMaterial({ color: 0xffea00 }),
    );
    const crossMaterial = new THREE.LineBasicMaterial({ color: 0xffea00 });
    const crossGeometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-0.18, 0, 0),
      new THREE.Vector3(0.18, 0, 0),
      new THREE.Vector3(0, -0.18, 0),
      new THREE.Vector3(0, 0.18, 0),
      new THREE.Vector3(0, 0, -0.18),
      new THREE.Vector3(0, 0, 0.18),
    ]);
    const cross = new THREE.LineSegments(crossGeometry, crossMaterial);
    this.pivotMarker.add(dot, cross);
    this.pivotMarker.visible = false;
    this.scene.add(this.pivotMarker);
  }

  setPivotMarker(position) {
    if (!this.pivotMarker || !position) return;
    this.pivotMarker.position.copy(position);
    this.pivotMarker.visible = true;
  }

  clearPivotMarker() {
    if (!this.pivotMarker) return;
    this.pivotMarker.visible = false;
  }

  setSceneRoot(root) {
    if (this.sceneRoot) {
      this.scene.remove(this.sceneRoot);
    }
    this.alignObjectToGround(root);
    this.sceneRoot = root;
    this.scene.add(root);
    this.fitCameraToObject(root);
  }

  alignObjectToGround(object) {
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return;

    // Keep initial preview usable by snapping model lowest point to grid (Y=0).
    const minY = box.min.y;
    if (!Number.isFinite(minY)) return;
    object.position.y -= minY;
  }

  fitCameraToObject(object) {
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return;

    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(size.x, size.y, size.z) * 0.75 + 1;

    this.camera.position.set(center.x + radius, center.y + radius * 0.6, center.z + radius);
    this.controls.target.copy(center);
    this.controls.update();
  }

  resize() {
    const width = this.viewportEl.clientWidth || 1;
    const height = this.viewportEl.clientHeight || 1;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
  }

  render() {
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  initJointGizmo() {
    this.jointGizmo = new TransformControls(this.camera, this.renderer.domElement);
    this.jointGizmo.visible = false;
    this.jointGizmo.enabled = false;
    this.jointGizmo.size = 0.8;
    this.scene.add(this.jointGizmo.getHelper());

    // Disable orbit controls while dragging gizmo
    this.jointGizmoDragging = false;
    this.jointGizmo.addEventListener('dragging-changed', (event) => {
      this.controls.enabled = !event.value;
      this.jointGizmoDragging = event.value;
      if (event.value && this.jointGizmoOnDragStart) {
        this.jointGizmoOnDragStart();
      }
      if (!event.value && this.jointGizmoOnDragEnd) {
        this.jointGizmoOnDragEnd();
      }
    });

    this.jointGizmoTarget = null;
    this.jointGizmoOnChange = null;
    this.jointGizmoOnDragStart = null;
    this.jointGizmoOnDragEnd = null;
  }

  /**
   * Show joint gizmo on an object.
   * @param {THREE.Object3D} object - the child object to attach gizmo to
   * @param {'rotate'|'translate'} mode - gizmo mode
   * @param {'x'|'y'|'z'} axis - which axis to constrain (in UI convention, mapped to world)
   * @param {Function} onChange - callback(deltaValue) called during drag
   */
  showJointGizmo(object, mode, axis, onChange) {
    if (!object || !this.jointGizmo) return;

    // Map UI axis to world axis for Three.js
    const worldAxis = axis === 'z' ? 'Y' : axis === 'y' ? 'Z' : 'X';

    this.jointGizmo.detach();
    this.jointGizmo.setMode(mode);
    this.jointGizmo.showX = worldAxis === 'X';
    this.jointGizmo.showY = worldAxis === 'Y';
    this.jointGizmo.showZ = worldAxis === 'Z';
    this.jointGizmo.attach(object);
    this.jointGizmo.visible = true;
    this.jointGizmo.enabled = true;
    this.jointGizmoTarget = object;
    this.jointGizmoOnChange = onChange || null;

    // 记录拖拽起始状态，用于后续 delta 计算
    this._gizmoStartQuat = object.quaternion.clone();
    this._gizmoStartPos = object.position.clone();
    // 起始世界位置/四元数：平移 gizmo 和旋转 gizmo 都用世界空间计算 delta
    // 之所以必须用世界空间：TransformControls 默认沿世界轴操作，直接用
    // object.position/quaternion（局部）计算，当父节点有旋转时结果错乱。
    object.updateMatrixWorld(true);
    this._gizmoStartWorldPos = object.getWorldPosition(new THREE.Vector3());
    this._gizmoStartWorldQuat = object.getWorldQuaternion(new THREE.Quaternion());
    this._gizmoWorldAxis = worldAxis;
    this._gizmoMode = mode;

    // Remove old listener if any
    if (this._gizmoChangeHandler) {
      this.jointGizmo.removeEventListener('objectChange', this._gizmoChangeHandler);
    }

    this._gizmoChangeHandler = () => {
      if (!this.jointGizmoOnChange) return;

      if (this._gizmoMode === 'rotate') {
        // 世界空间旋转 delta：current_world = delta_world * start_world
        // → delta_world = current_world * start_world^-1
        object.updateMatrixWorld(true);
        const currentWorldQuat = object.getWorldQuaternion(new THREE.Quaternion());
        const startWorldQuatInv = this._gizmoStartWorldQuat.clone().invert();
        const deltaWorldQuat = currentWorldQuat.clone().multiply(startWorldQuatInv);

        // 提取绕世界轴的有符号角度。
        // 对于绕单位轴 A 旋转 θ 角度的 quaternion：q = (cos(θ/2), sin(θ/2) * A)
        // 所以 sin(θ/2) = q.xyz 在 A 方向上的点积，cos(θ/2) = q.w
        // Euler 分解在多轴耦合时会失真，这里用点积法稳定准确。
        const axisVec = this._gizmoWorldAxis === 'X' ? new THREE.Vector3(1, 0, 0)
          : this._gizmoWorldAxis === 'Y' ? new THREE.Vector3(0, 1, 0)
          : new THREE.Vector3(0, 0, 1);
        const vecPart = new THREE.Vector3(deltaWorldQuat.x, deltaWorldQuat.y, deltaWorldQuat.z);
        const sinHalf = vecPart.dot(axisVec);
        const cosHalf = deltaWorldQuat.w;
        const angle = 2 * Math.atan2(sinHalf, cosHalf);
        const degrees = (angle * 180) / Math.PI;
        this.jointGizmoOnChange(degrees);
      } else if (this._gizmoMode === 'translate') {
        // 世界空间位移 → 投影到关节的世界轴方向，得到有符号标量
        // 之前用 object.position（局部空间）- startPos 会在父节点有旋转时失败：
        // 世界 Y 拖拽在局部空间可能分散到 XYZ，局部 Y 分量很小导致"弹回"。
        object.updateMatrixWorld(true);
        const currentWorldPos = object.getWorldPosition(new THREE.Vector3());
        const deltaWorld = currentWorldPos.sub(this._gizmoStartWorldPos);
        // 世界轴单位向量（worldAxis 是 'X'/'Y'/'Z'）
        const axisVec = this._gizmoWorldAxis === 'X' ? new THREE.Vector3(1, 0, 0)
          : this._gizmoWorldAxis === 'Y' ? new THREE.Vector3(0, 1, 0)
          : new THREE.Vector3(0, 0, 1);
        // 有符号投影长度 = 位移向量在轴方向上的分量
        const signedMagnitude = deltaWorld.dot(axisVec);
        this.jointGizmoOnChange(signedMagnitude);
      }
    };

    this.jointGizmo.addEventListener('objectChange', this._gizmoChangeHandler);
  }

  hideJointGizmo() {
    if (!this.jointGizmo) return;
    if (this._gizmoChangeHandler) {
      this.jointGizmo.removeEventListener('objectChange', this._gizmoChangeHandler);
      this._gizmoChangeHandler = null;
    }
    this.jointGizmo.detach();
    this.jointGizmo.visible = false;
    this.jointGizmo.enabled = false;
    this.jointGizmoTarget = null;
    this.jointGizmoOnChange = null;
  }

  dispose() {
    this.controls.dispose();
    if (this.jointGizmo) this.jointGizmo.dispose();
    this.renderer.dispose();
  }
}
