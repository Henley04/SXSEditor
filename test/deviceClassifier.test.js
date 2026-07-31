const { expect } = require('chai');

describe('deviceClassifier', () => {
  let classifyDevice;

  before(() => {
    classifyDevice = require('../src/utils/deviceClassifier').classifyDevice;
  });

  describe('NPU detection', () => {
    it('should detect "npu" in name', () => {
      expect(classifyDevice('Intel NPU', 0)).to.equal('npu');
    });

    it('should detect "Intel AI Boost"', () => {
      expect(classifyDevice('Intel AI Boost', 0)).to.equal('npu');
    });

    it('should detect "AMD Ryzen AI"', () => {
      expect(classifyDevice('AMD Ryzen AI 9 HX 370', 0)).to.equal('npu');
    });

    it('should detect "Qualcomm Hexagon"', () => {
      expect(classifyDevice('Qualcomm Hexagon NPU', 0)).to.equal('npu');
    });

    it('should detect "AMD XDNA"', () => {
      expect(classifyDevice('AMD XDNA AI Engine', 0)).to.equal('npu');
    });
  });

  describe('discrete GPU detection', () => {
    it('should detect NVIDIA GPU', () => {
      expect(classifyDevice('NVIDIA GeForce RTX 4090', 24 * 1024 ** 3)).to.equal('discrete-gpu');
    });

    it('should detect AMD Radeon RX', () => {
      expect(classifyDevice('AMD Radeon RX 7900 XTX', 24 * 1024 ** 3)).to.equal('discrete-gpu');
    });

    it('should detect Intel Arc A-series', () => {
      expect(classifyDevice('Intel Arc A770', 8 * 1024 ** 3)).to.equal('discrete-gpu');
    });

    it('should classify by DML discrete flag when true', () => {
      expect(classifyDevice('Some GPU', 0, true)).to.equal('discrete-gpu');
    });

    it('should classify by VRAM threshold (>= 512MB)', () => {
      expect(classifyDevice('Unknown GPU', 512 * 1024 * 1024)).to.equal('discrete-gpu');
    });
  });

  describe('integrated GPU detection', () => {
    it('should detect Intel UHD Graphics', () => {
      expect(classifyDevice('Intel UHD Graphics 630', 0)).to.equal('integrated-gpu');
    });

    it('should detect Intel Iris Xe', () => {
      expect(classifyDevice('Intel Iris Xe Graphics', 0)).to.equal('integrated-gpu');
    });

    it('should fall through to CPU for Intel Arc without A-series model number', () => {
      // Intel Arc without A-number pattern (e.g. 'Arc A<digit>') is not detected
      expect(classifyDevice('Intel Arc Graphics', 0)).to.equal('cpu');
    });

    it('should classify by DML discrete flag when false', () => {
      expect(classifyDevice('Some GPU', 0, false)).to.equal('integrated-gpu');
    });

    it('should classify small VRAM as integrated', () => {
      expect(classifyDevice('Unknown GPU', 128 * 1024 * 1024)).to.equal('integrated-gpu');
    });

    it('should detect Microsoft Basic Display', () => {
      expect(classifyDevice('Microsoft Basic Display Adapter', 0)).to.equal('integrated-gpu');
    });

    it('should detect Radeon without RX/Pro/Instinct as integrated', () => {
      expect(classifyDevice('AMD Radeon Graphics', 0)).to.equal('integrated-gpu');
    });
  });

  describe('fallback to CPU', () => {
    it('should return cpu when no info matches', () => {
      expect(classifyDevice('', 0)).to.equal('cpu');
    });

    it('should return cpu for null/undefined name', () => {
      expect(classifyDevice(null, 0)).to.equal('cpu');
      expect(classifyDevice(undefined, 0)).to.equal('cpu');
    });
  });
});