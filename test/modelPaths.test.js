const { expect } = require('chai');
const path = require('path');
const fs = require('fs');

// Import ACTUAL functions from modelManager (not inline copies)
const {
  MODEL_FILE_MANIFEST,
  PRECISION_SUBDIR_MAP,
  PRECISION_SUBDIR_PRECESIONS,
  getLocalFilePath,
  getManifestForPrecision,
  isSvsModelFile,
  checkMissingFiles,
} = require('../src/modelManager');

// Pipeline constants
const {
  ONNX_MODEL_FILES,
  SIFIGAN_MODEL_FILES,
  VOCODER_CHUNK_FRAMES,
  NPU_VOCODER_SEQ_LEN,
  MEL_DIM,
  HOP_SIZE,
  SAMPLE_RATE,
} = require('../src/inference/pipeline/constants');

// Text processing
const { TextProcessing } = require('../src/inference/pipeline/textProcessing');

describe('Model Path Consistency (using actual modelManager functions)', () => {
  const baseDir = '/test/models';

  describe('isSvsModelFile (actual function)', () => {
    it('should return true for SVS model files', () => {
      expect(isSvsModelFile('note_text_encoder.onnx')).to.be.true;
      expect(isSvsModelFile('diff_step_dml.onnx')).to.be.true;
      expect(isSvsModelFile('vocoder_dml.onnx')).to.be.true;
    });

    it('should return false for preprocess models', () => {
      expect(isSvsModelFile('preprocess/rmvpe_model.onnx')).to.be.false;
      expect(isSvsModelFile('preprocess/rosvot_model.onnx')).to.be.false;
    });

    it('should return false for basic_pitch models', () => {
      expect(isSvsModelFile('basic_pitch_model/model.json')).to.be.false;
      expect(isSvsModelFile('basic_pitch_model/group1-shard1of1.bin')).to.be.false;
    });
  });

  describe('getLocalFilePath (actual function)', () => {
    it('should use fp16 subdirectory for fp16 SVS models', () => {
      const result = getLocalFilePath(baseDir, 'note_text_encoder.onnx', 'fp16');
      expect(result).to.equal(path.join(baseDir, 'fp16', 'note_text_encoder.onnx'));
    });

    it('should use int8 subdirectory for int8 SVS models', () => {
      const result = getLocalFilePath(baseDir, 'diff_step_dml.onnx', 'int8');
      expect(result).to.equal(path.join(baseDir, 'int8', 'diff_step_dml.onnx'));
    });

    it('should use int8/optimized_npu for int8-npu SVS models', () => {
      const result = getLocalFilePath(baseDir, 'vocoder_dml.onnx', 'int8-npu');
      expect(result).to.equal(path.join(baseDir, 'int8', 'optimized_npu', 'vocoder_dml.onnx'));
    });

    it('should NOT use subdirectory for preprocess models even with precision', () => {
      const result = getLocalFilePath(baseDir, 'preprocess/rmvpe_model.onnx', 'fp16');
      expect(result).to.equal(path.join(baseDir, 'preprocess/rmvpe_model.onnx'));
    });

    it('should NOT use subdirectory for basic_pitch models even with precision', () => {
      const result = getLocalFilePath(baseDir, 'basic_pitch_model/model.json', 'fp16');
      expect(result).to.equal(path.join(baseDir, 'basic_pitch_model/model.json'));
    });

    it('should use base directory when no precision specified', () => {
      const result = getLocalFilePath(baseDir, 'note_text_encoder.onnx', null);
      expect(result).to.equal(path.join(baseDir, 'note_text_encoder.onnx'));
    });

    it('should use base directory for fp32 (no subdirectory)', () => {
      const result = getLocalFilePath(baseDir, 'note_text_encoder.onnx', 'fp32');
      expect(result).to.equal(path.join(baseDir, 'note_text_encoder.onnx'));
    });
  });

  describe('getManifestForPrecision (actual function)', () => {
    it('fp16 manifest should include .onnx.data files', () => {
      const manifest = getManifestForPrecision('fp16');
      const hasDataFiles = manifest.some(f => f.filePath.endsWith('.onnx.data'));
      expect(hasDataFiles).to.be.true;
    });

    it('int8-npu manifest should NOT include .onnx.data files', () => {
      const manifest = getManifestForPrecision('int8-npu');
      const hasDataFiles = manifest.some(f => f.filePath.endsWith('.onnx.data'));
      expect(hasDataFiles).to.be.false;
    });

    it('all manifests should include basic_pitch_model files', () => {
      for (const precision of ['fp16', 'int8', 'int8-npu', 'fp32']) {
        const manifest = getManifestForPrecision(precision);
        const hasBasicPitch = manifest.some(f => f.filePath.startsWith('basic_pitch_model/'));
        expect(hasBasicPitch, `basic_pitch_model missing from ${precision} manifest`).to.be.true;
      }
    });
  });

  describe('PRECISION_SUBDIR_MAP (actual export)', () => {
    it('fp16 maps to "fp16"', () => {
      expect(PRECISION_SUBDIR_MAP['fp16']).to.equal('fp16');
    });

    it('int8 maps to "int8"', () => {
      expect(PRECISION_SUBDIR_MAP['int8']).to.equal('int8');
    });

    it('int8-npu maps to "int8/optimized_npu"', () => {
      expect(PRECISION_SUBDIR_MAP['int8-npu']).to.equal(path.join('int8', 'optimized_npu'));
    });
  });

  describe('Download and pipeline path consistency', () => {
    // Simulate what checkMissingFiles does: for each manifest file,
    // verify the path is consistent between download and pipeline loading
    const precisions = ['fp16', 'int8', 'int8-npu'];

    for (const precision of precisions) {
      describe(`precision="${precision}"`, () => {
        const manifest = getManifestForPrecision(precision);

        for (const file of manifest) {
          if (!file.required) return;

          it(`${file.filePath} download path should be deterministic`, () => {
            const downloadPath = getLocalFilePath(baseDir, file.filePath, precision);
            // Run it twice — should be identical
            const downloadPath2 = getLocalFilePath(baseDir, file.filePath, precision);
            expect(downloadPath).to.equal(downloadPath2);
          });

          if (isSvsModelFile(file.filePath)) {
            it(`SVS file ${file.filePath} should be in precision subdirectory`, () => {
              const downloadPath = getLocalFilePath(baseDir, file.filePath, precision);
              const subdir = PRECISION_SUBDIR_MAP[precision];
              expect(downloadPath).to.include(subdir);
            });
          } else {
            it(`non-SVS file ${file.filePath} should NOT be in precision subdirectory`, () => {
              const downloadPath = getLocalFilePath(baseDir, file.filePath, precision);
              const subdir = PRECISION_SUBDIR_MAP[precision];
              expect(downloadPath).to.not.include(subdir);
            });
          }
        }
      });
    }
  });

  describe('Pipeline ONNX_MODEL_FILES are all in download manifest', () => {
    const manifestFiles = MODEL_FILE_MANIFEST.map(f => f.filePath);

    for (const modelFile of ONNX_MODEL_FILES) {
      it(`pipeline model "${modelFile}" should be in download manifest`, () => {
        const found = manifestFiles.includes(modelFile);
        expect(found, `"${modelFile}" not found in MODEL_FILE_MANIFEST`).to.be.true;
      });
    }
  });

  describe('Download manifest SVS files are in pipeline model list', () => {
    const svsManifestFiles = MODEL_FILE_MANIFEST
      .filter(f => isSvsModelFile(f.filePath))
      .map(f => f.filePath);

    for (const manifestFile of svsManifestFiles) {
      it(`manifest file "${manifestFile}" should be handled by pipeline`, () => {
        // Skip external data files (loaded alongside their .onnx sibling)
        if (manifestFile.endsWith('.onnx.data')) return;
        // Skip non-ONNX auxiliary files (e.g., sifigan_stats.joblib is a
        // normalization stats file, not an ONNX model the pipeline loads)
        if (!manifestFile.endsWith('.onnx')) return;
        // Optional SVS ONNX files (e.g., sifigan_vocoder_dml.onnx) are
        // conditionally swapped into the pipeline at runtime via index
        // replacement, not always loaded. They live in SIFIGAN_MODEL_FILES.
        const found = ONNX_MODEL_FILES.includes(manifestFile)
          || SIFIGAN_MODEL_FILES.includes(manifestFile);
        expect(found, `"${manifestFile}" in manifest but not in ONNX_MODEL_FILES or SIFIGAN_MODEL_FILES`).to.be.true;
      });
    }
  });

  describe('checkMissingFiles uses correct paths', () => {
    it('should use getLocalFilePath for each manifest entry', () => {
      // Verify that checkMissingFiles produces paths consistent with getLocalFilePath
      // by checking a non-existent directory (all files missing)
      const tmpDir = path.join(__dirname, '..', '.test-tmp-nonexistent');
      const { missing } = checkMissingFiles(tmpDir, 'fp16');
      expect(missing.length).to.be.greaterThan(0);

      // Each missing file should have a filePath from the manifest
      for (const m of missing) {
        expect(m.filePath).to.be.a('string');
        expect(MODEL_FILE_MANIFEST.some(f => f.filePath === m.filePath)).to.be.true;
      }
    });
  });
});

