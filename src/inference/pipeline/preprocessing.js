// 惰性 ORT：见 ortRuntime.js。
const { lazyOrt: ort } = require('../ortRuntime.js');
const { SAMPLE_RATE, HOP_SIZE, MEL_DIM, EMBED_DIM, COND_DIM, F0_BIN, F0_MIN, NPU_STATIC_SEQ_LEN } = require('./constants');
const { createFloatTensor, outputToFloat32, disposeTensor } = require('./utils');
const { isRestNote } = require('./audioSegmentation');
const durationStats = require('./durationStats');

/**
 * Pre-processing: note encoding, pitch encoding, F0 encoding, condition embedding
 */
class Preprocessing {
    constructor(textProcessing) {
        this.textProcessing = textProcessing;
        this._buildIdx2Phone();
        // ARPAbet 元音基名（不含重音后缀 0/1/2）
        this._enVowelBases = new Set(['AA', 'AE', 'AH', 'AO', 'AW', 'AY', 'EH', 'ER', 'EY', 'IH', 'IY', 'OW', 'OY', 'UH', 'UW']);
        this._jpVowels = new Set(['a', 'i', 'u', 'e', 'o']);
        // 懒加载英文音素时长统计表（异步，不阻塞构造）
        this._durationStats = null;
        durationStats.preload().then(s => { this._durationStats = s; }).catch(() => {});
    }

    _buildIdx2Phone() {
        const phone2idx = this.textProcessing.phone2idx || {};
        const maxIdx = Object.values(phone2idx).reduce((m, v) => Math.max(m, v), 0);
        this._idx2phone = new Array(maxIdx + 1).fill(null);
        for (const [phone, idx] of Object.entries(phone2idx)) {
            this._idx2phone[idx] = phone;
        }
    }

    /**
     * 判断 phonemeId 是否对应元音。
     * 用于短音符下帧分配时元音优先（元音是发音核心）。
     */
    _isVowelByIdx(phonemeIdx) {
        const name = this._idx2phone[phonemeIdx];
        if (!name) return false;
        if (name.startsWith('en_')) {
            const base = name.slice(3).replace(/[012]$/, '');
            return this._enVowelBases.has(base);
        }
        if (name.startsWith('jp_')) {
            return this._jpVowels.has(name.slice(3));
        }
        return false;
    }

    midiToFreq(pitch) {
        return 440 * Math.pow(2, (pitch - 69) / 12);
    }

    /**
     * Rest predicate — delegates to audioSegmentation.isRestNote(), the single
     * shared definition used by AudioSegmentation (region splitting) and
     * index.js _silenceNonVocalRegions(). Keeping one implementation prevents
     * the three call sites from disagreeing.
     */
    isRestNote(note) {
        return isRestNote(note);
    }

    /**
     * Unvoiced predicate for F0 assignment. Rests carry no f0 at all;
     * <AP> aspiration is audible but has no harmonic pitch, so its f0 must
     * also be 0 (f0 bin 0 = unvoiced). Previously a pitch-0 <SP> gap note
     * fell through to midiToFreq(0) ≈ 8.18 Hz → quantized f0 bin 1, which
     * conditioned the model to voice a near-DC "sung" SP during rests.
     */
    isUnvoicedNote(note) {
        if (this.isRestNote(note)) return true;
        return String(note.lyric || '').trim() === '<AP>';
    }

    interpolateEnvelope(envelope, beatTime) {
        const kfs = envelope.keyframes;
        const len = kfs.length;
        if (len === 0) return 0;
        if (len === 1) return kfs[0].value;
        if (beatTime <= kfs[0].time) return kfs[0].value;
        if (beatTime >= kfs[len - 1].time) return kfs[len - 1].value;

        // Binary search for the segment
        let lo = 0, hi = len - 1;
        while (lo < hi - 1) {
            const mid = (lo + hi) >>> 1;
            if (kfs[mid].time <= beatTime) lo = mid;
            else hi = mid;
        }
        const t = (beatTime - kfs[lo].time) / (kfs[lo + 1].time - kfs[lo].time);
        return kfs[lo].value + t * (kfs[lo + 1].value - kfs[lo].value);
    }

    buildF0FrameSequence(notes, bpm, f0Envelope, pitchCurveF0) {
        if (notes.length === 0) return new Float32Array(0);
        // F2：总时长取 max(start+duration)，不再取 notes[notes.length-1]。
        // 渲染层新建音符是 push 到数组末尾的，数组末元素未必是最晚结束的音符；
        // 用它算 totalFrames 会让整段 F0 被截断（实测 150 帧 vs 应有 300 帧，
        // 尾部 3 秒的音高 conditioning 全部变成 unvoiced）。
        let totalBeats = 0;
        for (const n of notes) {
            const end = n.start + n.duration;
            if (end > totalBeats) totalBeats = end;
        }
        const totalSeconds = (totalBeats / bpm) * 60;
        const totalFrames = Math.floor(totalSeconds * SAMPLE_RATE / HOP_SIZE);

        // Precompute beat-to-frame conversion factor
        const framesPerBeat = (60 / bpm) * (SAMPLE_RATE / HOP_SIZE);

        if (pitchCurveF0 && pitchCurveF0.length > 0) {
            const srcData = pitchCurveF0 instanceof Float32Array ? pitchCurveF0 : new Float32Array(pitchCurveF0);
            const f0 = new Float32Array(totalFrames);
            const copyLen = Math.min(srcData.length, totalFrames);
            f0.set(copyLen === srcData.length ? srcData : srcData.subarray(0, copyLen));
            // Force rest / aspiration gaps to unvoiced even when the extracted
            // curve carries interpolated f0 across a gap (used for autoShift
            // median statistics — stray voiced values in rests skew it).
            for (const note of notes) {
                if (!this.isUnvoicedNote(note) && note.pitch > 0) continue;
                const startFrame = Math.floor(note.start * framesPerBeat);
                const endFrame = Math.min(totalFrames, Math.floor((note.start + note.duration) * framesPerBeat));
                const fillStart = Math.max(0, startFrame);
                if (fillStart < endFrame) f0.fill(0, fillStart, endFrame);
            }
            return f0;
        }
        const f0 = new Float32Array(totalFrames); // auto-zeroed
        for (const note of notes) {
            // Rest / aspiration frames stay 0 (unvoiced). Previously pitch-0
            // rest notes were filled with midiToFreq(0) ≈ 8.18 Hz, which made
            // downstream quantizeF0 emit voiced bin 1 during silence.
            if (this.isUnvoicedNote(note) || !(note.pitch > 0)) continue;
            let effectivePitch = note.pitch;
            if (f0Envelope && f0Envelope.keyframes && f0Envelope.keyframes.length > 0) {
                const noteCenterBeat = note.start + note.duration / 2;
                const semitoneShift = this.interpolateEnvelope(f0Envelope, noteCenterBeat);
                effectivePitch = note.pitch + semitoneShift;
            }
            const freq = this.midiToFreq(effectivePitch);
            const startFrame = Math.floor(note.start * framesPerBeat);
            const endFrame = Math.min(totalFrames, Math.floor((note.start + note.duration) * framesPerBeat));
            // TypedArray.fill 走原生填充；钳制起点兼容音符起点为负/越界的情况
            // （旧标量循环对越界区间自然不迭代，fill 越界会抛 RangeError）。
            const fillStart = Math.max(0, startFrame);
            if (fillStart < endFrame) {
                f0.fill(freq, fillStart, endFrame);
            }
        }
        return f0;
    }

    quantizeF0(f0Frames, f0Shift = 0) {
        const seq = new Int32Array(f0Frames.length);
        for (let i = 0; i < f0Frames.length; i++) {
            const f = f0Frames[i];
            if (f <= 0) {
                seq[i] = 0;
            } else {
                const f0Cents = 1200 * Math.log2(Math.max(f, F0_MIN) / F0_MIN);
                let bin = Math.round(f0Cents / 20) + 1;
                if (f0Shift !== 0 && bin > 0) {
                    bin = Math.max(1, Math.min(F0_BIN - 1, bin + f0Shift * 5));
                }
                seq[i] = Math.max(1, Math.min(F0_BIN - 1, bin));
            }
        }
        return seq;
    }

