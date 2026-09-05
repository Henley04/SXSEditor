const { LONG_AUDIO_THRESHOLD_SEC, SEGMENT_MIN_SEC, SEGMENT_MAX_SEC, SEGMENT_OVERLAP_SEC } = require('./constants');

// Only rests >= 1.5 seconds are excluded from inference; 150 ms of rest
// context is kept on both sides of the split so consonant releases and the
// following attack still see an <SP>-like boundary. Shared by
// buildVocalSegments() and splitLongRestRegions().
const LONG_REST_SEC = 1.5;
const REST_CONTEXT_SEC = 0.15;

/**
 * Long audio segmentation and stitching logic
 */
class AudioSegmentation {
    /**
     * Fill gaps between notes with rest notes
     */
    fillNoteGaps(notes) {
        if (!notes || notes.length <= 1) return notes;

        const sorted = [...notes].sort((a, b) => a.start - b.start);
        const result = [sorted[0]];
        let currentTime = sorted[0].start + sorted[0].duration;

        for (let i = 1; i < sorted.length; i++) {
            const note = sorted[i];
            const gap = note.start - currentTime;
            if (gap > 0.01) {
                // Preserve the complete score timeline. Long rests must remain
                // represented here so sequence duration and following note
                // positions are not compressed. buildVocalSegments() is the
                // layer responsible for excluding long rests from inference.
                result.push({
                    lyric: '<SP>',
                    pitch: 0,
                    noteType: 1,
                    isGeneratedRest: true,
                    start: currentTime,
                    duration: gap,
                });
            }
            result.push(note);
            currentTime = Math.max(currentTime, note.start + note.duration);
        }

        return result;
    }

    /**
     * Shared rest-note predicate (rest = excluded from vocal content).
     * slur/continuation notes (noteType 3) are NOT rests even when their
     * lyric is empty.
     */
    _isRestNote(note) {
        const lyric = String(note.lyric || '').trim();
        const continuation = note.noteType === 3 || note.isSlur || note.isContinuation;
        return note.pitch <= 0 || note.noteType === 1
            || lyric === '<SP>' || lyric === '<AP>'
            || (lyric === '' && !continuation);
    }

    /**
     * Split the gap-filled score timeline into inference regions at long
     * rests, keeping absolute note starts.
     *
     * Companion of buildVocalSegments() for the streaming multi-fragment
     * path (synthesizeMultiStreaming). Two deliberate differences:
     *
     * 1. NO re-basing: region notes keep their absolute starts within the
     *    source fragment. The streaming mixer places chunk audio at
     *    (fragment.startTimeBeat + firstNoteStartBeat) and indexes the
     *    absolute-time pitchCurveF0 with offset 0 — both assume absolute
     *    starts. Rebased regions made every region mix at the fragment
     *    start, piling all voices onto each other (severe misalignment).
     *
     * 2. NO >SEGMENT_MAX_SEC overlap split: the streaming path chunks long
     *    sequences itself via its diffusion chunkPlan and mixes with plain
     *    addition (no crossfade), so overlapping segments would be
     *    double-mixed. Only the central part of a >= LONG_REST_SEC rest is
     *    removed from inference; up to REST_CONTEXT_SEC of rest context is
     *    kept on both region edges, and regions never overlap in time.
     *
     * @param {Array} notes - gap-filled notes (fillNoteGaps output)
     * @param {number} bpm
     * @returns {Array<{notes, startBeat, endBeat}>} regions; startBeat/endBeat
     *   are the absolute (fragment-relative) bounds, used for cache identity.
     */
    splitLongRestRegions(notes, bpm) {
        if (!notes || notes.length === 0) return [];
        if (!Number.isFinite(bpm) || bpm <= 0) {
            throw new RangeError('bpm must be a positive finite number');
        }
        const secondsPerBeat = 60 / bpm;
        const longRestBeats = LONG_REST_SEC / secondsPerBeat;
        const restContextBeats = REST_CONTEXT_SEC / secondsPerBeat;
        const isRest = (note) => this._isRestNote(note);

        const sorted = [...notes].sort((a, b) => a.start - b.start);
        for (const note of sorted) {
            if (!Number.isFinite(note.start) || !Number.isFinite(note.duration) || note.duration <= 0) {
                throw new RangeError('notes must have finite start and positive duration');
            }
        }

        const hasLongRest = sorted.some(note => isRest(note) && note.duration >= longRestBeats);
        if (!hasLongRest) {
            const end = sorted[sorted.length - 1].start + sorted[sorted.length - 1].duration;
            return [{ notes: sorted, startBeat: 0, endBeat: end }];
        }

        const regions = [];
        let current = [];
        let pendingHeadRest = null;
        const flush = () => {
            if (current.some(n => !isRest(n))) {
                regions.push({
                    notes: current,
                    startBeat: current[0].start,
                    endBeat: current[current.length - 1].start + current[current.length - 1].duration,
                });
            }
            current = [];
        };
        for (const note of sorted) {
            if (isRest(note) && note.duration >= longRestBeats) {
                const pad = Math.min(restContextBeats, note.duration / 3);
                if (pad > 0) current.push({ ...note, duration: pad });
                flush();
                pendingHeadRest = pad > 0
                    ? { ...note, start: note.start + note.duration - pad, duration: pad }
                    : null;
                continue;
            }
            if (pendingHeadRest) {
                current.push(pendingHeadRest);
                pendingHeadRest = null;
            }
            current.push(note);
        }
        flush();
        return regions;
    }

