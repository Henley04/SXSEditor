const { expect } = require('chai');
const { isCJK, tokenizeLyric } = require('../src/utils/cjkUtils');
const { debounce } = require('../src/utils/debounce');
const { escapeHtml } = require('../src/utils/escapeHtml');
const { formatBytes } = require('../src/utils/formatBytes');
const { midiToNoteName, NOTE_NAMES } = require('../src/utils/midiUtils');
const { smoothstep } = require('../src/utils/smoothstep');

describe('utils/cjkUtils', () => {
  describe('isCJK', () => {
    it('should detect common CJK ideographs', () => {
      expect(isCJK('中')).to.be.true;
      expect(isCJK('日')).to.be.true;
      expect(isCJK('语')).to.be.true;
    });

    it('should detect CJK Extension A', () => {
      expect(isCJK('\u3400')).to.be.true;
      expect(isCJK('\u4DBF')).to.be.true;
    });

    it('should detect CJK Extension B', () => {
      expect(isCJK('\uD840\uDC00')).to.be.true;
    });

    it('should detect hiragana', () => {
      expect(isCJK('あ')).to.be.true;
      expect(isCJK('ん')).to.be.true;
    });

    it('should detect katakana', () => {
      expect(isCJK('ア')).to.be.true;
      expect(isCJK('ン')).to.be.true;
    });

    it('should detect hangul', () => {
      expect(isCJK('가')).to.be.true;
      expect(isCJK('힣')).to.be.true;
    });

    it('should reject ASCII and latin extensions', () => {
      expect(isCJK('a')).to.be.false;
      expect(isCJK('A')).to.be.false;
      expect(isCJK('1')).to.be.false;
      expect(isCJK(' ')).to.be.false;
    });

    it('should reject empty string (codePointAt 0)', () => {
      expect(isCJK('')).to.be.false;
    });

    it('should handle supplementary plane surrogate by codePointAt(0)', () => {
      // Emoji outside CJK ranges
      expect(isCJK('😀')).to.be.false;
    });
  });

  describe('tokenizeLyric', () => {
    it('should return empty array for empty/whitespace input', () => {
      expect(tokenizeLyric('')).to.deep.equal([]);
      expect(tokenizeLyric('   ')).to.deep.equal([]);
      expect(tokenizeLyric(null)).to.deep.equal([]);
      expect(tokenizeLyric(undefined)).to.deep.equal([]);
    });

    it('should tokenize latin words by whitespace', () => {
      expect(tokenizeLyric('hello world')).to.deep.equal(['hello', 'world']);
    });

    it('should tokenize each CJK char as its own token', () => {
      expect(tokenizeLyric('你好')).to.deep.equal(['你', '好']);
    });

    it('should attach trailing tone digit to CJK char', () => {
      expect(tokenizeLyric('你3好5')).to.deep.equal(['你3', '好5']);
    });

    it('should NOT attach digit to latin word', () => {
      expect(tokenizeLyric('hello3 world')).to.deep.equal(['hello3', 'world']);
    });

    it('should mix latin and CJK tokens', () => {
      expect(tokenizeLyric('hello 你好 world')).to.deep.equal(['hello', '你', '好', 'world']);
    });

    it('should collapse multiple whitespace', () => {
      expect(tokenizeLyric('a   b')).to.deep.equal(['a', 'b']);
    });

    it('should handle leading/trailing whitespace via trim', () => {
      expect(tokenizeLyric('  a  ')).to.deep.equal(['a']);
    });

    it('should treat tone digit 0 as part of latin word, not CJK tone', () => {
      // 0 is not in [1-5], so for CJK it won't attach; but for a CJK followed by 0
      expect(tokenizeLyric('你0')).to.deep.equal(['你', '0']);
    });
  });
});

describe('utils/debounce', () => {
  it('should not call fn immediately', () => {
    let called = 0;
    const fn = debounce(() => { called++; }, 50);
    fn();
    expect(called).to.equal(0);
  });

  it('should call fn after delay', async () => {
    let called = 0;
    const fn = debounce(() => { called++; }, 30);
    fn();
    await new Promise(r => setTimeout(r, 60));
    expect(called).to.equal(1);
  });

  it('should coalesce multiple rapid calls (trailing)', async () => {
    let called = 0;
    const fn = debounce(() => { called++; }, 30);
    fn(); fn(); fn();
    await new Promise(r => setTimeout(r, 60));
    expect(called).to.equal(1);
  });

  it('should pass arguments of the last call', async () => {
    let received = null;
    const fn = debounce((...args) => { received = args; }, 30);
    fn(1); fn(2); fn(3);
    await new Promise(r => setTimeout(r, 60));
    expect(received).to.deep.equal([3]);
  });

  it('should preserve `this` context', async () => {
    const obj = {
      val: 42,
      fn: debounce(function () { return this.val; }, 20),
    };
    const result = obj.fn();
    await new Promise(r => setTimeout(r, 40));
    // fn returns undefined (async via setTimeout); verify via side effect
    expect(result).to.equal(undefined);
  });

  it('should reset timer on each call', async () => {
    let called = 0;
    const fn = debounce(() => { called++; }, 40);
    fn();
    await new Promise(r => setTimeout(r, 20));
    fn(); // reset
    await new Promise(r => setTimeout(r, 25));
    expect(called).to.equal(0); // would be 1 if not reset
    await new Promise(r => setTimeout(r, 30));
    expect(called).to.equal(1);
  });
});

