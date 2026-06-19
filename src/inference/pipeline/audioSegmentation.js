const { SAMPLE_RATE, HOP_SIZE, LONG_AUDIO_THRESHOLD_SEC, SEGMENT_MIN_SEC, SEGMENT_MAX_SEC, SEGMENT_OVERLAP_SEC } = require('./constants');

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

        const sorted = [...notes].sort((a, b) => a.start - b.start);
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

            if (segEnd >= totalBeats - 0.01) {
                segEnd = totalBeats;
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

            segStart = segEnd - overlapBeats;
            if (segStart >= totalBeats - 0.01) break;
        }

        return segments;
    }

    /**
     * Compute hash for caching
     */
    hashArray(arr) {
        if (!arr) return 0;
        let h = 0;
        const step = Math.max(1, Math.floor(arr.length / 2000));
        for (let i = 0; i < arr.length; i += step) {
            h = ((h << 5) - h + (arr[i] | 0)) | 0;
        }
        return h;
    }

    /**
     * Compute synthesis cache key
     */
    computeSynthCacheKey(notes, bpm, options, interpolateEnvelope) {
        const f0Envelope = options.f0Envelope || null;
        const pitchCurveF0 = options.pitchCurveF0 || null;
        const refAudioWavBuffer = options.refAudioWavBuffer || null;
        const totalSteps = options.nSteps || 32;
        const cfgStrength = options.cfg || 3.0;
        const cfgRescale = options.cfgRescale !== undefined ? options.cfgRescale : 0.75;
        const autoShift = options.autoShift || false;
        const pitchShift = options.pitchShift || 0;

        let notesHash = 0;
        for (let i = 0; i < notes.length; i++) {
            const n = notes[i];
            const s = `${n.lyric || ''}|${n.pitch}|${n.start}|${n.duration}|${n.isSlur ? 1 : 0}|${n.isContinuation ? 1 : 0}`;
            for (let j = 0; j < s.length; j++) {
                notesHash = ((notesHash << 5) - notesHash + s.charCodeAt(j)) | 0;
            }
        }

        const f0EnvHash = f0Envelope ? this.hashArray(
            f0Envelope.keyframes ? f0Envelope.keyframes.flatMap(kf => [kf.time, kf.value * 1000]) : []
        ) : 0;

        const f0Hash = this.hashArray(pitchCurveF0);

        let refHash = 0;
        if (refAudioWavBuffer) {
            const buf = refAudioWavBuffer instanceof ArrayBuffer ? new Uint8Array(refAudioWavBuffer) :
                        Buffer.isBuffer(refAudioWavBuffer) ? refAudioWavBuffer : null;
            if (buf) {
                refHash = buf.length;
                for (let i = 0; i < Math.min(buf.length, 4000); i += Math.max(1, Math.floor(buf.length / 2000))) {
                    refHash = ((refHash << 5) - refHash + buf[i]) | 0;
                }
            }
        }

        return `${notesHash}_${bpm}_${f0EnvHash}_${f0Hash}_${refHash}_${totalSteps}_${cfgStrength}_${cfgRescale}_${autoShift}_${pitchShift}`;
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
