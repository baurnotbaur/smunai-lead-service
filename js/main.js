(() => {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- NAV SCROLL STATE ---------- */
  const nav = document.getElementById('nav');
  const toTop = document.getElementById('toTop');
  const stickyCta = document.getElementById('stickyCta');
  const progressBar = document.getElementById('progressBar');
  const hero = document.getElementById('hero');

  /* ---------- PIN / STICKY REVEAL: LOGO -> STATION (state needed by onScroll below) ---------- */
  const pinSection = document.querySelector('.pin-section');
  const revealStage = document.getElementById('revealStage');
  const revealLogo = document.getElementById('revealLogo');
  const logoStartMarker = document.getElementById('logoStartMarker');
  const logoTarget = document.getElementById('logoTarget');
  const stationScene = document.getElementById('stationScene');

  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const smoothstep = (t) => t * t * (3 - 2 * t);

  const revealCache = { ready: false };

  function measureReveal() {
    if (!revealStage || !logoStartMarker || !logoTarget || !revealLogo) return;
    const stageRect = revealStage.getBoundingClientRect();
    const sRect = logoStartMarker.getBoundingClientRect();
    const tRect = logoTarget.getBoundingClientRect();
    if (stageRect.width === 0) return;

    revealCache.stageW = stageRect.width;
    revealCache.start = { x: sRect.left - stageRect.left, y: sRect.top - stageRect.top, w: sRect.width, h: sRect.height };
    revealCache.target = { x: tRect.left - stageRect.left, y: tRect.top - stageRect.top, w: tRect.width, h: tRect.height };
    revealCache.startScale = revealCache.start.w / revealCache.stageW;
    revealCache.targetScale = revealCache.target.w / revealCache.stageW;
    revealCache.aspect = (revealLogo.naturalHeight && revealLogo.naturalWidth)
      ? revealLogo.naturalHeight / revealLogo.naturalWidth
      : 207 / 1230;
    revealCache.ready = true;
  }

  window.addEventListener('load', measureReveal);
  if (revealLogo) {
    if (revealLogo.complete) measureReveal();
    else revealLogo.addEventListener('load', measureReveal);
  }

  function updatePinSection() {
    if (!pinSection) return;
    const rect = pinSection.getBoundingClientRect();
    const total = rect.height - window.innerHeight;
    if (total <= 0) return;
    let progress = (-rect.top) / total;
    progress = clamp01(progress);

    if (revealLogo && revealCache.ready) {
      const ease = smoothstep(progress);
      const scale = lerp(revealCache.startScale, revealCache.targetScale, ease);
      const startCenterY = revealCache.start.y + (revealCache.start.h - revealCache.stageW * revealCache.startScale * revealCache.aspect) / 2;
      const targetCenterY = revealCache.target.y + (revealCache.target.h - revealCache.stageW * revealCache.targetScale * revealCache.aspect) / 2;
      const x = lerp(revealCache.start.x, revealCache.target.x, ease);
      const y = lerp(startCenterY, targetCenterY, ease);
      revealLogo.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    }

    if (stationScene) {
      const sp = smoothstep(clamp01((progress - 0.1) / 0.7));
      stationScene.style.opacity = sp;
      stationScene.style.transform = `scale(${0.82 + 0.18 * sp})`;
    }
  }

  function onScroll() {
    const y = window.scrollY;
    nav.classList.toggle('scrolled', y > 20);
    toTop.classList.toggle('show', y > 700);

    if (stickyCta) {
      const heroBottom = hero.offsetTop + hero.offsetHeight;
      stickyCta.classList.toggle('show', y > heroBottom);
    }

    const docH = document.documentElement.scrollHeight - window.innerHeight;
    progressBar.style.width = docH > 0 ? `${(y / docH) * 100}%` : '0%';

    updatePinSection();
  }
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
  updatePinSection();

  toTop.addEventListener('click', () => window.scrollTo({ top: 0, behavior: reducedMotion ? 'auto' : 'smooth' }));

  /* ---------- RESIZE: re-measure reveal geometry ---------- */
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      measureReveal();
      updatePinSection();
    }, 150);
  });

  /* ---------- REVEAL ON SCROLL ---------- */
  const revealEls = document.querySelectorAll('[data-reveal]');
  const revealObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        revealObserver.unobserve(entry.target);
      }
    });
  }, { threshold: 0.15, rootMargin: '0px 0px -60px 0px' });
  revealEls.forEach(el => revealObserver.observe(el));

  /* ---------- COUNT UP (trust numbers) ---------- */
  const countEls = document.querySelectorAll('[data-count]');
  const countObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const el = entry.target;
      const target = parseFloat(el.dataset.count);
      const duration = 1200;
      const start = performance.now();
      function tick(now) {
        const progress = Math.min((now - start) / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        el.textContent = Math.round(target * eased);
        if (progress < 1) requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
      countObserver.unobserve(el);
    });
  }, { threshold: 0.4 });
  countEls.forEach(el => countObserver.observe(el));

  /* ---------- TOAST ---------- */
  const toast = document.getElementById('toast');
  let toastTimer;
  function showToast(msg) {
    toast.textContent = msg;
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 3600);
  }

  /* ---------- LEAD FORM ----------
     Заявка уходит в сервис отдела продаж (папка lead-service).
     Адрес и ключ задаются в index.html через window.LEADS_CONFIG.
     Если сервис не настроен — форма работает как раньше, в демо-режиме. */
  const leadForm = document.getElementById('leadForm');
  const leadsCfg = window.LEADS_CONFIG || {};

  leadForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = document.getElementById('leadName').value.trim();
    const phone = document.getElementById('leadPhone').value.trim();
    const thanks = `Спасибо${name ? ', ' + name : ''}! Заявка принята — перезвоним в течение 15 минут.`;

    if (!leadsCfg.endpoint || !leadsCfg.key) {
      showToast(thanks);
      leadForm.reset();
      return;
    }

    const button = leadForm.querySelector('[type="submit"]');
    const label = button.textContent;
    button.disabled = true;
    button.textContent = 'Отправляем…';

    try {
      const res = await fetch(leadsCfg.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: leadsCfg.key,
          name,
          phone,
          form_id: 'leadForm',
          page_url: location.href,
          referrer: document.referrer,
          ...utmParams(),
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.message || 'Не удалось отправить заявку');
      showToast(thanks);
      leadForm.reset();
    } catch (err) {
      showToast('Не удалось отправить заявку. Позвоните нам — мы на связи.');
      console.error('[lead]', err);
    } finally {
      button.disabled = false;
      button.textContent = label;
    }
  });

  /* UTM-метки текущего визита: сохраняем при первом заходе и шлём вместе с заявкой */
  function utmParams() {
    const keys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
    const q = new URLSearchParams(location.search);
    const fresh = {};
    keys.forEach(k => { if (q.get(k)) fresh[k] = q.get(k).slice(0, 120); });
    try {
      if (Object.keys(fresh).length) {
        localStorage.setItem('ld_attribution', JSON.stringify(fresh));
        return fresh;
      }
      return JSON.parse(localStorage.getItem('ld_attribution') || '{}');
    } catch {
      return fresh;
    }
  }
})();
