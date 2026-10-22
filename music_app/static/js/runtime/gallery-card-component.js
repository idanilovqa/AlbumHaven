function buildGalleryCardHtml(config = {}) {
  const interaction = config.interaction === undefined ? 'native' : config.interaction;
  if (!['native', 'controlled', 'none'].includes(interaction)) throw new TypeError('Unknown GalleryCard interaction.');
  if (interaction !== 'native') return buildControlledGalleryCardHtml(config);
  const displayMode = ['list', 'cards', 'covers'].includes(config.displayMode) ? config.displayMode : 'cards';
  const releaseYear = displayMode === 'covers' ? String(config.year ?? '').trim() : '';
  const openAttributes = `data-open-tracklist="1" data-album-key="${escapeHtml(config.albumKey || '')}" data-album-version-key="${escapeHtml(config.albumVersionKey || '')}" data-album="${escapeHtml(config.albumFallback || '')}"`;
  return `
    <section class="album-card${config.isSearchMatch === true ? ' album-card--search-match' : ''}" data-gallery-display="${displayMode}"${releaseYear ? ` data-gallery-release-year="${escapeHtml(releaseYear)}"` : ''} data-gallery-card-key="${escapeHtml(config.identity || '')}" data-gallery-card-render-key="${escapeHtml(config.renderKey || '')}">
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
    label: 'Open', ariaLabel: `Open ${title}`, size: 'small', disabled: config.openDisabled === true, attributes: attributes('open'),
  }) : '';
  const play = can('play') ? ButtonComponent.renderActionButton({
    ariaLabel: `Play ${title}`, icon: 'play', presentation: 'bare', attributes: attributes('play'),
  }) : '';
  const completion = can('complete') && typeof config.completion?.completed === 'boolean'
    ? ButtonComponent.renderActionButton({
      ariaLabel: config.completion.label || `${config.completion.completed ? 'Clear completion' : 'Mark completed'}: ${title}`,
      title: config.completion.label || `${config.completion.completed ? 'Clear completion' : 'Mark completed'}: ${title}`,
      icon: 'complete', presentation: 'bare', disabled: config.completion.disabled === true,
      pressed: config.completion.completed,
      attributes: {...attributes('complete'), 'aria-pressed': String(config.completion.completed)},
    }) : '';
  const information = displayMode === 'covers' ? `<span class="gallery-card__focus-title">${escapeHtml(title)}</span>`
    : buildGalleryCardInfoHtml({ ...config, openAttributes: '' });
  return `<section class="album-card${config.isSearchMatch === true ? ' album-card--search-match' : ''}" data-gallery-display="${displayMode}" data-gallery-card-interaction="${config.interaction}" data-gallery-card-key="${escapeHtml(config.identity || '')}" data-gallery-card-render-key="${escapeHtml(config.renderKey || '')}">${artwork}${information}${open || play || completion ? `<div class="gallery-card__actions">${open}${play}${completion}</div>` : ''}</section>`;
}

let galleryCardMetadataMotion = null;
function syncGalleryCardMetadataMotion(root) {
  const mobile = typeof usesMobilePageLayout === 'function' && usesMobilePageLayout();
  if (!mobile) { galleryCardMetadataMotion?.dispose(); return null; }
  if (typeof root?.querySelectorAll !== 'function' || typeof ResizeObserver !== 'function') return galleryCardMetadataMotion;
  if (!galleryCardMetadataMotion) {
    const controller = createGalleryCardMetadataMotion({onDispose() {
      if (galleryCardMetadataMotion === controller) galleryCardMetadataMotion = null;
    }});
    galleryCardMetadataMotion = controller;
  }
  galleryCardMetadataMotion.update(root);
  return galleryCardMetadataMotion;
}

const resourceGalleryMetadataOwners = new WeakMap();
function createGalleryCardMetadataMotion({root = null, isCurrent = () => true, onDispose = () => {}} = {}) {
    if (root && (root.ownerDocument !== document || typeof root.querySelectorAll !== 'function')) {
      throw new TypeError('A native Gallery metadata root is required.');
    }
    if (typeof ResizeObserver !== 'function') return null;
    const rows = new Map();
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0, disposed = false;
    const current = () => !disposed && (!root || resourceGalleryMetadataOwners.get(root) === controller)
      && isCurrent() === true && !disposed && (!root || resourceGalleryMetadataOwners.get(root) === controller);
    const refresh = () => {
      if (disposed) return;
      frame = 0;
      if (!current()) {controller.dispose(); return;}
      for (const [row, text] of rows) {
        if (!row.isConnected || !text.isConnected || text.parentElement !== row
          || !text.matches('[data-gallery-metadata-text]') || root && !root.contains(row)) {
          observer.unobserve(row); observer.unobserve(text); rows.delete(row);
          if (!root || root.contains(row)) row.classList.remove('is-card-text-overflowing');
          continue;
        }
        const mobile = !root || typeof usesMobilePageLayout === 'function' && usesMobilePageLayout();
        const motion = mobile && !reduced.matches ? resolveCompactPlayerMetadataRowMotion({ clientWidth: row.clientWidth, scrollWidth: text.scrollWidth }) : { overflowing: false, distance: 0, durationMs: 0 };
        if (!current()) {controller.dispose(); return;}
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
      update(nextRoot = root) {
        if (disposed) return;
        if (!current()) {controller.dispose(); return;}
        if (!nextRoot || root && nextRoot !== root) throw new TypeError('Gallery metadata cannot change its resource root.');
        nextRoot.querySelectorAll('.album-card [data-gallery-metadata-text]').forEach(text => {
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
        const ownsRoot = !root || resourceGalleryMetadataOwners.get(root) === controller;
        if (root && ownsRoot) resourceGalleryMetadataOwners.delete(root);
        if (ownsRoot) for (const row of rows.keys()) {
          if (!root || root.contains(row)) row.classList.remove('is-card-text-overflowing');
        }
        rows.clear();
        onDispose();
      },
    };
    if (root) {
      const previous = resourceGalleryMetadataOwners.get(root);
      resourceGalleryMetadataOwners.set(root, controller);
      previous?.dispose();
      if (!current()) controller.dispose();
      else controller.update();
    }
    return controller;
}
