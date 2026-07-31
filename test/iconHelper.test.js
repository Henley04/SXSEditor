const { expect } = require('chai');

describe('iconHelper', () => {
  let createIcon, setIcon, hydrateIcons, stripLeadingEmoji;

  before(() => {
    const ih = require('../src/icons/iconHelper.js');
    createIcon = ih.createIcon;
    setIcon = ih.setIcon;
    hydrateIcons = ih.hydrateIcons;
    stripLeadingEmoji = ih.stripLeadingEmoji;
  });

  describe('createIcon', () => {
    it('should return an SVG element for a known icon', () => {
      const svg = createIcon('play');
      expect(svg).to.be.an.instanceof(SVGElement);
      expect(svg.getAttribute('class')).to.include('icon-play');
    });

    it('should return null for an unknown icon', () => {
      expect(createIcon('nonexistent')).to.be.null;
    });

    it('should set default size to 16', () => {
      const svg = createIcon('play');
      expect(svg.getAttribute('width')).to.equal('16');
      expect(svg.getAttribute('height')).to.equal('16');
    });

    it('should accept custom size option', () => {
      const svg = createIcon('play', { size: 24 });
      expect(svg.getAttribute('width')).to.equal('24');
      expect(svg.getAttribute('height')).to.equal('24');
    });

    it('should set aria-hidden by default', () => {
      const svg = createIcon('play');
      expect(svg.getAttribute('aria-hidden')).to.equal('true');
    });

    it('should set aria-label when label option is provided', () => {
      const svg = createIcon('play', { label: 'Play' });
      expect(svg.getAttribute('aria-label')).to.equal('Play');
      expect(svg.getAttribute('role')).to.equal('img');
    });

    it('should set viewBox to 0 0 24 24', () => {
      const svg = createIcon('play');
      expect(svg.getAttribute('viewBox')).to.equal('0 0 24 24');
    });

    it('should include inner SVG markup', () => {
      const svg = createIcon('play');
      expect(svg.innerHTML).to.include('<path');
    });

    it('should append custom className', () => {
      const svg = createIcon('play', { className: 'extra-class' });
      expect(svg.getAttribute('class')).to.include('extra-class');
    });
  });

  describe('setIcon', () => {
    it('should prepend an SVG icon to an element', () => {
      const btn = document.createElement('button');
      btn.textContent = 'Play';
      setIcon(btn, 'play');
      expect(btn.children.length).to.equal(1);
      expect(btn.children[0].tagName).to.equal('svg');
      expect(btn.children[0].getAttribute('class')).to.include('icon-play');
    });

    it('should be idempotent (replace existing icon)', () => {
      const btn = document.createElement('button');
      setIcon(btn, 'play');
      setIcon(btn, 'pause');
      expect(btn.children.length).to.equal(1);
      expect(btn.children[0].getAttribute('class')).to.include('icon-pause');
    });

    it('should do nothing for null element', () => {
      expect(() => setIcon(null, 'play')).to.not.throw();
    });

    it('should do nothing for unknown icon', () => {
      const btn = document.createElement('button');
      expect(() => setIcon(btn, 'nonexistent')).to.not.throw();
      expect(btn.children.length).to.equal(0);
    });
  });

  describe('hydrateIcons', () => {
    it('should replace data-icon attributes with SVG elements', () => {
      const div = document.createElement('div');
      div.innerHTML = '<button data-icon="play">Play</button><button data-icon="save">Save</button>';
      hydrateIcons(div);
      const buttons = div.querySelectorAll('button');
      expect(buttons[0].querySelector('svg.icon-play')).to.exist;
      expect(buttons[1].querySelector('svg.icon-save')).to.exist;
    });

    it('should handle data-icon-size attribute', () => {
      const div = document.createElement('div');
      div.innerHTML = '<button data-icon="play" data-icon-size="24">Play</button>';
      hydrateIcons(div);
      const svg = div.querySelector('svg');
      expect(svg.getAttribute('width')).to.equal('24');
    });

    it('should handle data-icon-class attribute', () => {
      const div = document.createElement('div');
      div.innerHTML = '<button data-icon="play" data-icon-class="big-icon">Play</button>';
      hydrateIcons(div);
      const svg = div.querySelector('svg');
      expect(svg.getAttribute('class')).to.include('big-icon');
    });
  });

  describe('stripLeadingEmoji', () => {
    it('should strip leading emoji glyph', () => {
      expect(stripLeadingEmoji('▶ Play')).to.equal('Play');
    });

    it('should return plain text unchanged', () => {
      expect(stripLeadingEmoji('Play')).to.equal('Play');
    });

    it('should handle non-string input', () => {
      expect(stripLeadingEmoji(null)).to.be.null;
      expect(stripLeadingEmoji(undefined)).to.be.undefined;
      expect(stripLeadingEmoji(123)).to.equal(123);
    });

    it('should handle empty string', () => {
      expect(stripLeadingEmoji('')).to.equal('');
    });
  });
});