import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { USDZLoader } from 'three/examples/jsm/loaders/USDZLoader.js';

/**
 * Asset loader abstraction.
 * Extension point: replace or augment this with a real USD pipeline service.
 */
export class AssetLoader {
  constructor() {
    this.gltfLoader = new GLTFLoader();
    this.usdzLoader = new USDZLoader();
    this.converterServiceUrl = import.meta.env.VITE_CONVERTER_URL || 'http://localhost:8091';
  }

  async loadFromFile(file, onStatus = () => {}) {
    const lower = file.name.toLowerCase();
    const extension = lower.split('.').pop() || '';
    onStatus('正在读取本地文件...');
    const buffer = await file.arrayBuffer();

    if (extension === 'usdz') {
      onStatus('正在解析 USDZ...');
      const object = await this.usdzLoader.parseAsync(buffer);
      object.name = object.name || file.name;
      return object;
    }

    if (extension === 'glb' || extension === 'gltf') {
      onStatus('正在解析 GLB/GLTF...');
      return this.parseGlbLikeBuffer(buffer, file.name);
    }

    if (extension === 'usd' || extension === 'usda' || extension === 'usdc' || extension === 'fbx') {
      return this.loadViaConverterService(file, onStatus);
    }

    throw new Error(`Unsupported format: .${extension}`);
  }

  async parseGlbLikeBuffer(buffer, fallbackName = '') {
    return new Promise((resolve, reject) => {
      this.gltfLoader.parse(
        buffer,
        '',
        (gltf) => {
          const root = gltf.scene || gltf.scenes?.[0];
          if (!root) {
            reject(new Error('GLTF scene missing.'));
            return;
          }
          root.name = root.name || fallbackName;
          resolve(root);
        },
        reject,
      );
    });
  }

  async loadViaConverterService(file, onStatus = () => {}) {
    const body = new FormData();
    body.append('file', file, file.name);

    onStatus('正在上传资产到转换服务...');
    const response = await fetch(`${this.converterServiceUrl}/api/convert-to-glb`, {
      method: 'POST',
      body,
    });
    if (!response.ok) {
      let detail = '';
      try {
        const json = await response.json();
        detail = json?.message || '';
      } catch {
        detail = await response.text();
      }
      throw new Error(
        `转换服务不可用或转换失败。请先运行 npm run converter。${detail ? ` 详情: ${detail}` : ''}`,
      );
    }

    onStatus('转换成功，正在解析 GLB...');
    const glbBuffer = await response.arrayBuffer();
    return this.parseGlbLikeBuffer(glbBuffer, file.name);
  }

  createMockSceneForUnsupportedUsd(fileName) {
    // Placeholder fallback for workflow validation when direct USD is unavailable.
    const group = new THREE.Group();
    group.name = `${fileName} (mock)`;

    const base = new THREE.Mesh(
      new THREE.BoxGeometry(2, 0.4, 2),
      new THREE.MeshStandardMaterial({ color: 0x4b5563 }),
    );
    base.position.y = 0.2;
    base.name = 'base';

    const arm = new THREE.Mesh(
      new THREE.BoxGeometry(0.4, 1.6, 0.4),
      new THREE.MeshStandardMaterial({ color: 0x2563eb }),
    );
    arm.position.set(0.8, 1, 0);
    arm.name = 'arm';

    const tool = new THREE.Mesh(
      new THREE.CylinderGeometry(0.08, 0.08, 1, 16),
      new THREE.MeshStandardMaterial({ color: 0xf59e0b }),
    );
    tool.rotation.z = Math.PI / 2;
    tool.position.set(1.4, 1.4, 0);
    tool.name = 'tool';

    group.add(base, arm, tool);
    return group;
  }
}
