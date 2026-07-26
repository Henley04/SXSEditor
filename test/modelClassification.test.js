const { expect } = require('chai');
const path = require('path');

const {
  MODEL_FILE_MANIFEST,
  BASE_SVS_MODEL_FILES,
  DIFF_STEP_MODEL_FILES,
  VOCODER_MODEL_FILES,
  isBaseSvsModelFile,
  isDiffStepModelFile,
  isVocoderModelFile,
  isSvsModelFile,
} = require('../src/modelManager');

/**
 * SVS 模型分类测试 —— 验证基础模型（除 vocoder 和 diffstep）与扩散模型的精度分离。
 *
 * 分类规则（见 modelManager.js 顶部注释）：
 *   1. base (基础模型): 7 个轻量模型，统一精度检测（probe preflow），共用 baseModelsIsFP16
 *      - note_text_encoder / note_pitch_encoder / note_type_encoder / f0_encoder
 *      - preflow / cond_emb / mel_transform
 *   2. diffusion (扩散模型): 各自独立精度检测
 *      - diff_step_dml (diffStepIsFP16)
 *      - vocoder_dml  (vocoderIsFP16)
 *
 * 文件夹与版本管理：所有 SVS 模型仍共用同一精度子目录与 version.json，
 * 此分类仅为代码层面识别，不改变磁盘布局。
 */