    notesToSequences(notes, bpm, f0Envelope, pitchCurveF0, f0Shift = 0, pitchCurveOffsetSec = 0) {
        const PAD_ID = this.textProcessing.phone2idx['<PAD>'] || 0;
        const BOW_ID = this.textProcessing.phone2idx['<BOW>'] || 4;
        const EOW_ID = this.textProcessing.phone2idx['<EOW>'] || 5;
        const SEP_ID = this.textProcessing.phone2idx['<SEP>'] || 9;

        const noteDurations = [];
        for (let i = 0; i < notes.length; i++) {
            noteDurations.push((notes[i].duration / bpm) * 60);
        }

        const totalDuration = noteDurations.reduce((a, b) => a + b, 0);
        const totalFrames = Math.floor(totalDuration * SAMPLE_RATE / HOP_SIZE);

        if (totalFrames === 0) {
            return {
                f0Ids: new Int32Array(0),
                f0Hz: new Float32Array(0),
                noteTextSeq: new Int32Array([PAD_ID]),
                notePitchSeq: new Int32Array([0]),
                noteTypeSeq: new Int32Array([1]),
                mel2token: new Int32Array(0),
                tokenCount: 1,
            };
        }

        const phLocations = [];
        const newPhonemes = [PAD_ID];
        const note2origin = [];
        const notePitches = [0];
        const noteTypes = [1];

        let durSum = 0;

        for (let phIdx = 0; phIdx < notes.length; phIdx++) {
            const note = notes[phIdx];
            const rawLyric = note.lyric || '';
            // '-' 是"连音"标记，不是音素。
            // 编辑器输入 '-' 会存成 lyric='' + isContinuation（见 fragmentEditor/
            // eventHandlers.applyLyricEditorValue），但上游 midi_parser 的历史行为是
            // "第一个音符就是 '-'，或前一个音符没有歌词时，把字面 '-' 原样当歌词存下来"。
            // 这条路径上的 '-' 以前会直接送进词表 → `Unknown phoneme: "-"` → <UNK>，
            // 模型于是在这个音节上唱一个未知音素。这里统一归一成空歌词（后续解析为
            // <SP>），音符类型仍然靠下面的 slur 判定变成 3（不重新起音）。
            const isSlurMarker = rawLyric.trim() === '-';
            const lyric = isSlurMarker ? '' : rawLyric;
            const pitch = note.pitch;
            let noteType;
            // 注意: slur/continuation 检查必须优先于空歌词检查。slur 音符通常
            // 歌词为空（延续前一个音节的发音），若先判空歌词会把 slur 误分类
            // 为休止符（type 1），导致模型把连音当成静音处理。
            //
            // 判定条件必须与 audioSegmentation.isRestNote() 对齐（那边是
            // `noteType === 3 || isSlur || isContinuation`）：此前这里漏了
            // noteType===3，MIDI 导入的连音音符（只带 noteType，没有 isSlur 标志）
            // 会被当成普通音符**重新起音**唱一遍；歌词是 '-' 时还会变成 <UNK>。
            if (note.isSlur || note.isContinuation || note.noteType === 3 || isSlurMarker) {
                noteType = 3;
            } else if (this.isRestNote(note)) {
                // 休止：空歌词、显式 <SP>、pitch<=0 或 noteType=1
                // （fillNoteGaps 为音符间空隙合成的 <SP> 休止以前因歌词非空
                // 被误判成 type 2 唱音，模型便在休止段“唱”出错误音素）。
                noteType = 1;
            } else {
                noteType = 2;
            }

            let dur = Math.round(durSum * SAMPLE_RATE / HOP_SIZE);
            dur = Math.min(dur, totalFrames - 1);

            newPhonemes.push(BOW_ID);
            note2origin.push(phIdx);
            notePitches.push(pitch);
            noteTypes.push(noteType);

            const adj = note.phonemeAdjustments;
            const hasAdj = Array.isArray(adj) && adj.length > 0;
            const durationRatios = hasAdj ? adj.map(a => a.durationRatio) : null;

            if (lyric.startsWith('en_') && lyric.includes('-')) {
                const subParts = lyric.slice(3).split('-');
                const enPhIds = [];
                for (let s = 0; s < subParts.length; s++) {
                    enPhIds.push(this.textProcessing._lookupPhonemeId('en_' + subParts[s].trim()));
                }
                enPhIds.push(SEP_ID);
                phLocations.push([dur, Math.max(1, enPhIds.length), durationRatios, enPhIds]);
                for (let e = 0; e < enPhIds.length; e++) {
                    newPhonemes.push(enPhIds[e]);
                    note2origin.push(phIdx);
                    notePitches.push(pitch);
                    noteTypes.push(noteType);
                }
            } else if (this.textProcessing._isJapanese && this.textProcessing._isJapanese(lyric)) {
                // In en-phonemes / hybrid mode, convert Japanese kana/kanji to English ARPAbet phonemes.
                // The base multilingual model (not JP LoRA) is used, so English phonemes + SEP
                // are the correct input format — consistent with how English lyrics are processed.
                // hybrid mode uses an improved mapping table (L for ら行, AO for お段) but the
                // token format (en_ prefix + SEP) is identical to en-phonemes.
                if (this.textProcessing.japaneseVocalization === 'en-phonemes' || this.textProcessing.japaneseVocalization === 'hybrid') {
                    const enPhonemeObjs = this.textProcessing._japaneseToEnglishPhonemes(lyric);
                    const enPhIds = [];
                    // Collect mora-based weights from the phoneme objects (set by
                    // _attachJapaneseWeights). These are passed to _allocateByStats
                    // via phLocations[4] so inference uses mora timing instead of
                    // English stress-based stats for Japanese notes.
                    const jpWeights = [];
                    for (const obj of enPhonemeObjs) {
                        enPhIds.push(this.textProcessing._lookupPhonemeId(obj.name));
                        jpWeights.push(typeof obj.weight === 'number' ? obj.weight : 0.5);
                    }
                    // Add SEP_ID — English phoneme sequences use SEP as syllable boundary marker
                    enPhIds.push(SEP_ID);
                    jpWeights.push(0.1); // SEP gets minimal weight (boundary marker)
                    phLocations.push([dur, Math.max(1, enPhIds.length), durationRatios, enPhIds, jpWeights]);
                    for (let e = 0; e < enPhIds.length; e++) {
                        newPhonemes.push(enPhIds[e]);
                        note2origin.push(phIdx);
                        notePitches.push(pitch);
                        noteTypes.push(noteType);
                    }
                } else {
                    // jp-lora mode: use jp_ phonemes (no SEP, consistent with JP training data)
                    const phonemeStr = this.textProcessing._japaneseG2p(lyric);
                    if (phonemeStr) {
                        const phParts = phonemeStr.split(' ').filter(s => s);
                        const jpPhIds = [];
                        // jp-lora mode: derive weights from JP_MORA_WEIGHTS for jp_ phonemes
                        const jpWeights = [];
                        const { JP_MORA_WEIGHTS, JP_MORA_DEFAULT_WEIGHT } = require('./textProcessing');
                        for (let s = 0; s < phParts.length; s++) {
                            const part = phParts[s].trim();
                            jpPhIds.push(this.textProcessing._lookupPhonemeId('jp_' + part));
                            const w = JP_MORA_WEIGHTS[part] !== undefined ? JP_MORA_WEIGHTS[part] : JP_MORA_DEFAULT_WEIGHT;
                            jpWeights.push(w);
                        }
                        // Don't add SEP_ID for Japanese — training doesn't use it
                        phLocations.push([dur, Math.max(1, jpPhIds.length), durationRatios, jpPhIds, jpWeights]);
                        for (let e = 0; e < jpPhIds.length; e++) {
                            newPhonemes.push(jpPhIds[e]);
                            note2origin.push(phIdx);
                            notePitches.push(pitch);
                            noteTypes.push(noteType);
                        }
                    } else {
                        const phId = this.textProcessing._lookupPhonemeId(lyric);
                        phLocations.push([dur, 1, durationRatios, [phId]]);
                        newPhonemes.push(phId);
                        note2origin.push(phIdx);
                        notePitches.push(pitch);
                        noteTypes.push(noteType);
                    }
                }
            } else if (/^[a-zA-Z]+$/.test(lyric) && !lyric.startsWith('en_') && !lyric.startsWith('zh_') && !lyric.startsWith('yue_') && !lyric.startsWith('jp_')) {
                const g2pResult = this.textProcessing._englishG2p(lyric);
                if (g2pResult) {
                    const phParts = g2pResult.split(' ');
                    const enPhIds = [];
                    for (let s = 0; s < phParts.length; s++) {
                        enPhIds.push(this.textProcessing._lookupPhonemeId('en_' + phParts[s].trim()));
                    }
                    enPhIds.push(SEP_ID);
                    phLocations.push([dur, Math.max(1, enPhIds.length), durationRatios, enPhIds]);
                    for (let e = 0; e < enPhIds.length; e++) {
                        newPhonemes.push(enPhIds[e]);
                        note2origin.push(phIdx);
                        notePitches.push(pitch);
                        noteTypes.push(noteType);
                    }
                } else {
                    const phId = this.textProcessing._lookupPhonemeId(lyric);
                    phLocations.push([dur, 1, durationRatios, [phId]]);
                    newPhonemes.push(phId);
                    note2origin.push(phIdx);
                    notePitches.push(pitch);
                    noteTypes.push(noteType);
                }
            } else if (lyric.startsWith('jp_') && (this.textProcessing.japaneseVocalization === 'en-phonemes' || this.textProcessing.japaneseVocalization === 'hybrid')) {
                // In en-phonemes / hybrid mode, convert jp_ prefixed phonemes to English ARPAbet phonemes.
                // e.g., 'jp_k' → en_K, 'jp_ts' → en_T en_S, 'jp_ky' → en_K en_Y
                // hybrid mode: 'jp_r' → en_L (not R), 'jp_o' → en_AO1 (not OW1)
                const jpPhone = lyric.slice(3);
                const enPhonemeObjs = this.textProcessing._japanesePhoneToEnglishPhonemes(jpPhone);
                const enPhIds = [];
                const jpWeights = [];
                for (const obj of enPhonemeObjs) {
                    enPhIds.push(this.textProcessing._lookupPhonemeId(obj.name));
                    jpWeights.push(typeof obj.weight === 'number' ? obj.weight : 0.5);
                }
                enPhIds.push(SEP_ID);
                jpWeights.push(0.1); // SEP gets minimal weight
                phLocations.push([dur, Math.max(1, enPhIds.length), durationRatios, enPhIds, jpWeights]);
                for (let e = 0; e < enPhIds.length; e++) {
                    newPhonemes.push(enPhIds[e]);
                    note2origin.push(phIdx);
                    notePitches.push(pitch);
                    noteTypes.push(noteType);
                }
            } else {
                const phId = this.textProcessing._lookupPhonemeId(lyric);
                phLocations.push([dur, 1, durationRatios, [phId]]);
                newPhonemes.push(phId);
                note2origin.push(phIdx);
                notePitches.push(pitch);
                noteTypes.push(noteType);
            }

            newPhonemes.push(EOW_ID);
            note2origin.push(phIdx);
            notePitches.push(pitch);
            noteTypes.push(noteType);

            durSum += noteDurations[phIdx];
        }

        const mel2token = this._buildMel2token(phLocations, newPhonemes.length, totalFrames);

        const f0Hz = new Float32Array(totalFrames);
        if (pitchCurveF0 && pitchCurveF0.length > 0) {
            const srcData = pitchCurveF0 instanceof Float32Array ? pitchCurveF0 : new Float32Array(pitchCurveF0);
            let frameOffset = 0;
            for (let i = 0; i < notes.length; i++) {
                const note = notes[i];
                const noteDurationSec = noteDurations[i];
                const noteFrames = Math.round(noteDurationSec * SAMPLE_RATE / HOP_SIZE);
                const noteStartSec = (note.start / bpm) * 60;
                // 休止/换气帧强制 f0=0（清音），即使音高曲线在空隙内带有
                // 插值出的正值，否则模型会把休止段当成浊音唱出来。
                const noteUnvoiced = this.isUnvoicedNote(note) || !(note.pitch > 0);
                const noteFreq = noteUnvoiced ? 0 : this.midiToFreq(note.pitch);
                for (let f = 0; f < noteFrames && frameOffset + f < totalFrames; f++) {
                    if (noteUnvoiced) {
                        f0Hz[frameOffset + f] = 0;
                        continue;
                    }
                    // 多 segment 路径：segmentNotes.start 是相对 segStart，需要加
                    // pitchCurveOffsetSec (= segStartBeat 对应秒数) 才能正确索引
                    // 绝对时间的 pitchCurveF0。否则 f0 严重错位 → vocoder mel/f0
                    // 不匹配 → 电流声。单 segment 路径 offset=0，行为不变。
                    const absTimeSec = noteStartSec + pitchCurveOffsetSec + f * HOP_SIZE / SAMPLE_RATE;
                    const srcFrame = Math.floor(absTimeSec * SAMPLE_RATE / HOP_SIZE);
                    if (srcFrame >= 0 && srcFrame < srcData.length && srcData[srcFrame] > 0) {
                        f0Hz[frameOffset + f] = srcData[srcFrame];
                    } else {
                        f0Hz[frameOffset + f] = noteFreq;
                    }
                }
                frameOffset += noteFrames;
            }
        } else {
            let frameOffset = 0;
            for (let i = 0; i < notes.length; i++) {
                const note = notes[i];
                let effectivePitch = note.pitch;
                if (f0Envelope && f0Envelope.keyframes && f0Envelope.keyframes.length > 0) {
                    const noteCenterBeat = note.start + note.duration / 2;
                    const semitoneShift = this.interpolateEnvelope(f0Envelope, noteCenterBeat);
                    effectivePitch = note.pitch + semitoneShift;
                }
                // 休止（<SP>/空歌词/pitch<=0）与 <AP> 换气为清音，f0=0
                const noteUnvoiced = this.isUnvoicedNote(note) || !(effectivePitch > 0);
                const freq = noteUnvoiced ? 0 : this.midiToFreq(effectivePitch);
                const noteFrames = Math.round(noteDurations[i] * SAMPLE_RATE / HOP_SIZE);
                for (let f = 0; f < noteFrames && frameOffset + f < totalFrames; f++) {
                    f0Hz[frameOffset + f] = freq;
                }
                frameOffset += noteFrames;
            }
        }

        // 对 f0Hz 应用 f0Shift（半音偏移）。
        // f0Hz 同时用于：
        //   1. quantizeF0 → f0Ids（diffusion 条件，已在 quantizeF0 内部偏移 bin）
        //   2. SiFiGAN vocoder 的 f0 输入（_currentF0Hz → effectiveF0）
        // 之前 f0Hz 未偏移导致 vocoder f0 与 diffusion mel（基于偏移后的音高）不匹配，
        // autoShift 较大时产生口齿不清。现在统一在源头偏移 f0Hz，
        // quantizeF0 的 bin 偏移改为基于已偏移的 f0Hz，避免双重偏移。
        if (f0Shift !== 0) {
            const shiftFactor = Math.pow(2, f0Shift / 12);
            for (let i = 0; i < f0Hz.length; i++) {
                if (f0Hz[i] > 0) {
                    f0Hz[i] = f0Hz[i] * shiftFactor;
                }
            }
        }

        const f0Ids = this.quantizeF0(f0Hz, 0); // f0Hz 已偏移，不再传 f0Shift

        const tokenCount = newPhonemes.length;
        const noteTextSeq = new Int32Array(tokenCount);
        const notePitchSeq = new Int32Array(tokenCount);
        const noteTypeSeq = new Int32Array(tokenCount);

        for (let t = 0; t < tokenCount; t++) {
            noteTextSeq[t] = newPhonemes[t];
            notePitchSeq[t] = notePitches[t];
            noteTypeSeq[t] = noteTypes[t];
        }

        if (f0Shift !== 0) {
            for (let t = 0; t < tokenCount; t++) {
                if (notePitchSeq[t] > 0) {
                    notePitchSeq[t] = Math.max(0, Math.min(255, notePitchSeq[t] + f0Shift));
                }
            }
        }

        return {
            f0Ids,
            f0Hz,
            noteTextSeq,
            notePitchSeq,
            noteTypeSeq,
            mel2token,
            tokenCount,
        };
    }

