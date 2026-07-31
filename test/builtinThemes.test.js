const { expect } = require('chai');

describe('builtinThemes', () => {
  let BUILTIN_THEMES, BUILTIN_THEME_IDS;

  before(() => {
    const bt = require('../src/themes/builtins/index.js');
    BUILTIN_THEMES = bt.BUILTIN_THEMES;
    BUILTIN_THEME_IDS = bt.BUILTIN_THEME_IDS;
  });

  it('should have 4 built-in themes', () => {
    expect(BUILTIN_THEMES).to.have.lengthOf(4);
  });

  it('each theme should have required fields', () => {
    BUILTIN_THEMES.forEach(theme => {
      expect(theme, `theme "${theme.id}"`).to.have.property('id').that.is.a('string');
      expect(theme, `theme "${theme.id}"`).to.have.property('name').that.is.a('string');
      expect(theme, `theme "${theme.id}"`).to.have.property('tokens').that.is.an('object');
      expect(theme, `theme "${theme.id}"`).to.have.property('isDark').that.is.a('boolean');
      expect(theme, `theme "${theme.id}"`).to.have.property('version').that.is.a('string');
      expect(theme, `theme "${theme.id}"`).to.have.property('author').that.is.a('string');
    });
  });

  it('should have a dark-aurora theme', () => {
    expect(BUILTIN_THEME_IDS).to.include('dark-aurora');
  });

  it('should have a light-paper theme', () => {
    expect(BUILTIN_THEME_IDS).to.include('light-paper');
  });

  it('should have a midnight-amber theme', () => {
    expect(BUILTIN_THEME_IDS).to.include('midnight-amber');
  });

  it('should have an acg theme', () => {
    expect(BUILTIN_THEME_IDS).to.include('acg');
  });

  it('theme IDs should be unique', () => {
    const ids = BUILTIN_THEMES.map(t => t.id);
    expect(new Set(ids).size).to.equal(ids.length);
  });

  it('each theme should have non-empty tokens', () => {
    BUILTIN_THEMES.forEach(theme => {
      expect(Object.keys(theme.tokens).length, `theme "${theme.id}" tokens`).to.be.greaterThan(0);
    });
  });

  it('should have 4 theme IDs matching BUILTIN_THEMES length', () => {
    expect(BUILTIN_THEME_IDS).to.have.lengthOf(BUILTIN_THEMES.length);
  });
});