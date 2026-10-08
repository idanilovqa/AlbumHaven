(() => {
  const root = document.querySelector('[data-startup-progress]');
  if (!root) return;
  const bar = root.querySelector('[role="progressbar"]');
  const percentLabel = root.querySelector('[data-startup-percent]');
  const error = root.querySelector('[data-startup-error]');
  const previousInert = new Map();
  let completed = false;
  let percent = 0;
  let targetPercent = 0;
  let animationFrame = 0;
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  const hide = () => {
    root.hidden = true;
    previousInert.forEach((value, element) => { element.inert = value; });
    previousInert.clear();
  };
  const render = value => {
    percent = Math.round(value);
    bar.setAttribute('aria-valuenow', String(percent));
    root.querySelector('.progress-fill').style.width = `${percent}%`;
    percentLabel.textContent = `${percent}%`;
  };
  const finishHide = () => window.requestAnimationFrame(() => window.requestAnimationFrame(hide));
  const animate = () => {
    animationFrame = 0;
    if (percent < targetPercent) {
      render(Math.min(targetPercent, percent + Math.max(1, Math.ceil((targetPercent - percent) * 0.16))));
    }
    if (percent < targetPercent) animationFrame = window.requestAnimationFrame(animate);
    else if (completed && percent === 100) finishHide();
  };
  const show = value => {
    const next = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
    if (completed || next < targetPercent) return;
    targetPercent = next;
    root.hidden = false;
    for (const element of document.body.children) {
      if (element === root) continue;
      if (!previousInert.has(element)) previousInert.set(element, element.inert);
      element.inert = true;
    }
    if (reducedMotion) {
      render(next);
      return;
    }
    if (!animationFrame) animationFrame = window.requestAnimationFrame(animate);
  };
  window.AlbumHavenStartupProgress = {
    show,
    finish() {
      if (completed) return;
      show(100);
      completed = true;
      if (reducedMotion || percent === 100) finishHide();
    },
    fail() {
      if (completed || root.hidden) return;
      completed = true;
      error.hidden = false;
      bar.hidden = true;
      root.querySelector('[data-startup-retry]').focus();
    },
    reset() {
      completed = false; targetPercent = 0;
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      animationFrame = 0;
      render(0); error.hidden = true; bar.hidden = false; hide();
    },
  };
  root.querySelector('[data-startup-retry]').addEventListener('click', () => window.location.reload());
  document.addEventListener('error', event => {
    if (event.target?.tagName === 'SCRIPT' && /(?:runtime-bundle|app)\.js(?:[?]|$)/.test(event.target.src || '')) {
      window.AlbumHavenStartupProgress.fail();
    }
  }, true);
  window.addEventListener('error', () => window.AlbumHavenStartupProgress.fail());
  if (root.dataset.startupProgress === '50') show(50);
})();
