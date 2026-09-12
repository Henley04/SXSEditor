/**
 * id -> note 的共享索引。
 *
 * 代码里到处是 `notes.find(n => n.id === id)`（hover 提示、音素面板、拖拽、
 * 汉字分组、多选批量操作…）。在长分段 + 高频 mousemove 下，这些线性扫描是
 * 稳定的 O(n) 热点。这里用 notesRef + notesVersion + length 作键缓存
 * 一张 Map，把单次查询降到 O(1)。
 *
 * 之所以放在独立模块：canvasRenderer / eventHandlers / kanjiGroupUtils
 * 三方都要用，而 canvasRenderer 体积很大，让 kanjiGroupUtils 直接 import
 * 它会拖慢首屏并埋下循环依赖隐患。本模块只依赖 state.js。
 */
import { getNotes, getNotesVersion } from './state.js';

let _cache = { notesRef: null, version: -1, length: -1, map: null };

function _ensure() {
  const notes = getNotes();
  const v = getNotesVersion();
  if (_cache.map && _cache.notesRef === notes
      && _cache.version === v && _cache.length === notes.length) {
    return;
  }
  const m = new Map();
  for (let i = 0; i < notes.length; i++) {
    m.set(notes[i].id, notes[i]);
  }
  _cache = { notesRef: notes, version: v, length: notes.length, map: m };
}

/**
 * 按 id 取 note（O(1)，带版本化缓存）。找不到返回 null。
 * @param {number} id
 */
export function getNoteById(id) {
  _ensure();
  return _cache.map.get(id) || null;
}

/**
 * 取当前 notes 的 id -> note Map（构建一次后复用）。
 * 供需要批量按 id 查询的调用方使用，避免重复建表。
 */
export function getNoteMap() {
  _ensure();
  return _cache.map;
}

/** 强制失效缓存（极少需要；版本化通常已足够）。 */
export function invalidateNoteLookup() {
  _cache = { notesRef: null, version: -1, length: -1, map: null };
}