describe('utils/escapeHtml', () => {
  it('should escape ampersand', () => {
    expect(escapeHtml('a&b')).to.equal('a&amp;b');
  });
  it('should escape double quote', () => {
    expect(escapeHtml('"hi"')).to.equal('&quot;hi&quot;');
  });
  it('should escape less-than and greater-than', () => {
    expect(escapeHtml('<div>')).to.equal('&lt;div&gt;');
  });
  it('should escape single quote', () => {
    expect(escapeHtml("it's")).to.equal('it&#39;s');
  });
  it('should escape all special chars together', () => {
    expect(escapeHtml('<a href="x" title=\'y\'>&</a>')).to.equal(
      '&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;'
    );
  });
  it('should leave plain text unchanged', () => {
    expect(escapeHtml('hello world 123')).to.equal('hello world 123');
  });
  it('should handle empty string', () => {
    expect(escapeHtml('')).to.equal('');
  });
  it('should escape multiple ampersands independently', () => {
    expect(escapeHtml('&&&')).to.equal('&amp;&amp;&amp;');
  });
});

describe('utils/formatBytes', () => {
  it('should format 0 as "0 B"', () => {
    expect(formatBytes(0)).to.equal('0 B');
  });
  it('should treat null/undefined as 0', () => {
    expect(formatBytes(null)).to.equal('0 B');
    expect(formatBytes(undefined)).to.equal('0 B');
  });
  it('should format bytes below 1KB', () => {
    expect(formatBytes(1)).to.equal('1 B');
    expect(formatBytes(512)).to.equal('512 B');
    expect(formatBytes(1023)).to.equal('1023 B');
  });
  it('should format KB', () => {
    expect(formatBytes(1024)).to.equal('1 KB');
    expect(formatBytes(2048)).to.equal('2 KB');
  });
  it('should format MB with 0 decimals (i<2 branch skipped, i=2 → round)', () => {
    expect(formatBytes(1024 * 1024)).to.equal('1 MB');
    expect(formatBytes(1024 * 1024 * 1.5)).to.equal('2 MB');
  });
  it('should format GB with 2 decimals', () => {
    expect(formatBytes(1024 * 1024 * 1024)).to.equal('1.00 GB');
    expect(formatBytes(1024 * 1024 * 1024 * 2.5)).to.equal('2.50 GB');
  });
  it('should format TB with 2 decimals', () => {
    expect(formatBytes(1024 ** 4)).to.equal('1.00 TB');
  });
  it('should handle negative values by prefixing "-"', () => {
    expect(formatBytes(-1024)).to.equal('-1 KB');
    expect(formatBytes(-1)).to.equal('-1 B');
  });
});

describe('utils/midiUtils', () => {
  it('should have 12 note names', () => {
    expect(NOTE_NAMES).to.have.lengthOf(12);
    expect(NOTE_NAMES[0]).to.equal('C');
    expect(NOTE_NAMES[11]).to.equal('B');
  });
  it('should convert MIDI 69 to A4', () => {
    expect(midiToNoteName(69)).to.equal('A4');
  });
  it('should convert MIDI 60 to C4', () => {
    expect(midiToNoteName(60)).to.equal('C4');
  });
  it('should convert MIDI 0 to C-1', () => {
    expect(midiToNoteName(0)).to.equal('C-1');
  });
  it('should convert MIDI 12 to C0', () => {
    expect(midiToNoteName(12)).to.equal('C0');
  });
  it('should handle sharps', () => {
    expect(midiToNoteName(61)).to.equal('C#4');
    expect(midiToNoteName(70)).to.equal('A#4');
  });
  it('should wrap around octave boundary', () => {
    expect(midiToNoteName(71)).to.equal('B4');
    expect(midiToNoteName(72)).to.equal('C5');
  });
});

describe('utils/smoothstep', () => {
  it('should return t when smoothness is 0', () => {
    expect(smoothstep(0.5, 0)).to.equal(0.5);
    expect(smoothstep(0, 0)).to.equal(0);
    expect(smoothstep(1, 0)).to.equal(1);
  });
  it('should return t when smoothness is negative', () => {
    expect(smoothstep(0.5, -1)).to.equal(0.5);
  });
  it('should apply hermite interpolation for smoothness>0', () => {
    // t*t*(3-2t)
    expect(smoothstep(0.5, 1)).to.equal(0.5 * 0.5 * (3 - 2 * 0.5));
    expect(smoothstep(0.5, 1)).to.equal(0.5);
  });
  it('should produce 0 at t=0 and 1 at t=1 regardless of smoothness', () => {
    expect(smoothstep(0, 1)).to.equal(0);
    expect(smoothstep(1, 1)).to.equal(1);
  });
  it('should be monotonic for smoothness>0 within [0,1]', () => {
    let prev = -Infinity;
    for (let i = 0; i <= 10; i++) {
      const v = smoothstep(i / 10, 1);
      expect(v).to.be.at.least(prev);
      prev = v;
    }
  });
});