    _buildMel2token(phLocations, tokenCount, totalFrames) {
        const mel2token = new Int32Array(totalFrames);
        mel2token.fill(0);

        if (phLocations.length === 0) return mel2token;

        let phIdx = 1;
        for (let idx = 0; idx < phLocations.length; idx++) {
            let i = phLocations[idx][0];
            const j = phLocations[idx][1];
            const ratios = phLocations[idx][2]; // optional durationRatios array
            const nextPhonemeStart = idx < phLocations.length - 1 ? phLocations[idx + 1][0] : totalFrames;
            if (i >= totalFrames) {
                break;
            }
            if (i < totalFrames && mel2token[i] > 0) {
                while (i < totalFrames && mel2token[i] > 0) {
                    i += 1;
                }
            }
            if (i >= totalFrames) break;
            mel2token[i] = phIdx;

            const innerFrames = Math.max(0, nextPhonemeStart - i - 2);
            const phonemeIds = phLocations[idx][3] || [];
            // Optional Japanese mora weights (5th element, set by notesToSequences
            // for Japanese lyrics). When present and no user ratios, used for
            // mora-timing allocation instead of English stress-based stats.
            const jpWeights = phLocations[idx][4] || null;
            let allocation;

            if (innerFrames >= j) {
                // 帧数充足
                if (ratios && ratios.length === j) {
                    // 用户自定义音素边界：按 ratios 比例分配，保证每项 >= 1 且总和 == innerFrames
                    allocation = new Array(j);
                    for (let p = 0; p < j; p++) {
                        allocation[p] = Math.round(innerFrames * ratios[p]);
                    }
                    for (let p = 0; p < j; p++) {
                        if (allocation[p] === 0) allocation[p] = 1;
                    }
                    let used = allocation.reduce((s, v) => s + v, 0);
                    let diff = innerFrames - used;
                    if (diff > 0) {
                        const order = [...Array(j).keys()].sort((a, b) => ratios[b] - ratios[a]);
                        for (let k = 0; k < diff; k++) allocation[order[k % j]]++;
                    } else if (diff < 0) {
                        const order = [...Array(j).keys()].sort((a, b) => ratios[a] - ratios[b]);
                        let toRemove = -diff;
                        for (let k = 0; k < j && toRemove > 0; k++) {
                            const idx2 = order[k];
                            while (allocation[idx2] > 1 && toRemove > 0) {
                                allocation[idx2]--;
                                toRemove--;
                            }
                        }
                    }
                } else if (jpWeights && jpWeights.length === j) {
                    // 日语默认：按 mora 权重比例分配（用户未自定义时）
                    // 使用 JP_MORA_WEIGHTS 而非英文统计表，符合日语拍时序
                    allocation = this._allocateByWeights(jpWeights, j, innerFrames);
                } else {
                    // 默认：数据驱动统计表查表（英文）或线性插值（其他语言/表未加载）
                    allocation = this._allocateByStats(idx, phLocations, phonemeIds, j, innerFrames);
                }
            } else if (phonemeIds.length === j) {
                // 帧数不足：元音优先（无论是否有 ratios，帧数不足时 ratios 无意义）
                // 优先级：元音（发音核心）> 辅音 > SEP
                allocation = new Array(j).fill(0);
                const SEP_LOCAL_ID = this.textProcessing.phone2idx['<SEP>'] || 9;
                const vowelPositions = [];
                const consonantPositions = [];
                const sepPositions = [];
                for (let p = 0; p < j; p++) {
                    if (this._isVowelByIdx(phonemeIds[p])) {
                        vowelPositions.push(p);
                    } else if (phonemeIds[p] === SEP_LOCAL_ID) {
                        sepPositions.push(p);
                    } else {
                        consonantPositions.push(p);
                    }
                }
                let used = 0;
                for (const p of vowelPositions) {
                    if (used < innerFrames) { allocation[p] = 1; used++; }
                }
                let remaining = innerFrames - used;
                while (remaining > 0 && vowelPositions.length > 0) {
                    let gaveAny = false;
                    for (const p of vowelPositions) {
                        if (remaining <= 0) break;
                        if (allocation[p] < 2) {
                            allocation[p]++;
                            remaining--;
                            used++;
                            gaveAny = true;
                        }
                    }
                    if (!gaveAny) break;
                }
                for (const p of consonantPositions) {
                    if (used < innerFrames) { allocation[p] = 1; used++; }
                }
                for (const p of sepPositions) {
                    if (used < innerFrames) { allocation[p] = 1; used++; }
                }
                remaining = innerFrames - used;
                while (remaining > 0) {
                    let gaveAny = false;
                    for (const p of vowelPositions) {
                        if (remaining <= 0) break;
                        allocation[p]++;
                        remaining--;
                        gaveAny = true;
                    }
                    if (!gaveAny) {
                        for (let p = 0; p < j; p++) {
                            if (remaining <= 0) break;
                            allocation[p]++;
                            remaining--;
                            gaveAny = true;
                        }
                    }
                    if (!gaveAny) break;
                }
            } else {
                // 无音素信息：回退到基数+余数（兼容旧 phLocations 结构）
                const baseFrames = Math.floor(innerFrames / j);
                const extraFrames = innerFrames % j;
                allocation = new Array(j);
                for (let p = 0; p < j; p++) {
                    allocation[p] = baseFrames + (p < extraFrames ? 1 : 0);
                }
            }

            // 按位置顺序写入 mel2token
            let offset = 0;
            for (let p = 0; p < j; p++) {
                const pFrames = allocation[p];
                const pStart = i + 1 + offset;
                const pEnd = Math.min(pStart + pFrames, totalFrames);
                for (let f = pStart; f < pEnd; f++) {
                    mel2token[f] = phIdx + 1 + p;
                }
                offset += pFrames;
            }

            if (nextPhonemeStart - 1 > i && nextPhonemeStart - 1 < totalFrames) {
                mel2token[nextPhonemeStart - 1] = phIdx + j + 1;
            }
            phIdx += j + 2;
        }

        let maxVal = 0;
        for (let f = 0; f < totalFrames; f++) {
            if (mel2token[f] > maxVal) maxVal = mel2token[f];
        }
        if (maxVal > tokenCount - 1) {
            for (let f = 0; f < totalFrames; f++) {
                mel2token[f] = Math.min(mel2token[f], tokenCount - 1);
            }
        }

        return mel2token;
    }

