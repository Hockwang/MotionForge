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
    // objectDataById：对象元数据。仅保留 baseTransform（被 jointDef baseTransform 兜底用）。
    // 不再有 per-object clips。
    this.objectDataById = new Map();
    /** Map<nodeUuid, {id, name, type, axis, limits:{min,max}, parentId, childId, currentValue, baseTransform}> */
    this.jointDefinitions = new Map();

    // ── 全局关键帧系统 ──
    // 项目级动画片段，所有关节共享同一时间线。每个 clip 包含：
    //   - clipName: 片段名（"default" / "open" / "close" 等）
    //   - duration: 片段时长（秒）
    //   - keyframes: 全局关键帧数组，每个 keyframe 是 { time, jointValues: { [jointDefId]: number } }
    //     一个 keyframe 同时记录多个关节在该时刻的状态，回放时所有关节同步插值
    /** @type {Map<string, {clipName:string, duration:number, keyframes:Array<{time:number, jointValues:Object<string,number>}>}>} */
    this.globalClips = new Map();
    this.globalClips.set('default', { clipName: 'default', duration: 10, keyframes: [] });
    this.activeClipName = 'default';

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
    this.globalClips.clear();
    this.globalClips.set('default', { clipName: 'default', duration: 10, keyframes: [] });
    this.activeClipName = 'default';
    this.pkfParameters.clear();  // 清空 PKF 参数
    this.pkfSteps = [];           // 清空 PKF 步骤
  }

  /**
   * 确保对象有 objectData 记录（仅保留 baseTransform）
   * 主要用途：作为 jointDef.baseTransform 的兜底（当关节定义没有自己的零点时）
   * @param {THREE.Object3D} object
   */
  ensureObjectData(object) {
    if (!object) return null;
    const current = this.objectDataById.get(object.uuid);
    if (current) {
      current.objectName = object.name || '(unnamed)';
      return current;
    }
    const created = {
      objectId: object.uuid,
      objectName: object.name || '(unnamed)',
      baseTransform: {
        tx: object.position.x,
        ty: object.position.y,
        tz: object.position.z,
        rx: object.rotation.x,
        ry: object.rotation.y,
        rz: object.rotation.z,
      },
    };
    this.objectDataById.set(object.uuid, created);
    return created;
  }

  // ── Joint Definition CRUD (layer-tree joint type per node) ──

  getJointDef(nodeId) {
    return this.jointDefinitions.get(nodeId) ?? null;
  }

  /**
   * 创建或更新指定节点的关节定义
   * @param {string} nodeId - child 节点 uuid
   * @param {Object} patch - 要更新的字段
   * @param {Object} [patch.baseTransform] - 关节零点姿态 {tx,ty,tz,rx,ry,rz}
   *   首次创建关节时由调用方传入对象当前的 local position/rotation。
   *   之后 applyJointDrive 以此为零点（currentValue=0 时回到这个姿态）。
   *   注意：def.baseTransform 与 objectData.baseTransform 是两个独立概念，
   *   后者用于关键帧动画的 bind pose，前者只服务于关节驱动。
   * @returns {Object|null}
   */
  setJointDef(nodeId, patch) {
    const existing = this.jointDefinitions.get(nodeId);
    const def = existing || {
      id: nodeId,
      name: '',
      type: 'none',       // none | revolute | prismatic | fixed
      axis: 'y',           // x | y | z (UI convention)
      origin: { x: 0, y: 0, z: 0 }, // 关节原点（世界空间，UI Z-up 约定）——revolute 的旋转中心
      limits: { min: -180, max: 180 },
      parentId: null,
      childId: nodeId,
      currentValue: 0,
      baseTransform: null, // 关节零点姿态，由首次创建关节时捕获
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
    // 仅在 patch 显式传入时更新 baseTransform，避免后续修改类型/轴时覆盖零点
    if (patch.baseTransform) {
      def.baseTransform = {
        tx: normalizeValue(patch.baseTransform.tx, 0),
        ty: normalizeValue(patch.baseTransform.ty, 0),
        tz: normalizeValue(patch.baseTransform.tz, 0),
        rx: normalizeValue(patch.baseTransform.rx, 0),
        ry: normalizeValue(patch.baseTransform.ry, 0),
        rz: normalizeValue(patch.baseTransform.rz, 0),
      };
    }

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

    // 关节零点姿态（parent-local space）
    // 优先级：def 自带的 baseTransform（关节首次创建时捕获，最准确）
    //       > objectData.baseTransform（动画 bind pose，可能与关节零点不同）
    //       > 当前 position/rotation（兜底，不准）
    const objectData = this.objectDataById.get(nodeId);
    const base = def.baseTransform || objectData?.baseTransform;

    // def.origin 存储在 UI 约定（Z-up），表示世界空间坐标
    // （与 syncJointOriginMarker、onOriginFromBbox/Center、onOriginFromJointPoint 一致）
    // 转换到 Three.js 世界空间（Y-up）：UI Z → Y，UI Y → Z
    const originWorld = new THREE.Vector3(
      def.origin?.x ?? 0,
      def.origin?.z ?? 0,  // UI Z → Three.js Y (vertical)
      def.origin?.y ?? 0,  // UI Y → Three.js Z
    );

    if (def.type === 'revolute') {
      // 在世界空间绕 originWorld 旋转 currentValue 度。
      // 之前把 origin 当 parent-local 用，导致父节点有偏移时旋转中心错位。
      const rad = (def.currentValue * Math.PI) / 180;
      const worldAxis = mapUiAxisToWorld(def.axis);
      const worldAxisVec = worldAxis === 'x' ? new THREE.Vector3(1, 0, 0)
        : worldAxis === 'y' ? new THREE.Vector3(0, 1, 0)
        : new THREE.Vector3(0, 0, 1);
      // 世界轴旋转 quaternion
      const deltaQuat = new THREE.Quaternion().setFromAxisAngle(worldAxisVec, rad);

      const parent = childObj.parent;
      if (!parent) return;

      // 1) 先把 child 放回关节零点姿态（parent-local）
      if (base) {
        childObj.position.set(base.tx, base.ty, base.tz);
        childObj.rotation.set(base.rx, base.ry, base.rz);
      }

      // 2) 读取零点姿态下的世界 transform
      //    getWorldPosition/Quaternion 会向上递归 updateWorldMatrix，确保准确
      const baseWorldPos = childObj.getWorldPosition(new THREE.Vector3());
      const baseWorldQuat = childObj.getWorldQuaternion(new THREE.Quaternion());

      // 3) 绕 originWorld 旋转 deltaQuat：newPos = origin + deltaQuat * (basePos - origin)
      const offset = baseWorldPos.clone().sub(originWorld);
      const rotatedOffset = offset.applyQuaternion(deltaQuat);
      const newWorldPos = originWorld.clone().add(rotatedOffset);
      const newWorldQuat = deltaQuat.clone().multiply(baseWorldQuat);

      // 4) 世界 transform 转回 parent-local，写入 child
      childObj.position.copy(parent.worldToLocal(newWorldPos.clone()));
      const parentWorldQuatInv = parent.getWorldQuaternion(new THREE.Quaternion()).invert();
      childObj.quaternion.copy(parentWorldQuatInv.multiply(newWorldQuat));
    } else if (def.type === 'prismatic') {
      // Prismatic：沿关节的世界轴方向平移 currentValue 单位。
      // 注意必须在世界空间计算，而不是简单地加到局部 position[axis] 上。
      // 当 childObj 的父节点有旋转时，父节点的局部 Y 方向并不等于世界 Y 方向，
      // 直接加到局部 position.y 上会导致实际位移方向偏离用户预期（gizmo 拖拽方向）。
      const worldAxis = mapUiAxisToWorld(def.axis);
      const worldAxisVec = worldAxis === 'x' ? new THREE.Vector3(1, 0, 0)
        : worldAxis === 'y' ? new THREE.Vector3(0, 1, 0)
        : new THREE.Vector3(0, 0, 1);

      // 1) 先把 child 放回关节零点（parent-local）
      if (base) {
        childObj.position.set(base.tx, base.ty, base.tz);
      }

      // 2) 计算 child 在零点姿态下的世界位置
      const parent = childObj.parent;
      if (parent) {
        parent.updateMatrixWorld(true);
        // getWorldPosition 会使用 child 刚才设置的 local + parent 的 worldMatrix
        const baseWorldPos = childObj.getWorldPosition(new THREE.Vector3());
        // 3) 沿世界轴方向加上 currentValue 位移
        const targetWorldPos = baseWorldPos.add(worldAxisVec.multiplyScalar(def.currentValue));
        // 4) 把目标世界位置转回父 local，写入 child.position
        childObj.position.copy(parent.worldToLocal(targetWorldPos));
      } else {
        // 兜底：没有父节点时，local 就是世界，直接加
        childObj.position[worldAxis] += def.currentValue;
      }
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

  // ══════════════════════════════════════════════════════════════
  //  全局动画片段（Global Clips）管理
  // ══════════════════════════════════════════════════════════════

  /** 当前激活的全局 clip 对象 */
  getActiveGlobalClip() {
    return this.globalClips.get(this.activeClipName) ?? null;
  }

  /** 所有全局 clip 名称列表 */
  getClipNames() {
    return [...this.globalClips.keys()];
  }

  /** 切换激活的全局 clip */
  setActiveClip(clipName) {
    if (!this.globalClips.has(clipName)) return false;
    this.activeClipName = clipName;
    return true;
  }

  /**
   * 创建一个全局 clip。如果名字冲突自动加后缀
   * @param {string} requestedName
   * @returns {string} 实际创建的 clip 名（可能带后缀）
   */
  createClip(requestedName) {
    const base = (requestedName || 'new_clip').trim() || 'new_clip';
    let name = base;
    let i = 1;
    while (this.globalClips.has(name)) {
      i += 1;
      name = `${base}_${i}`;
    }
    this.globalClips.set(name, { clipName: name, duration: 10, keyframes: [] });
    return name;
  }

  /** 当前 clip 时长（秒） */
  getClipDuration() {
    return this.getActiveGlobalClip()?.duration ?? 10;
  }

  /** 设置当前 clip 时长 */
  setClipDuration(duration) {
    const clip = this.getActiveGlobalClip();
    if (!clip) return;
    clip.duration = Math.max(0.1, Number(duration) || 10);
  }

  /** 当前 clip 的关键帧数组 */
  getKeyframes() {
    return this.getActiveGlobalClip()?.keyframes ?? [];
  }

  // ══════════════════════════════════════════════════════════════
  //  全局关键帧 CRUD
  // ══════════════════════════════════════════════════════════════

  /**
   * 在指定时间添加一个全局关键帧
   * 抓取**所有有 jointDef 的对象**的当前 def.currentValue，存入 keyframe.jointValues
   * @param {number} time
   * @returns {Object|null} 创建的关键帧对象
   */
  addKeyframe(time) {
    const clip = this.getActiveGlobalClip();
    if (!clip) return null;

    // 收集所有关节定义的当前状态
    const jointValues = {};
    this.jointDefinitions.forEach((def) => {
      jointValues[def.id] = normalizeValue(def.currentValue, 0);
    });

    const t = Number(time);
    // 同一时间已有关键帧则替换
    clip.keyframes = clip.keyframes.filter((k) => Math.abs(k.time - t) > 0.0001);
    const keyframe = { time: t, jointValues };
    clip.keyframes.push(keyframe);
    clip.keyframes.sort((a, b) => a.time - b.time);
    return keyframe;
  }

  /**
   * 删除指定时间的全局关键帧
   * @param {number} time
   * @returns {boolean}
   */
  removeKeyframe(time) {
    const clip = this.getActiveGlobalClip();
    if (!clip) return false;
    const before = clip.keyframes.length;
    clip.keyframes = clip.keyframes.filter((k) => Math.abs(k.time - Number(time)) > 0.0001);
    return clip.keyframes.length !== before;
  }

  // ══════════════════════════════════════════════════════════════
  //  关键帧求值
  // ══════════════════════════════════════════════════════════════

  /**
   * 在时间 t 上为指定 joint def 求值（在当前 clip 的关键帧中插值）
   * 只考虑那些 jointValues 字典里**包含该 jointDefId**的关键帧
   * @param {Array} keyframes - 全局关键帧数组
   * @param {string} jointDefId
   * @param {number} t
   * @returns {number|null} 插值结果，没有任何相关关键帧则返回 null
   */
  _interpolateJointValueAtTime(keyframes, jointDefId, t) {
    // 只看包含该关节状态的关键帧
    const relevant = keyframes.filter(
      (k) => k.jointValues && k.jointValues[jointDefId] !== undefined && k.jointValues[jointDefId] !== null,
    );
    if (!relevant.length) return null;

    if (t <= relevant[0].time) {
      return relevant[0].jointValues[jointDefId];
    }
    if (t >= relevant[relevant.length - 1].time) {
      return relevant[relevant.length - 1].jointValues[jointDefId];
    }
    for (let i = 0; i < relevant.length - 1; i += 1) {
      const left = relevant[i];
      const right = relevant[i + 1];
      if (t < left.time || t > right.time) continue;
      const ratio = (t - left.time) / (right.time - left.time);
      return lerp(left.jointValues[jointDefId], right.jointValues[jointDefId], ratio);
    }
    return null;
  }

  /**
   * 在时间 t 求值整个项目的关键帧动画
   * 对每个 jointDef 在当前 clip 中插值，写回 def.currentValue
   * 之后 loop 里的 applyAllJointDrives 会用新的 currentValue 驱动对象
   * @param {number} time
   * @param {THREE.Object3D} _root - 兼容旧签名，未使用
   */
  evaluateAllAt(time, _root) {
    this.currentTime = Math.max(0, Number(time) || 0);
    const clip = this.getActiveGlobalClip();
    if (!clip || !clip.keyframes.length) return;

    this.jointDefinitions.forEach((def) => {
      const value = this._interpolateJointValueAtTime(clip.keyframes, def.id, this.currentTime);
      if (value !== null && value !== undefined) {
        def.currentValue = normalizeValue(value, def.currentValue);
      }
    });
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
        // 关节零点姿态（深拷贝），undo/redo 时不能丢
        baseTransform: d.baseTransform ? { ...d.baseTransform } : null,
      })),
      objects: [...this.objectDataById.values()].map((obj) => ({
        objectId: obj.objectId,
        objectName: obj.objectName,
        baseTransform: obj.baseTransform,
      })),
      // 全局 clips：每个 clip 包含 duration + keyframes（每个 keyframe 含全局 jointValues）
      activeClipName: this.activeClipName,
      globalClips: [...this.globalClips.values()].map((clip) => ({
        clipName: clip.clipName,
        duration: clip.duration,
        keyframes: clip.keyframes.map((k) => ({
          time: k.time,
          jointValues: { ...k.jointValues }, // 浅拷贝足够（值都是 number）
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
        // 关节零点姿态：可能为 null（旧数据），applyJointDrive 会 fallback
        baseTransform: d.baseTransform ? { ...d.baseTransform } : null,
      });
    });

    // Restore objectData (only baseTransform, no per-object clips anymore)
    this.objectDataById.clear();
    (serializedState?.objects || []).forEach((obj) => {
      this.objectDataById.set(obj.objectId, {
        objectId: obj.objectId,
        objectName: obj.objectName,
        baseTransform: obj.baseTransform,
      });
    });

    // Restore global clips
    this.globalClips.clear();
    (serializedState?.globalClips || []).forEach((clip) => {
      this.globalClips.set(clip.clipName, {
        clipName: clip.clipName,
        duration: Math.max(0.1, Number(clip.duration) || 10),
        keyframes: (clip.keyframes || []).map((k) => ({
          time: Number(k.time) || 0,
          jointValues: { ...(k.jointValues || {}) },
        })),
      });
    });
    // 至少保证有一个 default clip
    if (!this.globalClips.size) {
      this.globalClips.set('default', { clipName: 'default', duration: 10, keyframes: [] });
    }
    this.activeClipName = serializedState?.activeClipName && this.globalClips.has(serializedState.activeClipName)
      ? serializedState.activeClipName
      : this.globalClips.keys().next().value;

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