describe('SVS Model Classification (base vs diffusion)', () => {
  describe('BASE_SVS_MODEL_FILES set', () => {
    it('should contain exactly 7 base model files', () => {
      expect(BASE_SVS_MODEL_FILES.size).to.equal(7);
    });

    it('should include all expected base model files', () => {
      const expected = [
        'note_text_encoder.onnx',
        'note_pitch_encoder.onnx',
        'note_type_encoder.onnx',
        'f0_encoder.onnx',
        'preflow.onnx',
        'cond_emb.onnx',
        'mel_transform.onnx',
      ];
      for (const file of expected) {
        expect(BASE_SVS_MODEL_FILES.has(file), `${file} should be in BASE_SVS_MODEL_FILES`).to.be.true;
      }
    });

    it('should NOT include diff_step or vocoder', () => {
      expect(BASE_SVS_MODEL_FILES.has('diff_step_dml.onnx')).to.be.false;
      expect(BASE_SVS_MODEL_FILES.has('diff_step.onnx')).to.be.false;
      expect(BASE_SVS_MODEL_FILES.has('vocoder_dml.onnx')).to.be.false;
      expect(BASE_SVS_MODEL_FILES.has('vocoder.onnx')).to.be.false;
    });

    it('should NOT include SiFiGAN variants', () => {
      expect(BASE_SVS_MODEL_FILES.has('sifigan_vocoder_dml.onnx')).to.be.false;
      expect(BASE_SVS_MODEL_FILES.has('sifigan_vocoder_dml_fp16.onnx')).to.be.false;
    });
  });

  describe('DIFF_STEP_MODEL_FILES set', () => {
    it('should contain both diff_step variants', () => {
      expect(DIFF_STEP_MODEL_FILES.size).to.equal(2);
      expect(DIFF_STEP_MODEL_FILES.has('diff_step_dml.onnx')).to.be.true;
      expect(DIFF_STEP_MODEL_FILES.has('diff_step.onnx')).to.be.true;
    });

    it('should NOT include base models or vocoder', () => {
      expect(DIFF_STEP_MODEL_FILES.has('preflow.onnx')).to.be.false;
      expect(DIFF_STEP_MODEL_FILES.has('vocoder_dml.onnx')).to.be.false;
    });
  });

  describe('VOCODER_MODEL_FILES set', () => {
    it('should contain both vocoder variants', () => {
      expect(VOCODER_MODEL_FILES.size).to.equal(2);
      expect(VOCODER_MODEL_FILES.has('vocoder_dml.onnx')).to.be.true;
      expect(VOCODER_MODEL_FILES.has('vocoder.onnx')).to.be.true;
    });

    it('should NOT include SiFiGAN variants (separately managed)', () => {
      expect(VOCODER_MODEL_FILES.has('sifigan_vocoder_dml.onnx')).to.be.false;
      expect(VOCODER_MODEL_FILES.has('sifigan_vocoder_dml_fp16.onnx')).to.be.false;
    });

    it('should NOT include base models or diff_step', () => {
      expect(VOCODER_MODEL_FILES.has('preflow.onnx')).to.be.false;
      expect(VOCODER_MODEL_FILES.has('diff_step_dml.onnx')).to.be.false;
    });
  });

  describe('isBaseSvsModelFile()', () => {
    it('should return true for base model .onnx files', () => {
      expect(isBaseSvsModelFile('note_text_encoder.onnx')).to.be.true;
      expect(isBaseSvsModelFile('preflow.onnx')).to.be.true;
      expect(isBaseSvsModelFile('mel_transform.onnx')).to.be.true;
    });

    it('should return true for base model .onnx.data files (external data)', () => {
      expect(isBaseSvsModelFile('note_text_encoder.onnx.data')).to.be.true;
      expect(isBaseSvsModelFile('preflow.onnx.data')).to.be.true;
      expect(isBaseSvsModelFile('mel_transform.onnx.data')).to.be.true;
    });

    it('should return false for diff_step and vocoder files', () => {
      expect(isBaseSvsModelFile('diff_step_dml.onnx')).to.be.false;
      expect(isBaseSvsModelFile('diff_step.onnx')).to.be.false;
      expect(isBaseSvsModelFile('vocoder_dml.onnx')).to.be.false;
      expect(isBaseSvsModelFile('vocoder.onnx')).to.be.false;
    });

    it('should return false for SiFiGAN files', () => {
      expect(isBaseSvsModelFile('sifigan_vocoder_dml.onnx')).to.be.false;
      expect(isBaseSvsModelFile('sifigan_vocoder_dml_fp16.onnx')).to.be.false;
    });

    it('should return false for non-SVS files', () => {
      expect(isBaseSvsModelFile('preprocess/rmvpe_model.onnx')).to.be.false;
      expect(isBaseSvsModelFile('basic_pitch_model/model.json')).to.be.false;
    });

    it('should handle invalid input gracefully', () => {
      expect(isBaseSvsModelFile(null)).to.be.false;
      expect(isBaseSvsModelFile(undefined)).to.be.false;
      expect(isBaseSvsModelFile('')).to.be.false;
      expect(isBaseSvsModelFile(123)).to.be.false;
    });
  });

  describe('isDiffStepModelFile()', () => {
    it('should return true for diff_step_dml.onnx', () => {
      expect(isDiffStepModelFile('diff_step_dml.onnx')).to.be.true;
    });

    it('should return true for diff_step.onnx (fallback variant)', () => {
      expect(isDiffStepModelFile('diff_step.onnx')).to.be.true;
    });

    it('should return false for base models and vocoder', () => {
      expect(isDiffStepModelFile('preflow.onnx')).to.be.false;
      expect(isDiffStepModelFile('vocoder_dml.onnx')).to.be.false;
    });

    it('should handle invalid input gracefully', () => {
      expect(isDiffStepModelFile(null)).to.be.false;
      expect(isDiffStepModelFile('')).to.be.false;
    });
  });

  describe('isVocoderModelFile()', () => {
    it('should return true for vocoder_dml.onnx', () => {
      expect(isVocoderModelFile('vocoder_dml.onnx')).to.be.true;
    });

    it('should return true for vocoder.onnx (fallback variant)', () => {
      expect(isVocoderModelFile('vocoder.onnx')).to.be.true;
    });

    it('should return false for SiFiGAN files (separately managed by sifiganPrecision)', () => {
      expect(isVocoderModelFile('sifigan_vocoder_dml.onnx')).to.be.false;
      expect(isVocoderModelFile('sifigan_vocoder_dml_fp16.onnx')).to.be.false;
    });

    it('should return false for base models and diff_step', () => {
      expect(isVocoderModelFile('preflow.onnx')).to.be.false;
      expect(isVocoderModelFile('diff_step_dml.onnx')).to.be.false;
    });

    it('should handle invalid input gracefully', () => {
      expect(isVocoderModelFile(null)).to.be.false;
      expect(isVocoderModelFile('')).to.be.false;
    });
  });

  describe('Manifest classification consistency', () => {
    // Collect all SVS .onnx files from the manifest (excluding preprocess/ and basic_pitch/)
    const svsOnnxFiles = MODEL_FILE_MANIFEST
      .filter(f => isSvsModelFile(f.filePath) && f.filePath.endsWith('.onnx'))
      .map(f => f.filePath);

    it('every SVS .onnx file should be classified as exactly one category (or SiFiGAN)', () => {
      for (const file of svsOnnxFiles) {
        const isBase = isBaseSvsModelFile(file);
        const isDiff = isDiffStepModelFile(file);
        const isVoc = isVocoderModelFile(file);
        const isSifigan = file.startsWith('sifigan_');
        const classifiedCount = [isBase, isDiff, isVoc].filter(Boolean).length;

        // SiFiGAN files are not in any of the three categories (separately managed)
        if (isSifigan) {
          expect(classifiedCount, `${file} should not be in any category`).to.equal(0);
        } else {
          expect(classifiedCount, `${file} should be in exactly one category`).to.equal(1);
        }
      }
    });

    it('all 7 base models should be in the manifest', () => {
      const manifestFiles = new Set(svsOnnxFiles);
      for (const baseFile of BASE_SVS_MODEL_FILES) {
        expect(manifestFiles.has(baseFile), `${baseFile} should be in MODEL_FILE_MANIFEST`).to.be.true;
      }
    });

    it('diff_step_dml.onnx should be in the manifest', () => {
      const manifestFiles = new Set(svsOnnxFiles);
      expect(manifestFiles.has('diff_step_dml.onnx')).to.be.true;
    });

    it('vocoder_dml.onnx should be in the manifest', () => {
      const manifestFiles = new Set(svsOnnxFiles);
      expect(manifestFiles.has('vocoder_dml.onnx')).to.be.true;
    });

    it('base .onnx.data files should also be classified as base', () => {
      const dataFiles = MODEL_FILE_MANIFEST
        .filter(f => f.filePath.endsWith('.onnx.data'))
        .map(f => f.filePath);

      for (const dataFile of dataFiles) {
        const correspondingOnnx = dataFile.replace(/\.onnx\.data$/, '.onnx');
        if (BASE_SVS_MODEL_FILES.has(correspondingOnnx)) {
          expect(isBaseSvsModelFile(dataFile), `${dataFile} should be classified as base`).to.be.true;
        }
      }
    });
  });

  describe('Three-tier precision separation (documentation)', () => {
    it('base model count matches design (7 models)', () => {
      // 7 base models: note_text_encoder, note_pitch_encoder, note_type_encoder,
      // f0_encoder, preflow, cond_emb, mel_transform
      expect(BASE_SVS_MODEL_FILES.size).to.equal(7);
    });

    it('diffusion model categories are non-empty', () => {
      expect(DIFF_STEP_MODEL_FILES.size).to.be.greaterThan(0);
      expect(VOCODER_MODEL_FILES.size).to.be.greaterThan(0);
    });

    it('categories are mutually exclusive', () => {
      const baseAndDiff = [...BASE_SVS_MODEL_FILES].filter(f => DIFF_STEP_MODEL_FILES.has(f));
      const baseAndVoc = [...BASE_SVS_MODEL_FILES].filter(f => VOCODER_MODEL_FILES.has(f));
      const diffAndVoc = [...DIFF_STEP_MODEL_FILES].filter(f => VOCODER_MODEL_FILES.has(f));

      expect(baseAndDiff, 'base and diff_step should not overlap').to.be.empty;
      expect(baseAndVoc, 'base and vocoder should not overlap').to.be.empty;
      expect(diffAndVoc, 'diff_step and vocoder should not overlap').to.be.empty;
    });
  });
});
