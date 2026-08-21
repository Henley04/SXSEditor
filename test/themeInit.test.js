const { expect } = require('chai');
const sinon = require('sinon');

describe('themeInit', () => {
  let initWindowTheme;

  before(() => {
    const ti = require('../src/themes/themeInit.js');
    initWindowTheme = ti.initWindowTheme;
  });

  beforeEach(() => {
    // Clean up inline styles
    const root = document.documentElement;
    for (let i = root.style.length - 1; i >= 0; i--) {
      const prop = root.style[i];
      if (prop.startsWith('--')) root.style.removeProperty(prop);
    }
  });

  describe('initWindowTheme', () => {
    it('should return early when electronAPI is not available', async () => {
      const result = await initWindowTheme();
      expect(result).to.be.undefined;
    });

    it('should return early when themeAPI is not available', async () => {
      window.electronAPI = {};
      const result = await initWindowTheme();
      expect(result).to.be.undefined;
      delete window.electronAPI;
    });

    it('should call bootstrap and inject tokens onto :root', async () => {
      const tokens = { '--bg-app': '#123456' };
      window.electronAPI = {
        themeAPI: {
          bootstrap: sinon.stub().resolves({
            currentTheme: { tokens },
          }),
          onChanged: sinon.stub().returns(() => {}),
        },
      };
      await initWindowTheme([]);
      const root = document.documentElement;
      expect(root.style.getPropertyValue('--bg-app')).to.equal('#123456');
      delete window.electronAPI;
    });

    it('should use themeId fallback when bootstrap has no tokens', async () => {
      window.electronAPI = {
        themeAPI: {
          bootstrap: sinon.stub().resolves({ themeId: 'dark-aurora' }),
          get: sinon.stub().resolves({ tokens: { '--bg-app': '#abcdef' } }),
          onChanged: sinon.stub().returns(() => {}),
        },
      };
      await initWindowTheme([]);
      const root = document.documentElement;
      expect(root.style.getPropertyValue('--bg-app')).to.equal('#abcdef');
      delete window.electronAPI;
    });

    it('should register onChanged listener', async () => {
      const onChanged = sinon.stub().returns(() => {});
      window.electronAPI = {
        themeAPI: {
          bootstrap: sinon.stub().resolves({ themeId: 'dark-aurora' }),
          get: sinon.stub().resolves({ tokens: {} }),
          onChanged,
        },
      };
      const cleanups = [];
      await initWindowTheme(cleanups);
      expect(onChanged.calledOnce).to.be.true;
      expect(cleanups).to.have.lengthOf(1);
      delete window.electronAPI;
    });

    it('should apply theme on onChanged callback', async () => {
      const cleanup = sinon.stub();
      const onChanged = sinon.stub().callsFake((cb) => {
        // Simulate theme change
        setTimeout(() => cb({ themeId: 'new-theme' }), 10);
        return cleanup;
      });
      window.electronAPI = {
        themeAPI: {
          bootstrap: sinon.stub().resolves({ themeId: 'dark-aurora' }),
          get: sinon.stub().callsFake((id) => {
            if (id === 'new-theme') return Promise.resolve({ tokens: { '--bg-app': '#fedcba' } });
            return Promise.resolve({ tokens: {} });
          }),
          onChanged,
        },
      };
      await initWindowTheme([]);
      await new Promise(r => setTimeout(r, 20));
      const root = document.documentElement;
      expect(root.style.getPropertyValue('--bg-app')).to.equal('#fedcba');
      delete window.electronAPI;
    });
  });
});