const { LONG_AUDIO_THRESHOLD_SEC, SEGMENT_MIN_SEC, SEGMENT_MAX_SEC, SEGMENT_OVERLAP_SEC } = require('./constants');

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
                result.push({
                    lyric: '',
                    pitch: 0,
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
        const totalBeats = sorted[sorted.length - 1].start + sorted[sorted.length - 1].duration;
        const totalSec = (totalBeats / bpm) * 60;

        if (totalSec <= LONG_AUDIO_THRESHOLD_SEC) {
            return [{ notes, startBeat: 0, endBeat: totalBeats }];
        }

        console.log(`[OnnxSVSPipeline] Long audio detected: ${totalSec.toFixed(1)}s > ${LONG_AUDIO_THRESHOLD_SEC}s, using segmented synthesis`);

        const overlapBeats = (SEGMENT_OVERLAP_SEC / 60) * bpm;
        const minBeats = (SEGMENT_MIN_SEC / 60) * bpm;
        const maxBeats = (SEGMENT_MAX_SEC / 60) * bpm;

        const restBoundaries = [0];
        for (let i = 0; i < sorted.length; i++) {
            const note = sorted[i];
            if (note.lyric && note.lyric.trim().length === 0) {
                const midBeat = note.start + note.duration / 2;
                restBoundaries.push(midBeat);
            }
            if (i > 0) {
                const prevEnd = sorted[i - 1].start + sorted[i - 1].duration;
                const gap = note.start - prevEnd;
                if (gap > 0.05) {
                    restBoundaries.push(prevEnd + gap / 2);
                }
            }
        }
        restBoundaries.push(totalBeats);
        restBoundaries.sort((a, b) => a - b);

        const segments = [];
        let segStart = 0;

        while (segStart < totalBeats - 0.01) {
            let segEnd = segStart + maxBeats;
            let reachedEnd = false;

            if (segEnd >= totalBeats - 0.01) {
                segEnd = totalBeats;
                reachedEnd = true;
            } else {
                let bestBoundary = segEnd;
                let bestDist = Infinity;
                for (const b of restBoundaries) {
                    if (b <= segStart + minBeats) continue;
                    if (b >= segStart + maxBeats + overlapBeats) break;
                    const dist = Math.abs(b - (segStart + (maxBeats + minBeats) / 2));
                    if (dist < bestDist) {
                        bestDist = dist;
                        bestBoundary = b;
                    }
                }
                segEnd = bestBoundary;
            }

            const segNotes = sorted.filter(n => {
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

            if (segNotes.length > 0) {
                segments.push({
                    notes: segNotes,
                    startBeat: segStart,
                    endBeat: segEnd,
                });
            }

            // 当末段被夹到 totalBeats 时必须立即终止循环，否则下一轮
            // segStart = totalBeats - overlapBeats 仍 < totalBeats - 0.01，
            // 会无限重复处理最后一段并把 segment 对象不断 push 进数组，
            // 最终耗尽内存（OOM）。overlap 仅用于中间段的衔接，末段无后继。
            if (reachedEnd) break;

            segStart = segEnd - overlapBeats;
            if (segStart >= totalBeats - 0.01) break;
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
