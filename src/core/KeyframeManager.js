import * as THREE from 'three';

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function normalizeValue(raw, fallback = 0) {
  const next = Number(raw);
  return Number.isFinite(next) ? next : fallback;
}

// UI uses Z-up convention; Three.js runtime is Y-up.
function mapUiAxisToWorld(axis) {
  if (axis === 'z') return 'y';
  if (axis === 'y') return 'z';
  return 'x';
}

export class KeyframeManager {
  constructor() {
    this.currentTime = 0;
    this.objectDataById = new Map();
    /** Map<nodeUuid, {id, name, type, axis, limits:{min,max}, parentId, childId, currentValue}> */
    this.jointDefinitions = new Map();

    // ── PKF（参数化关键帧公式）数据容器 ──
    // 参数声明表：每个参数有 id（唯一标识）、type（number/vec3）、unit（单位）、desc（描述）、default（默认值）
    /** @type {Map<string, {id:string, type:string, unit:string, desc:string, default:*}>} */
    this.pkfParameters = new Map();
    // 步骤列表：每个步骤关联一个关节，定义通道/轴向/时间区间/起止公式/缓动
    /** @type {Array<{id:string, joint:string, joint_def_id:string, channel:string, axis:string, t_start:number, t_end:number, value_start:string, value_end:string, easing:string}>} */
    this.pkfSteps = [];
  }

  reset() {
    this.currentTime = 0;
    this.objectDataById.clear();
    this.jointDefinitions.clear();
    this.pkfParameters.clear();  // 清空 PKF 参数
    this.pkfSteps = [];           // 清空 PKF 步骤
  }

  ensureObjectData(object) {
    if (!object) return null;
    const current = this.objectDataById.get(object.uuid);
    if (current) {
      current.objectName = object.name || '(unnamed)';
      return current;
    }

    const defaultClip = {
      clipName: 'default',
      jointEnabled: true,
      translateAxis: 'z',
      currentTranslateValue: 0,
      rotateAxis: 'z',
      currentRotateValue: 0,
      pivotEnabled: false,
      pivotX: object.position.x,
      pivotY: object.position.y,
      pivotZ: object.position.z,
      minValue: null,
      maxValue: null,
      duration: 10,
      keyframes: [],
    };
    const created = {
      objectId: object.uuid,
      objectName: object.name || '(unnamed)',
      jointNode: {
        marked: false,
        name: object.name || object.uuid,
      },
      jointPoints: [],
      baseTransform: {
        tx: object.position.x,
        ty: object.position.y,
        tz: object.position.z,
        rx: object.rotation.x,
        ry: object.rotation.y,
        rz: object.rotation.z,
      },
      activeClipName: 'default',
      clips: new Map([['default', defaultClip]]),
    };
    this.objectDataById.set(object.uuid, created);
    return created;
  }

  markJointNode(object, name) {
    const objectData = this.ensureObjectData(object);
    if (!objectData) return;
    objectData.jointNode = {
      marked: true,
      name: (name || object.name || object.uuid || 'joint_node').trim(),
    };
  }

  getJointNodeInfo(object) {
    const objectData = this.ensureObjectData(object);
    if (!objectData) return null;
    return objectData.jointNode;
  }

  getJointPoints(object) {
    const objectData = this.ensureObjectData(object);
    if (!objectData) return [];
    return objectData.jointPoints || [];
  }

