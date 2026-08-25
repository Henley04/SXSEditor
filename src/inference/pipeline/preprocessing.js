const ort = require('onnxruntime-node');
const { SAMPLE_RATE, HOP_SIZE, EMBED_DIM, COND_DIM, F0_BIN, F0_MIN, NPU_STATIC_SEQ_LEN } = require('./constants');
const { createFloatTensor, outputToFloat32, disposeTensor } = require('./utils');
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
        const lastNote = notes[notes.length - 1];
        const totalBeats = lastNote.start + lastNote.duration;
        const totalSeconds = (totalBeats / bpm) * 60;
        const totalFrames = Math.floor(totalSeconds * SAMPLE_RATE / HOP_SIZE);

        if (pitchCurveF0 && pitchCurveF0.length > 0) {
            const srcData = pitchCurveF0 instanceof Float32Array ? pitchCurveF0 : new Float32Array(pitchCurveF0);
            const f0 = new Float32Array(totalFrames);
            const copyLen = Math.min(srcData.length, totalFrames);
            f0.set(copyLen === srcData.length ? srcData : srcData.subarray(0, copyLen));
            return f0;
        }

        // Precompute beat-to-frame conversion factor
        const framesPerBeat = (60 / bpm) * (SAMPLE_RATE / HOP_SIZE);
        const f0 = new Float32Array(totalFrames); // auto-zeroed
        for (const note of notes) {
            let effectivePitch = note.pitch;
            if (f0Envelope && f0Envelope.keyframes && f0Envelope.keyframes.length > 0) {
                const noteCenterBeat = note.start + note.duration / 2;
                const semitoneShift = this.interpolateEnvelope(f0Envelope, noteCenterBeat);
                effectivePitch = note.pitch + semitoneShift;
            }
            const freq = this.midiToFreq(effectivePitch);
            const startFrame = Math.floor(note.start * framesPerBeat);
            const endFrame = Math.min(totalFrames, Math.floor((note.start + note.duration) * framesPerBeat));
            for (let i = startFrame; i < endFrame; i++) {
                f0[i] = freq;
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
            const lyric = note.lyric || '';
            const pitch = note.pitch;
            let noteType;
            // 注意: slur/continuation 检查必须优先于空歌词检查。slur 音符通常
            // 歌词为空（延续前一个音节的发音），若先判空歌词会把 slur 误分类
            // 为休止符（type 1），导致模型把连音当成静音处理。
            if (note.isSlur || note.isContinuation) {
                noteType = 3;
            } else if (lyric.trim().length === 0) {
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
                const lyric = note.lyric || '';
                const noteDurationSec = noteDurations[i];
                const noteFrames = Math.round(noteDurationSec * SAMPLE_RATE / HOP_SIZE);
                const noteStartSec = (note.start / bpm) * 60;
                const noteFreq = lyric.trim().length === 0 ? 0 : this.midiToFreq(note.pitch);
                for (let f = 0; f < noteFrames && frameOffset + f < totalFrames; f++) {
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
                const lyric = note.lyric || '';
                let effectivePitch = note.pitch;
                if (f0Envelope && f0Envelope.keyframes && f0Envelope.keyframes.length > 0) {
                    const noteCenterBeat = note.start + note.duration / 2;
                    const semitoneShift = this.interpolateEnvelope(f0Envelope, noteCenterBeat);
                    effectivePitch = note.pitch + semitoneShift;
                }
                const freq = lyric.trim().length === 0 ? 0 : this.midiToFreq(effectivePitch);
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
     * Run all encoders and produce the combined condition embedding
     */
    async runEncoder(sessions, sequences, tokenCount, totalFrames, isFP16, ptFrameCount = 0, useStaticShapes = false) {
        const phonemeIds = new BigInt64Array(tokenCount);
        const pitchIds = new BigInt64Array(tokenCount);
        const typeIds = new BigInt64Array(tokenCount);
        const f0IdsArr = new BigInt64Array(totalFrames);

        for (let i = 0; i < tokenCount; i++) {
            phonemeIds[i] = BigInt(sequences.noteTextSeq[i]);
            pitchIds[i] = BigInt(sequences.notePitchSeq[i]);
            typeIds[i] = BigInt(sequences.noteTypeSeq[i]);
        }
        for (let i = 0; i < totalFrames; i++) {
            f0IdsArr[i] = BigInt(sequences.f0Ids[i]);
        }

        const encSeqLen = useStaticShapes ? NPU_STATIC_SEQ_LEN : tokenCount;
        const encF0Len = useStaticShapes ? NPU_STATIC_SEQ_LEN : totalFrames;

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

        const [textResults, pitchResults, typeResults, f0Results] = await Promise.all([
            sessions.noteTextEncoder.run({ input_ids: textInput }),
            sessions.notePitchEncoder.run({ input_ids: pitchInput }),
            sessions.noteTypeEncoder.run({ input_ids: typeInput }),
            sessions.f0Encoder.run({ input_ids: f0Input }),
        ]);

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
        const textEmb = useStaticShapes ? outputToFloat32(textOut).subarray(0, tokenCount * EMBED_DIM) : outputToFloat32(textOut);
        const pitchEmb = useStaticShapes ? outputToFloat32(pitchOut).subarray(0, tokenCount * EMBED_DIM) : outputToFloat32(pitchOut);
        const typeEmb = useStaticShapes ? outputToFloat32(typeOut).subarray(0, tokenCount * EMBED_DIM) : outputToFloat32(typeOut);
        const f0Emb = useStaticShapes ? outputToFloat32(f0Out).subarray(0, totalFrames * EMBED_DIM) : outputToFloat32(f0Out);
        // 释放 4 个 encoder 的输入和输出张量（outputToFloat32 已拷贝数据）
        disposeTensor(textInput);
        disposeTensor(pitchInput);
        disposeTensor(typeInput);
        disposeTensor(f0Input);
        disposeTensor(textOut);
        disposeTensor(pitchOut);
        disposeTensor(typeOut);
        disposeTensor(f0Out);

        const tokenEmb = new Float32Array(tokenCount * EMBED_DIM);
        for (let t = 0; t < tokenCount; t++) {
            const tBase = t * EMBED_DIM;
            for (let d = 0; d < EMBED_DIM; d++) {
                tokenEmb[tBase + d] = textEmb[tBase + d] + pitchEmb[tBase + d] + typeEmb[tBase + d];
            }
        }

        const floatType = isFP16 ? 'float16' : 'float32';
        const preflowSeqLen = useStaticShapes ? NPU_STATIC_SEQ_LEN : tokenCount;
        const preflowTokenEmb = useStaticShapes ? (() => { const p = new Float32Array(preflowSeqLen * EMBED_DIM); p.set(tokenEmb); return p; })() : tokenEmb;
        const featuresTensor = createFloatTensor(floatType, preflowTokenEmb, [1, preflowSeqLen, EMBED_DIM]);
        const preflowResults = await sessions.preflow.run({ features: featuresTensor });
        const preflowOut = pickOutput(preflowResults, ['processed_features', 'output']);
        const processedTokenEmb = useStaticShapes ? outputToFloat32(preflowOut).subarray(0, tokenCount * EMBED_DIM) : outputToFloat32(preflowOut);
        // 释放 preflow 输入和输出张量
        disposeTensor(featuresTensor);
        disposeTensor(preflowOut);

        // 长片段时在 preflow → expandedEmb 之间 yield 一次，避免连续 CPU 循环阻塞主线程
        if (totalFrames > 256) {
            await new Promise(r => setImmediate(r));
        }

        // 用 subarray.set 替代元素级循环，走 native memcpy（每帧 EMBED_DIM=512 维拷贝）
        const mel2token = sequences.mel2token;
        const expandedEmb = new Float32Array(totalFrames * EMBED_DIM);
        for (let f = 0; f < totalFrames; f++) {
            const tokenIdx = mel2token[f];
            expandedEmb.set(
                processedTokenEmb.subarray(tokenIdx * EMBED_DIM, (tokenIdx + 1) * EMBED_DIM),
                f * EMBED_DIM
            );
        }

        // expandedEmb → combinedFeatures 之间 yield
        if (totalFrames > 256) {
            await new Promise(r => setImmediate(r));
        }

        const combinedFeatures = new Float32Array(totalFrames * EMBED_DIM);
        for (let f = 0; f < totalFrames; f++) {
            const fBase = f * EMBED_DIM;
            for (let d = 0; d < EMBED_DIM; d++) {
                combinedFeatures[fBase + d] = expandedEmb[fBase + d] + f0Emb[fBase + d];
            }
        }

        const totalCondFrames = ptFrameCount > 0 ? ptFrameCount + totalFrames : totalFrames;
        const condCodeData = new Float32Array(totalCondFrames * EMBED_DIM);
        // 单次 set 完成整段拷贝（源/目的连续），替代元素级双重循环
        if (ptFrameCount === 0) {
            condCodeData.set(combinedFeatures);
        } else {
            condCodeData.set(combinedFeatures, ptFrameCount * EMBED_DIM);
        }

        const condSeqLen = useStaticShapes ? NPU_STATIC_SEQ_LEN : totalCondFrames;
        const paddedCondCode = useStaticShapes ? (() => { const p = new Float32Array(condSeqLen * EMBED_DIM); p.set(condCodeData); return p; })() : condCodeData;
        const condCodeTensor = createFloatTensor(floatType, paddedCondCode, [1, condSeqLen, EMBED_DIM]);
        const condEmbResults = await sessions.condEmb.run({ cond_code: condCodeTensor });
        const condOut = pickOutput(condEmbResults, ['cond_embedding', 'output']);
        const cond = useStaticShapes ? outputToFloat32(condOut).subarray(0, totalCondFrames * COND_DIM) : outputToFloat32(condOut);
        // 释放 condEmb 输入和输出张量
        disposeTensor(condCodeTensor);
        disposeTensor(condOut);

        return cond;
    }
}

module.exports = { Preprocessing };