    /**
     * Build vocal segments for long audio
     */
    buildVocalSegments(notes, bpm) {
        if (!notes || notes.length === 0) return [{ notes, startBeat: 0, endBeat: 0 }];
        if (!Number.isFinite(bpm) || bpm <= 0) {
            throw new RangeError('bpm must be a positive finite number');
        }

        const sorted = [...notes].sort((a, b) => a.start - b.start);
        for (const note of sorted) {
            if (!Number.isFinite(note.start) || !Number.isFinite(note.duration) || note.duration <= 0) {
                throw new RangeError('notes must have finite start and positive duration');
            }
        }

        const secondsPerBeat = 60 / bpm;
        // Conservative scheduling: only gaps >= 1.5 seconds are removed from
        // model input. Keep 150 ms of rest context on both sides so consonant
        // releases and the following attack still see an <SP>-like boundary.
        const longRestBeats = LONG_REST_SEC / secondsPerBeat;
        const restContextBeats = REST_CONTEXT_SEC / secondsPerBeat;
        const isRest = (note) => this._isRestNote(note);

        const timelineEnd = sorted[sorted.length - 1].start + sorted[sorted.length - 1].duration;
        const timelineSec = timelineEnd * secondsPerBeat;
        const hasLongRest = sorted.some(note => isRest(note) && note.duration >= longRestBeats);
        // Preserve the established short-clip path exactly when there is no
        // expensive long rest to remove.
        if (!hasLongRest && timelineSec <= LONG_AUDIO_THRESHOLD_SEC) {
            return [{ notes, startBeat: 0, endBeat: timelineEnd }];
        }

        // Split the score into active inference regions. The central part of a
        // long rest is intentionally absent, so diffusion and Vocos never run
        // for it. Short rests stay in-region as model timing context.
        const regions = [];
        let current = [];
        let pendingHeadRest = null;
        let skippedLongRest = false;
        const flush = () => {
            if (current.some(n => !isRest(n))) regions.push(current);
            current = [];
        };
        for (const note of sorted) {
            if (isRest(note) && note.duration >= longRestBeats) {
                skippedLongRest = true;
                const pad = Math.min(restContextBeats, note.duration / 3);
                if (pad > 0) current.push({ ...note, duration: pad });
                flush();
                pendingHeadRest = pad > 0
                    ? { ...note, start: note.start + note.duration - pad, duration: pad }
                    : null;
                continue;
            }
            if (pendingHeadRest) {
                current.push(pendingHeadRest);
                pendingHeadRest = null;
            }
            current.push(note);
        }
        flush();

        if (regions.length === 0) return [];

        const overlapBeats = (SEGMENT_OVERLAP_SEC / 60) * bpm;
        const minBeats = (SEGMENT_MIN_SEC / 60) * bpm;
        const maxBeats = (SEGMENT_MAX_SEC / 60) * bpm;
        const segments = [];

        const segmentRegion = (regionNotes) => {
            const regionStart = regionNotes[0].start;
            const regionEnd = regionNotes[regionNotes.length - 1].start
                + regionNotes[regionNotes.length - 1].duration;
            const regionSec = (regionEnd - regionStart) * secondsPerBeat;
            if (regionSec <= LONG_AUDIO_THRESHOLD_SEC) {
                const preserveLegacySingle = regions.length === 1 && !skippedLongRest;
                segments.push({
                    notes: preserveLegacySingle
                        ? regionNotes
                        : regionNotes.map(n => ({ ...n, start: n.start - regionStart })),
                    startBeat: preserveLegacySingle ? 0 : regionStart,
                    endBeat: regionEnd,
                });
                return;
            }

            const restBoundaries = [regionStart];
            const noteEndBoundaries = [];
            for (const note of regionNotes) {
                if (isRest(note)) restBoundaries.push(note.start + note.duration / 2);
                else noteEndBoundaries.push(note.start + note.duration);
            }
            restBoundaries.push(regionEnd);
            restBoundaries.sort((a, b) => a - b);
            noteEndBoundaries.sort((a, b) => a - b);

            let segStart = regionStart;
            while (segStart < regionEnd - 0.01) {
                let segEnd = segStart + maxBeats;
                let reachedEnd = false;
                if (segEnd >= regionEnd - 0.01) {
                    segEnd = regionEnd;
                    reachedEnd = true;
                } else {
                    const target = segStart + (maxBeats + minBeats) / 2;
                    const upper = Math.min(regionEnd, segStart + maxBeats + overlapBeats);
                    const pickNearest = (candidates) => {
                        let best = null;
                        let distance = Infinity;
                        for (const boundary of candidates) {
                            if (boundary <= segStart + minBeats) continue;
                            if (boundary >= upper) break;
                            const candidateDistance = Math.abs(boundary - target);
                            if (candidateDistance < distance) {
                                best = boundary;
                                distance = candidateDistance;
                            }
                        }
                        return best;
                    };
                    segEnd = pickNearest(restBoundaries)
                        ?? pickNearest(noteEndBoundaries)
                        ?? segEnd;
                }

                const segNotes = regionNotes.filter(n => {
                    const noteEnd = n.start + n.duration;
                    return n.start < segEnd && noteEnd > segStart;
                }).map(n => {
                    const clippedStart = Math.max(n.start, segStart);
                    const clippedEnd = Math.min(n.start + n.duration, segEnd);
                    return {
                        ...n,
                        start: clippedStart - segStart,
                        duration: Math.max(0.01, clippedEnd - clippedStart),
                    };
                });
                if (segNotes.some(n => !isRest(n))) {
                    segments.push({ notes: segNotes, startBeat: segStart, endBeat: segEnd });
                }
                if (reachedEnd) break;
                const nextStart = segEnd - overlapBeats;
                if (nextStart <= segStart + 0.01) break;
                segStart = nextStart;
            }
        };

        for (const region of regions) segmentRegion(region);
        const totalSec = (sorted[sorted.length - 1].start + sorted[sorted.length - 1].duration) * secondsPerBeat;
        if (segments.length > 1 || regions.length > 1) {
            console.log(`[OnnxSVSPipeline] Scheduled ${segments.length} inference segments across ${regions.length} active regions (${totalSec.toFixed(1)}s timeline); long rests skipped`);
        }
        return segments;
    }

