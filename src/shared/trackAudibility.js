/**
 * 轨道的可听性判定（Mute / Solo）—— 主窗口播放、导出、签名三处共用。
 *
 * 规则（与 DAW 的直觉一致，且只有这一套）：
 *   1. **静音优先**：轨道被静音就永远不出声，即使同时被独奏；
 *   2. **有独奏则只放独奏**：任意轨道进入独奏后，其余轨道全部静音；
 *   3. **伴奏一并静音**：独奏某条人声轨时伴奏轨不发声 —— 独奏的意义是"只听
 *      这一条"，让人声还压在伴奏上等于没独奏。
 *
 * 为什么抽成纯函数：播放（audioPlayback）、导出（exportDialog）、播放缓存签名
 * （audioSignature）三处必须给出**同一个**结论。三处各写一遍必然分叉，症状是
 * "导出比播放多一条轨"或"静音后签名没变、播的还是旧音频"。
 *
 * 为什么伴奏默认跟随独奏静音而不是单独判断：伴奏轨自己的 mute 仍然生效，
 * 独奏只决定"别的人声轨要不要响"；伴奏跟人声轨不同类，让它跟着静音最符合
 * 用户说"只留这一条"时的预期。
 */

/**
 * 是否有机道处于独奏状态。
 *
 * @param {Array<{solo?:boolean}>} tracks
 * @returns {boolean}
 */
export function hasAnySolo(tracks) {
  if (!Array.isArray(tracks)) return false;
  return tracks.some((t) => !!t && t.solo === true);
}

/**
 * 单条轨道是否发声。
 *
 * @param {{type?:string, mute?:boolean, solo?:boolean}} track
 * @param {boolean} anySolo 全局是否存在独奏轨（由 hasAnySolo 得到）
 * @returns {boolean}
 */
export function isTrackAudible(track, anySolo) {
  if (!track) return false;
  if (track.mute === true) return false;
  if (!anySolo) return true;
  return track.solo === true;
}

/**
 * 一次算出所有轨道的可听性，避免在循环里反复判断"是否存在独奏"。
 *
 * @param {Array} tracks
 * @returns {{anySolo: boolean, audible: (track: object) => boolean, byId: Map<string, boolean>}}
 */
export function computeAudibility(tracks) {
  const list = Array.isArray(tracks) ? tracks : [];
  const anySolo = hasAnySolo(list);
  const byId = new Map();
  for (const t of list) {
    if (t && t.id !== undefined) byId.set(t.id, isTrackAudible(t, anySolo));
  }
  return {
    anySolo,
    byId,
    audible: (track) => isTrackAudible(track, anySolo),
  };
}

/**
 * 按可听性过滤分片。
 *
 * 轨道已被删除的分片（singerId 找不到）算**不可听**：没有轨道就没有音色，
 * 播放路径本来也会在拿到 singer 之后的 `if (!singer) continue` 把它跳过。
 * 三处（播放 / 导出 / 签名）保持同一个结论，避免"签名里算了、播放里没算"
 * 这种只在特定工程下才会暴露的分歧。
 *
 * @param {Array<{singerId?:string}>} fragments
 * @param {Map<string, object>|Array<object>} singers
 * @returns {Array} 属于可听轨道的分片（保持原顺序）
 */
export function filterAudibleFragments(fragments, singers) {
  const map = singers instanceof Map ? singers : new Map((singers || []).map((s) => [s.id, s]));
  const aud = computeAudibility(Array.from(map.values()));
  return (fragments || []).filter((f) => {
    if (!f) return false;
    return aud.audible(map.get(f.singerId));
  });
}
