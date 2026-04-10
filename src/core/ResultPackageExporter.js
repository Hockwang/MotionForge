/**
 * 结果包导出器
 * 将编辑器数据打包为带时间戳的 ZIP 文件，包含 manifest、joints、motion、pkf、model
 *
 * schema_version 历史：
 *  - v1：老格式，joints.json 是关节点（空间锚点）+ joint-definitions.json 是 FK 关节定义
 *  - v2：joints.json 直接存 FK 关节定义；origin 是世界坐标（UI Z-up）
 *  - v3：origin 改为 parent-local（URDF 风格），父节点动 → 关节中心自动跟。
 *       motion.json 是全局关键帧 schema（clips[].keyframes[].joint_values 字典）
 *  - v4：model.glb 由 GLTFExporter 重新序列化当前 sceneRoot，
 *       包含运行时插入的父级 group（onInsertGroup）和其他 reparent 修改。
 *       这样导入时场景树状态完整，joint def 的 parent/child 关系不会丢。
 */
import JSZip from 'jszip';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';

export class ResultPackageExporter {
  /**
   * 用 GLTFExporter 把当前的 sceneRoot 序列化成 GLB ArrayBuffer
   * 这一步是 v4 的核心：包含运行时插入的 group / reparent 修改，
   * 而不是用户最初加载的原始 GLB 文件。
   * @param {THREE.Object3D} sceneRoot
   * @returns {Promise<ArrayBuffer>}
   */
  serializeSceneToGlb(sceneRoot) {
    return new Promise((resolve, reject) => {
      const exporter = new GLTFExporter();
      exporter.parse(
        sceneRoot,
        (result) => {
          if (result instanceof ArrayBuffer) {
            resolve(result);
          } else {
            reject(new Error('GLTFExporter 返回非 ArrayBuffer，可能是 binary 选项未生效'));
          }
        },
        (error) => reject(error),
        { binary: true, embedImages: true }, // .glb 二进制 + 嵌入纹理
      );
    });
  }

