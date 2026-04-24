import { defineConfig } from 'vitest/config';

// vitest 配置（F4 基建）
// - environment: 'node' —— 单元测试不依赖 DOM，Three.js 的纯几何类（Vector3 / Box3 / Object3D / Mesh / BoxGeometry）在 node 下能用
// - include：
//   - tests/unit/**：单元测试，测单类/单函数行为
//   - tests/integration/**（#65）：集成测试，测跨模块流程（ZIP export → JSON → import roundtrip）
//     专门兜住历史上反复踩的"跨序列化边界丢字段"类 bug（#18 / F61 等）
// - tests/ 根目录的 diag-*.js / test-pkf-p*.js 是浏览器 console 脚本，不进 vitest
export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'tests/unit/**/*.test.js',
      'tests/integration/**/*.test.js',
    ],
    reporters: 'default',
  },
});
