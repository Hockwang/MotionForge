/**
 * 结果包导出器
 * 将编辑器数据打包为带时间戳的 ZIP 文件，包含 manifest、joints、joint-definitions、motion、pkf、model
 */
import JSZip from 'jszip';

export class ResultPackageExporter {
  /**
   * 导出结果包 ZIP
   * @param {Object} options
   * @param {string}  options.sourceFileName    - 源文件名
   * @param {string}  options.sourceFormat      - 源格式
   * @param {File}    options.rawModelFile      - 原始模型文件
   * @param {Array}   options.jointPoints       - 关节点数据
   * @param {Array}   options.jointDefinitions  - 关节定义数据
   * @param {Array}   options.clips             - 动作片段数据
   * @param {Array}   [options.pkfParameters]   - PKF 参数声明数组
   * @param {Array}   [options.pkfSteps]        - PKF 步骤数组
   * @param {string}  [options.editorName]      - 编辑器名称
   * @returns {Promise<{manifest, joints, motion, pkf}>}
   */
  async exportZip({
    sourceFileName,
    sourceFormat,
    rawModelFile,
    jointPoints,
    jointDefinitions,
    clips,
    pkfParameters,
    pkfSteps,
    editorName = 'MotionForge',
  }) {
    const zip = new JSZip();
    const timestamp = this.getTimestamp();
    const manifestFileName = `manifest-${timestamp}.json`;
    const jointsFileName = `joints-${timestamp}.json`;
    const jointDefsFileName = `joint-definitions-${timestamp}.json`;
    const motionFileName = `motion-${timestamp}.json`;
    // PKF 文件：有参数或步骤时才生成
    const hasPkf = (pkfParameters && pkfParameters.length) || (pkfSteps && pkfSteps.length);
    const pkfFileName = hasPkf ? `pkf-${timestamp}.json` : null;

    const modelFileName = rawModelFile ? `model-${timestamp}.${this.getExtension(sourceFileName)}` : null;

    const manifest = {
      schema_version: 1,
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
        joints: jointsFileName,
        joint_definitions: jointDefsFileName,
        motion: motionFileName,
        pkf: pkfFileName, // 可为 null（向后兼容：旧版无此字段）
      },
    };

    const joints = {
      _comment: {
        offset_from_object_origin:
          '关节点相对于跟随对象世界坐标原点的偏移量（世界坐标系）。对象平移时，关节位置 = 对象当前世界坐标 + offset_from_object_origin。关节不跟随对象旋转。',
      },
      joints: (jointPoints || []).map((p) => ({
        id: p.id,
        name: p.name,
        position: [p.x ?? 0, p.y ?? 0, p.z ?? 0],
        follow_object: p.followObjectName || null,
        offset_from_object_origin: p.followOffset
          ? [p.followOffset.x ?? 0, p.followOffset.y ?? 0, p.followOffset.z ?? 0]
          : null,
      })),
    };

    const motion = {
      clips: (clips || []).map((clip) => ({
        object: clip.object_name,
        object_id: clip.object_id,
        clip_name: clip.clip_name,
        pivot: clip.pivot_enabled
          ? [clip.pivot_x ?? 0, clip.pivot_y ?? 0, clip.pivot_z ?? 0]
          : null,
        duration: clip.duration,
        channels: {
          translate: {
            axis: clip.translate_axis,
            samples: (clip.keyframes || []).map((k) => ({ t: k.t, value: k.translate_value })),
          },
          rotate: {
            axis: clip.rotate_axis,
            samples: (clip.keyframes || []).map((k) => ({ t: k.t, value: k.rotate_value })),
          },
        },
      })),
    };

    const jointDefs = {
      _comment: '层级树关节定义（FK 关节类型、轴向、原点、限位、当前值）',
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
      })),
    };

    // ── 构建 PKF 数据（参数化关键帧公式）──
    const pkf = hasPkf
      ? {
          _comment: '参数化关键帧公式：parameters 声明输入参数，steps 定义公式驱动的运动步骤',
          parameters: (pkfParameters || []).map((p) => ({
            id: p.id,
            type: p.type || 'number',
            unit: p.unit || '',
            desc: p.desc || '',
            default: p.default ?? 0,
          })),
          steps: (pkfSteps || []).map((s) => ({
            id: s.id,
            joint: s.joint || '',
            joint_def_id: s.joint_def_id || '',
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
    zip.file(jointDefsFileName, JSON.stringify(jointDefs, null, 2));
    zip.file(motionFileName, JSON.stringify(motion, null, 2));

    // PKF 文件仅在有数据时写入
    if (pkf && pkfFileName) {
      zip.file(pkfFileName, JSON.stringify(pkf, null, 2));
    }

    if (rawModelFile && modelFileName) {
      const modelBuffer = await rawModelFile.arrayBuffer();
      zip.file(modelFileName, modelBuffer);
    }

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

  getExtension(fileName) {
    if (!fileName) return 'glb';
    const ext = fileName.split('.').pop()?.toLowerCase();
    return ext || 'glb';
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
