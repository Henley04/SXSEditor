/**
 * Kanji group utilities for the fragment editor.
 *
 * Manages the relationship between kanji characters and their kana decompositions
 * within a fragment. When a fragment contains Japanese (kana), all kanji in that
 * fragment are automatically treated as Japanese and split into kana notes.
 * Users can manually toggle individual kanji between Chinese (single note) and
 * Japanese (kana group) via right-click.
 *
 * NOTE: JP_HIRAGANA_MAP is duplicated from src/inference/pipeline/textProcessing.js
 * because the renderer process uses ES modules and cannot require CommonJS modules.
 * Keep them in sync.
 *
 * JP_KANJI_DICT is loaded from the shared jpKanjiDict.json (generated from
 * KANJIDIC2, ~2600 entries covering all Jōyō kanji). The JSON is imported at
 * build time via webpack, so no runtime file access is needed in the renderer.
 */

import jpKanjiDictData from '../inference/pipeline/jpKanjiDict.json';
import { getNoteById } from './noteLookup.js';

// 2.2: 与主进程 textProcessing.js 共用同一份假名→音素映射（原先是复制品）。
// CJS 模块在 webpack 下可用 default import 拿到，node ESM 同样支持。
import jpPhonemeMap from '../shared/jpPhonemeMap.js';

const { JP_HIRAGANA_MAP, JP_KATAKANA_MAP } = jpPhonemeMap;

// ---- Kanji → phoneme dictionary (loaded from shared jpKanjiDict.json) ----
// ~2600 entries covering all Jōyō kanji, generated from KANJIDIC2.
// See scripts/generate_jp_kanji_dict.py for regeneration instructions.
const JP_KANJI_DICT = jpKanjiDictData;

// ---- Reverse map: phoneme string → kana character ----
const PHONEME_TO_KANA = {};
for (const [kana, ph] of Object.entries(JP_HIRAGANA_MAP)) {
    if (!PHONEME_TO_KANA[ph]) PHONEME_TO_KANA[ph] = kana;
}
for (const [kana, ph] of Object.entries(JP_KATAKANA_MAP)) {
    if (!PHONEME_TO_KANA[ph]) PHONEME_TO_KANA[ph] = kana;
}

// ---- Character classification ----

/** Check if a character is hiragana or katakana (kana). */
export function isKanaChar(char) {
    if (!char || char.length === 0) return false;
    const code = char.codePointAt(0);
    return (code >= 0x3040 && code <= 0x309F) || (code >= 0x30A0 && code <= 0x30FF);
}

/** Check if a character is a CJK ideograph (kanji/hanzi). */
export function isKanjiChar(char) {
    if (!char || char.length === 0) return false;
    const code = char.codePointAt(0);
    return (code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3400 && code <= 0x4DBF);
}

/** Check if a string contains any kana character. */
export function containsKana(text) {
    if (!text) return false;
    for (const ch of text) {
        if (isKanaChar(ch)) return true;
    }
    return false;
}

/** Check if a lyric string is a single kanji character (candidate for grouping). */
export function isSingleKanji(lyric) {
    return lyric && lyric.length === 1 && isKanjiChar(lyric);
}

// ---- Phoneme → kana conversion ----

/**
 * Convert a space-separated phoneme string (as stored in JP_KANJI_DICT) into
 * an array of kana characters using greedy longest-match.
 *
 * Example: 's o r a' → ['そ', 'ら']
 *          'a i'     → ['あ', 'い']
 *          's a n'   → ['さ', 'ん']
 */
function phonemeStrToKana(phonemeStr) {
    const tokens = phonemeStr.split(' ').filter(t => t.length > 0);
    const result = [];
    let i = 0;
    while (i < tokens.length) {
        let matched = false;
        // Try 3-token match (e.g., 'k y a' → 'きゃ')
        if (i + 2 < tokens.length) {
            const tri = tokens.slice(i, i + 3).join(' ');
            if (PHONEME_TO_KANA[tri]) {
                result.push(PHONEME_TO_KANA[tri]);
                i += 3;
                matched = true;
            }
        }
        // Try 2-token match (e.g., 'k a' → 'か', 'sh i' → 'し')
        if (!matched && i + 1 < tokens.length) {
            const bi = tokens.slice(i, i + 2).join(' ');
            if (PHONEME_TO_KANA[bi]) {
                result.push(PHONEME_TO_KANA[bi]);
                i += 2;
                matched = true;
            }
        }
        // Try 1-token match (e.g., 'a' → 'あ', 'n' → 'ん', 'cl' → 'っ')
        if (!matched) {
            const mono = tokens[i];
            if (PHONEME_TO_KANA[mono]) {
                result.push(PHONEME_TO_KANA[mono]);
            }
            i += 1;
        }
    }
    return result;
}