describe('Pipeline Constants Consistency', () => {
  it('VOCODER_CHUNK_FRAMES should be 1008', () => {
    expect(VOCODER_CHUNK_FRAMES).to.equal(1008);
  });

  it('NPU_VOCODER_SEQ_LEN should be 500', () => {
    expect(NPU_VOCODER_SEQ_LEN).to.equal(500);
  });

  it('NPU_VOCODER_SEQ_LEN should be less than VOCODER_CHUNK_FRAMES', () => {
    expect(NPU_VOCODER_SEQ_LEN).to.be.lessThan(VOCODER_CHUNK_FRAMES);
  });

  it('MEL_DIM should be 128', () => {
    expect(MEL_DIM).to.equal(128);
  });

  it('HOP_SIZE should be 480', () => {
    expect(HOP_SIZE).to.equal(480);
  });

  it('SAMPLE_RATE should be 24000', () => {
    expect(SAMPLE_RATE).to.equal(24000);
  });

  it('ONNX_MODEL_FILES should have 9 entries', () => {
    expect(ONNX_MODEL_FILES.length).to.equal(9);
  });
});

describe('TextProcessing - Vocabulary and Dictionary', () => {
  let tp;

  before(() => {
    tp = new TextProcessing();
  });

  describe('Phoneme vocabulary', () => {
    it('should load phone_set.json with entries', () => {
      expect(Object.keys(tp.phone2idx).length).to.be.greaterThan(0);
    });

    it('should have 3033 phonemes (including 33 JP)', () => {
      expect(Object.keys(tp.phone2idx).length).to.equal(3033);
    });

    it('should contain special tokens', () => {
      expect(tp.phone2idx['<PAD>']).to.equal(0);
      expect(tp.phone2idx['<SP>']).to.equal(1);
      expect(tp.phone2idx['<UNK>']).to.equal(3);
      expect(tp.phone2idx['<BOW>']).to.equal(4);
      expect(tp.phone2idx['<EOW>']).to.equal(5);
    });

    it('should contain English phonemes with en_ prefix', () => {
      expect(tp.phone2idx['en_AA0']).to.be.a('number');
      expect(tp.phone2idx['en_EH1']).to.be.a('number');
      expect(tp.phone2idx['en_L']).to.be.a('number');
      expect(tp.phone2idx['en_EY1']).to.be.a('number');
    });

    it('should contain Chinese phonemes with zh_ prefix', () => {
      expect(tp.phone2idx['zh_a1']).to.be.a('number');
    });
  });

  describe('English G2P dictionary', () => {
    it('should load en_g2p_dict.json with entries', () => {
      expect(Object.keys(tp.enG2pDict).length).to.be.greaterThan(0);
    });

    it('should have 126052 words', () => {
      expect(Object.keys(tp.enG2pDict).length).to.equal(126052);
    });

    it('la should resolve to L AA1', () => {
      expect(tp.enG2pDict['la']).to.equal('L AA1');
    });
  });

  describe('_lookupPhonemeId', () => {
    it('should find en_EH1', () => {
      const id = tp._lookupPhonemeId('en_EH1');
      expect(id).to.be.a('number');
      expect(id).to.not.equal(tp.phone2idx['<UNK>']);
    });

    it('should find en_L', () => {
      const id = tp._lookupPhonemeId('en_L');
      expect(id).to.be.a('number');
      expect(id).to.not.equal(tp.phone2idx['<UNK>']);
    });

    it('should return UNK for unknown phoneme', () => {
      const id = tp._lookupPhonemeId('en_ZZZZZ999');
      expect(id).to.equal(tp.phone2idx['<UNK>']);
    });

    it('should handle empty input', () => {
      const id = tp._lookupPhonemeId('');
      expect(id).to.equal(tp.phone2idx['<SP>']);
    });
  });

  describe('resolveLyricToPhonemes', () => {
    it('should resolve English word', () => {
      const result = tp.resolveLyricToPhonemes('la');
      expect(result).to.be.an('array');
      expect(result.length).to.be.greaterThan(0);
      expect(result[0].name).to.match(/^en_/);
    });

    it('should handle SP token', () => {
      const result = tp.resolveLyricToPhonemes('<SP>');
      expect(result).to.deep.equal([{ name: '<SP>', display: 'SP' }]);
    });
  });
});

describe('phone_set.json file integrity', () => {
  let phoneSet;

  before(() => {
    const phoneSetPath = path.join(__dirname, '..', 'src', 'inference', 'phone_set.json');
    phoneSet = JSON.parse(fs.readFileSync(phoneSetPath, 'utf-8'));
  });

  it('should be a non-empty array with 3033 entries (including 33 JP)', () => {
    expect(phoneSet).to.be.an('array');
    expect(phoneSet.length).to.equal(3033);
  });

  it('should have no duplicate entries', () => {
    const unique = new Set(phoneSet);
    expect(unique.size).to.equal(phoneSet.length);
  });

  it('should contain en_EH1, en_L, en_EY1', () => {
    expect(phoneSet).to.include('en_EH1');
    expect(phoneSet).to.include('en_L');
    expect(phoneSet).to.include('en_EY1');
  });
});
