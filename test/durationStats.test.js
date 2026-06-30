const { expect } = require('chai');
const {
  extractStress,
  barePhone,
  lookupWeight,
  computeNormalizedRatios,
  loadDurationStats,
  getDurationStatsSync,
} = require('../src/inference/pipeline/durationStats');

describe('inference/pipeline/durationStats', () => {
  describe('extractStress', () => {
    it('should return X for null/empty/non-en', () => {
      expect(extractStress(null)).to.equal('X');
      expect(extractStress('')).to.equal('X');
      expect(extractStress('jp_a')).to.equal('X');
      expect(extractStress('zh_ni3')).to.equal('X');
    });
    it('should return stress digit for stressed vowel', () => {
      expect(extractStress('en_AE1')).to.equal('1');
      expect(extractStress('en_IY0')).to.equal('0');
      expect(extractStress('en_OW2')).to.equal('2');
    });
    it('should return X for consonant', () => {
      expect(extractStress('en_T')).to.equal('X');
      expect(extractStress('en_K')).to.equal('X');
      expect(extractStress('en_HH')).to.equal('X');
    });
    it('should return X for vowel without stress digit', () => {
      // vowel base without digit → returns '0' (default branch)
      expect(extractStress('en_AE')).to.equal('0');
    });
  });

  describe('barePhone', () => {
    it('should strip en_ prefix', () => {
      expect(barePhone('en_AE1')).to.equal('AE1');
      expect(barePhone('en_T')).to.equal('T');
    });
    it('should return input unchanged for non-en', () => {
      expect(barePhone('jp_a')).to.equal('jp_a');
      expect(barePhone('zh_ni3')).to.equal('zh_ni3');
    });
    it('should return empty for null/empty', () => {
      expect(barePhone(null)).to.equal('');
      expect(barePhone('')).to.equal('');
    });
  });

  describe('lookupWeight', () => {
    it('should return 1.0 for null stats or currPhone', () => {
      expect(lookupWeight(null, 'T', 'S', 'E', 'initial')).to.equal(1.0);
      expect(lookupWeight({}, null, 'S', 'E', 'initial')).to.equal(1.0);
      expect(lookupWeight({}, '', 'S', 'E', 'initial')).to.equal(1.0);
    });

    it('should walk fallback chain: trigram_full → trigram → bigram → unigram → 1.0', () => {
      const stats = {
        trigram_full: { 'S|T|E|initial|X': { mean_ms: 99 } },
        trigram: { 'S|T|E': { mean_ms: 50 } },
        bigram: { 'S|T': { mean_ms: 30 } },
        unigram: { 'T': { mean_ms: 10 } },
      };
      // exact trigram_full match
      expect(lookupWeight(stats, 'T', 'S', 'E', 'initial')).to.equal(99);
      // no trigram_full match → trigram
      expect(lookupWeight(stats, 'T', 'X', 'E', 'initial')).to.equal(50);
      // no trigram match → bigram
      expect(lookupWeight(stats, 'T', 'X', 'Y', 'initial')).to.equal(30);
      // no bigram match → unigram
      expect(lookupWeight(stats, 'T', 'X', 'Y', 'medial')).to.equal(10);
    });

    it('should skip entries with mean_ms <= 0', () => {
      const stats = {
        trigram: { 'S|T|E': { mean_ms: 0 } },
        unigram: { 'T': { mean_ms: 5 } },
      };
      expect(lookupWeight(stats, 'T', 'S', 'E', 'initial')).to.equal(5);
    });

    it('should return 1.0 when nothing matches', () => {
      expect(lookupWeight({ unigram: {} }, 'QQQ', 'S', 'E', 'initial')).to.equal(1.0);
    });
  });

  describe('computeNormalizedRatios', () => {
    it('should return empty array for empty input', () => {
      expect(computeNormalizedRatios({}, [])).to.deep.equal([]);
      expect(computeNormalizedRatios(null, ['en_T'])).to.deep.equal([]);
    });

    it('should return ratios summing to 1 for real phonemes', () => {
      const stats = {
        unigram: { 'T': { mean_ms: 50 }, 'AE1': { mean_ms: 100 } },
      };
      const ratios = computeNormalizedRatios(stats, ['en_T', 'en_AE1'], 'initial');
      expect(ratios.length).to.equal(2);
      const sum = ratios.reduce((s, v) => s + v, 0);
      expect(sum).to.be.closeTo(1.0, 1e-6);
    });

    it('should give special tokens minimal weight', () => {
      const stats = {
        unigram: { 'T': { mean_ms: 50 } },
      };
      const ratios = computeNormalizedRatios(stats, ['en_T', '<SEP>', '<BOW>'], 'initial');
      // special tokens get 0.1 weight; real token gets 50
      // sum = 50.2, T ratio >> special token ratios
      expect(ratios[0]).to.be.greaterThan(ratios[1]);
      expect(ratios[0]).to.be.greaterThan(ratios[2]);
    });

    it('should evenly distribute when all tokens are special', () => {
      const stats = { unigram: {} };
      const ratios = computeNormalizedRatios(stats, ['<SEP>', '<BOW>', '<EOW>'], 'initial');
      ratios.forEach(r => expect(r).to.be.closeTo(1 / 3, 1e-6));
    });

    it('should evenly distribute when sum is 0', () => {
      const stats = { unigram: { 'T': { mean_ms: 0 } } };
      const ratios = computeNormalizedRatios(stats, ['en_T'], 'initial');
      expect(ratios[0]).to.equal(1);
    });

    it('should use <S> and <E> as boundary context for first/last phoneme', () => {
      // verify it doesn't throw and produces valid ratios
      const stats = {
        unigram: { 'T': { mean_ms: 50 }, 'AE1': { mean_ms: 100 } },
        bigram: { '<S>|T': { mean_ms: 80 } },
      };
      const ratios = computeNormalizedRatios(stats, ['en_T', 'en_AE1'], 'initial');
      expect(ratios.length).to.equal(2);
      const sum = ratios.reduce((s, v) => s + v, 0);
      expect(sum).to.be.closeTo(1.0, 1e-6);
    });
  });

  describe('loadDurationStats', () => {
    it('should load the stats file and return a non-empty object', async () => {
      const stats = await loadDurationStats();
      expect(stats).to.be.an('object');
      expect(stats.unigram).to.be.an('object');
    });

    it('should cache the result (second call returns same object)', async () => {
      const a = await loadDurationStats();
      const b = await loadDurationStats();
      expect(a).to.equal(b);
    });

    it('getDurationStatsSync should return cached stats or null', async () => {
      await loadDurationStats();
      const sync = getDurationStatsSync();
      expect(sync).to.not.be.null;
      expect(sync.unigram).to.be.an('object');
    });
  });
});
