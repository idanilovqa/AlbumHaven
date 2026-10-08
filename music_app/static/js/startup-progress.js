(() => {
  const root = document.querySelector('[data-startup-progress]');
  if (!root) return;
  const bar = root.querySelector('[role="progressbar"]');
  const error = root.querySelector('[data-startup-error]');
  const previousInert = new Map();
  let completed = false;
  let percent = 0;
  const hide = () => {
    root.hidden = true;
    previousInert.forEach((value, element) => { element.inert = value; });
    previousInert.clear();
  };
  const show = value => {
    if (completed || value < percent) return;
    percent = value;
    root.hidden = false;
    for (const element of document.body.children) {
      if (element === root) continue;
      if (!previousInert.has(element)) previousInert.set(element, element.inert);
      element.inert = true;
    }
    bar.setAttribute('aria-valuenow', String(value));
    root.querySelector('.progress-fill').style.width = `${value}%`;
  };
  window.AlbumHavenStartupProgress = {
    show,
    finish() {
      if (completed) return;
      show(100);
      completed = true;
      window.requestAnimationFrame(() => window.requestAnimationFrame(hide));
    },
    fail() {
      if (completed || root.hidden) return;
      completed = true;
      error.hidden = false;
      bar.hidden = true;
      root.querySelector('[data-startup-retry]').focus();
    },
    reset() { completed = false; percent = 0; error.hidden = true; bar.hidden = false; hide(); },
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
