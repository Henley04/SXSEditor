/**
 * UI 播放会话号裁决（主进程侧）。
 *
 * 渲染层的独占播放是异步的：`audio:play` 要排队（同一个 manager 用 play 锁
 * 串行化）、要等 worker 回执。用户完全可能在第二条 play 还排着队时按了停止。
 * 若那条 play 之后才轮到执行，它会把声音重新放出来 —— 用户看到的就是
 * "按了停止，声音自己又响一遍"。
 *
 * 渲染层每次 play / stop 都带一个单调递增的会话号，主进程只接受"不早于
 * 已见最大值"的命令：排队的旧 play 一进队列就被丢弃，旧 stop 也不会去掐
 * 新会话刚开始的声音。
 *
 * 渲染层的对应实现在 renderer/audioPlayback.js 的 _exclusiveSessionToken
 * （分片编辑器是 fragmentEditor/audioPlayback.js 的 _fragmentSessionToken）。
 */

/**
 * @returns {{accept: (sessionId: number|undefined) => boolean, lastSessionId: () => number}}
 */
function createSessionGate() {
  let last = 0;
  return {
    /**
     * @param {number|undefined} sessionId 调用方会话号；非有限值表示"不参与裁决"
     *   （老调用方 / 共享模式下的无条件停止），一律接受。
     * @returns {boolean} false = 这条命令属于已经过期的会话，应当丢弃。
     */
    accept(sessionId) {
      if (!Number.isFinite(sessionId)) return true;
      if (sessionId < last) return false;
      if (sessionId > last) last = sessionId;
      return true;
    },
    lastSessionId() {
      return last;
    },
  };
}

module.exports = { createSessionGate };