    /**
     * 数据驱动音素帧分配（英文）。
     * 用 trigram+position+stress 统计表查每个音素的相对时长权重，
     * 归一化后按比例分配 innerFrames。统计表未加载或非英文时退回线性插值。
     *
     * 上下文：跨 note 边界取相邻 note 的首/尾音素作为 prev/next。
     *
     * @param {number} noteIdx 当前 note 在 phLocations 中的索引
     * @param {Array} phLocations phLocations 数组
     * @param {Int32Array|number[]} phonemeIds 当前 note 的音素 ID 数组
     * @param {number} j 音素个数
     * @param {number} innerFrames 可分配帧数
     * @returns {number[]} 每个音素的帧数分配，长度 == j，总和 == innerFrames
     */
    _allocateByStats(noteIdx, phLocations, phonemeIds, j, innerFrames) {
        const stats = this._durationStats;

        // 统计表未加载：退回线性插值
        if (!stats || !stats.unigram) {
            return this._linearAllocate(j, innerFrames);
        }

        // 检查是否为英文音素（至少有一个 en_ 前缀）
        let hasEnglish = false;
        const phoneNames = new Array(j);
        for (let p = 0; p < j; p++) {
            const name = this._idx2phone[phonemeIds[p]] || '';
            phoneNames[p] = name;
            if (name.startsWith('en_')) hasEnglish = true;
        }
        if (!hasEnglish) {
            return this._linearAllocate(j, innerFrames);
        }

        // 跨 note 上下文：取前一 note 的最后一个真实音素，后一 note 的第一个真实音素
        const prevNoteLastPhone = this._getBoundaryPhone(noteIdx - 1, phLocations, 'last');
        const nextNoteFirstPhone = this._getBoundaryPhone(noteIdx + 1, phLocations, 'first');

        // 词内位置：单音素 note 标 medial；多音素 note 首音素 initial，末音素 final
        const positionFor = (p) => {
            if (j <= 1) return 'medial';
            if (p === 0) return 'initial';
            if (p === j - 1) return 'final';
            return 'medial';
        };

        // 查表计算每个音素的时长权重
        const SPECIAL_TOKENS = new Set(['<SEP>', '<BOW>', '<EOW>', '<PAD>']);
        const weights = new Array(j);
        for (let p = 0; p < j; p++) {
            const name = phoneNames[p];
            if (SPECIAL_TOKENS.has(name)) {
                weights[p] = 0.1; // 特殊 token 最小权重
                continue;
            }
            const curr = durationStats.barePhone(name);
            const prev = (p > 0) ? durationStats.barePhone(phoneNames[p - 1]) : (prevNoteLastPhone || '<S>');
            const next = (p < j - 1) ? durationStats.barePhone(phoneNames[p + 1]) : (nextNoteFirstPhone || '<E>');
            weights[p] = durationStats.lookupWeight(stats, curr, prev, next, positionFor(p));
        }

        // 按权重比例分配帧（保证每个音素 >= 1 帧）
        const sum = weights.reduce((s, v) => s + v, 0);
        if (sum <= 0) {
            return this._linearAllocate(j, innerFrames);
        }

        const allocation = new Array(j);
        for (let p = 0; p < j; p++) {
            allocation[p] = Math.max(1, Math.round(innerFrames * weights[p] / sum));
        }

        // 修正总和误差
        let used = allocation.reduce((s, v) => s + v, 0);
        let diff = innerFrames - used;
        if (diff > 0) {
            // 帧不够：按权重降序补给
            const order = [...Array(j).keys()].sort((a, b) => weights[b] - weights[a]);
            for (let k = 0; k < diff; k++) allocation[order[k % j]]++;
        } else if (diff < 0) {
            // 帧过多：按权重升序削减（不低于 1）
            const order = [...Array(j).keys()].sort((a, b) => weights[a] - weights[b]);
            let toRemove = -diff;
            for (let k = 0; k < j && toRemove > 0; k++) {
                const idx2 = order[k];
                while (allocation[idx2] > 1 && toRemove > 0) {
                    allocation[idx2]--;
                    toRemove--;
                }
            }
        }

        return allocation;
    }

