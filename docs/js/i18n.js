/* ==========================================================================
   SXSEditor Docs — i18n (EN / ZH-CN) with auto language detection
   - data-i18n="key"            → textContent from dictionary (shared chrome)
   - data-i18n-html="key"       → innerHTML from dictionary
   - data-i18n-ph="key"         → placeholder
   - data-lang="en"|"zh" blocks → show/hide whole bilingual content blocks
   Persistence: localStorage 'sxs-lang'. Auto-detect from navigator.language.
   ========================================================================== */
(function (global) {
  'use strict';

  const I18N = {
    en: {
      'brand.name': 'SXSEditor',
      'nav.home': 'Home',
      'nav.docs': 'Documentation',
      'nav.user': 'User Guide',
      'nav.dev': 'Developer Guide',
      'nav.github': 'GitHub',
      'nav.download': 'Download',
      'theme.toggle': 'Toggle theme',
      'menu.open': 'Open menu',
      'footer.docs': 'Documentation',
      'footer.help': 'Help & FAQ',
      'footer.github': 'GitHub Repository',
      'footer.gitcode': 'GitCode Mirror',
      'footer.issues': 'Issue Tracker',
      'footer.copy': '© 2026 SXSEditor. MIT License.',
      'toc.title': 'On this page',
      'sidebar.user': 'User Guide',
      'sidebar.dev': 'Developer Guide',
      'sidebar.overview': 'Overview',
      'pager.prev': 'Previous',
      'pager.next': 'Next',
      'search.ph': 'Search docs...',
      'docs.user.title': 'User Guide',
      'docs.user.desc': 'Guides for installing, creating singers, editing, synthesizing, and exporting.',
      'docs.dev.title': 'Developer Guide',
      'docs.dev.desc': 'Architecture, build from source, ONNX models, inference pipeline, and testing.',
      'docs.start': 'Get started →',
      'copy': 'Copy',
      'copied': 'Copied'
    },
    zh: {
      'brand.name': 'SXSEditor',
      'nav.home': '首页',
      'nav.docs': '文档',
      'nav.user': '用户指南',
      'nav.dev': '开发者指南',
      'nav.github': 'GitHub',
      'nav.download': '下载',
      'theme.toggle': '切换主题',
      'menu.open': '打开菜单',
      'footer.docs': '文档',
      'footer.help': '帮助与常见问题',
      'footer.github': 'GitHub 仓库',
      'footer.gitcode': 'GitCode 镜像',
      'footer.issues': '问题追踪',
      'footer.copy': '© 2026 SXSEditor. MIT 许可证。',
      'toc.title': '本页内容',
      'sidebar.user': '用户指南',
      'sidebar.dev': '开发者指南',
      'sidebar.overview': '总览',
      'pager.prev': '上一页',
      'pager.next': '下一页',
      'search.ph': '搜索文档...',
      'docs.user.title': '用户指南',
      'docs.user.desc': '安装、创建歌手、编辑、合成与导出的使用指南。',
      'docs.dev.title': '开发者指南',
      'docs.dev.desc': '架构、源码构建、ONNX 模型、推理管线与测试。',
      'docs.start': '开始阅读 →',
      'copy': '复制',
      'copied': '已复制'
    }
  };

  const STORAGE_KEY = 'sxs-lang';

  function detectLang() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && I18N[saved]) return saved;
    const langs = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || '']);
    for (const l of langs) {
      const low = (l || '').toLowerCase();
      if (low.indexOf('zh') === 0) return 'zh';
      if (low.indexOf('en') === 0) return 'en';
    }
    return 'en';
  }

  const i18n = {
    lang: 'en',
    init() {
      this.lang = detectLang();
      this.apply();
    },
    setLang(lang) {
      if (!I18N[lang]) return;
      this.lang = lang;
      localStorage.setItem(STORAGE_KEY, lang);
      this.apply();
    },
    t(key) {
      return (I18N[this.lang] && I18N[this.lang][key]) || I18N.en[key] || key;
    },
    apply() {
      document.documentElement.lang = this.lang === 'zh' ? 'zh-CN' : 'en';
      // text keys
      document.querySelectorAll('[data-i18n]').forEach((el) => {
        const v = this.t(el.getAttribute('data-i18n'));
        if (v) el.textContent = v;
      });
      // html keys
      document.querySelectorAll('[data-i18n-html]').forEach((el) => {
        const v = this.t(el.getAttribute('data-i18n-html'));
        if (v) el.innerHTML = v;
      });
      // placeholders
      document.querySelectorAll('[data-i18n-ph]').forEach((el) => {
        const v = this.t(el.getAttribute('data-i18n-ph'));
        if (v) el.setAttribute('placeholder', v);
      });
      // language content blocks
      document.querySelectorAll('[data-lang]').forEach((el) => {
        el.classList.toggle('show', el.getAttribute('data-lang') === this.lang);
      });
      // language button states
      document.querySelectorAll('[data-lang-btn]').forEach((btn) => {
        btn.classList.toggle('active', btn.getAttribute('data-lang-btn') === this.lang);
      });
      // re-run prism if present
      if (global.Prism) global.Prism.highlightAll();
    }
  };

  global.SXS_i18n = i18n;
})(window);
