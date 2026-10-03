function buildGalleryCardHtml(config = {}) {
  const displayMode = ['list', 'cards', 'covers'].includes(config.displayMode) ? config.displayMode : 'cards';
  const releaseYear = displayMode === 'covers' ? String(config.year ?? '').trim() : '';
  const openAttributes = `data-open-tracklist="1" data-album-key="${escapeHtml(config.albumKey || '')}" data-album-version-key="${escapeHtml(config.albumVersionKey || '')}" data-album="${escapeHtml(config.albumFallback || '')}"`;
  const sourceCategories = ['main', 'hoard', 'new_arrivals'].filter((category) => (
    Array.isArray(config.sourceCategories) && config.sourceCategories.includes(category)
  ));
  const sourceColors = { main: 'var(--gallery-artbox-hover-frame, #fff)', hoard: 'var(--library-source-hoard)', new_arrivals: 'var(--library-source-arrivals)' };
  const sourceGradient = sourceCategories.length
    ? `conic-gradient(${sourceCategories.map((category, index) => `${sourceColors[category]} ${index * 100 / sourceCategories.length}% ${(index + 1) * 100 / sourceCategories.length}%`).join(', ')})`
    : 'none';
  const sourceAction = (category, label, drawing) => `<button class="ui-button ui-button--small gallery-source-action gallery-source-action--${category}" type="button" aria-label="${label}" ${openAttributes}><svg viewBox="0 0 48 48" aria-hidden="true" focusable="false">${drawing}</svg><span>${label}</span></button>`;
  const sourceActions = [
    sourceCategories.includes('hoard') ? sourceAction('hoard', 'Hoard', '<path d="M5 22v-7A10 10 0 0 1 15 5h18a10 10 0 0 1 10 10v7H5Zm1 0v19h36V22M5 18h38M13 6v12m22-12v12M13 23v17m22-17v17M8 41v3m32-3v3"/><rect x="19" y="21" width="10" height="13" rx="2"/><path d="M21 21v-3a3 3 0 0 1 6 0v3M24 26v3"/><path d="M9 12h.1M39 12h.1M9 28h.1M39 28h.1M9 35h.1M39 35h.1"/>') : '',
    sourceCategories.includes('new_arrivals') ? sourceAction('new_arrivals', 'New Arrivals', '<path d="M17 14a9 9 0 0 1 8-4h11a9 9 0 0 1 9 9v15H27V19a9 9 0 0 0-9-9M27 34h-9M30 34v12m3-12v12M34 15V2h7v4h-7"/><circle cx="16" cy="26" r="11"/><circle cx="16" cy="26" r="3"/><path d="M17 18a8 8 0 0 1 7 7M17 21a5 5 0 0 1 4 4M8 33l-6 5q8 3 16-1"/><path d="m8 5 1.2 3.8L13 10l-3.8 1.2L8 15l-1.2-3.8L3 10l3.8-1.2Z" fill="currentColor" stroke="none"/>') : '',
  ].join('');
  const duplicateAction = config.hasDuplicateFiles
    ? sourceAction('duplicate', 'Duplicate files', '<path d="M24 6 45 42H3Z"/><path d="M24 18v11m0 6v1"/>')
    : '';
  return `
    <section class="album-card" data-library-sources="${sourceCategories.join(' ')}" style="--library-source-gradient:${sourceGradient}" data-gallery-display="${displayMode}"${releaseYear ? ` data-gallery-release-year="${escapeHtml(releaseYear)}"` : ''} data-gallery-card-key="${escapeHtml(config.identity || '')}" data-gallery-card-render-key="${escapeHtml(config.renderKey || '')}">
      <button class="album-card__artbox-trigger album-open-trigger cover" type="button" ${openAttributes} aria-label="${escapeHtml(config.openLabel || `Open ${config.title || 'album'} tracklist`)}">
        ${String(config.artboxHtml || '')}
      </button>
      ${sourceActions || duplicateAction ? `<div class="gallery-card__source-overlay"><div class="gallery-card__source-actions">${sourceActions}</div>${duplicateAction}</div>` : ''}
      ${releaseYear ? `<span class="gallery-card__hover-year" aria-hidden="true">${escapeHtml(releaseYear)}</span>` : ''}
      ${displayMode === 'covers'
        ? `<span class="gallery-card__focus-title">${escapeHtml(config.title || '')}</span>`
        : buildGalleryCardInfoHtml({ ...config, openAttributes })}
    </section>
  `;
}

let galleryCardMetadataMotion = null;
function syncGalleryCardMetadataMotion(root) {
  const mobile = typeof usesMobilePageLayout === 'function' && usesMobilePageLayout();
  if (!mobile) { galleryCardMetadataMotion?.dispose(); galleryCardMetadataMotion = null; return; }
  if (!root?.querySelectorAll || typeof ResizeObserver !== 'function') return;
  if (!galleryCardMetadataMotion) {
    const rows = new Map();
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0, disposed = false;
    const refresh = () => {
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
    galleryCardMetadataMotion = {
      update(root) {
        root.querySelectorAll('.album-card [data-gallery-metadata-text]').forEach(text => {
          const row = text.parentElement, previous = rows.get(row);
          if (previous === text) return;
          if (previous) observer.unobserve(previous);
          rows.set(row, text); observer.observe(row); observer.observe(text);
        });
        schedule();
      },
      dispose() {
        disposed = true;
        if (frame) cancelAnimationFrame(frame);
        observer.disconnect(); reduced.removeEventListener('change', schedule);
        for (const row of rows.keys()) row.classList.remove('is-card-text-overflowing');
        rows.clear();
      },
    };
  }
  galleryCardMetadataMotion.update(root);
}
