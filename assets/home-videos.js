(() => {
  'use strict';
  const root = document.getElementById('homeVideoRoot');
  if (!root) return;
  const fallbackHtml = root.innerHTML;
  let items = [];
  let currentIndex = 0;
  let rotationTimer = null;
  let intervalMs = 8000;

  const escapeHtml = value => String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
  const safeMediaPath = value => {
    const path = String(value || '').trim();
    return !path || /^(javascript|data):/i.test(path) ? '' : path;
  };
  const stopRotation = () => {
    if (rotationTimer) window.clearInterval(rotationTimer);
    rotationTimer = null;
  };
  const playVisibleVideos = () => {
    root.querySelectorAll('video').forEach(video => {
      video.muted = true;
      const promise = video.play();
      if (promise?.catch) promise.catch(() => {});
    });
  };
  function startRotation() {
    stopRotation();
    if (items.length < 2 || document.hidden || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    rotationTimer = window.setInterval(() => showPair(currentIndex + 1), intervalMs);
  }
  function showPair(index) {
    if (!items.length) return;
    currentIndex = (index + items.length) % items.length;
    const shown = items.length === 1 ? [items[0]] : [items[currentIndex], items[(currentIndex + 1) % items.length]];
    root.innerHTML = `
      <div class="home-video-grid">
        ${shown.map(item => `<div class="home-video-tile">
          <video autoplay muted loop playsinline preload="metadata" aria-label="${escapeHtml(item.title || 'Intervention AS Encombrants')}"><source src="${escapeHtml(safeMediaPath(item.src))}"></video>
          <div class="home-video-caption">${escapeHtml(item.title || 'Intervention rapide et soignée')}</div>
        </div>`).join('')}
      </div>
      <div class="home-video-badge">Nos interventions</div>
      <div class="home-video-dots" aria-label="Choisir les vidéos">
        ${items.map((_, dotIndex) => `<button type="button" class="home-video-dot ${dotIndex === currentIndex ? 'active' : ''}" data-home-video-index="${dotIndex}" aria-label="Afficher à partir de la vidéo ${dotIndex + 1}"></button>`).join('')}
      </div>
      ${items.length > 1 ? `<div class="home-video-controls"><button type="button" class="home-video-control" data-home-video-action="previous" aria-label="Vidéos précédentes">‹</button><button type="button" class="home-video-control" data-home-video-action="next" aria-label="Vidéos suivantes">›</button></div>` : ''}`;
    root.querySelectorAll('[data-home-video-index]').forEach(button => button.addEventListener('click', () => { showPair(Number(button.dataset.homeVideoIndex)); startRotation(); }));
    root.querySelector('[data-home-video-action="previous"]')?.addEventListener('click', () => { showPair(currentIndex - 1); startRotation(); });
    root.querySelector('[data-home-video-action="next"]')?.addEventListener('click', () => { showPair(currentIndex + 1); startRotation(); });
    playVisibleVideos();
  }
  async function initializeHomeVideos() {
    try {
      const response = await fetch(`data/site-data.json?v=${Date.now()}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const settings = data.homeVideos || {};
      intervalMs = Math.max(4, Math.min(30, Number(settings.intervalSeconds || 8))) * 1000;
      items = [...(settings.items || [])].filter(item => item.visible !== false && safeMediaPath(item.src)).sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
      if (settings.enabled === false || !items.length) { root.innerHTML = fallbackHtml; return; }
      showPair(0);
      startRotation();
      if ('IntersectionObserver' in window) {
        new IntersectionObserver(entries => {
          if (entries[0]?.isIntersecting) { playVisibleVideos(); startRotation(); }
          else { root.querySelectorAll('video').forEach(video => video.pause()); stopRotation(); }
        }, { threshold: .15 }).observe(root);
      }
    } catch (error) {
      console.warn('Vidéos d’accueil indisponibles :', error);
      root.innerHTML = fallbackHtml;
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { root.querySelectorAll('video').forEach(video => video.pause()); stopRotation(); }
    else { playVisibleVideos(); startRotation(); }
  });
  initializeHomeVideos();
})();