  addJointPoint(object, point) {
    const objectData = this.ensureObjectData(object);
    if (!objectData) return null;
    const nextIndex = (objectData.jointPoints?.length || 0) + 1;
    const created = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: point?.name?.trim() || `关节${nextIndex}`,
      x: normalizeValue(point?.x, 0),
      y: normalizeValue(point?.y, 0),
      z: normalizeValue(point?.z, 0),
    };
    objectData.jointPoints = [...(objectData.jointPoints || []), created];
    return created;
  }

  renameJointPoint(object, pointId, newName) {
    const objectData = this.ensureObjectData(object);
    if (!objectData) return false;
    const target = (objectData.jointPoints || []).find((p) => p.id === pointId);
    if (!target) return false;
    target.name = (newName || '').trim() || target.name;
    return true;
  }

  updateJointPoint(object, pointId, patch) {
    const objectData = this.ensureObjectData(object);
    if (!objectData) return false;
    const target = (objectData.jointPoints || []).find((p) => p.id === pointId);
    if (!target) return false;
    if (typeof patch.name !== 'undefined') target.name = (patch.name || '').trim() || target.name;
    if (typeof patch.x !== 'undefined') target.x = normalizeValue(patch.x, target.x);
    if (typeof patch.y !== 'undefined') target.y = normalizeValue(patch.y, target.y);
    if (typeof patch.z !== 'undefined') target.z = normalizeValue(patch.z, target.z);
    return true;
  }

  removeJointPoint(object, pointId) {
    const objectData = this.ensureObjectData(object);
    if (!objectData) return false;
    const before = (objectData.jointPoints || []).length;
    objectData.jointPoints = (objectData.jointPoints || []).filter((p) => p.id !== pointId);
    return objectData.jointPoints.length !== before;
  }

  // ── Joint Definition CRUD (layer-tree joint type per node) ──

  getJointDef(nodeId) {
    return this.jointDefinitions.get(nodeId) ?? null;
  }

  setJointDef(nodeId, patch) {
    const existing = this.jointDefinitions.get(nodeId);
    const def = existing || {
      id: nodeId,
      name: '',
      type: 'none',       // none | revolute | prismatic | fixed
      axis: 'y',           // x | y | z (UI convention)
      origin: { x: 0, y: 0, z: 0 }, // joint origin in parent-local space (UI convention)
      limits: { min: -180, max: 180 },
      parentId: null,
      childId: nodeId,
      currentValue: 0,
    };
    if (typeof patch.name !== 'undefined') def.name = String(patch.name);
    if (patch.type) def.type = patch.type;
    if (patch.axis) def.axis = patch.axis;
    if (patch.origin) {
      if (typeof patch.origin.x !== 'undefined') def.origin.x = normalizeValue(patch.origin.x, def.origin.x);
      if (typeof patch.origin.y !== 'undefined') def.origin.y = normalizeValue(patch.origin.y, def.origin.y);
      if (typeof patch.origin.z !== 'undefined') def.origin.z = normalizeValue(patch.origin.z, def.origin.z);
    }
    if (patch.limits) {
      if (typeof patch.limits.min !== 'undefined') def.limits.min = normalizeValue(patch.limits.min, def.limits.min);
      if (typeof patch.limits.max !== 'undefined') def.limits.max = normalizeValue(patch.limits.max, def.limits.max);
    }
    if (typeof patch.parentId !== 'undefined') def.parentId = patch.parentId;
    if (typeof patch.childId !== 'undefined') def.childId = patch.childId;
    if (typeof patch.currentValue !== 'undefined') def.currentValue = normalizeValue(patch.currentValue, 0);

    if (def.type === 'none') {
      this.jointDefinitions.delete(nodeId);
      return null;
    }
    this.jointDefinitions.set(nodeId, def);
    return def;
  }

  removeJointDef(nodeId) {
    return this.jointDefinitions.delete(nodeId);
  }

  getAllJointDefs() {
    return [...this.jointDefinitions.values()];
  }

  getJointDefLabel(nodeId) {
    const def = this.jointDefinitions.get(nodeId);
    if (!def) return '无';
    if (def.type === 'revolute') return '🔄R';
    if (def.type === 'prismatic') return '↕P';
    if (def.type === 'fixed') return '🔗F';
    return '无';
  }

  setJointValue(nodeId, value) {
    const def = this.jointDefinitions.get(nodeId);
    if (!def || def.type === 'fixed') return 0;
    const clamped = Math.max(def.limits.min, Math.min(def.limits.max, normalizeValue(value, 0)));
    def.currentValue = clamped;
    return clamped;
  }

  /**
   * Apply joint drive for a single node.
   * Operates in parent-local space: revolute rotates child around axis,
   * prismatic translates child along axis. Fixed does nothing.
   * @param {string} nodeId - uuid of the child node
   * @param {THREE.Object3D} root - scene root for traversal
   */
  applyJointDrive(nodeId, root) {
    const def = this.jointDefinitions.get(nodeId);
    if (!def || def.type === 'none' || def.type === 'fixed') return;

    // Skip if gizmo is actively dragging this node (avoid double-write)
    if (this._gizmoDraggingNodeId === nodeId) return;

    let childObj = null;
    root.traverse((obj) => { if (obj.uuid === nodeId) childObj = obj; });
    if (!childObj) return;

    // Get base transform (bind pose) — this is in parent-local space
    const objectData = this.objectDataById.get(nodeId);
    const base = objectData?.baseTransform;

    // Origin is stored in UI convention; convert to parent-local space (swap Y/Z)
    const originLocal = new THREE.Vector3(
      def.origin?.x ?? 0,
      def.origin?.z ?? 0,  // UI Z -> Three.js Y
      def.origin?.y ?? 0,  // UI Y -> Three.js Z
    );

    if (def.type === 'revolute') {
      const rad = (def.currentValue * Math.PI) / 180;
      const worldAxis = mapUiAxisToWorld(def.axis);
      const axisVec = worldAxis === 'x' ? new THREE.Vector3(1, 0, 0)
        : worldAxis === 'y' ? new THREE.Vector3(0, 1, 0)
        : new THREE.Vector3(0, 0, 1);
      const deltaQuat = new THREE.Quaternion().setFromAxisAngle(axisVec, rad);

      // Base position/rotation in parent-local space
      const basePos = base
        ? new THREE.Vector3(base.tx, base.ty, base.tz)
        : childObj.position.clone();
      const baseQuat = base
        ? new THREE.Quaternion().setFromEuler(new THREE.Euler(base.rx, base.ry, base.rz))
        : childObj.quaternion.clone();

      // Rotate around origin in parent-local space:
      // newPos = origin + deltaQuat * (basePos - origin)
      const offset = basePos.clone().sub(originLocal);
      const rotatedOffset = offset.applyQuaternion(deltaQuat);
      const newPos = originLocal.clone().add(rotatedOffset);

      childObj.position.copy(newPos);
      childObj.quaternion.copy(deltaQuat.clone().multiply(baseQuat));
    } else if (def.type === 'prismatic') {
      const worldAxis = mapUiAxisToWorld(def.axis);
      // Reset to base position in parent-local space
      if (base) {
        childObj.position.set(base.tx, base.ty, base.tz);
      }
      childObj.position[worldAxis] += def.currentValue;
    }
  }

  /**
   * Apply all joint drives. Called from render loop or after value changes.
   */
  applyAllJointDrives(root) {
    if (!root) return;
    this.jointDefinitions.forEach((def) => {
      this.applyJointDrive(def.childId, root);
    });
  }

  getClipNames(object) {
    const objectData = this.ensureObjectData(object);
    if (!objectData) return [];
    return [...objectData.clips.keys()];
  }

  getActiveClip(object) {
    const objectData = this.ensureObjectData(object);
    if (!objectData) return null;
    return objectData.clips.get(objectData.activeClipName) ?? null;
  }

  getActiveMotionValue(object) {
    return this.getActiveClip(object)?.currentTranslateValue ?? 0;
  }

  createClip(object, requestedName) {
    const objectData = this.ensureObjectData(object);
    if (!objectData) return null;

    const base = (requestedName || 'new_clip').trim() || 'new_clip';
    let clipName = base;
    let i = 1;
    while (objectData.clips.has(clipName)) {
      clipName = `${base}_${i}`;
      i += 1;
    }

    const template = this.getActiveClip(object) ?? {
      jointEnabled: true,
      translateAxis: 'z',
      currentTranslateValue: 0,
      rotateAxis: 'z',
      currentRotateValue: 0,
      pivotEnabled: false,
      pivotX: object.position.x,
      pivotY: object.position.y,
      pivotZ: object.position.z,
      minValue: null,
      maxValue: null,
      duration: 10,
    };
    objectData.clips.set(clipName, {
      clipName,
      jointEnabled: template.jointEnabled,
      translateAxis: template.translateAxis,
      currentTranslateValue: template.currentTranslateValue,
      rotateAxis: template.rotateAxis,
      currentRotateValue: template.currentRotateValue,
      pivotEnabled: template.pivotEnabled,
      pivotX: template.pivotX,
      pivotY: template.pivotY,
      pivotZ: template.pivotZ,
      minValue: template.minValue,
      maxValue: template.maxValue,
      duration: template.duration,
      keyframes: [],
    });
    objectData.activeClipName = clipName;
    return objectData.clips.get(clipName);
  }

  setActiveClip(object, clipName) {
    const objectData = this.ensureObjectData(object);
    if (!objectData || !objectData.clips.has(clipName)) return;
    objectData.activeClipName = clipName;
  }

  updateActiveClipConfig(object, patch) {
    const clip = this.getActiveClip(object);
    if (!clip) return;

    if (typeof patch.jointEnabled !== 'undefined') clip.jointEnabled = Boolean(patch.jointEnabled);
    if (patch.translateAxis) clip.translateAxis = patch.translateAxis;
    if (patch.rotateAxis) clip.rotateAxis = patch.rotateAxis;
    if (typeof patch.pivotEnabled !== 'undefined') clip.pivotEnabled = Boolean(patch.pivotEnabled);
    if (typeof patch.pivotX !== 'undefined') clip.pivotX = normalizeValue(patch.pivotX, clip.pivotX);
    if (typeof patch.pivotY !== 'undefined') clip.pivotY = normalizeValue(patch.pivotY, clip.pivotY);
    if (typeof patch.pivotZ !== 'undefined') clip.pivotZ = normalizeValue(patch.pivotZ, clip.pivotZ);
    if (typeof patch.translateValue !== 'undefined') {
      clip.currentTranslateValue = normalizeValue(patch.translateValue, clip.currentTranslateValue);
    }
    if (typeof patch.rotateValue !== 'undefined') {
      clip.currentRotateValue = normalizeValue(patch.rotateValue, clip.currentRotateValue);
    }
    if (typeof patch.duration !== 'undefined') {
      clip.duration = Math.max(0.1, Number(patch.duration) || 10);
    }
    if (typeof patch.minValue !== 'undefined') {
      clip.minValue = patch.minValue === null || patch.minValue === '' ? null : Number(patch.minValue);
    }
    if (typeof patch.maxValue !== 'undefined') {
      clip.maxValue = patch.maxValue === null || patch.maxValue === '' ? null : Number(patch.maxValue);
    }
  }

  getTrack(object) {
    const clip = this.getActiveClip(object);
    return clip?.keyframes ?? [];
  }

  getClipDuration(object) {
    const clip = this.getActiveClip(object);
    return clip?.duration ?? 10;
  }

  applyCurrentChannelValues(object) {
    const clip = this.getActiveClip(object);
    const objectData = this.ensureObjectData(object);
    if (!clip || !objectData || !object) return;
    this.applySemanticToObject(
      object,
      objectData.baseTransform,
      clip,
      clip.currentTranslateValue,
      clip.currentRotateValue,
    );
  }

  addKeyframe(object, time) {
    const clip = this.getActiveClip(object);
    if (!object || !clip) return;

    const keyframe = {
      time: Number(time),
      translateValue: normalizeValue(clip.currentTranslateValue, 0),
      rotateValue: normalizeValue(clip.currentRotateValue, 0),
    };

    const withoutSameTime = clip.keyframes.filter((k) => Math.abs(k.time - keyframe.time) > 0.0001);
    withoutSameTime.push(keyframe);
    withoutSameTime.sort((a, b) => a.time - b.time);
    clip.keyframes = withoutSameTime;
  }

  removeKeyframe(object, time) {
    const clip = this.getActiveClip(object);
    if (!clip) return false;
    const before = clip.keyframes.length;
    clip.keyframes = clip.keyframes.filter((k) => Math.abs(k.time - Number(time)) > 0.0001);
    return clip.keyframes.length !== before;
  }

  getFrameAtTime(track, time, fallbackTranslate = 0, fallbackRotate = 0) {
    if (!track.length) {
      return { translateValue: fallbackTranslate, rotateValue: fallbackRotate };
    }
    if (time <= track[0].time) {
      return {
        translateValue: track[0].translateValue,
        rotateValue: track[0].rotateValue,
      };
    }
    if (time >= track[track.length - 1].time) {
      return {
        translateValue: track[track.length - 1].translateValue,
        rotateValue: track[track.length - 1].rotateValue,
      };
    }

    for (let i = 0; i < track.length - 1; i += 1) {
      const left = track[i];
      const right = track[i + 1];
      if (time < left.time || time > right.time) continue;
      const ratio = (time - left.time) / (right.time - left.time);
      return {
        translateValue: lerp(left.translateValue, right.translateValue, ratio),
        rotateValue: lerp(left.rotateValue, right.rotateValue, ratio),
      };
    }
    return { translateValue: fallbackTranslate, rotateValue: fallbackRotate };
  }

  evaluateObjectAt(object, time) {
    const objectData = this.ensureObjectData(object);
    const clip = this.getActiveClip(object);
    if (!objectData || !clip || !object) return;

    const frame = this.getFrameAtTime(
      clip.keyframes,
      time,
      clip.currentTranslateValue,
      clip.currentRotateValue,
    );
    clip.currentTranslateValue = frame.translateValue;
    clip.currentRotateValue = frame.rotateValue;
    this.applySemanticToObject(
      object,
      objectData.baseTransform,
      clip,
      frame.translateValue,
      frame.rotateValue,
    );
  }

  applySemanticToObject(object, baseTransform, clip, translateValue, rotateValue) {
    // Reset to object bind-like baseline before applying semantic delta.
    object.position.set(baseTransform.tx, baseTransform.ty, baseTransform.tz);
    object.rotation.set(baseTransform.rx, baseTransform.ry, baseTransform.rz);

    if (!clip.jointEnabled) return;

    const parent = object.parent;
    const parentWorldQuat = parent ? parent.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion();
    const parentWorldQuatInv = parentWorldQuat.clone().invert();
    const baseLocalQuat = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(baseTransform.rx, baseTransform.ry, baseTransform.rz),
    );
    const baseWorldQuat = parent ? parentWorldQuat.clone().multiply(baseLocalQuat) : baseLocalQuat.clone();
    const baseWorldPos = parent
      ? parent.localToWorld(new THREE.Vector3(baseTransform.tx, baseTransform.ty, baseTransform.tz))
      : new THREE.Vector3(baseTransform.tx, baseTransform.ty, baseTransform.tz);

    const worldRotateAxis = mapUiAxisToWorld(clip.rotateAxis);
    const axisVector =
      worldRotateAxis === 'x'
        ? new THREE.Vector3(1, 0, 0)
        : worldRotateAxis === 'y'
          ? new THREE.Vector3(0, 1, 0)
          : new THREE.Vector3(0, 0, 1);
    const rotateRad = (rotateValue * Math.PI) / 180;

    const rotateDeltaQuat = new THREE.Quaternion().setFromAxisAngle(axisVector, rotateRad);
    const finalWorldQuat = rotateDeltaQuat.clone().multiply(baseWorldQuat);

    let finalWorldPos = baseWorldPos.clone();

    // Extension point: replace single-pivot math with parent-child FK solver.
    if (clip.pivotEnabled) {
      const pivot = new THREE.Vector3(clip.pivotX, clip.pivotY, clip.pivotZ);
      const rotatedOffset = baseWorldPos.clone().sub(pivot).applyQuaternion(rotateDeltaQuat);
      finalWorldPos = pivot.clone().add(rotatedOffset);
    }

    // Keep translate channel as additive delta after rotation solve.
    const worldTranslateAxis = mapUiAxisToWorld(clip.translateAxis);
    finalWorldPos[worldTranslateAxis] += translateValue;

    const finalLocalPos = parent ? parent.worldToLocal(finalWorldPos.clone()) : finalWorldPos;
    const finalLocalQuat = parent ? parentWorldQuatInv.multiply(finalWorldQuat) : finalWorldQuat;

    object.position.copy(finalLocalPos);
    object.quaternion.copy(finalLocalQuat);
  }

  evaluateAllAt(time, root) {
    if (!root) return;
    this.currentTime = Math.max(0, Number(time) || 0);

    const objectMap = new Map();
    root.traverse((obj) => objectMap.set(obj.uuid, obj));

    this.objectDataById.forEach((_data, objectId) => {
      const object = objectMap.get(objectId);
      if (!object) return;
      this.evaluateObjectAt(object, this.currentTime);
    });
  }

  exportForObject(object) {
    const objectData = this.ensureObjectData(object);
    if (!objectData) return null;
    const clip = this.getActiveClip(object);
    if (!clip) return null;

    const payload = {
      object_id: objectData.objectId,
      object_name: objectData.objectName,
      joint_node: objectData.jointNode,
      joint_points: objectData.jointPoints || [],
      joint_enabled: clip.jointEnabled,
      channels: {
        translate: { axis: clip.translateAxis },
        rotate: { axis: clip.rotateAxis },
      },
      pivot: {
        enabled: clip.pivotEnabled,
        x: clip.pivotX,
        y: clip.pivotY,
        z: clip.pivotZ,
      },
      clip_name: clip.clipName,
      duration: clip.duration,
      keyframes: clip.keyframes.map((k) => ({
        t: k.time,
        translate_value: k.translateValue,
        rotate_value: k.rotateValue,
      })),
      // Extension point: map joint semantics to USD Skel / internal system.
      semantics_version: 3,
    };
    if (clip.minValue !== null) payload.min_value = clip.minValue;
    if (clip.maxValue !== null) payload.max_value = clip.maxValue;
    return payload;
  }

  exportForObjects(objects) {
    const list = [];
    objects.forEach((obj) => {
      const objectData = this.ensureObjectData(obj);
      if (!objectData) return;

      objectData.clips.forEach((clip) => {
        const payload = {
          object_id: objectData.objectId,
          object_name: objectData.objectName,
          joint_node: objectData.jointNode,
          joint_points: objectData.jointPoints || [],
          joint_enabled: clip.jointEnabled,
          channels: {
            translate: { axis: clip.translateAxis },
            rotate: { axis: clip.rotateAxis },
          },
          pivot: {
            enabled: clip.pivotEnabled,
            x: clip.pivotX,
            y: clip.pivotY,
            z: clip.pivotZ,
          },
          clip_name: clip.clipName,
          duration: clip.duration,
          keyframes: clip.keyframes.map((k) => ({
            t: k.time,
            translate_value: k.translateValue,
            rotate_value: k.rotateValue,
          })),
          // Extension point: future multi-joint/FK export schema.
          semantics_version: 3,
        };
        if (clip.minValue !== null) payload.min_value = clip.minValue;
        if (clip.maxValue !== null) payload.max_value = clip.maxValue;
        list.push(payload);
      });
    });
    return list;
  }

  // ══════════════════════════════════════════════════════════════
  //  PKF 参数 CRUD（增删改查）
  // ══════════════════════════════════════════════════════════════

  /**
   * 添加一个 PKF 参数声明
   * @param {Object} param - 参数对象
   * @param {string} param.id       - 唯一标识（必填），同时也是公式中引用的变量名
   * @param {string} [param.type]   - 值类型，默认 'number'，可选 'vec3'
   * @param {string} [param.unit]   - 单位，如 'mm'、'deg'
   * @param {string} [param.desc]   - 中文描述
   * @param {*}      [param.default] - 默认值，编辑器预览时使用，默认 0
   * @returns {Object|null} 创建成功返回参数对象；id 为空或已存在返回 null
   */
  addPkfParameter(param) {
    if (!param?.id) return null;                       // id 为空，拒绝
    if (this.pkfParameters.has(param.id)) return null; // id 重复，拒绝
    const created = {
      id: param.id,
      type: param.type || 'number',
      unit: param.unit || '',
      desc: param.desc || '',
      default: param.default ?? 0,
    };
    this.pkfParameters.set(created.id, created);
    return created;
  }

  /**
   * 更新指定 PKF 参数的字段（支持改名）
   * 改名时会自动更新所有步骤公式中对该参数的引用（正则单词边界匹配）
   * @param {string} id    - 要修改的参数 id
   * @param {Object} patch - 要更新的字段（只传需要改的）
   * @returns {boolean} 成功返回 true；参数不存在或新 id 冲突返回 false
   */
  updatePkfParameter(id, patch) {
    const existing = this.pkfParameters.get(id);
    if (!existing) return false; // 参数不存在

    // ── 处理 id 改名 ──
    if (patch.id && patch.id !== id) {
      if (this.pkfParameters.has(patch.id)) return false; // 新 id 已被占用，拒绝
      this.pkfParameters.delete(id);       // 从 Map 中移除旧 key
      existing.id = patch.id;              // 更新对象的 id
      this.pkfParameters.set(existing.id, existing); // 用新 key 存回 Map

      // 遍历所有步骤，将公式中的旧参数名替换为新参数名
      // 使用 \b 单词边界，避免误替换（如 stroke 不会匹配 stroke_rate）
      this.pkfSteps.forEach((s) => {
        if (typeof s.value_start === 'string') s.value_start = s.value_start.replace(new RegExp(`\\b${id}\\b`, 'g'), existing.id);
        if (typeof s.value_end === 'string') s.value_end = s.value_end.replace(new RegExp(`\\b${id}\\b`, 'g'), existing.id);
      });
    }

    // ── 更新普通字段（只改传入的字段，不碰其他字段）──
    if (typeof patch.type !== 'undefined') existing.type = patch.type;
    if (typeof patch.unit !== 'undefined') existing.unit = patch.unit;
    if (typeof patch.desc !== 'undefined') existing.desc = patch.desc;
    if (typeof patch.default !== 'undefined') existing.default = patch.default;
    return true;
  }

  /**
   * 删除指定 PKF 参数
   * @param {string} id - 参数 id
   * @returns {boolean} 删除成功返回 true；不存在返回 false
   */
  removePkfParameter(id) {
    return this.pkfParameters.delete(id);
  }

  /**
   * 获取所有 PKF 参数的副本数组
   * @returns {Array<Object>} 参数对象数组（浅拷贝，修改不影响内部数据）
   */
  getAllPkfParameters() {
    return [...this.pkfParameters.values()];
  }

  // ══════════════════════════════════════════════════════════════
  //  PKF 步骤 CRUD（增删改查）
  // ══════════════════════════════════════════════════════════════

  /**
   * 添加一个 PKF 步骤
   * @param {Object} [step] - 步骤配置
   * @param {string} [step.id]           - 唯一标识，不传则自动生成（时间戳+随机串）
   * @param {string} [step.joint]        - 关联的关节名称
   * @param {string} [step.joint_def_id] - 关联的关节定义 id
   * @param {string} [step.channel]      - 通道：'translate' 或 'rotate'，默认 'translate'
   * @param {string} [step.axis]         - 轴向：'x'/'y'/'z'，默认 'z'（Z-up 主轴）
   * @param {number} [step.t_start]      - 起始时间（秒），默认 0
   * @param {number} [step.t_end]        - 结束时间（秒），默认 1
   * @param {string} [step.value_start]  - 起始值公式字符串，默认 '0'
   * @param {string} [step.value_end]    - 结束值公式字符串，默认 '0'
   * @param {string} [step.easing]       - 缓动类型，默认 'linear'
   * @returns {Object} 创建好的步骤对象
   */
  addPkfStep(step) {
    const created = {
      id: step?.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, // 自动生成唯一 id
      joint: step?.joint || '',
      joint_def_id: step?.joint_def_id || '',
      channel: step?.channel || 'translate',
      axis: step?.axis || 'z',
      t_start: step?.t_start ?? 0,
      t_end: step?.t_end ?? 1,
      value_start: String(step?.value_start ?? '0'), // 强制转字符串，PKF 核心是公式
      value_end: String(step?.value_end ?? '0'),     // 同上
      easing: step?.easing || 'linear',
    };
    this.pkfSteps.push(created);
    return created;
  }

  /**
   * 更新指定 PKF 步骤的字段
   * @param {string} stepId - 步骤 id
   * @param {Object} patch  - 要更新的字段（只传需要改的）
   * @returns {boolean} 成功返回 true；步骤不存在返回 false
   */
  updatePkfStep(stepId, patch) {
    const step = this.pkfSteps.find((s) => s.id === stepId);
    if (!step) return false; // 步骤不存在

    // 逐字段检查并更新，只改传入的字段
    if (typeof patch.joint !== 'undefined') step.joint = patch.joint;
    if (typeof patch.joint_def_id !== 'undefined') step.joint_def_id = patch.joint_def_id;
    if (typeof patch.channel !== 'undefined') step.channel = patch.channel;
    if (typeof patch.axis !== 'undefined') step.axis = patch.axis;
    if (typeof patch.t_start !== 'undefined') step.t_start = Number(patch.t_start) || 0;
    if (typeof patch.t_end !== 'undefined') step.t_end = Number(patch.t_end) || 0;
    if (typeof patch.value_start !== 'undefined') step.value_start = String(patch.value_start); // 保持字符串
    if (typeof patch.value_end !== 'undefined') step.value_end = String(patch.value_end);       // 保持字符串
    if (typeof patch.easing !== 'undefined') step.easing = patch.easing;
    return true;
  }

  /**
   * 删除指定 PKF 步骤
   * @param {string} stepId - 步骤 id
   * @returns {boolean} 删除成功返回 true；不存在返回 false
   */
  removePkfStep(stepId) {
    const before = this.pkfSteps.length;
    this.pkfSteps = this.pkfSteps.filter((s) => s.id !== stepId); // 过滤掉目标步骤
    return this.pkfSteps.length !== before; // 长度变化说明确实删了
  }

  /**
   * 获取所有 PKF 步骤的副本数组
   * @returns {Array<Object>} 步骤对象数组（浅拷贝）
   */
  getAllPkfSteps() {
    return [...this.pkfSteps];
  }

  serializeState() {
    return {
      currentTime: this.currentTime,
      jointDefinitions: [...this.jointDefinitions.values()].map((d) => ({
        id: d.id,
        name: d.name,
        type: d.type,
        axis: d.axis,
        origin: { x: d.origin?.x ?? 0, y: d.origin?.y ?? 0, z: d.origin?.z ?? 0 },
        limits: { min: d.limits.min, max: d.limits.max },
        parentId: d.parentId,
        childId: d.childId,
        currentValue: d.currentValue,
      })),
      objects: [...this.objectDataById.values()].map((obj) => ({
        objectId: obj.objectId,
        objectName: obj.objectName,
        jointNode: obj.jointNode,
        jointPoints: obj.jointPoints || [],
        baseTransform: obj.baseTransform,
        activeClipName: obj.activeClipName,
        clips: [...obj.clips.values()].map((clip) => ({
          clipName: clip.clipName,
          jointEnabled: clip.jointEnabled,
          translateAxis: clip.translateAxis,
          currentTranslateValue: clip.currentTranslateValue,
          rotateAxis: clip.rotateAxis,
          currentRotateValue: clip.currentRotateValue,
          pivotEnabled: clip.pivotEnabled,
          pivotX: clip.pivotX,
          pivotY: clip.pivotY,
          pivotZ: clip.pivotZ,
          minValue: clip.minValue,
          maxValue: clip.maxValue,
          duration: clip.duration,
          keyframes: clip.keyframes.map((k) => ({
            time: k.time,
            translateValue: k.translateValue,
            rotateValue: k.rotateValue,
          })),
        })),
      })),
      // PKF 数据序列化（深拷贝，确保快照与当前数据解耦）
      pkfParameters: [...this.pkfParameters.values()].map((p) => ({ ...p })),
      pkfSteps: this.pkfSteps.map((s) => ({ ...s })),
    };
  }

  restoreState(serializedState) {
    this.currentTime = serializedState?.currentTime ?? 0;

    // Restore joint definitions
    this.jointDefinitions.clear();
    (serializedState?.jointDefinitions || []).forEach((d) => {
      this.jointDefinitions.set(d.id, {
        id: d.id,
        name: d.name || '',
        type: d.type || 'none',
        axis: d.axis || 'y',
        origin: { x: d.origin?.x ?? 0, y: d.origin?.y ?? 0, z: d.origin?.z ?? 0 },
        limits: { min: d.limits?.min ?? -180, max: d.limits?.max ?? 180 },
        parentId: d.parentId ?? null,
        childId: d.childId ?? d.id,
        currentValue: normalizeValue(d.currentValue, 0),
      });
    });

    this.objectDataById.clear();
    (serializedState?.objects || []).forEach((obj) => {
      const clips = new Map();
      (obj.clips || []).forEach((clip) => {
        clips.set(clip.clipName, {
          clipName: clip.clipName,
          jointEnabled: typeof clip.jointEnabled === 'undefined' ? true : clip.jointEnabled,
          translateAxis: clip.translateAxis || 'z',
          currentTranslateValue: normalizeValue(clip.currentTranslateValue, 0),
          rotateAxis: clip.rotateAxis || 'z',
          currentRotateValue: normalizeValue(clip.currentRotateValue, 0),
          pivotEnabled: typeof clip.pivotEnabled === 'undefined' ? false : clip.pivotEnabled,
          pivotX: normalizeValue(clip.pivotX, 0),
          pivotY: normalizeValue(clip.pivotY, 0),
          pivotZ: normalizeValue(clip.pivotZ, 0),
          minValue: clip.minValue,
          maxValue: clip.maxValue,
          duration: clip.duration,
          keyframes: (clip.keyframes || []).map((k) => ({
            time: k.time,
            translateValue: normalizeValue(k.translateValue, 0),
            rotateValue: normalizeValue(k.rotateValue, 0),
          })),
        });
      });
      this.objectDataById.set(obj.objectId, {
        objectId: obj.objectId,
        objectName: obj.objectName,
        jointNode: obj.jointNode || { marked: false, name: obj.objectName || obj.objectId },
        jointPoints: obj.jointPoints || [],
        baseTransform: obj.baseTransform,
        activeClipName: obj.activeClipName,
        clips,
      });
    });

    // ── 恢复 PKF 数据 ──
    this.pkfParameters.clear(); // 先清空再重建，避免残留
    (serializedState?.pkfParameters || []).forEach((p) => {
      this.pkfParameters.set(p.id, { ...p }); // 深拷贝存入，与快照解耦
    });
    // 步骤数组整体替换，逐项深拷贝
    this.pkfSteps = (serializedState?.pkfSteps || []).map((s) => ({ ...s }));
  }

  // ══════════════════════════════════════════════════════════════
  //  PKF 公式求值与预览
  // ══════════════════════════════════════════════════════════════

  /**
   * 安全求值 PKF 公式字符串
   * 白名单机制：只允许数字、运算符、括号、Math 函数和已声明的参数名。
   * 拒绝任何可能的代码注入（函数调用、赋值、关键字等）。
   *
   * @param {string} formula     - 公式字符串，如 "stroke * 0.5 + 10"
   * @param {Object} paramValues - 参数名→实际值的映射，如 { stroke: 100, angle: 90 }
   * @returns {{ value: number, error: string|null }}
   *   成功时 value 为计算结果，error 为 null；
   *   失败时 value 为 0，error 为错误描述。
   */
  evaluatePkfFormula(formula, paramValues = {}) {
    // 空公式视为 0
    if (!formula || !formula.trim()) return { value: 0, error: null };

    const expr = formula.trim();

    // ── 安全性检查：白名单验证 ──
    // 允许的 Math 函数名
    const mathFns = ['abs', 'ceil', 'floor', 'round', 'min', 'max', 'sqrt', 'pow', 'sin', 'cos', 'tan', 'PI'];
    // 允许的参数名
    const paramNames = Object.keys(paramValues);
    // 所有允许的标识符
    const allowedIds = new Set([...mathFns, ...paramNames]);

    // 提取公式中所有标识符（连续字母/下划线/数字，首字符非数字）
    const identifiers = expr.match(/[a-zA-Z_]\w*/g) || [];
    // 检查是否有未知标识符
    for (const id of identifiers) {
      if (!allowedIds.has(id)) {
        return { value: 0, error: `未知标识符: "${id}"` };
      }
    }

    // 禁止危险字符：分号、花括号、方括号、反引号、等号（赋值）
    if (/[;{}\[\]`=]/.test(expr)) {
      return { value: 0, error: `公式含非法字符` };
    }

    // ── 构建安全求值环境 ──
    try {
      // 将参数值和 Math 函数注入到一个沙箱对象中
      const sandbox = { ...paramValues };
      // 注入常用 Math 函数（不带 Math. 前缀即可使用）
      mathFns.forEach((fn) => {
        if (typeof Math[fn] === 'function') sandbox[fn] = Math[fn].bind(Math);
        else if (fn === 'PI') sandbox.PI = Math.PI;
      });

      // 用 Function 构造器创建沙箱函数
      // 参数名作为形参，公式作为 return 表达式
      const argNames = Object.keys(sandbox);
      const argValues = argNames.map((k) => sandbox[k]);
      const fn = new Function(...argNames, `"use strict"; return (${expr});`);
      const result = fn(...argValues);

      // 验证结果是有效数字
      if (typeof result !== 'number' || !Number.isFinite(result)) {
        return { value: 0, error: `求值结果不是有效数字: ${result}` };
      }
      return { value: result, error: null };
    } catch (err) {
      return { value: 0, error: `求值异常: ${err.message}` };
    }
  }

  /**
   * 根据参数默认值构建参数值映射
   * @returns {Object} 参数名→默认值的映射，如 { stroke: 100, angle: 90 }
   */
  buildDefaultParamValues() {
    const values = {};
    this.pkfParameters.forEach((p) => {
      values[p.id] = p.default ?? 0;
    });
    return values;
  }

  /**
   * 预览 PKF：用参数默认值求值所有步骤，在指定时间 t 计算每个关节的目标值
   * 返回每个关节定义 id 对应的驱动值（可用于 applyJointDrive）。
   *
   * @param {number} t           - 当前预览时间（秒）
   * @param {Object} [paramOverrides] - 可选的参数值覆盖（优先于默认值）
   * @returns {Array<{ joint_def_id: string, channel: string, axis: string, value: number, error: string|null }>}
   */
  evaluatePkfAt(t, paramOverrides = {}) {
    const paramValues = { ...this.buildDefaultParamValues(), ...paramOverrides };
    const results = [];

    this.pkfSteps.forEach((step) => {
      // 跳过时间范围外的步骤
      if (t < step.t_start || t > step.t_end) return;

      // 计算时间进度 [0, 1]
      const duration = step.t_end - step.t_start;
      let progress = duration > 0 ? (t - step.t_start) / duration : 1;

      // 应用缓动函数
      progress = this._applyEasing(progress, step.easing);

      // 求值起止公式
      const startResult = this.evaluatePkfFormula(step.value_start, paramValues);
      const endResult = this.evaluatePkfFormula(step.value_end, paramValues);

      // 线性插值
      const value = startResult.value + (endResult.value - startResult.value) * progress;
      const error = startResult.error || endResult.error || null;

      results.push({
        step_id: step.id,
        joint_def_id: step.joint_def_id,
        joint: step.joint,
        channel: step.channel,
        axis: step.axis,
        value,
        error,
      });
    });

    return results;
  }

  /**
   * 应用缓动函数，将线性进度 [0,1] 映射为缓动后的进度
   * @param {number} t      - 线性进度 0~1
   * @param {string} easing - 缓动类型
   * @returns {number} 缓动后的进度
   * @private
   */
  _applyEasing(t, easing) {
    switch (easing) {
      case 'ease-in':
        return t * t;                          // 二次缓入
      case 'ease-out':
        return t * (2 - t);                    // 二次缓出
      case 'ease-in-out':
        return t < 0.5                         // 二次缓入缓出
          ? 2 * t * t
          : -1 + (4 - 2 * t) * t;
      case 'linear':
      default:
        return t;
    }
  }
}
