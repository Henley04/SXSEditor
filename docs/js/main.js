document.addEventListener('DOMContentLoaded', () => {
  // 初始化 i18n
  i18n.init();

  // 语言切换按钮
  document.querySelectorAll('.lang-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const lang = btn.getAttribute('data-lang');
      i18n.setLang(lang);
      document.querySelectorAll('.lang-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    });

    // 初始化活跃状态
    if (btn.getAttribute('data-lang') === i18n.getLang()) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });

  // 导航栏滚动效果
  const nav = document.getElementById('nav');
  const scrollTop = document.getElementById('scrollTop');

  function onScroll() {
    if (window.scrollY > 50) {
      nav.classList.add('scrolled');
    } else {
      nav.classList.remove('scrolled');
    }

    // 回到顶部按钮
    if (window.scrollY > 600) {
      scrollTop.classList.add('visible');
    } else {
      scrollTop.classList.remove('visible');
    }
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  // 回到顶部
  scrollTop.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  // 移动端菜单
  const mobileMenuBtn = document.getElementById('mobileMenuBtn');
  const navLinks = document.getElementById('navLinks');

  mobileMenuBtn.addEventListener('click', () => {
    navLinks.classList.toggle('open');
  });

  // 点击导航链接后关闭移动端菜单
  navLinks.querySelectorAll('a').forEach(link => {
    link.addEventListener('click', () => {
      navLinks.classList.remove('open');
    });
  });

  // IntersectionObserver 滚动动画
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
        }
      });
    },
    { threshold: 0.1, rootMargin: '0px 0px -40px 0px' }
  );

  document.querySelectorAll('.fade-in').forEach(el => {
    observer.observe(el);
  });
});