    /**
     * 按预计算权重分配帧（日语 mora 时序）。
     *
     * 与 _allocateByStats 不同：本方法不做统计表查表，直接使用 textProcessing
     * 在 G2P 阶段附带的 jpWeights（来自 JP_MORA_WEIGHTS 表）。这些权重已经过
     * 拍时序校准（元音=1.0，单辅音=0.35，鼻音=0.40，拗音=0.45-0.50，促音=0.20），
     * 适合日语 mora-timing 而非英文 stress-timing。
     *
     * 分配规则与 _allocateByStats 一致：
     *   1. 每个音素至少 1 帧
     *   2. 按权重比例 round 分配
     *   3. 修正总和误差使 sum(allocation) == innerFrames
     *
     * @param {number[]} weights 预计算的 mora 权重数组（长度 == j）
     * @param {number} j 音素个数
     * @param {number} innerFrames 可分配帧数（>= j，由调用方保证）
     * @returns {number[]} 每个音素的帧数分配，长度 == j，总和 == innerFrames
     */
    _allocateByWeights(weights, j, innerFrames) {
        if (!weights || weights.length !== j || j <= 0) {
            return this._linearAllocate(j, innerFrames);
        }

        const sum = weights.reduce((s, v) => s + Math.max(0, v), 0);
        if (sum <= 0) {
            return this._linearAllocate(j, innerFrames);
        }

        const allocation = new Array(j);
        for (let p = 0; p < j; p++) {
            allocation[p] = Math.max(1, Math.round(innerFrames * Math.max(0, weights[p]) / sum));
        }

        // 修正总和误差（与 _allocateByStats 相同的策略）
        let used = allocation.reduce((s, v) => s + v, 0);
        let diff = innerFrames - used;
        if (diff > 0) {
            // 帧不够：按权重降序补给
            const order = [...Array(j).keys()].sort((a, b) => weights[b] - weights[a]);
            for (let k = 0; k < diff; k++) allocation[order[k % j]]++;
        } else if (diff < 0) {
            // 帧过多：按权重升序削减（不低于 1）
            const order = [...Array(j).keys()].sort((a, b) => weights[a] - weights[b]);
            let toRemove = -diff;
            for (let k = 0; k < j && toRemove > 0; k++) {
                const idx2 = order[k];
                while (allocation[idx2] > 1 && toRemove > 0) {
                    allocation[idx2]--;
                    toRemove--;
                }
            }
        }

        return allocation;
    }

    /**
     * 获取相邻 note 的边界音素名（用于跨 note 上下文）。
     * @param {number} noteIdx 相邻 note 索引
     * @param {Array} phLocations
     * @param {'first'|'last'} which 取第一个还是最后一个真实音素
     * @returns {string|null} 裸音素名（如 'AE1'），无相邻或无真实音素返回 null
     */
    _getBoundaryPhone(noteIdx, phLocations, which) {
        if (noteIdx < 0 || noteIdx >= phLocations.length) return null;
        const ids = phLocations[noteIdx][3];
        if (!ids || ids.length === 0) return null;
        const SPECIAL = new Set(['<SEP>', '<BOW>', '<EOW>', '<PAD>']);
        if (which === 'first') {
            for (let i = 0; i < ids.length; i++) {
                const name = this._idx2phone[ids[i]] || '';
                if (!SPECIAL.has(name)) return durationStats.barePhone(name);
            }
        } else {
            for (let i = ids.length - 1; i >= 0; i--) {
                const name = this._idx2phone[ids[i]] || '';
                if (!SPECIAL.has(name)) return durationStats.barePhone(name);
            }
        }
        return null;
    }

    /**
     * 线性插值分配（与训练 data_processor.py 一致），作为统计表未加载时的回退。
     */
    _linearAllocate(j, innerFrames) {
        const allocation = new Array(j);
        for (let p = 0; p < j; p++) {
            const pStart = Math.floor(p * innerFrames / j);
            const pEnd = Math.floor((p + 1) * innerFrames / j);
            allocation[p] = pEnd - pStart;
        }
        return allocation;
    }

