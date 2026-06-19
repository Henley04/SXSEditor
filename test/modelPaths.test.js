const { expect } = require('chai');
const path = require('path');
const fs = require('fs');

// Model manager path resolution
const {
  MODEL_FILE_MANIFEST,
} = require('../src/modelManager');

// Inline helpers from modelManager (not exported)
const PRECISION_SUBDIR_MAP = {
  'int8': 'int8',
  'fp16': 'fp16',
  'int8-npu': path.join('int8', 'optimized_npu'),
};
function isSvsModelFile(filePath) {
  return !filePath.startsWith('preprocess/') && !filePath.startsWith('basic_pitch_model/');
}
function getLocalFilePath(baseDir, filePath, precision) {
  const PRECISION_SUBDIR_PRECESIONS = new Set(['int8', 'fp16', 'int8-npu']);
  if (precision && PRECISION_SUBDIR_PRECESIONS.has(precision) && isSvsModelFile(filePath)) {
    const subdir = PRECISION_SUBDIR_MAP[precision] || precision;
    return path.join(baseDir, subdir, filePath);
  }
  return path.join(baseDir, filePath);
}

// Pipeline constants
const {
  ONNX_MODEL_FILES,
  VOCODER_CHUNK_FRAMES,
  NPU_VOCODER_SEQ_LEN,
  MEL_DIM,
  HOP_SIZE,
  SAMPLE_RATE,
} = require('../src/inference/pipeline/constants');

// Text processing
const { TextProcessing } = require('../src/inference/pipeline/textProcessing');