/**
 * Convert a kanji character to an array of kana characters.
 * Returns null if the kanji is not in the dictionary.
 */
export function kanjiToKana(kanji) {
    const phonemeStr = JP_KANJI_DICT[kanji];
    if (!phonemeStr) return null;
    const kana = phonemeStrToKana(phonemeStr);
    return kana.length > 0 ? kana : null;
}

// ---- Fragment-level detection ----

/**
 * Check if any note in the notes array has kana in its lyric.
 */
export function fragmentHasKana(notes) {
    if (!notes) return false;
    for (const note of notes) {
        if (containsKana(note.lyric)) return true;
    }
    return false;
}

// ---- Group ID generation ----

let _kanjiGroupIdCounter = 0;

export function genKanjiGroupId() {
    _kanjiGroupIdCounter++;
    return `kg_${Date.now()}_${_kanjiGroupIdCounter}`;
}

// ---- Split / merge operations ----

/**
 * Split a single kanji note into multiple kana notes and create a kanji group.
 *
 * @param {object} note - The kanji note to split (must have lyric = single kanji)
 * @param {function} genNoteId - Function to generate unique note IDs
 * @returns {{ kanaNotes: object[], group: object } | null} - New kana notes and group, or null if kanji not in dict
 */
export function splitKanjiNoteToKana(note, genNoteId) {
    const kanji = note.lyric;
    const kanaList = kanjiToKana(kanji);
    if (!kanaList || kanaList.length === 0) return null;

    const totalDuration = note.duration;
    const perKanaDuration = totalDuration / kanaList.length;
    const kanaNotes = [];
    for (let i = 0; i < kanaList.length; i++) {
        kanaNotes.push({
            id: genNoteId(),
            pitch: note.pitch,
            start: note.start + i * perKanaDuration,
            duration: perKanaDuration,
            lyric: kanaList[i],
        });
    }

    const group = {
        id: genKanjiGroupId(),
        kanji: kanji,
        noteIds: kanaNotes.map(n => n.id),
        manual: false,
    };

    return { kanaNotes, group };
}

/**
 * Merge a kanji group's kana notes back into a single kanji note.
 *
 * The new note spans from the first kana's start to the last kana's end.
 * The pitch is taken from the right-clicked note (or the first kana if not specified).
 *
 * @param {object} group - The kanji group to merge
 * @param {object[]} notes - The current notes array (to look up kana notes)
 * @param {number} rightClickedNoteId - ID of the note that was right-clicked (for pitch)
 * @param {function} genNoteId - Function to generate unique note IDs
 * @returns {{ newNote: object, kanaNoteIds: number[] } | null} - New kanji note and IDs of removed kana notes
 */
export function mergeKanaGroupToKanji(group, notes, rightClickedNoteId, genNoteId) {
    const groupNotes = group.noteIds
        // O(1) 查表：原先对每个 id 做一次线性扫描，长分段下是 O(k·n)
        .map(id => getNoteById(id))
        .filter(Boolean);

    if (groupNotes.length === 0) return null;

    // Sort by start time to find first and last
    const sorted = [...groupNotes].sort((a, b) => a.start - b.start);
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const totalStart = first.start;
    const totalEnd = last.start + last.duration;

    // Use the right-clicked note's pitch, or fall back to the first kana's pitch
    const refNote = groupNotes.find(n => n.id === rightClickedNoteId) || first;

    const newNote = {
        id: genNoteId(),
        pitch: refNote.pitch,
        start: totalStart,
        duration: totalEnd - totalStart,
        lyric: group.kanji,
        kanjiForceChinese: true,  // Mark as manually set to Chinese (don't auto-split again)
    };

    return {
        newNote,
        kanaNoteIds: group.noteIds.slice(),  // Copy the IDs
    };
}

// ---- Auto-detection ----

/**
 * Auto-detect kanji notes that should be split into kana groups.
 *
 * This runs when a fragment contains kana: all ungrouped, non-force-Chinese
 * kanji notes are split into kana groups. Existing groups and manual overrides
 * are preserved.
 *
 * @param {object[]} notes - The notes array (mutated in place)
 * @param {object[]} kanjiGroups - The kanji groups array (mutated in place)
 * @param {function} genNoteId - Function to generate unique note IDs
 * @returns {boolean} - Whether any changes were made
 */
