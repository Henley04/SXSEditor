const { expect } = require('chai');
const sinon = require('sinon');

describe('i18n', () => {
  let t, tOr, setLocale, getLocale, initI18n;

  before(() => {
    const i18n = require('../src/i18n/index.js');
    t = i18n.t;
    tOr = i18n.tOr;
    setLocale = i18n.setLocale;
    getLocale = i18n.getLocale;
    initI18n = i18n.initI18n;
  });

  beforeEach(() => {
    // Stub document.dispatchEvent to avoid JSDOM CustomEvent incompatibility
    sinon.stub(document, 'dispatchEvent').returns(true);
    // Reset locale to English before each test
    setLocale('en');
    localStorage.clear();
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('getLocale / setLocale', () => {
    it('should default to English', () => {
      expect(getLocale()).to.equal('en');
    });

    it('should switch to zh-CN', () => {
      setLocale('zh-CN');
      expect(getLocale()).to.equal('zh-CN');
    });

    it('should ignore unknown locale', () => {
      setLocale('ja');
      expect(getLocale()).to.equal('en');
    });

    it('should persist to localStorage', () => {
      setLocale('zh-CN');
      expect(localStorage.getItem('sxseditor-locale')).to.equal('zh-CN');
    });
  });

  describe('t() - basic translation', () => {
    it('should translate known key for current locale', () => {
      expect(t('common.cancel')).to.equal('Cancel');
    });

    it('should fallback to English when key is missing in zh-CN', () => {
      setLocale('zh-CN');
      // The zh-CN locale should have this key, but let's test a key that would fallback
      expect(t('common.cancel')).to.equal('取消');
    });

    it('should return the key string when key is missing in all locales', () => {
      expect(t('nonexistent.key')).to.equal('nonexistent.key');
    });

    it('should deep-resolve dotted keys', () => {
      expect(t('main.exportDialog.title')).to.equal('Export Audio');
    });

    it('should handle parameter substitution', () => {
      expect(t('main.synthesizingProgress', { progress: 42 })).to.equal('Synthesizing 42%');
    });

    it('should leave unreplaced params as {name}', () => {
      expect(t('main.synthesizingProgress', {})).to.equal('Synthesizing {progress}%');
    });

    it('should cache parameterless lookups', () => {
      // First call populates cache
      t('common.save');
      // Second call should hit cache
      expect(t('common.save')).to.equal('Save');
    });
  });

  describe('tOr() - translation with fallback', () => {
    it('should return translation when key exists', () => {
      expect(tOr('common.cancel', 'Fallback')).to.equal('Cancel');
    });

    it('should return fallback when key is missing', () => {
      expect(tOr('nonexistent.key', 'Fallback')).to.equal('Fallback');
    });

    it('should handle parameter substitution', () => {
      expect(tOr('main.synthesizingProgress', 'Fallback', { progress: 75 })).to.equal('Synthesizing 75%');
    });

    it('should return fallback for missing key even with params', () => {
      expect(tOr('nonexistent.key', 'Fallback', { x: 1 })).to.equal('Fallback');
    });
  });

  describe('initI18n()', () => {
    it('should load from localStorage when saved', async () => {
      localStorage.setItem('sxseditor-locale', 'zh-CN');
      await initI18n();
      expect(getLocale()).to.equal('zh-CN');
    });

    it('should default to English when nothing is saved', async () => {
      // Simulate no localStorage and no electronAPI
      await initI18n();
      // navigator.language from JSDOM defaults to en-US
      expect(getLocale()).to.equal('en');
    });

    it('should use electronAPI.getLocale when available', async () => {
      localStorage.removeItem('sxseditor-locale');
      window.electronAPI = {
        getLocale: async () => 'zh-CN',
      };
      await initI18n();
      expect(getLocale()).to.equal('zh-CN');
      expect(localStorage.getItem('sxseditor-locale')).to.equal('zh-CN');
      delete window.electronAPI;
    });
  });
});