    /**
     * Compute hash for caching.
     * 采用 FNV-1a 32-bit 变种，对短数组（≤2000 元素）全量哈希避免下采样盲区；
     * 长数组仍按 2000 个采样点哈希以控制开销，但 FNV-1a 的雪崩效应优于原多项式哈希，
     * 显著降低微调单点改动落在步长盲区内导致缓存误命中的概率。
     */
    hashArray(arr) {
        if (!arr) return 0;
        let h = 0x811c9dc5;
        const bytes = new Uint8Array(8);
        const view = new DataView(bytes.buffer);
        const hashValue = (value) => {
            // Preserve fractional edits. The old bitwise coercion collapsed every
            // value in (-1, 1) to zero, causing stale synthesis-cache hits for F0 curves.
            view.setFloat64(0, Number.isFinite(Number(value)) ? Number(value) : 0, true);
            for (let j = 0; j < bytes.length; j++) {
                h ^= bytes[j];
                h = Math.imul(h, 0x01000193);
            }
        };

        const step = Math.max(1, Math.floor(arr.length / 2000));
        let lastHashed = -1;
        for (let i = 0; i < arr.length; i += step) {
            hashValue(arr[i]);
            lastHashed = i;
        }
        // Sampling must include the tail, where editor curves commonly receive a final keyframe.
        if (arr.length > 0 && lastHashed !== arr.length - 1) hashValue(arr[arr.length - 1]);
        hashValue(arr.length);
        return h | 0;
    }

