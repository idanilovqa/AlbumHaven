function buildMissingAlbumMarkHtml() {
  return `<span class="album-artbox__missing-mark" aria-hidden="true">
    <svg viewBox="0 0 96 96">
      <circle class="album-artbox__missing-disc" cx="48" cy="48" r="31"></circle>
      <circle class="album-artbox__missing-groove" cx="48" cy="48" r="23"></circle>
      <circle class="album-artbox__missing-groove" cx="48" cy="48" r="17"></circle>
      <circle class="album-artbox__missing-label" cx="48" cy="48" r="10"></circle>
      <circle class="album-artbox__missing-hub" cx="48" cy="48" r="3"></circle>
      <path class="album-artbox__missing-slash" d="M22 22 74 74"></path>
    </svg>
  </span>`;
}

function buildAlbumArtboxHtml(config = {}) {
  const requestedState = String(config.state || '').trim().toLowerCase();
  const state = ['ready', 'loading', 'empty', 'missing'].includes(requestedState)
    ? requestedState
    : 'empty';
  const label = String(config.label || 'Album artwork').trim();
  const coverHtml = String(config.coverHtml || '');
  const actionHtml = String(config.actionHtml || '');
  const content = state === 'missing' || state === 'empty'
    ? buildMissingAlbumMarkHtml()
    : (coverHtml || `<span class="album-artbox__placeholder">${state === 'loading' ? 'Loading cover art' : 'No cover art'}</span>`);
  return `<span class="album-artbox album-artbox--${state}" data-album-artbox-state="${state}" aria-label="${escapeHtml(label)}">${content}${actionHtml ? `<span class="album-artbox__action">${actionHtml}</span>` : ''}</span>`;
}

function buildUtilityAlbumArtbox(album, { label = 'Album artwork', interactive = false, source = '' } = {}) {
  const preview = source || album?.cover_url || buildAlbumDisplayCoverUrl(album);
  const fullSource = album?.cover_url || buildAlbumLightboxCoverUrl(album) || preview;
  const artbox = buildAlbumArtboxHtml({
    state: preview ? 'ready' : 'missing', label,
    coverHtml: preview ? `<img class="utility-detail-cover-image" src="${escapeHtml(preview)}" alt="${escapeHtml(label)}" loading="${interactive ? 'eager' : 'lazy'}" decoding="async" data-cover-path="${escapeHtml(album?.cover_path || '')}" data-remote-cover-url="${escapeHtml(album?.remote_cover_url || album?.remote_cover_thumbnail_url || '')}" onerror="handleUtilityAlbumArtboxError(this)">` : '',
  });
  return interactive && preview
    ? `<button type="button" class="utility-artbox-trigger" data-open-lightbox="1" data-cover-src="${escapeHtml(fullSource)}" data-cover-alt="${escapeHtml(label)}" aria-label="${escapeHtml(`Enlarge ${label}`)}">${artbox}</button>`
    : artbox;
}

function handleUtilityAlbumArtboxError(image) {
  if (!image) return;
  const fallback = String(image.getAttribute('data-remote-cover-url') || '').trim();
  if (fallback && image.dataset.remoteCoverTried !== '1') {
    image.dataset.remoteCoverTried = '1';
    image.src = fallback;
    const trigger = image.closest('[data-open-lightbox]');
    trigger?.setAttribute('data-cover-src', fallback);
    return;
  }
  const artbox = image.closest('.album-artbox');
  if (!artbox) return;
  const label = artbox.getAttribute('aria-label') || 'Album artwork';
  const trigger = artbox.closest('.utility-artbox-trigger');
  const target = trigger || artbox;
  target.outerHTML = buildAlbumArtboxHtml({ state: 'missing', label });
}
