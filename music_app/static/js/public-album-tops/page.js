/* Metadata-only document. The server owns admission; no private app is started. */
(() => {
  'use strict';
  let page = null, payloadNode = null, content = null, payload = null, retired = false;
  const genericTitle = 'Shared Album Top · AlbumHaven';
  function currentNodes() {
    page = document.getElementById('public-album-top-page');
    payloadNode = document.getElementById('public-album-top-data');
    content = document.getElementById('public-album-top-content');
  }
  function clear(message) {
    retired = true;
    document.title = genericTitle;
    currentNodes();
    if (payloadNode) { payloadNode.textContent = ''; payloadNode.remove(); }
    if (content) content.replaceChildren();
    payloadNode = null; content = null; payload = null;
    if (!page) return;
    document.getElementById('public-album-top-loading')?.remove();
    const status = document.createElement('p');
    status.setAttribute('role', 'status');
    status.textContent = message;
    page.replaceChildren(status);
    page.hidden = false;
  }
  function retire() { clear('Loading published metadata…'); }
  window.addEventListener('pagehide', retire);
  window.addEventListener('pageshow', event => {
    if (!event.persisted) return;
    retire();
    // A restored document must obtain a fresh checked response, never its DTO.
    try { window.location.reload(); } catch (_) { /* Keep retired metadata empty. */ }
  });

  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const itemKeys = ['item_ref', 'original_position', 'curator_position', 'album_ref', 'presentation_ref',
    'title', 'artist', 'year', 'artwork_ref', 'details_path'];
  function requireValue(condition) { if (!condition) throw new TypeError('Invalid published metadata.'); }
  function record(value, keys) {
    requireValue(value !== null && typeof value === 'object' && !Array.isArray(value));
    requireValue(Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)));
    return value;
  }
  function identity(value) { requireValue(typeof value === 'string' && uuid.test(value)); return value; }
  function integer(value, minimum = 1, maximum = 5000) {
    requireValue(Number.isSafeInteger(value) && value >= minimum && value <= maximum); return value;
  }
  function decimal(value) {
    requireValue(typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value)
      && (value.length < 19 || value <= '9223372036854775807'));
    return value;
  }
  function text(value, maximum = 1000, empty = false) {
    requireValue(typeof value === 'string' && !/[\x00-\x1f\x7f]/.test(value) && (empty || value.trim() !== ''));
    const characters = Array.from(value);
    requireValue(characters.length <= maximum && characters.every(character => {
      const code = character.codePointAt(0); return code < 0xd800 || code > 0xdfff;
    }));
    return value;
  }
  function item(value, share) {
    record(value, itemKeys);
    identity(value.item_ref); identity(value.album_ref); identity(value.presentation_ref);
    decimal(value.original_position); integer(value.curator_position);
    text(value.title); text(value.artist);
    if (value.year !== null) integer(value.year, 1, 9999);
    requireValue(value.artwork_ref === null);
    requireValue(value.details_path === `/public/album-tops/${share}/items/${value.item_ref}`);
    return value;
  }
  function rows(values, maximum, position, ref, validate) {
    requireValue(Array.isArray(values) && values.length <= maximum);
    const seen = new Set(); let previous = null;
    for (const value of values) {
      validate(value);
      requireValue(!seen.has(value[ref]) && (previous === null || value[position] === previous + 1));
      seen.add(value[ref]); previous = value[position];
    }
  }
  function validate(payload) {
    record(payload, ['kind', 'share_ref', 'item_ref', 'limit', 'data']);
    requireValue(payload.kind === 'top' || payload.kind === 'item');
    identity(payload.share_ref);
    const isItem = payload.kind === 'item';
    if (isItem) identity(payload.item_ref); else requireValue(payload.item_ref === null);
    integer(payload.limit, 1, isItem ? 250 : 100);
    const path = `/public/album-tops/${payload.share_ref}${isItem ? `/items/${payload.item_ref}` : ''}`;
    requireValue(window.location.pathname === path);
    const query = [...new URLSearchParams(window.location.search)];
    requireValue(query.length <= 2 && new Set(query.map(([key]) => key)).size === query.length);
    let limit = isItem ? 100 : 50, hasCursor = false;
    for (const [key, value] of query) {
      requireValue(key === 'cursor' || key === 'limit');
      if (key === 'limit') {
        requireValue(/^[1-9][0-9]{0,2}$/.test(value)); limit = Number(value);
      } else { requireValue(value.length >= 1 && value.length <= 4096); hasCursor = true; }
    }
    requireValue(limit === payload.limit);
    const common = ['share_ref', 'publication_ref', 'publication_revision', 'next_cursor', 'allowed_actions'];
    const data = record(payload.data, [...common, ...(isItem ? ['item', 'tracks', 'track_count'] : ['title', 'description', 'items'])]);
    requireValue(data.share_ref === payload.share_ref);
    identity(data.publication_ref); decimal(data.publication_revision);
    record(data.allowed_actions, ['can_read', 'can_open_item']);
    requireValue(data.allowed_actions.can_read === true && data.allowed_actions.can_open_item === true);
    requireValue(data.next_cursor === null || typeof data.next_cursor === 'string'
      && data.next_cursor.length >= 1 && data.next_cursor.length <= 4096);
    if (isItem) {
      item(data.item, payload.share_ref); requireValue(data.item.item_ref === payload.item_ref);
      integer(data.track_count, 0);
      rows(data.tracks, payload.limit, 'position', 'track_ref', track => {
        record(track, ['track_ref', 'position', 'title', 'artist', 'duration_ms']);
        identity(track.track_ref); integer(track.position); text(track.title); text(track.artist);
        if (track.duration_ms !== null) integer(track.duration_ms, 0, 2147483647);
      });
      requireValue(data.tracks.length <= data.track_count && (!data.tracks.length || data.tracks.at(-1).position <= data.track_count));
      requireValue(hasCursor || !data.tracks.length || data.tracks[0].position === 1);
      requireValue(data.next_cursor === null || data.tracks.length === payload.limit && data.tracks.at(-1).position < data.track_count);
    } else {
      text(data.title, 100); text(data.description, 1000, true);
      rows(data.items, payload.limit, 'curator_position', 'item_ref', value => item(value, payload.share_ref));
      requireValue(hasCursor || !data.items.length || data.items[0].curator_position === 1);
      requireValue(data.next_cursor === null || data.items.length === payload.limit);
    }
    return payload;
  }
  function artwork(title) { return buildAlbumArtboxHtml({state: 'empty', label: `Artwork unavailable: ${title}`}); }
  function duration(milliseconds) {
    if (milliseconds === null) return '—';
    const seconds = Math.floor(milliseconds / 1000), hours = Math.floor(seconds / 3600);
    const minutes = Math.floor(seconds / 60) % 60, remainder = String(seconds % 60).padStart(2, '0');
    return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${remainder}` : `${minutes}:${remainder}`;
  }
  function gallery(data) {
    if (!data.items.length) return '<p class="public-album-top__empty" role="status">This published Top has no albums.</p>';
    return `<div class="public-album-top__gallery">${data.items.map(value => {
      const card = buildGalleryCardHtml({interaction: 'none', displayMode: 'cards',
        identity: value.item_ref, title: value.title, artist: value.artist, year: value.year,
        artboxHtml: artwork(value.title), listeningSummaryHtml: ''});
      return `<a class="public-album-top__card-link" href="${escapeHtml(value.details_path)}" aria-label="${escapeHtml(`Open ${value.title}, album ${value.curator_position}`)}">${card}</a>`;
    }).join('')}</div>`;
  }
  function detail(data) {
    const value = data.item;
    const header = buildAlbumDetailsHeaderHtml({variant: 'copy', title: value.title,
      subtitle: [value.artist, value.year].filter(part => part !== null).join(' · '),
      eyebrow: `Album ${value.curator_position}`, titleId: 'public-album-title',
      subtitleId: 'public-album-subtitle', actionsHtml: ''});
    const tracks = data.tracks.length ? buildAlbumTrackTableHtml({
      readOnly: true, showPath: false, showLove: false, subjectTaste: false, showProblem: false,
      selection: 'none', sectionActions: false, playingAnimation: false,
      ariaLabel: 'Published album tracks', idPrefix: 'public-album',
      groups: [{tracks: data.tracks.map(track => ({trackNumber: track.position, title: track.title,
        secondaryArtist: track.artist, duration: duration(track.duration_ms)}))}],
    }) : '<p class="public-album-top__empty" role="status">No tracks on this published page.</p>';
    return `<section class="public-album-top__detail" aria-labelledby="public-album-title"><div class="public-album-top__album-heading"><div class="public-album-top__artwork">${artwork(value.title)}</div>${header}</div><p class="public-album-top__track-count">${data.track_count} published track${data.track_count === 1 ? '' : 's'} · ${data.tracks.length} on this page</p>${tracks}</section>`;
  }
  function render() {
    currentNodes();
    if (retired) { retire(); return; }
    if (!page) return;
    try {
      requireValue(payloadNode && content && page.contains(payloadNode) && page.contains(content));
      requireValue(payloadNode.textContent.length <= 8000000);
      payload = validate(JSON.parse(payloadNode.textContent));
      const html = payload.kind === 'top' ? gallery(payload.data) : detail(payload.data);
      if (!retired) content.innerHTML = html;
      if (!retired) {
        document.getElementById('public-album-top-loading')?.remove();
        page.hidden = false;
      }
    } catch (_) {
      if (!retired) clear('This shared Album Top is unavailable.');
    } finally {
      payload = null;
      if (payloadNode) { payloadNode.textContent = ''; payloadNode.remove(); }
      payloadNode = null;
    }
  }
  // This entry registers retirement before parsing approved document metadata.
  // Deferred native builders finish before DOMContentLoaded invokes rendering.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render, {once: true});
  else render();
})();