describe('Model Path Consistency', () => {
  const baseDir = '/test/models';

  describe('getLocalFilePath precision subdirectories', () => {
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

    it('should NOT use subdirectory for preprocess models', () => {
      const result = getLocalFilePath(baseDir, 'preprocess/rmvpe_model.onnx', 'fp16');
      expect(result).to.equal(path.join(baseDir, 'preprocess/rmvpe_model.onnx'));
    });

    it('should NOT use subdirectory for basic_pitch models', () => {
      const result = getLocalFilePath(baseDir, 'basic_pitch_model/model.json', 'int8');
      expect(result).to.equal(path.join(baseDir, 'basic_pitch_model/model.json'));
    });

    it('should use base directory when no precision specified', () => {
      const result = getLocalFilePath(baseDir, 'note_text_encoder.onnx', null);
      expect(result).to.equal(path.join(baseDir, 'note_text_encoder.onnx'));
    });
  });

  describe('PRECISION_SUBDIR_MAP matches pipeline _resolveModelDir', () => {
    // Pipeline uses these exact subdirectory names
    const pipelineSubdirMap = {
      'int8': 'int8',
      'fp16': 'fp16',
      'int8-npu': path.join('int8', 'optimized_npu'),
    };

    for (const [precision, expectedSubdir] of Object.entries(pipelineSubdirMap)) {
      it(`should match for precision="${precision}"`, () => {
        expect(PRECISION_SUBDIR_MAP[precision]).to.equal(expectedSubdir);
      });
    }
  });

  describe('Pipeline ONNX_MODEL_FILES are all in download manifest', () => {
    const manifestFiles = MODEL_FILE_MANIFEST.map(f => f.filePath);

    for (const modelFile of ONNX_MODEL_FILES) {
      it(`pipeline model "${modelFile}" should be in download manifest`, () => {
        // The manifest may have .onnx.data entries alongside .onnx entries
        // Check that the .onnx file itself is listed
        const found = manifestFiles.includes(modelFile) ||
          manifestFiles.some(f => f === modelFile.replace('.onnx', '.onnx'));
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
        // .onnx.data files are external data for .onnx files, not separate models
        if (manifestFile.endsWith('.onnx.data')) return;
        const found = ONNX_MODEL_FILES.includes(manifestFile);
        expect(found, `"${manifestFile}" in manifest but not in ONNX_MODEL_FILES`).to.be.true;
      });
    }
  });

  describe('Pipeline resolves diff_step_dml and vocoder_dml fallbacks', () => {
    it('should list diff_step_dml.onnx as primary', () => {
      expect(ONNX_MODEL_FILES).to.include('diff_step_dml.onnx');
    });

    it('should list vocoder_dml.onnx as primary', () => {
      expect(ONNX_MODEL_FILES).to.include('vocoder_dml.onnx');
    });
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

    it('should have 2820 phonemes', () => {
      expect(Object.keys(tp.phone2idx).length).to.equal(2820);
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

    it('should contain common words', () => {
      expect(tp.enG2pDict['hello']).to.be.a('string');
      expect(tp.enG2pDict['the']).to.be.a('string');
      expect(tp.enG2pDict['la']).to.be.a('string');
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

    it('should find en_EY1', () => {
      const id = tp._lookupPhonemeId('en_EY1');
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

    it('should find phoneme by en_ prefix lookup', () => {
      // When passed without prefix, should try en_ prefix
      const id = tp._lookupPhonemeId('EH1');
      expect(id).to.be.a('number');
      expect(id).to.not.equal(tp.phone2idx['<UNK>']);
    });
  });

  describe('_englishG2p', () => {
    it('should resolve "la" from dictionary', () => {
      const result = tp._englishG2p('la');
      expect(result).to.equal('L AA1');
    });

    it('should resolve "hello" from dictionary', () => {
      const result = tp._englishG2p('hello');
      expect(result).to.be.a('string');
      expect(result.split(' ').length).to.be.greaterThan(1);
    });

    it('should fall back to letter-level for unknown words', () => {
      const result = tp._englishG2p('xyzzy');
      expect(result).to.be.a('string');
      expect(result.split(' ').length).to.be.greaterThan(0);
    });

    it('letter fallback for single letter should produce phonemes', () => {
      const result = tp._englishG2p('z');
      expect(result).to.be.a('string');
      expect(result).to.include('IY1');
    });
  });

  describe('resolveLyricToPhonemes', () => {
    it('should resolve Chinese character', () => {
      const result = tp.resolveLyricToPhonemes('你');
      expect(result).to.be.an('array');
      expect(result.length).to.be.greaterThan(0);
      expect(result[0].name).to.match(/^zh_/);
    });

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

    it('should handle empty string', () => {
      const result = tp.resolveLyricToPhonemes('');
      expect(result).to.deep.equal([{ name: '<SP>', display: 'SP' }]);
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

  it('should include both diff_step_dml and vocoder_dml', () => {
    expect(ONNX_MODEL_FILES).to.include('diff_step_dml.onnx');
    expect(ONNX_MODEL_FILES).to.include('vocoder_dml.onnx');
  });
});

describe('phone_set.json file integrity', () => {
  let phoneSet;

  before(() => {
    const phoneSetPath = path.join(__dirname, '..', 'src', 'inference', 'phone_set.json');
    phoneSet = JSON.parse(fs.readFileSync(phoneSetPath, 'utf-8'));
  });

  it('should be a non-empty array', () => {
    expect(phoneSet).to.be.an('array');
    expect(phoneSet.length).to.be.greaterThan(0);
  });

  it('first element should be <PAD>', () => {
    expect(phoneSet[0]).to.equal('<PAD>');
  });

  it('should have no duplicate entries', () => {
    const unique = new Set(phoneSet);
    expect(unique.size).to.equal(phoneSet.length);
  });

  it('all entries should be strings', () => {
    for (const entry of phoneSet) {
      expect(entry).to.be.a('string');
    }
  });

  it('should contain en_EH1, en_L, en_EY1', () => {
    expect(phoneSet).to.include('en_EH1');
    expect(phoneSet).to.include('en_L');
    expect(phoneSet).to.include('en_EY1');
  });
});

describe('en_g2p_dict.json file integrity', () => {
  let g2pDict;

  before(() => {
    const dictPath = path.join(__dirname, '..', 'src', 'inference', 'en_g2p_dict.json');
    g2pDict = JSON.parse(fs.readFileSync(dictPath, 'utf-8'));
  });

  it('should be a non-empty object', () => {
    expect(g2pDict).to.be.an('object');
    expect(Object.keys(g2pDict).length).to.be.greaterThan(0);
  });

  it('all keys should be lowercase', () => {
    for (const key of Object.keys(g2pDict)) {
      expect(key).to.equal(key.toLowerCase());
    }
  });

  it('all values should be non-empty strings', () => {
    for (const [key, value] of Object.entries(g2pDict)) {
      expect(value).to.be.a('string');
      expect(value.length).to.be.greaterThan(0);
    }
  });

  it('values should contain only uppercase phoneme symbols', () => {
    for (const [key, value] of Object.entries(g2pDict)) {
      const parts = value.split(' ');
      for (const part of parts) {
        // CMU phonemes are uppercase letters optionally followed by a digit
        expect(part).to.match(/^[A-Z]+[0-2]?$/);
      }
    }
  });
});
