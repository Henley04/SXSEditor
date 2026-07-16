const { expect } = require('chai');
const {
  _extractVersionContent,
  _parseListItems,
  _extractSpanInner,
} = require('../src/main/releaseNotesFetcher');

// Sample HTML mimicking the structure of docs/user/app-updates.html
const APP_UPDATES_SAMPLE = `<!DOCTYPE html>
<html><body>
<header class="site-header">header content</header>
<div class="docs-layout">
  <aside class="docs-sidebar"></aside>
  <main class="prose">
    <nav class="breadcrumb">breadcrumb</nav>
    <h1><span data-lang="en">Application Updates</span><span data-lang="zh">应用更新</span></h1>
    <p data-lang="en">Intro paragraph</p>
    <p data-lang="zh">介绍段落</p>

    <h2>
      <span data-lang="en">v1.0.5</span>
      <span data-lang="zh">v1.0.5</span>
    </h2>

    <h3>
      <span data-lang="en">New Features</span>
      <span data-lang="zh">新功能</span>
    </h3>
    <ul>
      <li><span data-lang="en"><strong>Feature A</strong> — description with <code>code</code> and <kbd class="kbd">Ctrl</kbd>.</span><span data-lang="zh"><strong>功能 A</strong>——包含 <code>代码</code> 和 <kbd class="kbd">Ctrl</kbd> 的描述。</span></li>
      <li><span data-lang="en">Feature B description.</span><span data-lang="zh">功能 B 描述。</span></li>
    </ul>

    <h3>
      <span data-lang="en">Bug Fixes</span>
      <span data-lang="zh">缺陷修复</span>
    </h3>
    <ul>
      <li><span data-lang="en">Fixed bug X.</span><span data-lang="zh">修复了 bug X。</span></li>
    </ul>

    <h2>
      <span data-lang="en">v1.0.4</span>
      <span data-lang="zh">v1.0.4</span>
    </h2>
    <ul>
      <li><span data-lang="en">Old feature.</span><span data-lang="zh">旧功能。</span></li>
    </ul>

    <nav class="doc-pager">pager</nav>
  </main>
</div>
</body></html>`;

// Sample HTML mimicking the structure of docs/user/model-updates.html
const MODEL_UPDATES_SAMPLE = `<!DOCTYPE html>
<html><body>
<div class="docs-layout">
  <main class="prose">
    <h1><span data-lang="en">Model Updates</span><span data-lang="zh">模型更新</span></h1>

    <h2>
      <span data-lang="en">v1 (Current)</span>
      <span data-lang="zh">v1（当前版本）</span>
    </h2>
    <ul>
      <li><span data-lang="en"><strong>GPU optimization</strong> — vocoder is 6x faster.</span><span data-lang="zh"><strong>GPU 优化</strong>——声码器提速 6 倍。</span></li>
      <li><span data-lang="en"><strong>ONNX opset 20</strong> — improved GPU kernels.</span><span data-lang="zh"><strong>ONNX opset 20</strong>——改善 GPU 内核。</span></li>
    </ul>

    <h2>
      <span data-lang="en">v0 (Deprecated)</span>
      <span data-lang="zh">v0（已弃用）</span>
    </h2>
    <p data-lang="en">The original model release. It is <strong>no longer provided</strong>.</p>
    <p data-lang="zh">最初的模型版本。<strong>不再提供</strong>。</p>
    <ul>
      <li><span data-lang="en">Exported at opset 17/18.</span><span data-lang="zh">以 opset 17/18 导出。</span></li>
    </ul>

    <nav class="doc-pager">pager</nav>
  </main>
</div>
</body></html>`;