    /**
     * 从 .sxssinger 的 MIDI / 歌词 / F0 标注构建 prompt 段 token 序列，并把
     * 参考 mel 裁剪到与 token 序列严格对齐的时间窗。
     *
     * 背景：仓库的官方对比脚本 scripts/verify_e2e_precision.py 会把 prompt token
     * + target token 拼在一起送 encoder/preflow，prompt 段拿到的是参考片段真实
     * 的 phoneme/pitch/type/F0。app 过去只编码 target，prompt 段 cond 全 0。
     * 这里用歌手文件里已经强制保存的 singerData（歌词 + MIDI + F0）补齐。
     *
     * 时间轴：singerData / f0Data / midiNotes 都以"裁掉前导静音后的 0 点"为
     * 原点，而参考 mel 是从原始 wav 提取的；因此统一加 trimOffsetSec 回到原始
     * 时间轴，再按 50Hz 帧号对齐。
     *
     * @param {Object|null} refSingerData - singer.singerData
     * @param {Array|null} refMidiNotes - singer.midiNotes（start/duration 单位是拍）
     * @param {Array|null} refF0Data - singer.f0Data（[{time, f0}]，50Hz，相对裁剪后音频）
     * @param {Float32Array|null} ptMelData - 完整参考音频的 mel
     * @param {number} ptFrameCount - 参考 mel 帧数
     * @param {{maxPromptFrames?: number, promptFramesCap?: number, f0Shift?: number}} [opts]
     *        0/undefined = 使用完整参考音频；>0 = 从第 0 帧起截断到该帧数；
     *        f0Shift = 与 target 相同的 note_pitch 半音偏移（prompt f0 不偏移）
     * @returns {{promptSeq: Object|null, ptMelData: Float32Array|null, ptFrameCount: number}}
     */
    buildPromptSequence(refSingerData, refMidiNotes, refF0Data, ptMelData, ptFrameCount, opts = {}) {
        const unchanged = { promptSeq: null, ptMelData, ptFrameCount };
        if (!refSingerData || typeof refSingerData !== 'object') return unchanged;
        if (!ptMelData || !(ptFrameCount > 0)) return unchanged;

        const notes = this._promptNotesFromSingerData(refSingerData, refMidiNotes);
        if (!notes || notes.length === 0) return unchanged;

        const trimOffsetSec = Math.max(0,
            this._finiteOr(refSingerData.trimOffsetSec, 0)
            || (Array.isArray(refSingerData.time) ? this._finiteOr(refSingerData.time[0], 0) / 1000 : 0)
        );

        // 回到原始 wav 时间轴
        for (const n of notes) {
            n.startSec += trimOffsetSec;
            n.endSec = n.startSec + n.durSec;
        }

        const f0Source = this._buildPromptF0Source(refSingerData, refF0Data);
        const trimOffsetFrame = Math.round(trimOffsetSec * SAMPLE_RATE / HOP_SIZE);

        // 参考音频长度行为保持原样：默认使用完整 prompt（上游 infer() 也是用
        // 整段 prompt metadata；其 example prompt 约 10s）。只有显式
        // maxPromptFrames > 0 时才截断，且与旧实现一样从第 0 帧开始截。
        const capRaw = opts.promptFramesCap !== undefined ? opts.promptFramesCap : opts.maxPromptFrames;
        const capFrames = Number.isFinite(capRaw) && capRaw > 0 ? Math.floor(capRaw) : 0;
        const promptFrames = Math.min(
            capFrames > 0 ? capFrames : ptFrameCount,
            ptFrameCount,
            Math.floor(ptMelData.length / MEL_DIM)
        );
        if (promptFrames <= 0) return unchanged;

        const promptStartSec = 0;
        const promptEndSec = promptFrames * HOP_SIZE / SAMPLE_RATE;

        // notesToSequences 按 duration 累加打包，不读 start；必须把 [0, promptEndSec]
        // 之间的空隙（含前导静音/尾静音）补成 <SP> rest，保证 token 时间轴与
        // prompt mel 严格对齐。
        const clipped = [];
        let cursor = promptStartSec;
        const sorted = notes
            .filter(n => n.endSec > promptStartSec && n.startSec < promptEndSec)
            .sort((a, b) => a.startSec - b.startSec);
        for (const n of sorted) {
            const s = Math.max(n.startSec, promptStartSec, cursor);
            const e = Math.min(n.endSec, promptEndSec);
            if (e <= s) continue;
            if (s - cursor > 0.02) {
                clipped.push({ lyric: '', pitch: 0, start: cursor - promptStartSec, duration: s - cursor, noteType: 1 });
            }
            clipped.push({
                lyric: n.lyric,
                pitch: n.pitch,
                start: s - promptStartSec,
                duration: e - s,
                noteType: n.noteType,
                isSlur: n.isSlur,
                isContinuation: n.isContinuation,
            });
            cursor = e;
        }
        if (promptEndSec - cursor > 0.02) {
            clipped.push({ lyric: '', pitch: 0, start: cursor - promptStartSec, duration: promptEndSec - cursor, noteType: 1 });
        }
        if (clipped.length === 0) return unchanged;
        // 没有任何歌词（只有 <SP>/空 lyric）时，prompt token 会全部是休止，
        // 与参考 mel 里的真实歌声矛盾；这种情况下退回旧的 cond=0 更安全。
        const hasAnyLyric = clipped.some(n => {
            const l = String(n.lyric || '').trim();
            return l && l !== '<SP>';
        });
        if (!hasAnyLyric) return unchanged;

        // bpm=60 → notesToSequences 的 beat 单位就是秒，mel2token 帧数 = 窗口时长 * 50
        // 注意：这里用 f0Shift=0 生成基础序列，随后只偏移 note_pitch。上游
        // infer() 对拼接后的 note_pitch 做 += f0_shift，但 prompt 的 f0_course
        // 仍由未偏移的 pt_f0 量化；两者不能一起偏移。
        const seq = this.notesToSequences(clipped, 60, null, null, 0, 0);
        const f0Shift = Number.isFinite(opts.f0Shift) ? Math.round(opts.f0Shift) : 0;
        const promptNotePitchSeq = new Int32Array(seq.notePitchSeq.length);
        for (let i = 0; i < seq.notePitchSeq.length; i++) {
            const p = seq.notePitchSeq[i];
            promptNotePitchSeq[i] = p > 0 ? Math.max(0, Math.min(255, p + f0Shift)) : p;
        }
        // notesToSequences 对总时长做 floor，可能比 promptFrames 少 1 帧；以
        // promptFrames 为准补齐/裁剪，保证与参考 mel 等长。
        const mel2token = new Int32Array(promptFrames);
        const copyLen = Math.min(promptFrames, seq.mel2token.length);
        if (copyLen > 0) {
            mel2token.set(seq.mel2token.subarray(0, copyLen));
            if (copyLen < promptFrames) mel2token.fill(mel2token[copyLen - 1], copyLen);
        }
        let tokenCount = seq.tokenCount;
        let maxToken = 0;
        for (let i = 0; i < promptFrames; i++) {
            if (mel2token[i] > maxToken) maxToken = mel2token[i];
        }
        tokenCount = Math.min(tokenCount, maxToken + 1);
        if (tokenCount <= 1) return unchanged;

        // prompt mel 从第 0 帧开始，长度与原始参考一致（或显式 maxPromptFrames）。
        const croppedMel = ptMelData.subarray(0, promptFrames * MEL_DIM);

        let f0Ids = null;
        if (f0Source && f0Source.length > 0) {
            const f0Hz = new Float32Array(promptFrames);
            const srcStart = -trimOffsetFrame;
            for (let i = 0; i < promptFrames; i++) {
                const src = srcStart + i;
                if (src >= 0 && src < f0Source.length) f0Hz[i] = f0Source[src];
            }
            const quantized = this.quantizeF0(f0Hz, 0);
            let voiced = false;
            for (let i = 0; i < quantized.length; i++) {
                if (quantized[i] > 0) { voiced = true; break; }
            }
            if (voiced) f0Ids = quantized;
        }
        // 没有可用 F0 标注时退回 note pitch，至少保证 prompt 段不是全 unvoiced。
        if (!f0Ids) {
            f0Ids = this._padInt32(seq.f0Ids.subarray(0, Math.min(promptFrames, seq.f0Ids.length)), promptFrames);
        }

        const promptSeq = {
            noteTextSeq: seq.noteTextSeq.subarray(0, tokenCount),
            notePitchSeq: promptNotePitchSeq.subarray(0, tokenCount),
            noteTypeSeq: seq.noteTypeSeq.subarray(0, tokenCount),
            f0Ids: f0Ids.length === promptFrames ? f0Ids : this._padInt32(f0Ids, promptFrames),
            mel2token,
            tokenCount,
        };
        console.log(`[PromptCond] aligned prompt: ${promptFrames}f, ${promptSeq.tokenCount}tok, cap=${capFrames || 'none'}`);
        return { promptSeq, ptMelData: croppedMel, ptFrameCount: promptFrames };
    }

    /**
     * 把 promptSeq 裁到 frames 帧（静态形状/序列长度钳制后调用）。token 数组
     * 也按最大被引用 token 收缩，避免 preflow 看到已不存在的尾部音符上下文。
     */
    slicePromptSeq(promptSeq, frames) {
        if (!promptSeq) return null;
        if (frames <= 0) return null;
        if (frames >= promptSeq.mel2token.length) return promptSeq;
        const mel2token = promptSeq.mel2token.subarray(0, frames);
        let maxToken = 0;
        for (let i = 0; i < frames; i++) {
            if (mel2token[i] > maxToken) maxToken = mel2token[i];
        }
        const tokenCount = Math.min(promptSeq.tokenCount, maxToken + 1);
        if (tokenCount <= 1) return null;
        return {
            noteTextSeq: promptSeq.noteTextSeq.subarray(0, tokenCount),
            notePitchSeq: promptSeq.notePitchSeq.subarray(0, tokenCount),
            noteTypeSeq: promptSeq.noteTypeSeq.subarray(0, tokenCount),
            f0Ids: promptSeq.f0Ids.subarray(0, frames),
            mel2token,
            tokenCount,
        };
    }