export function autoDetectKanjiGroups(notes, kanjiGroups, genNoteId) {
    if (!fragmentHasKana(notes)) return false;

    let changed = false;

    // Build a set of note IDs already in groups
    const groupedNoteIds = new Set();
    for (const group of kanjiGroups) {
        for (const id of group.noteIds) {
            groupedNoteIds.add(id);
        }
    }

    // Scan notes for single-kanji notes that should be split
    // Iterate backwards to allow safe splicing
    for (let i = notes.length - 1; i >= 0; i--) {
        const note = notes[i];
        if (groupedNoteIds.has(note.id)) continue;
        if (note.kanjiForceChinese) continue;
        if (!isSingleKanji(note.lyric)) continue;

        const result = splitKanjiNoteToKana(note, genNoteId);
        if (!result) continue;  // Kanji not in dictionary, skip

        // Replace the kanji note with kana notes
        notes.splice(i, 1, ...result.kanaNotes);
        kanjiGroups.push(result.group);
        changed = true;
    }

    if (changed) invalidateKanjiGroupIndex();
    return changed;
}

/**
 * Clean up kanji groups: remove groups whose notes no longer exist,
 * and remove note IDs that don't exist from groups.
 *
 * @param {object[]} notes - The notes array
 * @param {object[]} kanjiGroups - The kanji groups array (mutated in place)
 */
export function cleanupKanjiGroups(notes, kanjiGroups) {
    const noteIds = new Set(notes.map(n => n.id));
    for (let i = kanjiGroups.length - 1; i >= 0; i--) {
        const group = kanjiGroups[i];
        group.noteIds = group.noteIds.filter(id => noteIds.has(id));
        if (group.noteIds.length === 0) {
            kanjiGroups.splice(i, 1);
        }
    }
    invalidateKanjiGroupIndex();
}

/**
 * Find the kanji group that a note belongs to.
 *
 * 拖拽时每次 mousemove 都会调用（eventHandlers.applyNoteDrag），原来的线性
 * 双重扫描在长分段上是 O(groups × noteIds) 的热点。这里缓存 noteId → group
 * 的 Map：数组引用或长度变化时自动重建；长度不变的就地修改（splice 掉旧组
 * 同时 push 新组、noteIds 被过滤等）由调用方显式 invalidateKanjiGroupIndex()。
 *
 * @param {number} noteId - The note ID to look up
 * @param {object[]} kanjiGroups - The kanji groups array
 * @returns {object | null} - The group, or null if the note is not in any group
 */
let _groupIndex = null;
let _groupIndexRef = null;
let _groupIndexLength = -1;

/** Drop the cached noteId → group map (call after mutating kanjiGroups). */
export function invalidateKanjiGroupIndex() {
    _groupIndex = null;
    _groupIndexRef = null;
    _groupIndexLength = -1;
}

function _getGroupIndex(kanjiGroups) {
    if (_groupIndex && _groupIndexRef === kanjiGroups && _groupIndexLength === kanjiGroups.length) {
        return _groupIndex;
    }
    const map = new Map();
    for (const group of kanjiGroups) {
        for (const id of group.noteIds) {
            map.set(id, group);
        }
    }
    _groupIndex = map;
    _groupIndexRef = kanjiGroups;
    _groupIndexLength = kanjiGroups.length;
    return map;
}

export function findGroupByNoteId(noteId, kanjiGroups) {
    if (!kanjiGroups || kanjiGroups.length === 0) return null;
    return _getGroupIndex(kanjiGroups).get(noteId) || null;
}

/**
 * Get all note IDs that belong to any kanji group.
 * Used for checking deletion constraints.
 */
export function getAllGroupedNoteIds(kanjiGroups) {
    const ids = new Set();
    for (const group of kanjiGroups) {
        for (const id of group.noteIds) {
            ids.add(id);
        }
    }
    return ids;
}

/**
 * Check if a time range falls within any kanji group's span.
 * Used to block creating new notes between grouped kana.
 *
 * @param {number} start - Start time of the new note
 * @param {number} end - End time of the new note
 * @param {object[]} notes - The notes array
 * @param {object[]} kanjiGroups - The kanji groups array
 * @returns {boolean} - True if the range falls within a group's span
 */
export function isTimeRangeWithinAnyGroup(start, end, notes, kanjiGroups) {
    for (const group of kanjiGroups) {
        const groupNotes = group.noteIds
            .map(id => getNoteById(id))
            .filter(Boolean);
        if (groupNotes.length === 0) continue;
        const sorted = [...groupNotes].sort((a, b) => a.start - b.start);
        const groupStart = sorted[0].start;
        const groupEnd = sorted[sorted.length - 1].start + sorted[sorted.length - 1].duration;
        // If the new note's time range overlaps with the group's span, block it
        if (start < groupEnd && end > groupStart) return true;
    }
    return false;
}
