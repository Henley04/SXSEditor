const { expect } = require('chai');

describe('canvasTheme', () => {
  let getCanvasColors, invalidateCanvasThemeCache;
  let root;

  before(() => {
    const ct = require('../src/themes/canvasTheme.js');
    getCanvasColors = ct.getCanvasColors;
    invalidateCanvasThemeCache = ct.invalidateCanvasThemeCache;
    root = document.documentElement;
  });

  beforeEach(() => {
    // Clear any inline styles
    root.style = {};
    invalidateCanvasThemeCache();
  });

  describe('getCanvasColors', () => {
    it('should return default colors when no CSS variables are set', () => {
      const colors = getCanvasColors();
      expect(colors).to.be.an('object');
      expect(colors.bgApp).to.equal('#14141f');
      expect(colors.fgPrimary).to.equal('#e0e0f0');
      expect(colors.accent).to.equal('#5b8def');
    });

    it('should read CSS custom properties from :root', () => {
      root.style.setProperty('--bg-app', '#ff0000');
      root.style.setProperty('--fg-primary', '#00ff00');
      root.style.setProperty('--accent', '#0000ff');

      const colors = getCanvasColors();
      expect(colors.bgApp).to.equal('#ff0000');
      expect(colors.fgPrimary).to.equal('#00ff00');
      expect(colors.accent).to.equal('#0000ff');
    });

    it('should return cached result on subsequent calls', () => {
      const colors1 = getCanvasColors();
      root.style.setProperty('--bg-app', '#ff0000');
      const colors2 = getCanvasColors();
      // Should use cached version, still old values
      expect(colors2.bgApp).to.equal(colors1.bgApp);
    });

    it('should re-read after invalidateCanvasThemeCache', () => {
      getCanvasColors(); // populate cache
      root.style.setProperty('--bg-app', '#ff0000');
      invalidateCanvasThemeCache();
      const colors = getCanvasColors();
      expect(colors.bgApp).to.equal('#ff0000');
    });

    it('should include piano key colors (hardcoded, not theme-dependent)', () => {
      const colors = getCanvasColors();
      expect(colors.pianoWhiteKey).to.equal('#f0f0f0');
      expect(colors.pianoBlackKey).to.equal('#1a1a1a');
    });

    it('should include all expected color keys', () => {
      const colors = getCanvasColors();
      const expectedKeys = [
        'bgApp', 'bgPanel', 'bgElevated', 'bgInput', 'bgOverlay',
        'fgPrimary', 'fgSecondary', 'fgMuted', 'fgDisabled',
        'accent', 'accentHover', 'accentSoft', 'accentLine', 'accentFg',
        'success', 'warning', 'danger',
        'borderSubtle', 'borderDefault', 'borderStrong', 'borderAccent',
        'shadowColor', 'shadowColorMid',
        'scrollbarThumb',
        'selectionBg',
        'pianoWhiteKey', 'pianoBlackKey', 'pianoKeyBorder',
        'gridLineMajor', 'gridLineMinor', 'gridLineMeasure',
        'noteBg', 'noteSelectedBg', 'noteBorder', 'noteText',
        'pitchLine', 'pitchPoint', 'pitchAutoLine', 'pitchAutoPoint',
        'paramVol', 'paramPan', 'paramF0',
        'playhead',
        'fragmentText',
        'timeText',
        'loadingBg',
      ];
      expectedKeys.forEach(key => {
        expect(colors, `should have key "${key}"`).to.have.property(key);
      });
    });
  });

  describe('invalidateCanvasThemeCache', () => {
    it('should clear the cache', () => {
      getCanvasColors();
      invalidateCanvasThemeCache();
      // After invalidation, a new get should recompute
      root.style.setProperty('--bg-app', '#123456');
      const colors = getCanvasColors();
      expect(colors.bgApp).to.equal('#123456');
    });
  });
});