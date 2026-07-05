const { expect } = require('chai');
const { computeLuminance, computeIsDark } = require('../src/themes/colorUtils');

describe('themes/colorUtils', () => {
  describe('computeLuminance', () => {
    it('should return 0.5 for null/undefined/non-string', () => {
      expect(computeLuminance(null)).to.equal(0.5);
      expect(computeLuminance(undefined)).to.equal(0.5);
      expect(computeLuminance(123)).to.equal(0.5);
      expect(computeLuminance('')).to.equal(0.5);
    });

    it('should return high luminance for white', () => {
      const lum = computeLuminance('#ffffff');
      expect(lum).to.be.closeTo(1.0, 0.01);
    });

    it('should return low luminance for black', () => {
      const lum = computeLuminance('#000000');
      expect(lum).to.be.closeTo(0.0, 0.01);
    });

    it('should handle 3-digit hex shorthand', () => {
      const lum3 = computeLuminance('#fff');
      const lum6 = computeLuminance('#ffffff');
      expect(lum3).to.be.closeTo(lum6, 1e-6);
    });

    it('should handle 4-digit hex shorthand (with alpha)', () => {
      const lum = computeLuminance('#ffff');
      expect(lum).to.be.closeTo(1.0, 0.01);
    });

    it('should handle 8-digit hex (with alpha)', () => {
      const lum = computeLuminance('#ffffffff');
      expect(lum).to.be.closeTo(1.0, 0.01);
    });

    it('should return 0.5 for invalid hex', () => {
      expect(computeLuminance('#zzzzzz')).to.equal(0.5);
      expect(computeLuminance('#12')).to.equal(0.5);
    });

    it('should parse rgb() format', () => {
      const lumRgb = computeLuminance('rgb(255, 255, 255)');
      expect(lumRgb).to.be.closeTo(1.0, 0.01);
    });

    it('should parse rgba() format', () => {
      const lum = computeLuminance('rgba(0, 0, 0, 0.5)');
      expect(lum).to.be.closeTo(0.0, 0.01);
    });

    it('should treat green as brighter than blue (perceptual luminance)', () => {
      const green = computeLuminance('#00ff00');
      const blue = computeLuminance('#0000ff');
      expect(green).to.be.greaterThan(blue);
    });

    it('should treat red as brighter than blue', () => {
      const red = computeLuminance('#ff0000');
      const blue = computeLuminance('#0000ff');
      expect(red).to.be.greaterThan(blue);
    });
  });

  describe('computeIsDark', () => {
    it('should return false for null tokens', () => {
      expect(computeIsDark(null)).to.be.false;
      expect(computeIsDark(undefined)).to.be.false;
    });

    it('should return false when --bg-app missing', () => {
      expect(computeIsDark({})).to.be.false;
    });

    it('should return true for dark background', () => {
      expect(computeIsDark({ '--bg-app': '#000000' })).to.be.true;
      expect(computeIsDark({ '--bg-app': '#1a1a2e' })).to.be.true;
    });

    it('should return false for light background', () => {
      expect(computeIsDark({ '--bg-app': '#ffffff' })).to.be.false;
      expect(computeIsDark({ '--bg-app': '#f5f5f5' })).to.be.false;
    });

    it('should use threshold 0.5 (medium gray)', () => {
      // #808080 ~ luminance 0.216 (dark-ish); #c0c0c0 ~ 0.51 (light-ish)
      expect(computeIsDark({ '--bg-app': '#808080' })).to.be.true;
      expect(computeIsDark({ '--bg-app': '#c0c0c0' })).to.be.false;
    });
  });
});