    /** 解析 .sxssinger 的标注为 {startSec, durSec, lyric, pitch, noteType, isSlur}。 */
    _promptNotesFromSingerData(sd, refMidiNotes) {
        const splitNums = (s) => (typeof s === 'string' && s.trim() ? s.trim().split(/\s+/).map(Number) : []);
        const splitToks = (s) => (typeof s === 'string' && s.trim() ? s.trim().split(/\s+/) : []);
        const sdDur = splitNums(sd.duration);
        const sdText = splitToks(sd.text);
        const sdPitch = splitNums(sd.note_pitch);
        const sdType = splitNums(sd.note_type);
        const midi = Array.isArray(refMidiNotes) ? refMidiNotes : [];
        const notes = [];

        if (midi.length > 0) {
            // midiNotes 的 start/duration 是拍；singerData.duration 是秒。
            // 两者必须一一对应，否则无法可靠换算出原始音频时间轴 —— 静默按
            // bpm=120 猜会让 prompt token 和参考 mel 错位，宁可退回 cond=0。
            if (sdDur.length !== midi.length) {
                console.warn(`[PromptCond] singerData.duration (${sdDur.length}) != midiNotes (${midi.length}); skip prompt cond to avoid misalignment`);
                return [];
            }
            const beats = midi.map(n => this._finiteOr(n && n.duration, 0));
            let totalBeats = 0, totalSec = 0;
            for (let i = 0; i < midi.length; i++) {
                totalBeats += beats[i];
                totalSec += sdDur[i];
            }
            const bpm = totalBeats > 0 && totalSec > 0 ? totalBeats * 60 / totalSec : 120;
            for (let i = 0; i < midi.length; i++) {
                const n = midi[i] || {};
                const durSec = sdDur[i];
                if (!(durSec > 0)) continue;
                notes.push({
                    startSec: this._finiteOr(n.start, 0) * 60 / bpm,
                    durSec,
                    lyric: String(n.lyric || (sdText.length === midi.length ? sdText[i] : '') || ''),
                    pitch: this._finiteOr(n.pitch, sdPitch.length === midi.length ? sdPitch[i] : 0),
                    noteType: this._finiteOr(n.noteType, sdType.length === midi.length ? sdType[i] : 0),
                    isSlur: !!(n.isSlur || n.isContinuation || n.noteType === 3),
                    isContinuation: !!n.isContinuation,
                });
            }
        } else if (sdDur.length > 0) {
            let t = 0;
            for (let i = 0; i < sdDur.length; i++) {
                const d = sdDur[i];
                if (!(d > 0)) continue;
                notes.push({
                    startSec: t,
                    durSec: d,
                    lyric: sdText.length === sdDur.length ? String(sdText[i] || '') : '',
                    pitch: sdPitch.length === sdDur.length ? this._finiteOr(sdPitch[i], 0) : 0,
                    noteType: sdType.length === sdDur.length ? this._finiteOr(sdType[i], 0) : 0,
                    isSlur: sdType.length === sdDur.length && sdType[i] === 3,
                    isContinuation: false,
                });
                t += d;
            }
        }

        notes.sort((a, b) => a.startSec - b.startSec);
        return notes;
    }

    /** 参考 F0 优先取 f0Data（精确时间），其次 singerData.f0 字符串。 */
    _buildPromptF0Source(sd, refF0Data) {
        if (Array.isArray(refF0Data) && refF0Data.length > 0) {
            const out = new Float32Array(refF0Data.length);
            for (let i = 0; i < refF0Data.length; i++) {
                out[i] = this._finiteOr(refF0Data[i] && refF0Data[i].f0, 0);
            }
            return out;
        }
        if (typeof sd.f0 === 'string' && sd.f0.trim()) {
            const parts = sd.f0.trim().split(/\s+/);
            const out = new Float32Array(parts.length);
            for (let i = 0; i < parts.length; i++) out[i] = this._finiteOr(parts[i], 0);
            return out;
        }
        return null;
    }

    _padInt32(src, len) {
        if (!src || src.length === len) return src || new Int32Array(len);
        const out = new Int32Array(len);
        out.set(src.subarray(0, Math.min(src.length, len)));
        return out;
    }

    _finiteOr(v, fallback) {
        const n = Number(v);
        return Number.isFinite(n) ? n : fallback;
    }

