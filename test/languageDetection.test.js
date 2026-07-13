const { expect } = require('chai');
const {
    detectJapaneseNotes,
    detectEnglishNotes,
    resolveLanguage,
} = require('../src/main/languageDetection');

describe('languageDetection', () => {
    describe('detectJapaneseNotes', () => {
        it('should return false for null/undefined/non-array input', () => {
            expect(detectJapaneseNotes(null)).to.equal(false);
            expect(detectJapaneseNotes(undefined)).to.equal(false);
            expect(detectJapaneseNotes('not array')).to.equal(false);
            expect(detectJapaneseNotes({})).to.equal(false);
        });

        it('should return false for empty array or empty lyrics', () => {
            expect(detectJapaneseNotes([])).to.equal(false);
            expect(detectJapaneseNotes([{ lyric: '' }])).to.equal(false);
            expect(detectJapaneseNotes([{ lyric: undefined }])).to.equal(false);
            expect(detectJapaneseNotes([{}])).to.equal(false);
        });

        it('should detect jp_ prefix as Japanese', () => {
            expect(detectJapaneseNotes([{ lyric: 'jp_a' }])).to.equal(true);
            expect(detectJapaneseNotes([{ lyric: 'jp_t-a' }])).to.equal(true);
        });

        it('should detect jp_ anywhere in lyric as Japanese', () => {
            expect(detectJapaneseNotes([{ lyric: 'prefix_jp_a' }])).to.equal(true);
        });

        it('should detect hiragana as Japanese', () => {
            expect(detectJapaneseNotes([{ lyric: 'あ' }])).to.equal(true);
            expect(detectJapaneseNotes([{ lyric: 'さくら' }])).to.equal(true);
            expect(detectJapaneseNotes([{ lyric: 'わたし' }])).to.equal(true);
        });

        it('should detect katakana as Japanese', () => {
            expect(detectJapaneseNotes([{ lyric: 'ア' }])).to.equal(true);
            expect(detectJapaneseNotes([{ lyric: 'サクラ' }])).to.equal(true);
            expect(detectJapaneseNotes([{ lyric: 'ワタシ' }])).to.equal(true);
        });

        it('should return false for plain English lyrics', () => {
            expect(detectJapaneseNotes([{ lyric: 'hello' }])).to.equal(false);
            expect(detectJapaneseNotes([{ lyric: 'apples' }])).to.equal(false);
        });

        it('should return false for SP (silence) lyrics', () => {
            expect(detectJapaneseNotes([{ lyric: 'SP' }])).to.equal(false);
            expect(detectJapaneseNotes([{ lyric: '<SP>' }])).to.equal(false);
        });

        it('should detect Japanese in mixed note list (any note matches)', () => {
            const notes = [
                { lyric: 'hello' },
                { lyric: 'あ' },
                { lyric: 'world' },
            ];
            expect(detectJapaneseNotes(notes)).to.equal(true);
        });
    });

    describe('detectEnglishNotes', () => {
        it('should return false for null/undefined/non-array input', () => {
            expect(detectEnglishNotes(null)).to.equal(false);
            expect(detectEnglishNotes(undefined)).to.equal(false);
            expect(detectEnglishNotes('not array')).to.equal(false);
        });

        it('should return false for empty array or empty lyrics', () => {
            expect(detectEnglishNotes([])).to.equal(false);
            expect(detectEnglishNotes([{ lyric: '' }])).to.equal(false);
        });

        it('should detect Latin letters as English', () => {
            expect(detectEnglishNotes([{ lyric: 'hello' }])).to.equal(true);
            expect(detectEnglishNotes([{ lyric: 'apples' }])).to.equal(true);
            expect(detectEnglishNotes([{ lyric: 'a' }])).to.equal(true);
            expect(detectEnglishNotes([{ lyric: 'H' }])).to.equal(true);
        });

        it('should detect uppercase Latin letters as English', () => {
            expect(detectEnglishNotes([{ lyric: 'HELLO' }])).to.equal(true);
            expect(detectEnglishNotes([{ lyric: 'ABC' }])).to.equal(true);
        });

        it('should NOT detect jp_ prefix as English', () => {
            expect(detectEnglishNotes([{ lyric: 'jp_a' }])).to.equal(false);
            expect(detectEnglishNotes([{ lyric: 'jp_t-a' }])).to.equal(false);
            expect(detectEnglishNotes([{ lyric: 'prefix_jp_a' }])).to.equal(false);
        });

        it('should NOT detect hiragana/katakana as English', () => {
            expect(detectEnglishNotes([{ lyric: 'あ' }])).to.equal(false);
            expect(detectEnglishNotes([{ lyric: 'さくら' }])).to.equal(false);
            expect(detectEnglishNotes([{ lyric: 'ア' }])).to.equal(false);
            expect(detectEnglishNotes([{ lyric: 'サクラ' }])).to.equal(false);
        });

        it('should return false for SP (silence) lyrics', () => {
            expect(detectEnglishNotes([{ lyric: 'SP' }])).to.equal(false);
            expect(detectEnglishNotes([{ lyric: '<SP>' }])).to.equal(false);
        });

        it('should detect English in mixed note list (any note matches)', () => {
            const notes = [
                { lyric: 'あ' },
                { lyric: 'hello' },
                { lyric: 'jp_a' },
            ];
            expect(detectEnglishNotes(notes)).to.equal(true);
        });
    });

    describe('resolveLanguage', () => {
        // ===== en-phonemes mode (default) =====
        it('should return null for null/undefined input', () => {
            expect(resolveLanguage(null)).to.equal(null);
            expect(resolveLanguage(undefined)).to.equal(null);
        });

        it('en-phonemes: should return null for pure Japanese (uses base model)', () => {
            expect(resolveLanguage([{ lyric: 'さくら' }])).to.equal(null);
            expect(resolveLanguage([{ lyric: 'わたし' }])).to.equal(null);
        });

        it('en-phonemes: should return null for jp_ prefixed phonemes', () => {
            expect(resolveLanguage([{ lyric: 'jp_a' }])).to.equal(null);
            expect(resolveLanguage([{ lyric: 'jp_t-a' }])).to.equal(null);
        });

        it('en-phonemes: should return null for pure English', () => {
            expect(resolveLanguage([{ lyric: 'hello' }])).to.equal(null);
            expect(resolveLanguage([{ lyric: 'apples' }])).to.equal(null);
        });

        it('en-phonemes: should return null for silence/SP notes', () => {
            expect(resolveLanguage([{ lyric: '' }])).to.equal(null);
            expect(resolveLanguage([{ lyric: 'SP' }])).to.equal(null);
            expect(resolveLanguage([{ lyric: '<SP>' }])).to.equal(null);
        });

        it('en-phonemes: should return null for empty note array', () => {
            expect(resolveLanguage([])).to.equal(null);
        });

        // ===== jp-lora mode =====
        it('jp-lora: should return "ja" for pure Japanese (hiragana)', () => {
            expect(resolveLanguage([{ lyric: 'さくら' }], 'jp-lora')).to.equal('ja');
            expect(resolveLanguage([{ lyric: 'わたし' }], 'jp-lora')).to.equal('ja');
        });

        it('jp-lora: should return "ja" for pure Japanese (katakana)', () => {
            expect(resolveLanguage([{ lyric: 'サクラ' }], 'jp-lora')).to.equal('ja');
            expect(resolveLanguage([{ lyric: 'ワタシ' }], 'jp-lora')).to.equal('ja');
        });

        it('jp-lora: should return "ja" for jp_ prefixed phonemes', () => {
            expect(resolveLanguage([{ lyric: 'jp_a' }], 'jp-lora')).to.equal('ja');
            expect(resolveLanguage([{ lyric: 'jp_t-a' }], 'jp-lora')).to.equal('ja');
        });

        it('jp-lora: should return null for pure English (JP model OOD risk)', () => {
            expect(resolveLanguage([{ lyric: 'hello' }], 'jp-lora')).to.equal(null);
            expect(resolveLanguage([{ lyric: 'apples' }], 'jp-lora')).to.equal(null);
        });

        it('jp-lora: should return null for mixed Japanese + English (English takes priority)', () => {
            const notes = [
                { lyric: 'あ' },
                { lyric: 'hello' },
            ];
            expect(resolveLanguage(notes, 'jp-lora')).to.equal(null);
        });

        it('jp-lora: should return null for silence/SP notes', () => {
            expect(resolveLanguage([{ lyric: '' }], 'jp-lora')).to.equal(null);
            expect(resolveLanguage([{ lyric: 'SP' }], 'jp-lora')).to.equal(null);
            expect(resolveLanguage([{ lyric: '<SP>' }], 'jp-lora')).to.equal(null);
        });

        it('jp-lora: should return null for empty note array', () => {
            expect(resolveLanguage([], 'jp-lora')).to.equal(null);
        });

        it('jp-lora: should return "ja" for mixed Japanese notes without English', () => {
            const notes = [
                { lyric: 'jp_a' },
                { lyric: 'さくら' },
                { lyric: 'SP' },
                { lyric: '' },
            ];
            expect(resolveLanguage(notes, 'jp-lora')).to.equal('ja');
        });

        it('jp-lora: should return null for mixed English + jp_ (English detected)', () => {
            const notes = [
                { lyric: 'jp_a' },
                { lyric: 'hello' },
            ];
            expect(resolveLanguage(notes, 'jp-lora')).to.equal(null);
        });

        it('regression: apples should route to base model (not JP)', () => {
            // 历史 bug: apples 在 JP 模型下 OOD 崩溃为单个音素
            expect(resolveLanguage([{ lyric: 'apples' }], 'jp-lora')).to.equal(null);
        });

        it('regression: hahaha should route to base model (not JP)', () => {
            expect(resolveLanguage([{ lyric: 'hahaha' }], 'jp-lora')).to.equal(null);
        });

        it('regression: watashino (romaji) should route to base model', () => {
            // 罗马字是拉丁字母，应走 base 模型，不被误判为日文
            expect(resolveLanguage([{ lyric: 'watashino' }], 'jp-lora')).to.equal(null);
        });
    });

    // ===== hybrid mode =====
    describe('hybrid mode', () => {
        // Hybrid mode uses the base multilingual model with improved ARPAbet mapping
        // (L for ら行, AO for お段). It should ALWAYS return null (base model),
        // same as en-phonemes mode — never switch to JP LoRA.

        it('hybrid: should return null for pure Japanese (uses base model)', () => {
            expect(resolveLanguage([{ lyric: 'さくら' }], 'hybrid')).to.equal(null);
            expect(resolveLanguage([{ lyric: 'わたし' }], 'hybrid')).to.equal(null);
        });

        it('hybrid: should return null for pure Japanese (katakana)', () => {
            expect(resolveLanguage([{ lyric: 'サクラ' }], 'hybrid')).to.equal(null);
            expect(resolveLanguage([{ lyric: 'ワタシ' }], 'hybrid')).to.equal(null);
        });

        it('hybrid: should return null for jp_ prefixed phonemes', () => {
            expect(resolveLanguage([{ lyric: 'jp_a' }], 'hybrid')).to.equal(null);
            expect(resolveLanguage([{ lyric: 'jp_t-a' }], 'hybrid')).to.equal(null);
            expect(resolveLanguage([{ lyric: 'jp_r' }], 'hybrid')).to.equal(null);
        });

        it('hybrid: should return null for pure English', () => {
            expect(resolveLanguage([{ lyric: 'hello' }], 'hybrid')).to.equal(null);
            expect(resolveLanguage([{ lyric: 'apples' }], 'hybrid')).to.equal(null);
        });

        it('hybrid: should return null for mixed Japanese + English', () => {
            const notes = [
                { lyric: 'あ' },
                { lyric: 'hello' },
            ];
            expect(resolveLanguage(notes, 'hybrid')).to.equal(null);
        });

        it('hybrid: should return null for silence/SP notes', () => {
            expect(resolveLanguage([{ lyric: '' }], 'hybrid')).to.equal(null);
            expect(resolveLanguage([{ lyric: 'SP' }], 'hybrid')).to.equal(null);
            expect(resolveLanguage([{ lyric: '<SP>' }], 'hybrid')).to.equal(null);
        });

        it('hybrid: should return null for empty note array', () => {
            expect(resolveLanguage([], 'hybrid')).to.equal(null);
        });

        it('hybrid: should behave identically to en-phonemes (both use base model)', () => {
            const testCases = [
                [{ lyric: 'さくら' }],
                [{ lyric: 'jp_a' }],
                [{ lyric: 'hello' }],
                [{ lyric: 'あ' }, { lyric: 'hello' }],
                [{ lyric: 'SP' }],
                [],
            ];
            for (const notes of testCases) {
                expect(resolveLanguage(notes, 'hybrid')).to.equal(resolveLanguage(notes, 'en-phonemes'));
            }
        });
    });
});
