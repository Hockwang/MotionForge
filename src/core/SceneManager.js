import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { ViewHelper } from 'three/examples/jsm/helpers/ViewHelper.js';

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
    // 关闭 autoClear：因为 ViewHelper.render 内部会调 renderer.render，
    // 如果 autoClear=true 会清整个画布（不只是 ViewHelper 的 viewport）→ 主场景被擦黑
    this.renderer.autoClear = false;
    this.viewportEl.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.target.set(0, 1, 0);

    this.addDefaultLights();
    this.addHelpers();
    this.addPivotMarker();
    this.initJointGizmo();
    this.initViewHelper();
    this.resize();
  }

  // ViewHelper：视口角落的坐标轴小 gizmo（Y-up 世界坐标）
  // 用户加载不同软件导出的模型时，能直观看出当前视角方向
  initViewHelper() {
    this.viewHelper = new ViewHelper(this.camera, this.renderer.domElement);
    // 移到右上角（默认是右下角）；颜色 RGB 对应 XYZ
    this.viewHelper.location = { top: 0, right: 0, bottom: null, left: null };
  }

  // ══════════════════════════════════════════════════════════════
  //  场景 Marker 视觉工厂（schema v6）
  //  按 marker 类型创建对应的 Three.js 对象（box / sphere），
  //  返回的对象会被加到 sceneRoot，名字 = marker.name 让它能进场景树和参与 reparent
  // ══════════════════════════════════════════════════════════════

  createMarkerObject(marker) {
    let obj;
    if (marker.type === 'cargo') {
      // 货物占位：半透明立方体，size 来自 marker
      const w = marker.size?.w ?? 0.5;
      const h = marker.size?.h ?? 0.5;
      const d = marker.size?.d ?? 0.5;
      const geo = new THREE.BoxGeometry(w, h, d);
      const mat = new THREE.MeshStandardMaterial({
        color: marker.color || 0xff9933,
        transparent: true,
        opacity: 0.65,
        roughness: 0.6,
      });
      obj = new THREE.Mesh(geo, mat);
    } else if (marker.type === 'pickup') {
      // 取货点：青色球 + 立柱
      obj = this._buildPointMarker(marker.color || 0x22d3ee);
    } else if (marker.type === 'drop') {
      // 放货点：红色球 + 立柱
      obj = this._buildPointMarker(marker.color || 0xf87171);
    } else {
      return null;
    }
    obj.name = marker.name;
    obj.userData.markerId = marker.id;
    obj.userData.markerType = marker.type;
    return obj;
  }

  /**
   * 取货/放货点的视觉：地面上一个小球 + 一根细立柱（方便从上面看到位置）
   * @private
   */
  _buildPointMarker(color) {
    const group = new THREE.Group();
    // 球（在立柱顶部）
    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(0.15, 16, 12),
      new THREE.MeshBasicMaterial({ color }),
    );
    sphere.position.y = 0.5;
    // 立柱
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.02, 0.02, 0.5, 8),
      new THREE.MeshBasicMaterial({ color }),
    );
    pole.position.y = 0.25;
    // 地面圆盘
    const ring = new THREE.Mesh(
      new THREE.CircleGeometry(0.25, 24),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.45, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    group.add(sphere, pole, ring);
    return group;
  }

  /**
   * 更新一个已存在的 marker 视觉：cargo 改尺寸时重建 geometry
   */
  updateMarkerObject(obj, marker) {
    if (!obj || marker.type !== 'cargo') return;
    if (obj.geometry) obj.geometry.dispose();
    const w = marker.size?.w ?? 0.5;
    const h = marker.size?.h ?? 0.5;
    const d = marker.size?.d ?? 0.5;
    obj.geometry = new THREE.BoxGeometry(w, h, d);
    if (marker.color && obj.material?.color) {
      obj.material.color.set(marker.color);
    }
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

  /**
   * 设置场景根节点
   * @param {THREE.Object3D} root
   * @param {Object} [options]
   * @param {boolean} [options.skipAlign=false] - 跳过 alignObjectToGround（导入已对齐的 ZIP 时使用）
   */
  setSceneRoot(root, options = {}) {
    if (this.sceneRoot) {
      // #40 (F7 修复)：递归 dispose 旧 root 的 GPU 资源，防止反复导入大模型时 GPU 内存线性累积。
      // 只 dispose 自己 clone 过的 material（通过 userData._ownMaterial 标记，见 SelectionManager）
      // 和所有 geometry + texture。共享 material 不 dispose（可能被其他对象持有）。
      this._disposeObjectResources(this.sceneRoot);
      this.scene.remove(this.sceneRoot);
    }
    if (!options.skipAlign) {
      this.alignObjectToGround(root);
    }
    this.sceneRoot = root;
    this.scene.add(root);
    this.fitCameraToObject(root);
  }

  /**
   * 递归释放 Object3D 子树上的 GPU 资源（geometry / texture / clone material）。
   * @private
   * @param {THREE.Object3D} obj
   */
  _disposeObjectResources(obj) {
    obj.traverse((c) => {
      if (c.geometry) c.geometry.dispose();
      if (c.material) {
        const mats = Array.isArray(c.material) ? c.material : [c.material];
        mats.forEach((m) => {
          // 释放 texture maps（map/normalMap/roughnessMap/metalnessMap/emissiveMap 等）
          for (const k in m) {
            if (m[k]?.isTexture) m[k].dispose();
          }
          // 只 dispose 自己 clone 出来的 material（SelectionManager 标记过）
          // 原始共享 material 不 dispose（可能还被其他 scene root 持有）
          if (c.userData?._ownMaterial) m.dispose();
        });
      }
    });
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
    // 手动 clear：因为 autoClear=false（见 constructor 注释）
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    // ViewHelper 自己会处理 viewport + clearDepth，不用外部再清一次
    if (this.viewHelper) {
      this.viewHelper.render(this.renderer);
    }
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
    this._gizmoLastAngle = undefined; // 每次新拖拽重置解缠状态

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
        let angle = 2 * Math.atan2(sinHalf, cosHalf);

        // ── 解缠：避免四元数符号翻转（q 和 -q 同义）导致角度跳变 2π ──
        // TransformControls 拖动到大角度时，current quaternion 可能被归一化到"最短路径"表示，
        // 导致 deltaWorldQuat.w 突然变号 → 提取的 angle 跳变 ±2π（360°）。
        // 保持 angle 与上一帧连续：差值超过 π 就加减 2π 补偿。
        if (this._gizmoLastAngle !== undefined) {
          while (angle - this._gizmoLastAngle > Math.PI) angle -= 2 * Math.PI;
          while (angle - this._gizmoLastAngle < -Math.PI) angle += 2 * Math.PI;
        }
        this._gizmoLastAngle = angle;

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
