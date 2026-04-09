import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';

export class SceneManager {
  constructor(viewportEl) {
    this.viewportEl = viewportEl;
    this.sceneRoot = null;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x111827);

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
    this.addJointMarkersLayer();
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
    const grid = new THREE.GridHelper(20, 20, 0x374151, 0x1f2937);
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

  addJointMarkersLayer() {
    this.jointMarkersGroup = new THREE.Group();
    this.scene.add(this.jointMarkersGroup);
    this.jointRaycaster = new THREE.Raycaster();
    this.jointPointer = new THREE.Vector2();
  }

  renderJointMarkers(points, activeId = null) {
    if (!this.jointMarkersGroup) return;
    this.jointMarkersGroup.clear();

    points.forEach((point) => {
      const isActive = point.id === activeId;
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(isActive ? 0.1 : 0.06, 14, 14),
        new THREE.MeshBasicMaterial({ color: isActive ? 0xff3b30 : 0xffc107 }),
      );
      sphere.position.set(point.x, point.y, point.z);
      sphere.userData.jointPointId = point.id;
      this.jointMarkersGroup.add(sphere);
    });
  }

  pickJointMarker(clientX, clientY) {
    if (!this.jointMarkersGroup || !this.jointMarkersGroup.children.length) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.jointPointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this.jointPointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.jointRaycaster.setFromCamera(this.jointPointer, this.camera);
    const hits = this.jointRaycaster.intersectObjects(this.jointMarkersGroup.children, false);
    if (!hits.length) return null;
    return hits[0].object.userData.jointPointId ?? null;
  }

  setPivotMarker(position) {
    if (!this.pivotMarker || !position) return;
    this.pivotMarker.position.copy(position);
    this.pivotMarker.visible = true;
  }

  clearPivotMarker() {
    if (!this.pivotMarker) return;
    this.pivotMarker.visible = false;
    this.renderJointMarkers([], null);
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

    // Store initial state for delta computation
    this._gizmoStartQuat = object.quaternion.clone();
    this._gizmoStartPos = object.position.clone();
    this._gizmoWorldAxis = worldAxis;
    this._gizmoMode = mode;

    // Remove old listener if any
    if (this._gizmoChangeHandler) {
      this.jointGizmo.removeEventListener('objectChange', this._gizmoChangeHandler);
    }

    this._gizmoChangeHandler = () => {
      if (!this.jointGizmoOnChange) return;

      if (this._gizmoMode === 'rotate') {
        // Compute rotation delta in degrees around the constrained axis
        const invStart = this._gizmoStartQuat.clone().invert();
        const deltaQuat = object.quaternion.clone().multiply(invStart);
        const euler = new THREE.Euler().setFromQuaternion(deltaQuat, 'XYZ');
        const axisKey = this._gizmoWorldAxis === 'X' ? 'x' : this._gizmoWorldAxis === 'Y' ? 'y' : 'z';
        const degrees = (euler[axisKey] * 180) / Math.PI;
        this.jointGizmoOnChange(degrees);
      } else if (this._gizmoMode === 'translate') {
        const delta = object.position.clone().sub(this._gizmoStartPos);
        const axisKey = this._gizmoWorldAxis === 'X' ? 'x' : this._gizmoWorldAxis === 'Y' ? 'y' : 'z';
        this.jointGizmoOnChange(delta[axisKey]);
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
