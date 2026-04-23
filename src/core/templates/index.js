/**
 * 模板库入口：注册 + 自动识别
 *
 * 架构目的：以后加新模板（三向车、前移式、堆垛机……）只需新建一个模板文件
 * 实现 canApply + compileTemplate 契约 + 在 TEMPLATES 数组里注册一行，
 * 就能无侵入挂进 🚀 一键生成流程。
 *
 * 每个模板模块对外契约（duck-typing，见 ForkliftTemplate.js / ThreewayTemplate.js）：
 *   - canApply(km, sceneRoot): { ok: boolean, data?, missing? }
 *     判断当前场景是否适用本模板；ok=true 返回 ctx 数据包
 *   - compileTemplate(ctx, rhythm?, forkAnchorZero?): { parameters, steps, reparent_events, meta }
 *     编译出完整 PKF 数据
 *   - buildDefaultRhythm(totalSeconds?, segCount?): Array<{ index, duration, easing }>
 *     降级用的均分节奏
 *   - kind: string  标识符（'forklift' / 'threeway' / ...），传给后端 /api/template-rhythm
 *
 * 优先级：TEMPLATES 数组顺序 = 识别顺序。**特殊/严格的模板放前面**，
 * 否则普通叉车模板会先命中，特异模板永远走不到。
 */

import * as ForkliftTemplate from './ForkliftTemplate.js';

// 模板注册表：顺序即优先级
// 以后加新模板（例如三向车）：import * as ThreewayTemplate from './ThreewayTemplate.js'
// 然后把它放在 ForkliftTemplate 之前（因为它更特异）
const TEMPLATES = [
  ForkliftTemplate,
];

/**
 * 遍历注册的模板，返回第一个 canApply.ok === true 的模板 + 其 ctx。
 *
 * @param {KeyframeManager} keyframeManager
 * @param {THREE.Object3D} sceneRoot
 * @returns {{ template: Object, ctx: Object } | null}
 */
export function detectTemplate(keyframeManager, sceneRoot) {
  for (const tpl of TEMPLATES) {
    if (typeof tpl.canApply !== 'function') continue;
    const result = tpl.canApply(keyframeManager, sceneRoot);
    if (result?.ok) {
      return { template: tpl, ctx: result.data };
    }
  }
  return null;
}

/**
 * 收集所有模板的 canApply 结果（诊断用，不做流程决策）。
 * 方便用户或诊断脚本看"我的场景为什么没命中某个模板"。
 */
export function probeAllTemplates(keyframeManager, sceneRoot) {
  return TEMPLATES.map((tpl) => ({
    kind: tpl.kind || tpl.TEMPLATE_KIND || 'unknown',
    result: typeof tpl.canApply === 'function' ? tpl.canApply(keyframeManager, sceneRoot) : null,
  }));
}

// 向后兼容：保留老命名导出，其他文件仍能按原名 import（一段过渡期后可以移除）
export {
  FORKLIFT_TEMPLATE,
  FORKLIFT_TEMPLATE_VERSION,
  TEMPLATE_PARAMETERS,
  ROLE_CAR_FORWARD,
  ROLE_MAST_LIFT,
  ROLE_CAR_SIDEWAYS_PRIMARY,
  ROLE_CAR_SIDEWAYS_FALLBACK,
  buildDefaultRhythm,
  autoDetectForkName,
  collectTemplateContext,
  compileTemplate,
} from './ForkliftTemplate.js';
