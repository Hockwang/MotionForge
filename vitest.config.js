import { defineConfig } from 'vitest/config';

// vitest 配置（F4 基建）
// - environment: 'node' —— 单元测试不依赖 DOM，Three.js 的纯几何类（Vector3 / Box3 / Object3D / Mesh / BoxGeometry）在 node 下能用
// - include: 只跑 tests/unit/ 下的 .test.js；tests/ 根目录的 diag-*.js / test-pkf-p*.js 是浏览器 console 脚本，不进 vitest
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.js'],
    reporters: 'default',
  },
});