describe('releaseNotesFetcher', () => {
  describe('_extractSpanInner', () => {
    it('should extract inner HTML of a span with matching data-lang', () => {
      const html = '<span data-lang="en">Hello <strong>world</strong></span>';
      expect(_extractSpanInner(html, 'en')).to.equal('Hello <strong>world</strong>');
    });

    it('should return null when no matching span is found', () => {
      const html = '<span data-lang="en">Hello</span>';
      expect(_extractSpanInner(html, 'zh')).to.be.null;
    });

    it('should handle spans with additional attributes', () => {
      const html = '<span class="foo" data-lang="zh" id="bar">内容</span>';
      expect(_extractSpanInner(html, 'zh')).to.equal('内容');
    });
  });

  describe('_parseListItems', () => {
    it('should parse paired en/zh items from a ul block', () => {
      const ul = `<ul>
        <li><span data-lang="en">Item 1 EN</span><span data-lang="zh">条目 1 中文</span></li>
        <li><span data-lang="en">Item 2 EN</span><span data-lang="zh">条目 2 中文</span></li>
      </ul>`;
      const items = _parseListItems(ul);
      expect(items).to.have.length(2);
      expect(items[0].en).to.equal('Item 1 EN');
      expect(items[0].zh).to.equal('条目 1 中文');
      expect(items[1].en).to.equal('Item 2 EN');
      expect(items[1].zh).to.equal('条目 2 中文');
    });

    it('should preserve inline HTML formatting in items', () => {
      const ul = `<ul><li><span data-lang="en"><strong>Bold</strong> and <code>mono</code></span><span data-lang="zh"><strong>粗体</strong>和<code>等宽</code></span></li></ul>`;
      const items = _parseListItems(ul);
      expect(items[0].en).to.equal('<strong>Bold</strong> and <code>mono</code>');
      expect(items[0].zh).to.equal('<strong>粗体</strong>和<code>等宽</code>');
    });
  });

  describe('_extractVersionContent (app-updates)', () => {
    it('should extract v1.0.5 with two sections (New Features, Bug Fixes)', () => {
      const result = _extractVersionContent(APP_UPDATES_SAMPLE, 'v1.0.5');
      expect(result).to.not.be.null;
      expect(result.found).to.be.true;
      expect(result.version).to.equal('v1.0.5');
      expect(result.sections).to.have.length(2);

      const newFeatures = result.sections[0];
      expect(newFeatures.title.en).to.equal('New Features');
      expect(newFeatures.title.zh).to.equal('新功能');
      expect(newFeatures.items).to.have.length(2);
      expect(newFeatures.items[0].en).to.contain('<strong>Feature A</strong>');
      expect(newFeatures.items[0].en).to.contain('<code>code</code>');
      expect(newFeatures.items[0].en).to.contain('<kbd class="kbd">Ctrl</kbd>');
      expect(newFeatures.items[0].zh).to.contain('<strong>功能 A</strong>');

      const bugFixes = result.sections[1];
      expect(bugFixes.title.en).to.equal('Bug Fixes');
      expect(bugFixes.title.zh).to.equal('缺陷修复');
      expect(bugFixes.items).to.have.length(1);
    });

    it('should match version without v prefix', () => {
      const result = _extractVersionContent(APP_UPDATES_SAMPLE, '1.0.5');
      expect(result).to.not.be.null;
      expect(result.version).to.equal('v1.0.5');
    });

    it('should extract v1.0.4 with a single standalone ul (no h3)', () => {
      const result = _extractVersionContent(APP_UPDATES_SAMPLE, 'v1.0.4');
      expect(result).to.not.be.null;
      expect(result.sections).to.have.length(1);
      expect(result.sections[0].title.en).to.be.null;
      expect(result.sections[0].items).to.have.length(1);
      expect(result.sections[0].items[0].en).to.equal('Old feature.');
    });

    it('should return null for a version that does not exist', () => {
      const result = _extractVersionContent(APP_UPDATES_SAMPLE, 'v9.9.9');
      expect(result).to.be.null;
    });

    it('should return null for empty version', () => {
      const result = _extractVersionContent(APP_UPDATES_SAMPLE, '');
      expect(result).to.be.null;
    });

    it('should not include content from the next version block', () => {
      const result = _extractVersionContent(APP_UPDATES_SAMPLE, 'v1.0.5');
      // v1.0.4 content should not leak into v1.0.5
      const allItems = result.sections.flatMap((s) => s.items);
      expect(allItems.some((i) => i.en === 'Old feature.')).to.be.false;
    });

    it('should not include the doc-pager nav content', () => {
      const result = _extractVersionContent(APP_UPDATES_SAMPLE, 'v1.0.4');
      const allItems = result.sections.flatMap((s) => s.items);
      expect(allItems.some((i) => i.en && i.en.includes('pager'))).to.be.false;
    });
  });

  describe('_extractVersionContent (model-updates)', () => {
    it('should extract v1 (Current) by prefix match', () => {
      const result = _extractVersionContent(MODEL_UPDATES_SAMPLE, 'v1');
      expect(result).to.not.be.null;
      expect(result.found).to.be.true;
      expect(result.sections).to.have.length(1);
      expect(result.sections[0].title.en).to.be.null; // no h3 in model-updates
      expect(result.sections[0].items).to.have.length(2);
      expect(result.sections[0].items[0].en).to.contain('<strong>GPU optimization</strong>');
      expect(result.sections[0].items[0].zh).to.contain('<strong>GPU 优化</strong>');
      expect(result.intro).to.be.null; // v1 has no intro paragraph
    });

    it('should extract v0 (Deprecated) with intro paragraph', () => {
      const result = _extractVersionContent(MODEL_UPDATES_SAMPLE, 'v0');
      expect(result).to.not.be.null;
      expect(result.sections).to.have.length(1);
      expect(result.sections[0].items).to.have.length(1);
      expect(result.intro).to.not.be.null;
      expect(result.intro.en).to.contain('no longer provided');
      expect(result.intro.en).to.contain('<strong>no longer provided</strong>');
      expect(result.intro.zh).to.contain('不再提供');
    });

    it('should match v1 without v prefix', () => {
      const result = _extractVersionContent(MODEL_UPDATES_SAMPLE, '1');
      expect(result).to.not.be.null;
      expect(result.sections[0].items).to.have.length(2);
    });
  });
});
