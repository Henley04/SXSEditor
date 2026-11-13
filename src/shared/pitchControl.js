/**
 * 音高来源（pitch control）判定 —— 主窗口与分片编辑器共用。
 *
 * SoulX-Singer 的 infer() 有两种互斥的 control 模式：
 *
 *   · score  —— 只给 note_pitch，f0 条件整条置 0（bin 0 = unvoiced），
 *               F0 曲线由 diffusion 自己生成，换音过渡、起音、颤音都是模型学到的；
 *   · melody —— 只给 f0 曲线，note_pitch 置 0，音高完全由曲线决定。
 *
 * 官方 CLI 默认 melody。编辑器里三者映射为：
 *
 *   auto   —— 没有显式选择。有曲线内容就 manual，什么都没有就 score。
 *   manual —— 跟随曲线（用户手绘 / 自动层 / F0 后处理，或显式选了 manual）。
 *   score  —— 交给模型生成，曲线不参与条件，Pitch 视图置灰。
 *
 * auto 的存在是为了解决一个具体问题：老工程和"什么都没设"的分片以前会被
 * 预处理按 MIDI 填成逐音符恒定的平直 F0，模型只能照着这条死线唱。那种输入
 * 既不是 melody（曲线没信息量）也不是 score（模型收不到"无 F0"信号），
 * 落在训练分布之外。判成 score 之后模型才拿回自己生成 F0 的能力。
 */

export const PITCH_MODE_AUTO = 'auto';
export const PITCH_MODE_MANUAL = 'manual';
export const PITCH_MODE_SCORE = 'score';

/** 未知/缺省值一律当 auto，避免旧工程字段缺失时判成显式 manual。 */
export function normalizePitchMode(raw) {
  if (raw === PITCH_MODE_MANUAL || raw === PITCH_MODE_SCORE) return raw;
  return PITCH_MODE_AUTO;
}

/**
 * 生效模式。
 *
 * @param {string} explicitMode 分片上的 pitchMode（可能是 auto）
 * @param {boolean} hasContent  该分片是否含任何曲线内容（手绘 / 自动层 / F0 后处理）
 * @returns {'manual'|'score'}
 */
export function resolvePitchMode(explicitMode, hasContent) {
  const mode = normalizePitchMode(explicitMode);
  if (mode !== PITCH_MODE_AUTO) return mode;
  return hasContent ? PITCH_MODE_MANUAL : PITCH_MODE_SCORE;
}

/** 便捷判定：本次合成是否走 score。 */
export function isScoreMode(explicitMode, hasContent) {
  return resolvePitchMode(explicitMode, hasContent) === PITCH_MODE_SCORE;
}

/**
 * 分片（持久化形态）的曲线内容判定 —— 供主窗口使用。
 *
 * 与分片编辑器 buildPitchCurveF0Data() 里那条 `!hasCustom && !smoothingActive
 * && !autoOn` 必须保持等价，否则同一个分片在两处会算出不同的模式：编辑器
 * 认为"有内容"发曲线，主窗口认为"没内容"发 score，预览与导出就听感不一致。
 *
 * @param {object} fragment 分片
 * @param {(pp: object|null) => boolean} hasF0PostprocessEffect 由调用方注入，
 *        避免 shared 层反向依赖渲染层的后处理注册表。
 */
export function fragmentHasPitchContent(fragment, hasF0PostprocessEffect) {
  if (!fragment) return false;
  const pc = fragment.pitchCurve;
  if (!pc) return false;
  // 显式关掉曲线 = 用户做过选择，按 manual 处理（旧的"平直"行为），
  // 不能因为"没内容"就悄悄变成 score。
  if (pc.enabled === false) return true;
  if (Array.isArray(pc.anchorPoints) && pc.anchorPoints.length > 0) return true;
  if (Array.isArray(pc.brushSegments) && pc.brushSegments.length > 0) return true;
  if (Array.isArray(pc.bakedSegments) && pc.bakedSegments.length > 0) return true;
  if (pc.auto && pc.auto.enabled) return true;
  const notes = Array.isArray(fragment.notes) ? fragment.notes : [];
  for (let i = 0; i < notes.length; i++) {
    if (notes[i] && notes[i].vibrato && notes[i].vibrato.enabled) return true;
  }
  if (typeof hasF0PostprocessEffect === 'function'
    && hasF0PostprocessEffect(fragment.postprocess || null)) {
    return true;
  }
  return false;
}

/** 分片该发给管线的 control 值（'manual' | 'score'）。 */
export function fragmentPitchMode(fragment, hasF0PostprocessEffect) {
  return resolvePitchMode(
    fragment ? fragment.pitchMode : PITCH_MODE_AUTO,
    fragmentHasPitchContent(fragment, hasF0PostprocessEffect),
  );
}

/** 分片卡片徽标的种类（渲染层再映射成文案）。'mixed' = 自动层 + 手绘内容并存。 */
export const PITCH_BADGE_MIXED = 'mixed';

/**
 * 分片卡片上音高徽标该显示什么 —— 纯判定，不含文案。
 *
 * 关键：**显式 score 优先于曲线内容**。分片里可能留着从 VPR/VSQX 导入的
 * anchorPoints，但用户一旦把模式切成 score，这些曲线就不参与推理了；
 * 此前徽标只看 `auto.enabled` 和手绘点数，于是永远显示"手动"，和实际
 * 下发管线（resolvePitchMode 走 score）相反，用户以为切换没生效。
 *
 * @param {object} fragment 分片
 * @returns {'score'|'manual'|'auto'|'mixed'|null} null = 不画徽标
 */
export function pitchCurveBadgeKind(fragment) {
  if (!fragment) return null;
  const mode = normalizePitchMode(fragment.pitchMode);
  if (mode === PITCH_MODE_SCORE) return PITCH_MODE_SCORE;

  const pc = fragment.pitchCurve;
  if (!pc) return mode === PITCH_MODE_MANUAL ? PITCH_MODE_MANUAL : null;

  const autoOn = !!(pc.auto && pc.auto.enabled);
  const manualCount = (Array.isArray(pc.anchorPoints) ? pc.anchorPoints.length : 0)
    + (Array.isArray(pc.brushSegments) ? pc.brushSegments.length : 0)
    + (Array.isArray(pc.bakedSegments) ? pc.bakedSegments.length : 0);
  if (!autoOn && manualCount === 0) {
    // 显式 manual + 空曲线 = 平直 F0（旧"平直"行为），与 score 的听感不同，
    // 必须画出来，否则用户看不出这两种"都没有点"的状态有何区别。
    return mode === PITCH_MODE_MANUAL ? PITCH_MODE_MANUAL : null;
  }
  if (autoOn) return manualCount > 0 ? PITCH_BADGE_MIXED : PITCH_MODE_AUTO;
  return PITCH_MODE_MANUAL;
}
