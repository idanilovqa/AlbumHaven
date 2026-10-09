function buildGalleryCardHtml(config = {}) {
  const interaction = config.interaction === undefined ? 'native' : config.interaction;
  if (!['native', 'controlled', 'none'].includes(interaction)) throw new TypeError('Unknown GalleryCard interaction.');
  if (interaction !== 'native') return buildControlledGalleryCardHtml(config);
  const displayMode = ['list', 'cards', 'covers'].includes(config.displayMode) ? config.displayMode : 'cards';
  const releaseYear = displayMode === 'covers' ? String(config.year ?? '').trim() : '';
  const openAttributes = `data-open-tracklist="1" data-album-key="${escapeHtml(config.albumKey || '')}" data-album-version-key="${escapeHtml(config.albumVersionKey || '')}" data-album="${escapeHtml(config.albumFallback || '')}"`;
  return `
    <section class="album-card" data-gallery-display="${displayMode}"${releaseYear ? ` data-gallery-release-year="${escapeHtml(releaseYear)}"` : ''} data-gallery-card-key="${escapeHtml(config.identity || '')}" data-gallery-card-render-key="${escapeHtml(config.renderKey || '')}">
      <button class="album-card__artbox-trigger album-open-trigger cover" type="button" ${openAttributes} aria-label="${escapeHtml(config.openLabel || `Open ${config.title || 'album'} tracklist`)}">
        ${String(config.artboxHtml || '')}
      </button>
      ${releaseYear ? `<span class="gallery-card__hover-year" aria-hidden="true">${escapeHtml(releaseYear)}</span>` : ''}
      ${displayMode === 'covers'
        ? `<span class="gallery-card__focus-title">${escapeHtml(config.title || '')}</span>`
        : buildGalleryCardInfoHtml({ ...config, openAttributes })}
    </section>
  `;
}


function buildControlledGalleryCardHtml(config) {
  const displayMode = ['list', 'cards', 'covers'].includes(config.displayMode) ? config.displayMode : 'cards';
  const ref = typeof config.actionRef === 'string' && config.actionRef.trim() ? config.actionRef : '';
  const can = intent => config.interaction === 'controlled' && ref !== '' && config.actions?.[intent] === true;
  const attributes = intent => ({ 'data-gallery-card-intent': intent, 'data-gallery-card-ref': ref });
  const title = String(config.title || 'album');
  const artbox = String(config.artboxHtml || '');
  const artwork = can('select')
    ? `<button class="album-card__artbox-trigger cover" type="button" data-gallery-card-intent="select" data-gallery-card-ref="${escapeHtml(ref)}" aria-label="${escapeHtml(`Select ${title}`)}" aria-pressed="false">${artbox}</button>`
    : `<div class="album-card__artbox-trigger cover">${artbox}</div>`;
  const open = can('open') ? ButtonComponent.renderButton({
    label: 'Open', ariaLabel: `Open ${title}`, size: 'small', attributes: attributes('open'),
  }) : '';
  const play = can('play') ? ButtonComponent.renderActionButton({
    ariaLabel: `Play ${title}`, icon: 'play', presentation: 'bare', attributes: attributes('play'),
  }) : '';
  const information = displayMode === 'covers' ? `<span class="gallery-card__focus-title">${escapeHtml(title)}</span>`
    : buildGalleryCardInfoHtml({ ...config, openAttributes: '' });
  return `<section class="album-card" data-gallery-display="${displayMode}" data-gallery-card-interaction="${config.interaction}" data-gallery-card-key="${escapeHtml(config.identity || '')}" data-gallery-card-render-key="${escapeHtml(config.renderKey || '')}">${artwork}${information}${open || play ? `<div class="gallery-card__actions">${open}${play}</div>` : ''}</section>`;
}

let galleryCardMetadataMotion = null;
function syncGalleryCardMetadataMotion(root) {
  const mobile = typeof usesMobilePageLayout === 'function' && usesMobilePageLayout();
  if (!mobile) { galleryCardMetadataMotion?.dispose(); return null; }
  if (typeof root?.querySelectorAll !== 'function' || typeof ResizeObserver !== 'function') return galleryCardMetadataMotion;
  if (!galleryCardMetadataMotion) {
    const rows = new Map();
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0, disposed = false;
    const refresh = () => {
      if (disposed) return;
      frame = 0;
      for (const [row, text] of rows) {
        if (!row.isConnected) { observer.unobserve(row); observer.unobserve(text); rows.delete(row); continue; }
        const motion = !reduced.matches ? resolveCompactPlayerMetadataRowMotion({ clientWidth: row.clientWidth, scrollWidth: text.scrollWidth }) : { overflowing: false, distance: 0, durationMs: 0 };
        row.classList.toggle('is-card-text-overflowing', motion.overflowing);
        row.style.setProperty('--card-text-distance', `${motion.distance}px`);
        row.style.setProperty('--card-text-duration', `${motion.durationMs}ms`);
      }
    };
    const schedule = () => { if (!disposed && !frame) frame = requestAnimationFrame(refresh); };
    const observer = new ResizeObserver(schedule);
    reduced.addEventListener('change', schedule);
    document.fonts?.ready.then(schedule);
    const controller = {
      update(root) {
        if (disposed) return;
        root.querySelectorAll('.album-card [data-gallery-metadata-text]').forEach(text => {
          const row = text.parentElement, previous = rows.get(row);
          if (previous === text) return;
          if (previous) observer.unobserve(previous);
          rows.set(row, text); observer.observe(row); observer.observe(text);
        });
        schedule();
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        observer.disconnect(); reduced.removeEventListener('change', schedule);
        for (const row of rows.keys()) row.classList.remove('is-card-text-overflowing');
        rows.clear();
        if (galleryCardMetadataMotion === controller) galleryCardMetadataMotion = null;
      },
    };
    galleryCardMetadataMotion = controller;
  }
  galleryCardMetadataMotion.update(root);
  return galleryCardMetadataMotion;
}
