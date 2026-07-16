/* ==========================================================================
   SXSEditor Docs — Extensible navigation config
   Add new pages by extending the SECTIONS object below — no other changes
   to docs infrastructure are required. Each entry is:
     { href, title: {en, zh}, desc: {en, zh} (optional) }
   Sidebar auto-renders via SXS_DocsNav.render(section, containerEl).
   ========================================================================== */
(function (global) {
  'use strict';

  const SECTIONS = {
    user: {
      label: { en: 'User Guide', zh: '用户指南' },
      groups: [
        {
          title: { en: 'Getting Started', zh: '快速上手' },
          items: [
            { href: 'quick-start.html', title: { en: 'Quick Start', zh: '快速开始' } },
            { href: 'singer-creation.html', title: { en: 'Singer Creation', zh: '创建歌手' } }
          ]
        },
        {
          title: { en: 'Editing', zh: '编辑' },
          items: [
            { href: 'fragment-editor.html', title: { en: 'Fragment Editor', zh: '片段编辑器' } },
            { href: 'synthesis-export.html', title: { en: 'Synthesis & Export', zh: '合成与导出' } }
          ]
        },
        {
          title: { en: 'Reference', zh: '参考' },
          items: [
            { href: 'settings.html', title: { en: 'Settings', zh: '设置' } },
            { href: 'app-updates.html', title: { en: 'Application Updates', zh: '应用更新' } },
            { href: 'model-updates.html', title: { en: 'Model Updates', zh: '模型更新' } },
            { href: 'faq.html', title: { en: 'FAQ & Troubleshooting', zh: '常见问题与故障排查' } },
            { href: 'uninstall.html', title: { en: 'Uninstall', zh: '卸载' } }
          ]
        }
      ]
    },
    dev: {
      label: { en: 'Developer Guide', zh: '开发者指南' },
      groups: [
        {
          title: { en: 'Getting Started', zh: '快速上手' },
          items: [
            { href: 'build.html', title: { en: 'Build from Source', zh: '从源码构建' } },
            { href: 'architecture.html', title: { en: 'Architecture', zh: '架构概览' } }
          ]
        },
        {
          title: { en: 'In-depth', zh: '深入主题' },
          items: [
            { href: 'inference-pipeline.html', title: { en: 'Inference Pipeline', zh: '推理管线' } },
            { href: 'onnx-models.html', title: { en: 'ONNX Models', zh: 'ONNX 模型' } }
          ]
        },
        {
          title: { en: 'Extending', zh: '扩展开发' },
          items: [
            { href: 'themes.html', title: { en: 'Themes & UI', zh: '主题与界面' } },
            { href: 'testing-cli.html', title: { en: 'Testing & CLI', zh: '测试与命令行' } }
          ]
        }
      ]
    }
  };

  function curLang() { return (global.SXS_i18n && global.SXS_i18n.lang) || 'en'; }

  function render(section, container) {
    if (!container) return;
    const data = SECTIONS[section];
    if (!data) return;
    const lang = curLang();
    const frag = document.createDocumentFragment();

    data.groups.forEach(function (group) {
      const gTitle = document.createElement('div');
      gTitle.className = 'section-title';
      gTitle.textContent = group.title[lang] || group.title.en;
      frag.appendChild(gTitle);

      group.items.forEach(function (item) {
        const a = document.createElement('a');
        a.href = item.href;
        a.className = 'side-link';
        a.textContent = item.title[lang] || item.title.en;
        frag.appendChild(a);
      });
    });

    container.innerHTML = '';
    container.appendChild(frag);

    // highlight active
    const path = (location.pathname.split('/').pop() || '').toLowerCase();
    container.querySelectorAll('.side-link').forEach(function (link) {
      const href = (link.getAttribute('href') || '').split('/').pop().toLowerCase();
      if (href && href === path) link.classList.add('active');
    });
  }

  // re-render on language change
  function bindAutoRender() {
    if (!global.SXS_i18n) return;
    const orig = global.SXS_i18n.apply;
    global.SXS_i18n.apply = function () {
      orig.apply(this, arguments);
      document.querySelectorAll('[data-nav-section]').forEach(function (el) {
        render(el.getAttribute('data-nav-section'), el);
      });
    };
  }

  function init() {
    document.querySelectorAll('[data-nav-section]').forEach(function (el) {
      render(el.getAttribute('data-nav-section'), el);
    });
    bindAutoRender();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  global.SXS_DocsNav = { SECTIONS: SECTIONS, render: render };
})(window);
