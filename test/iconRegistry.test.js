const { expect } = require('chai');

describe('iconRegistry', () => {
  let getIconMarkup, getIconNames, ICON_REGISTRY;

  before(() => {
    const registry = require('../src/icons/iconRegistry.js');
    getIconMarkup = registry.getIconMarkup;
    getIconNames = registry.getIconNames;
    ICON_REGISTRY = registry.ICON_REGISTRY;
  });

  describe('ICON_REGISTRY', () => {
    it('should have at least 20 icons', () => {
      expect(Object.keys(ICON_REGISTRY)).to.have.lengthOf.at.least(20);
    });

    it('should have required transport icons', () => {
      expect(ICON_REGISTRY).to.include.keys('play', 'pause', 'stop');
    });

    it('should have required file operation icons', () => {
      expect(ICON_REGISTRY).to.include.keys('save', 'upload', 'download', 'trash');
    });

    it('should have required navigation icons', () => {
      expect(ICON_REGISTRY).to.include.keys('chevron-up', 'chevron-right', 'arrow-left', 'arrow-right');
    });

    it('should have status icons', () => {
      expect(ICON_REGISTRY).to.include.keys('check', 'close', 'warning', 'info');
    });

    it('each entry should be a function returning a string', () => {
      for (const [name, factory] of Object.entries(ICON_REGISTRY)) {
        expect(factory, `icon "${name}"`).to.be.a('function');
        const markup = factory();
        expect(markup, `icon "${name}" markup`).to.be.a('string');
        expect(markup.length, `icon "${name}" should not be empty`).to.be.greaterThan(0);
      }
    });

    it('should produce valid SVG markup (starts with <path> or <circle> or <rect>)', () => {
      for (const [name, factory] of Object.entries(ICON_REGISTRY)) {
        const markup = factory();
        expect(markup.trim(), `icon "${name}"`).to.match(/^<(path|circle|rect|polyline)/);
      }
    });
  });

  describe('getIconMarkup', () => {
    it('should return markup for known icon', () => {
      const markup = getIconMarkup('play');
      expect(markup).to.be.a('string');
      expect(markup).to.include('d=');
    });

    it('should return null for unknown icon', () => {
      expect(getIconMarkup('nonexistent-icon')).to.be.null;
    });
  });

  describe('getIconNames', () => {
    it('should return all registry keys', () => {
      const names = getIconNames();
      expect(names).to.be.an('array');
      expect(names).to.include.members(['play', 'pause', 'save', 'close']);
      expect(names).to.have.lengthOf(Object.keys(ICON_REGISTRY).length);
    });
  });
});