/**
 * PCM / typed-array ownership predicate for zero-copy postMessage transfers.
 *
 * A typed-array view can only be transferred by handing its whole backing
 * ArrayBuffer to `postMessage(message, [view.buffer])`. That is safe only when
 * the view owns the entire buffer:
 *
 *   - `byteOffset === 0`
 *   - `byteLength === buffer.byteLength`
 *   - the buffer is a real ArrayBuffer (not a SharedArrayBuffer)
 *
 * Views returned by `subarray()` over a larger buffer fail this check and are
 * structured-cloned instead. Views returned by `slice()` always pass.
 *
 * The predicate is shared by every producer / consumer so the "owns whole
 * buffer" rule cannot drift between the worker bridge and its tests.
 *
 * @param {ArrayBufferView|null|undefined} view
 * @returns {boolean}
 */
function ownsWholeBuffer(view) {
  return !!view
    && ArrayBuffer.isView(view)
    && view.buffer instanceof ArrayBuffer
    && view.byteOffset === 0
    && view.byteLength === view.buffer.byteLength;
}

module.exports = { ownsWholeBuffer };
