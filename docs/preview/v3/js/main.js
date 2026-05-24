document.addEventListener('DOMContentLoaded', () => {
  initI18n();
  initNav();
  initLangSwitcher();
  initScrollReveal();
  initSmoothScroll();
  initMobileMenu();
});

/* ===== Navigation scroll effect ===== */
function initNav() {
  const nav = document.querySelector('.nav');
  if (!nav) return;

  function updateNav() {
    if (window.scrollY > 20) {
      nav.classList.remove('transparent');
      nav.classList.add('solid');
    } else {
      nav.classList.remove('solid');
      nav.classList.add('transparent');
    }
  }

  updateNav();
  window.addEventListener('scroll', updateNav, { passive: true });
}

/* ===== Language switcher ===== */
function initLangSwitcher() {
  document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const lang = btn.getAttribute('data-lang');
      setLanguage(lang);
    });
  });
}

/* ===== Scroll reveal with IntersectionObserver ===== */
function initScrollReveal() {
  const elements = document.querySelectorAll('.section-reveal');
  if (!elements.length) return;

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('revealed');
        observer.unobserve(entry.target);
      }
    });
  }, {
    threshold: 0.1,
    rootMargin: '0px 0px -40px 0px'
  });

  elements.forEach(el => observer.observe(el));
}

/* ===== Smooth scroll for anchor links ===== */
function initSmoothScroll() {
  document.querySelectorAll('a[href^="#"]').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const targetId = link.getAttribute('href');
      const target = document.querySelector(targetId);
      if (target) {
        const navHeight = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--nav-height')) || 72;
        const top = target.getBoundingClientRect().top + window.scrollY - navHeight;
        window.scrollTo({ top, behavior: 'smooth' });
        // Close mobile menu if open
        const navLinks = document.querySelector('.nav-links');
        if (navLinks && navLinks.classList.contains('open')) {
          navLinks.classList.remove('open');
        }
      }
    });
  });
}

/* ===== Mobile menu toggle ===== */
function initMobileMenu() {
  const toggle = document.querySelector('.nav-mobile-toggle');
  const navLinks = document.querySelector('.nav-links');
  if (!toggle || !navLinks) return;

  toggle.addEventListener('click', () => {
    navLinks.classList.toggle('open');
  });

  // Close on click outside
  document.addEventListener('click', (e) => {
    if (!toggle.contains(e.target) && !navLinks.contains(e.target)) {
      navLinks.classList.remove('open');
    }
  });
}