  /**
   * 导出结果包 ZIP
   * @param {Object} options
   * @param {string}  options.sourceFileName    - 源文件名（仅用于命名 ZIP，不再决定模型扩展名）
   * @param {string}  options.sourceFormat      - 源格式
   * @param {THREE.Object3D} options.sceneRoot  - 当前场景根（v4 起必填，会被序列化为 model.glb）
   * @param {Array}   options.jointDefinitions  - 关节定义数组
   * @param {Array}   options.clips             - 动作片段数据
   * @param {Array}   [options.pkfParameters]   - PKF 参数声明数组
   * @param {Array}   [options.pkfSteps]        - PKF 步骤数组
   * @param {string}  [options.editorName]      - 编辑器名称
   * @returns {Promise<{manifest, joints, motion, pkf}>}
   */
  async exportZip({
    sourceFileName,
    sourceFormat,
    sceneRoot,
    jointDefinitions,
    clips,
    pkfParameters,
    pkfSteps,
    editorName = 'MotionForge',
  }) {
    if (!sceneRoot) {
      throw new Error('exportZip: sceneRoot 为必填参数（v4 schema）');
    }
    const zip = new JSZip();
    const timestamp = this.getTimestamp();
    const manifestFileName = `manifest-${timestamp}.json`;
    const jointsFileName = `joints-${timestamp}.json`;
    const motionFileName = `motion-${timestamp}.json`;
    // PKF 文件：有参数或步骤时才生成
    const hasPkf = (pkfParameters && pkfParameters.length) || (pkfSteps && pkfSteps.length);
    const pkfFileName = hasPkf ? `pkf-${timestamp}.json` : null;

    // v4：模型固定为 .glb（GLTFExporter 输出格式），不管原文件是 fbx/usd 都统一
    const modelFileName = `model-${timestamp}.glb`;

    const manifest = {
      schema_version: 4,
      generator: editorName,
      exported_at: new Date().toISOString(),
      source: {
        file_name: sourceFileName || 'unknown',
        format: sourceFormat || 'unknown',
        up_axis: 'Z',
        units_in_meters: 1.0,
        fps: 30,
      },
      files: {
        manifest: manifestFileName,
        model: modelFileName,
        joints: jointsFileName, // v2: FK 关节定义（取代了 v1 的关节点系统）
        motion: motionFileName,
        pkf: pkfFileName,       // 可为 null
      },
    };

    // joints.json（v2 schema）：FK 关节定义。
    // 每条记录包含：type（revolute/prismatic/fixed）、axis、origin（世界空间）、
    // limits、parent_id、child_id、current_value、base_transform（关节零点姿态）。
    const joints = {
      _comment: 'FK 关节定义。type 决定运动语义；origin 是世界空间旋转/平移参考点（UI Z-up 约定）；base_transform 是关节零点的 parent-local 姿态。',
      definitions: (jointDefinitions || []).map((d) => ({
        id: d.id,
        name: d.name,
        scene_path: d.scenePath || null,
        type: d.type,
        axis: d.axis,
        origin: { x: d.origin?.x ?? 0, y: d.origin?.y ?? 0, z: d.origin?.z ?? 0 },
        limits: { min: d.limits?.min ?? -180, max: d.limits?.max ?? 180 },
        parent_id: d.parentId,
        child_id: d.childId,
        current_value: d.currentValue ?? 0,
        base_transform: d.baseTransform || null,
      })),
    };

    // motion.json v2 schema：全局动画片段
    // 每个 clip 包含 duration + 全局关键帧数组
    // 每个关键帧含 jointValues 字典：{ jointDefName: number }
    // 不再有 per-object channels，所有关节在同一时间线上同步
    const motion = {
      _comment: 'v2 全局关键帧 schema：每个 clip 是项目级动画片段，keyframes[].joint_values 字典记录所有关节在该时刻的状态。joint_values 的 key 是 joint definition 的 name。',
      clips: (clips || []).map((clip) => ({
        clip_name: clip.clip_name,
        duration: clip.duration,
        keyframes: (clip.keyframes || []).map((k) => ({
          t: k.t,
          joint_values: { ...(k.joint_values || {}) },
        })),
      })),
    };

    // ── 构建 PKF 数据（参数化关键帧公式）──
    // 注意：step 只序列化 `joint`（关节名字），不写 `joint_def_id`（那是运行时 uuid，
    // 跨导出/导入不稳定）。下游按 joint 名字匹配 joints.json 里的 name 字段即可。
    const pkf = hasPkf
      ? {
          _comment: '参数化关键帧公式：parameters 声明输入参数，steps 定义公式驱动的运动步骤。joint 字段引用 joints.json 的 name。',
          parameters: (pkfParameters || []).map((p) => ({
            id: p.id,
            type: p.type || 'number',
            unit: p.unit || '',
            desc: p.desc || '',
            default: p.default ?? 0,
          })),
          steps: (pkfSteps || []).map((s) => ({
            id: s.id,
            joint: s.joint || '', // 关节名字（对应 joints.json 里的 name）
            channel: s.channel || 'translate',
            axis: s.axis || 'z',
            t_start: s.t_start ?? 0,
            t_end: s.t_end ?? 1,
            value_start: s.value_start ?? '0',
            value_end: s.value_end ?? '0',
            easing: s.easing || 'linear',
          })),
        }
      : null;

    zip.file(manifestFileName, JSON.stringify(manifest, null, 2));
    zip.file(jointsFileName, JSON.stringify(joints, null, 2));
    zip.file(motionFileName, JSON.stringify(motion, null, 2));

    // PKF 文件仅在有数据时写入
    if (pkf && pkfFileName) {
      zip.file(pkfFileName, JSON.stringify(pkf, null, 2));
    }

    // v4：用 GLTFExporter 序列化当前 sceneRoot（包含运行时插入的 group / reparent）
    // 这样导入时模型就是用户编辑后的状态，joint def 的 parent/child 关系不会断
    const glbBuffer = await this.serializeSceneToGlb(sceneRoot);
    zip.file(modelFileName, glbBuffer);

    const blob = await zip.generateAsync({ type: 'blob' });
    const safeName = (sourceFileName || 'motionforge').replace(/\.[^/.]+$/, '');
    this.downloadBlob(blob, `${safeName}-motion-package-${timestamp}.zip`);
    return { manifest, joints, motion, pkf };
  }

  getTimestamp() {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${yyyy}${mm}${dd}-${hh}${mi}${ss}`;
  }

  downloadBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }
}