    /**
     * Compute synthesis cache key
     */
    computeSynthCacheKey(notes, bpm, options, _interpolateEnvelope) {
        const f0Envelope = options.f0Envelope || null;
        const pitchCurveF0 = options.pitchCurveF0 || null;
        const refAudioWavBuffer = options.refAudioWavBuffer || null;
        const totalSteps = options.nSteps || 32;
        const cfgStrength = options.cfg !== undefined ? options.cfg : 3.0;
        const cfgRescale = options.cfgRescale !== undefined ? options.cfgRescale : 0.7;
        const autoShift = options.autoShift || false;
        const pitchShift = options.pitchShift || 0;
        const language = options.language || null;
        // diffStep 分块推理参数影响合成结果，必须纳入缓存键
        const diffStepChunk = options.diffStepChunk === true ? 1 : 0;
        const diffStepChunkFrames = options.diffStepChunkFrames || 0;
        const diffStepOverlapFrames = options.diffStepOverlapFrames !== undefined ? options.diffStepOverlapFrames : 0;
        // singerId 必须纳入缓存键：分片移动到不同歌手时，即使参考音频内容相同（或均为空），
        // 也必须触发重新合成，否则会命中旧缓存返回上一个歌手的音频。
        const singerId = options.singerId || null;

        let notesHash = 0;
        for (let i = 0; i < notes.length; i++) {
            const n = notes[i];
            // phonemeAdjustments 影响合成结果（durationRatios 决定 mel2token 帧分配，
            // volumePoints 决定音量包络），必须纳入缓存键，否则编辑音素边界/音量后
            // 会命中旧缓存返回过期音频。
            let s = `${n.lyric || ''}|${n.pitch}|${n.start}|${n.duration}|${n.isSlur ? 1 : 0}|${n.isContinuation ? 1 : 0}`;
            if (n.phonemeAdjustments) {
                for (const adj of n.phonemeAdjustments) {
                    s += `|dr:${adj.durationRatio}|or:${adj.offsetRatio || 0}`;
                    if (adj.volumePoints) {
                        for (const vp of adj.volumePoints) {
                            s += `:${vp.t}:${vp.v}`;
                        }
                    }
                }
            }
            for (let j = 0; j < s.length; j++) {
                notesHash = ((notesHash << 5) - notesHash + s.charCodeAt(j)) | 0;
            }
        }

        const f0EnvHash = f0Envelope ? this.hashArray(
            f0Envelope.keyframes ? f0Envelope.keyframes.flatMap(kf => [kf.time, kf.value * 1000]) : []
        ) : 0;

        const f0Hash = this.hashArray(pitchCurveF0);

        // Task 14: refHash uses FNV-1a over the full buffer via the existing
        // `hashArray` helper, replacing the old "first 4000 bytes with stride"
        // polynomial scan. `hashArray` already strides long arrays for cost
        // control but covers the full length (so two buffers sharing only the
        // first 4000 bytes produce different hashes — eliminating false cache
        // hits on long reference audio). It also folds in `arr.length`, so
        // length-differing prefixes never collide.
        // `hashArray` accepts any array-like (ArrayBuffer, Uint8Array / TypedArray,
        // Buffer, plain array); normalize the input accordingly.
        let refHash = 0;
        if (refAudioWavBuffer) {
            let buf = null;
            if (refAudioWavBuffer instanceof ArrayBuffer) {
                buf = new Uint8Array(refAudioWavBuffer);
            } else if (ArrayBuffer.isView(refAudioWavBuffer)) {
                // Covers Uint8Array / Uint8ClampedArray / Buffer / Int16Array / etc.
                buf = refAudioWavBuffer;
            } else if (Array.isArray(refAudioWavBuffer)) {
                buf = refAudioWavBuffer;
            }
            if (buf) {
                refHash = this.hashArray(buf);
            }
        }

        return `${notesHash}_${bpm}_${f0EnvHash}_${f0Hash}_${refHash}_${totalSteps}_${cfgStrength}_${cfgRescale}_${autoShift}_${pitchShift}_${language || 'base'}_${singerId || 'noid'}_dc${diffStepChunk}_${diffStepChunkFrames}_${diffStepOverlapFrames}_ss${options.smartSegmentation ? 1 : 0}`;
    }

    /**
     * 计算单个 segment 的分片级缓存键。
     *
     * 长音频多 segment 合成时，编辑某个音符只会影响包含该音符的 segment，
     * 其余 segment 的输入完全相同 → 音频也相同，可直接复用缓存避免重算
     * diffusion+vocoder。
     *
     * 键的构成：
     *   - 复用 computeSynthCacheKey 作为基础（覆盖 segment 自身 notes/bpm/f0/ref/步数等）
     *   - segStartBeat：pitchCurveF0 是绝对时间序列，segment 通过 pitchCurveOffsetSec
     *     =(segStartBeat/bpm)*60 索引它；相对 notes 相同但 segStartBeat 不同的 segment
     *     会产生不同 f0，必须区分。
     *   - segF0Shift：多 segment 路径按 segment 中位数独立计算 f0Shift（B2），是实际
     *     用于该 segment 的偏移量，直接决定输出。
     *   - ptFrameCount：prompt mel 帧数（来自参考音频或零填充），影响 diffusion
     *     conditioning，必须纳入。
     *
     * 未纳入但由缓存清空覆盖的因素：模型版本（clearSynthCache 在切换语言/模型时调用）、
     * useStaticShapes（模型级配置，切换时清缓存）。
     */
    computeSegmentCacheKey(segNotes, bpm, options, segStartBeat, segF0Shift, ptFrameCount) {
        const base = this.computeSynthCacheKey(segNotes, bpm, options);
        return `${base}_sb${segStartBeat}_fs${segF0Shift}_pt${ptFrameCount || 0}`;
    }

    /**
     * Compute median of an array
     */
    median(arr) {
        if (!arr || arr.length === 0) return 0;
        const sorted = [...arr].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }
}

module.exports = { AudioSegmentation };
