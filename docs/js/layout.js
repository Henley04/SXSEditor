/* ==========================================================================
   SXSEditor Docs — Shared layout behavior
   - Theme toggle (persist to localStorage 'sxs-theme', auto-detect system)
   - Language button wiring (delegates to SXS_i18n.setLang)
   - Mobile nav drawer toggle
   - Scroll-aware header .scrolled state
   - IntersectionObserver fade-in for .fade-in elements
   - Copy button delegation for [data-copy] / .copy-btn
   - Smooth-scroll back-to-top button
   ========================================================================== */
(function () {
  'use strict';

  const THEME_KEY = 'sxs-theme';

  function getPreferredTheme() {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
    return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(THEME_KEY, theme);
    // update aria-label on toggle if present
    const toggle = document.querySelector('[data-theme-toggle]');
    if (toggle) toggle.setAttribute('aria-label', theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
  }

  function initTheme() {
    applyTheme(getPreferredTheme());
    const toggle = document.querySelector('[data-theme-toggle]');
    if (toggle) {
      toggle.addEventListener('click', function () {
        const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
        applyTheme(cur === 'dark' ? 'light' : 'dark');
      });
    }
    // react to OS theme change if user hasn't set a preference
    if (window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function (e) {
        if (!localStorage.getItem(THEME_KEY)) {
          applyTheme(e.matches ? 'dark' : 'light');
        }
      });
    }
  }

  function initLangSwitcher() {
    if (!window.SXS_i18n) return;
    document.querySelectorAll('[data-lang-btn]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        window.SXS_i18n.setLang(btn.getAttribute('data-lang-btn'));
      });
    });
  }

  function initMobileNav() {
    const btn = document.querySelector('[data-menu-btn]');
    const nav = document.querySelector('[data-header-nav]');
    if (!btn || !nav) return;
    btn.addEventListener('click', function () { nav.classList.toggle('open'); });
    nav.querySelectorAll('a').forEach(function (a) {
      a.addEventListener('click', function () { nav.classList.remove('open'); });
    });
  }

  function initScrollHeader() {
    const header = document.querySelector('.site-header');
    if (!header) return;
    let ticking = false;
    function update() {
      if (window.scrollY > 8) header.classList.add('scrolled');
      else header.classList.remove('scrolled');
      ticking = false;
    }
    window.addEventListener('scroll', function () {
      if (!ticking) { window.requestAnimationFrame(update); ticking = true; }
    }, { passive: true });
    update();
  }

  function initFadeIn() {
    const els = document.querySelectorAll('.fade-in');
    if (!els.length || !('IntersectionObserver' in window)) {
      els.forEach(function (el) { el.classList.add('visible'); });
      return;
    }
    const io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          io.unobserve(entry.target);
        }
      });
    }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });
    els.forEach(function (el) { io.observe(el); });
  }

  function initCopyButtons() {
    document.addEventListener('click', function (e) {
      const btn = e.target.closest('[data-copy]');
      if (!btn) return;
      const text = btn.getAttribute('data-copy');
      if (!text) return;
      const done = function () {
        const orig = btn.textContent;
        btn.textContent = (window.SXS_i18n && window.SXS_i18n.t('copied')) || 'Copied';
        btn.classList.add('copied');
        setTimeout(function () { btn.textContent = orig; btn.classList.remove('copied'); }, 1500);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
      } else {
        fallbackCopy(text); done();
      }
    });
  }

  function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch (e) { /* ignore */ }
    document.body.removeChild(ta);
  }

  function initBackToTop() {
    const btn = document.querySelector('[data-back-to-top]');
    if (!btn) return;
    let ticking = false;
    function update() {
      if (window.scrollY > 600) btn.classList.add('visible');
      else btn.classList.remove('visible');
      ticking = false;
    }
    window.addEventListener('scroll', function () {
      if (!ticking) { window.requestAnimationFrame(update); ticking = true; }
    }, { passive: true });
    btn.addEventListener('click', function () { window.scrollTo({ top: 0, behavior: 'smooth' }); });
    update();
  }

  // highlight active sidebar link based on current path
  function initActiveSidebar() {
    const path = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
    document.querySelectorAll('.side-link').forEach(function (link) {
      const href = (link.getAttribute('href') || '').split('/').pop().toLowerCase();
      if (href && href === path) link.classList.add('active');
    });
  }

  // build TOC from h2/h3 in .prose if a [data-toc] container exists
  // Only shows the current language's text (respects [data-lang] spans).
  function headingText(h) {
    const lang = (window.SXS_i18n && window.SXS_i18n.lang) || 'en';
    const span = h.querySelector('[data-lang="' + lang + '"]');
    return span ? span.textContent : h.textContent;
  }

  function buildTOC() {
    const container = document.querySelector('[data-toc]');
    if (!container) return;
    const prose = document.querySelector('.prose');
    if (!prose) return;
    const heads = prose.querySelectorAll('h2, h3');
    if (!heads.length) { container.style.display = 'none'; return; }
    const frag = document.createDocumentFragment();
    heads.forEach(function (h, i) {
      if (!h.id) h.id = 'sec-' + i;
      const a = document.createElement('a');
      a.href = '#' + h.id;
      a.textContent = headingText(h);
      a.className = 'toc-link' + (h.tagName === 'H3' ? ' toc-sub' : '');
      frag.appendChild(a);
    });
    container.innerHTML = '';
    container.appendChild(frag);

    // scroll-spy
    const links = container.querySelectorAll('.toc-link');
    if ('IntersectionObserver' in window) {
      const io = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            links.forEach(function (l) { l.classList.remove('active'); });
            const active = container.querySelector('a[href="#' + entry.target.id + '"]');
            if (active) active.classList.add('active');
          }
        });
      }, { rootMargin: '0px 0px -70% 0px' });
      heads.forEach(function (h) { io.observe(h); });
    }
  }

  function initAutoTOC() {
    buildTOC();
    // rebuild TOC when language changes so headings stay in the active language
    if (window.SXS_i18n) {
      const orig = window.SXS_i18n.apply;
      window.SXS_i18n.apply = function () {
        orig.apply(this, arguments);
        buildTOC();
      };
    }
  }

  function boot() {
    initTheme();
    if (window.SXS_i18n) window.SXS_i18n.init();
    initLangSwitcher();
    initMobileNav();
    initScrollHeader();
    initFadeIn();
    initCopyButtons();
    initBackToTop();
    initActiveSidebar();
    initAutoTOC();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