    /**
     * Run all encoders and produce the combined condition embedding
     */
    async runEncoder(sessions, sequences, tokenCount, totalFrames, isFP16, ptFrameCount = 0, useStaticShapes = false, scoreMode = false, promptSeq = null) {
        // 静态形状的 4 个 encoder / preflow 固定 [1, NPU_STATIC_SEQ_LEN]。prompt
        // token 与 target token 合起来放不下时，退回旧的 prompt cond 置零路径，
        // 而不是把超长张量喂给静态引擎。
        if (promptSeq && promptSeq.tokenCount > 0 && ptFrameCount > 0
            && useStaticShapes && promptSeq.tokenCount + tokenCount > NPU_STATIC_SEQ_LEN) {
            console.warn(`[Preprocessing] prompt ${promptSeq.tokenCount}tok + target ${tokenCount}tok > static ${NPU_STATIC_SEQ_LEN}; prompt cond will be zero-filled`);
            promptSeq = null;
        }
        const hasPrompt = !!(promptSeq && promptSeq.tokenCount > 0 && ptFrameCount > 0);
        const ptTokenCount = hasPrompt ? promptSeq.tokenCount : 0;
        const combinedTokenCount = ptTokenCount + tokenCount;
        const combinedFrames = ptFrameCount + totalFrames;

        const phonemeIds = new BigInt64Array(combinedTokenCount);
        const pitchIds = new BigInt64Array(combinedTokenCount);
        const typeIds = new BigInt64Array(combinedTokenCount);
        const f0IdsArr = new BigInt64Array(combinedFrames);

        if (hasPrompt) {
            for (let i = 0; i < ptTokenCount; i++) {
                phonemeIds[i] = BigInt(promptSeq.noteTextSeq[i]);
                pitchIds[i] = BigInt(promptSeq.notePitchSeq[i]);
                typeIds[i] = BigInt(promptSeq.noteTypeSeq[i]);
            }
        }
        for (let i = 0; i < tokenCount; i++) {
            const o = ptTokenCount + i;
            phonemeIds[o] = BigInt(sequences.noteTextSeq[i]);
            pitchIds[o] = BigInt(sequences.notePitchSeq[i]);
            typeIds[o] = BigInt(sequences.noteTypeSeq[i]);
        }
        if (scoreMode) {
            // score 模式：f0 条件整条置 0（bin 0 = unvoiced），与官方
            // SoulXSinger.infer(control="score") 中 gt_f0/pt_f0 被 zeros_like
            // 覆盖后的结果逐位一致。音高只由 note_pitch_encoder 提供，F0 曲线
            // 交给 diffusion 自己生成。注意序列里的 f0Hz（真实频率）不能清 ——
            // SiFiGAN vocoder 与分块边界选择都还要用它。
            f0IdsArr.fill(0n);
        } else {
            if (hasPrompt) {
                for (let i = 0; i < ptFrameCount; i++) {
                    f0IdsArr[i] = BigInt(i < promptSeq.f0Ids.length ? promptSeq.f0Ids[i] : 0);
                }
            }
            for (let i = 0; i < totalFrames; i++) {
                f0IdsArr[ptFrameCount + i] = BigInt(sequences.f0Ids[i]);
            }
        }

        const encSeqLen = useStaticShapes ? NPU_STATIC_SEQ_LEN : combinedTokenCount;
        const encF0Len = useStaticShapes ? NPU_STATIC_SEQ_LEN : combinedFrames;

        const padInt64 = (src, len) => {
            if (src.length === len) return src;
            if (src.length > len) return src.subarray(0, len);
            const padded = new BigInt64Array(len);
            padded.set(src);
            return padded;
        };

        const encText = useStaticShapes ? padInt64(phonemeIds, encSeqLen) : phonemeIds;
        const encPitch = useStaticShapes ? padInt64(pitchIds, encSeqLen) : pitchIds;
        const encType = useStaticShapes ? padInt64(typeIds, encSeqLen) : typeIds;
        const encF0 = useStaticShapes ? padInt64(f0IdsArr, encF0Len) : f0IdsArr;

        // 4 个编码器并行执行（与 WebNN 路径一致），减少串行 JS 调度开销
        const textInput = new ort.Tensor('int64', encText, [1, encSeqLen]);
        const pitchInput = new ort.Tensor('int64', encPitch, [1, encSeqLen]);
        const typeInput = new ort.Tensor('int64', encType, [1, encSeqLen]);
        const f0Input = new ort.Tensor('int64', encF0, [1, encF0Len]);

        // 使用 allSettled：任一分支 reject 时，先释放所有已产生的输入/输出张量，
        // 再抛出第一个错误，避免成功分支的 GPU 张量泄漏（Promise.all 无此机会）。
        const _encoderInputs = [textInput, pitchInput, typeInput, f0Input];
        let settled;
        try {
            settled = await Promise.allSettled([
                sessions.noteTextEncoder.run({ input_ids: textInput }),
                sessions.notePitchEncoder.run({ input_ids: pitchInput }),
                sessions.noteTypeEncoder.run({ input_ids: typeInput }),
                sessions.f0Encoder.run({ input_ids: f0Input }),
            ]);
        } finally {
            // run 已全部结束，输入张量无论成功/失败都可释放。
            for (const t of _encoderInputs) disposeTensor(t);
        }
        const _failed = settled.find(s => s.status === 'rejected');
        if (_failed) {
            for (const s of settled) {
                if (s.status !== 'fulfilled' || !s.value) continue;
                for (const k of Object.keys(s.value)) disposeTensor(s.value[k]);
            }
            throw _failed.reason;
        }
        const [textResults, pitchResults, typeResults, f0Results] = settled.map(s => s.value);

        // 输出名自适应：optimized_npu 输出 'embeddings'，plain int8 量化模型输出重命名为
        // 'output'。按候选顺序取第一个存在的 key，避免硬编码只匹配一种命名。
        const pickOutput = (res, keys) => {
            if (!res) return undefined;
            const cands = keys || ['embeddings', 'output'];
            for (const k of cands) if (res[k]) return res[k];
            const ks = Object.keys(res);
            return ks.length ? res[ks[0]] : undefined;
        };
        const textOut = pickOutput(textResults);
        const pitchOut = pickOutput(pitchResults);
        const typeOut = pickOutput(typeResults);
        const f0Out = pickOutput(f0Results);
        const textEmb = useStaticShapes ? outputToFloat32(textOut).subarray(0, combinedTokenCount * EMBED_DIM) : outputToFloat32(textOut);
        const pitchEmb = useStaticShapes ? outputToFloat32(pitchOut).subarray(0, combinedTokenCount * EMBED_DIM) : outputToFloat32(pitchOut);
        const typeEmb = useStaticShapes ? outputToFloat32(typeOut).subarray(0, combinedTokenCount * EMBED_DIM) : outputToFloat32(typeOut);
        const f0Emb = useStaticShapes ? outputToFloat32(f0Out).subarray(0, combinedFrames * EMBED_DIM) : outputToFloat32(f0Out);
        // 释放 4 个 encoder 的输出张量（输入张量已在 finally 中释放；
        // outputToFloat32 已拷贝数据）
        disposeTensor(textOut);
        disposeTensor(pitchOut);
        disposeTensor(typeOut);
        disposeTensor(f0Out);

        const tokenEmb = new Float32Array(combinedTokenCount * EMBED_DIM);
        for (let t = 0; t < combinedTokenCount; t++) {
            const tBase = t * EMBED_DIM;
            for (let d = 0; d < EMBED_DIM; d++) {
                tokenEmb[tBase + d] = textEmb[tBase + d] + pitchEmb[tBase + d] + typeEmb[tBase + d];
            }
        }

        const floatType = isFP16 ? 'float16' : 'float32';
        const preflowSeqLen = useStaticShapes ? NPU_STATIC_SEQ_LEN : combinedTokenCount;
        const preflowTokenEmb = useStaticShapes ? (() => { const p = new Float32Array(preflowSeqLen * EMBED_DIM); p.set(tokenEmb); return p; })() : tokenEmb;
        const featuresTensor = createFloatTensor(floatType, preflowTokenEmb, [1, preflowSeqLen, EMBED_DIM]);
        const preflowResults = await sessions.preflow.run({ features: featuresTensor });
        const preflowOut = pickOutput(preflowResults, ['processed_features', 'output']);
        const processedTokenEmb = useStaticShapes ? outputToFloat32(preflowOut).subarray(0, combinedTokenCount * EMBED_DIM) : outputToFloat32(preflowOut);
        // 释放 preflow 输入和输出张量
        disposeTensor(featuresTensor);
        disposeTensor(preflowOut);

        // 长片段时在 preflow → expandedEmb 之间 yield 一次，避免连续 CPU 循环阻塞主线程
        if (combinedFrames > 256) {
            await new Promise(r => setImmediate(r));
        }

        // mel2token 展开：prompt 段用 promptSeq 自己的映射，target 段整体偏移
        // ptTokenCount。没有 promptSeq 时 prompt 段保持全 0（旧行为，cond_emb
        // 后是一个常数 bias），不会被 PAD/f0-bin0 的 embedding 意外污染。
        const mel2token = sequences.mel2token;
        const combinedMel2token = new Int32Array(combinedFrames);
        if (hasPrompt) {
            for (let f = 0; f < ptFrameCount; f++) {
                const raw = f < promptSeq.mel2token.length ? (promptSeq.mel2token[f] | 0) : 0;
                combinedMel2token[f] = Math.max(0, Math.min(ptTokenCount - 1, raw));
            }
        }
        for (let f = 0; f < totalFrames; f++) {
            const raw = mel2token[f] | 0;
            combinedMel2token[ptFrameCount + f] = ptTokenCount + Math.max(0, Math.min(tokenCount - 1, raw));
        }

        const combinedFeatures = new Float32Array(combinedFrames * EMBED_DIM);
        const firstCondFrame = hasPrompt ? 0 : ptFrameCount;
        for (let f = firstCondFrame; f < combinedFrames; f++) {
            const tokenIdx = combinedMel2token[f];
            combinedFeatures.set(
                processedTokenEmb.subarray(tokenIdx * EMBED_DIM, (tokenIdx + 1) * EMBED_DIM),
                f * EMBED_DIM
            );
        }

        // 展开 → f0 相加之间 yield
        if (combinedFrames > 256) {
            await new Promise(r => setImmediate(r));
        }

        for (let i = firstCondFrame * EMBED_DIM; i < combinedFeatures.length; i++) {
            combinedFeatures[i] += f0Emb[i];
        }

        const condSeqLen = useStaticShapes ? NPU_STATIC_SEQ_LEN : combinedFrames;
        const paddedCondCode = useStaticShapes ? (() => { const p = new Float32Array(condSeqLen * EMBED_DIM); p.set(combinedFeatures); return p; })() : combinedFeatures;
        const condCodeTensor = createFloatTensor(floatType, paddedCondCode, [1, condSeqLen, EMBED_DIM]);
        const condEmbResults = await sessions.condEmb.run({ cond_code: condCodeTensor });
        const condOut = pickOutput(condEmbResults, ['cond_embedding', 'output']);
        const cond = useStaticShapes ? outputToFloat32(condOut).subarray(0, combinedFrames * COND_DIM) : outputToFloat32(condOut);
        // 释放 condEmb 输入和输出张量
        disposeTensor(condCodeTensor);
        disposeTensor(condOut);

        return cond;
    }
}

module.exports = { Preprocessing };
