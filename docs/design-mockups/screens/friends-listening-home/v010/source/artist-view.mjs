/**
 * V007 review-only artist composition. It is not a production resource page.
 * The parent owns route/history, native artist-tree selection and preferences.
 * Native renderers own controls, art, row selection paint and ArtistInfo content.
 * No fetches, audio, persistence, global handlers or automatic navigation here.
 */

const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[character]));
const text = value => String(value ?? '').trim();
const albumId = album => text(album.id || album.key || album.album_ref);
const albumName = album => text(album.name || album.title) || 'Untitled release';

// Optional, explicitly fictional presentation metadata for the four existing
// fictional fixture artists. These are not real artist/release facts and are
// never written back into the seed arrays or native library state.
export const FICTIONAL_ARTIST_VIEW_METADATA = Object.freeze({
  north: Object.freeze({ yearsActive: '2014–present', connectedIds: Object.freeze(['cedar']) }),
  glass: Object.freeze({ yearsActive: '2018–present', connectedIds: Object.freeze(['sun']) }),
  sun: Object.freeze({ yearsActive: '2011–present', connectedIds: Object.freeze(['glass']) }),
  cedar: Object.freeze({ yearsActive: '2020–present', connectedIds: Object.freeze(['north']) }),
});
const FICTIONAL_RELEASE_TYPES = Object.freeze({
  a1: 'studio', a2: 'studio', a3: 'studio', a4: 'studio',
  a5: 'demo', a6: 'ep', a7: 'live', a8: 'ep',
});
const TYPE_LABELS = Object.freeze({
  studio: 'Studio albums', ep: 'EPs', live: 'Live albums', demo: 'Demos',
  single: 'Singles', compilation: 'Compilations', soundtrack: 'Soundtracks',
  other: 'Other releases', unknown: 'Unclassified releases',
});
const TYPE_ORDER = Object.keys(TYPE_LABELS);

// Exact native Cards glyph from buildGalleryBarHtml in the pinned runtime.
// Its native ActionButton wrapper supplies focus, hover, sizing and semantics.
const DISCOGRAPHY_EXPAND_GLYPH = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5M3 3l6 6M21 3l-6 6M3 21l6-6M21 21l-6-6"/></svg>';

function requireOwner(owners, name) {
  if (typeof owners?.[name] !== 'function') throw new TypeError(`Artist view requires the native ${name} owner.`);
  return owners[name];
}

function artistMetadata(artist, fictionalDefaults) {
  const defaults = fictionalDefaults ? FICTIONAL_ARTIST_VIEW_METADATA[artist.id] : null;
  const styles = Array.isArray(artist.styles) ? artist.styles : Array.isArray(artist.genres) ? artist.genres : [artist.genre];
  const activeYears = text(artist.yearsActive || artist.years_active || defaults?.yearsActive);
  return {
    name: text(artist.name) || 'Unknown artist',
    styles: styles.map(text).filter(Boolean).join(' · '),
    // A formation year alone is not evidence that an artist is still active.
    years: activeYears || (text(artist.formed) ? `Formed ${text(artist.formed)}` : 'Active years unavailable'),
  };
}

/** Reusable identity for the parent's compact ArtistInfo module header too. */
export function renderArtistIdentity(artist, { fictionalDefaults = false, heading = 'h1', id = '', suffix = '' } = {}) {
  if (!artist) throw new TypeError('Artist identity requires an artist fixture.');
  const tag = ['h1', 'h2', 'strong'].includes(heading) ? heading : 'h1';
  const identity = artistMetadata(artist, fictionalDefaults);
  return `<div class="mock-artist-view__identity"><${tag}${id ? ` id="${escape(id)}"` : ''}>${escape(identity.name)}${suffix ? ` • ${escape(suffix)}` : ''}</${tag}><p>${escape([identity.styles, identity.years].filter(Boolean).join(' · '))}</p></div>`;
}

function belongsToArtist(album, artist) {
  const fixtureId = text(album.mock?.artist_id || album.artist_id);
  return fixtureId ? fixtureId === text(artist.id) : text(album.album_artist) === text(artist.name);
}

function releaseType(album, fictionalDefaults) {
  const fixtureType = fictionalDefaults && album.mock?.fictional === true ? FICTIONAL_RELEASE_TYPES[albumId(album)] : '';
  // discography_type is an explicit consumer override. Native ALBUM only says
  // album, so without the fictional opt-in it remains unclassified.
  const value = text(album.discography_type || fixtureType || album.release_type).toLowerCase().replace(/[_-]+/g, ' ');
  if (/\blive\b/.test(value)) return 'live';
  if (/\bdemo\b/.test(value)) return 'demo';
  if (/\bep\b|extended play/.test(value)) return 'ep';
  if (/\bsingle\b/.test(value)) return 'single';
  if (/\bcompilation\b/.test(value)) return 'compilation';
  if (/\bsoundtrack\b/.test(value)) return 'soundtrack';
  if (/\bstudio\b/.test(value)) return 'studio';
  return value && value !== 'album' ? 'other' : 'unknown';
}

function releaseDate(album) {
  const date = text(album.release_date);
  const year = text(album.year).match(/^\d{4}$/)?.[0] || date.match(/^\d{4}/)?.[0] || '';
  return { year, sort: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : year ? `${year}-99-99` : '9999-99-99' };
}

function viewModel(config) {
  const { artist, albums = [], artists = [], fictionalDefaults = false } = config;
  if (!artist || !text(artist.id) || !text(artist.name)) throw new TypeError('Artist view requires the fixture artist id and name.');
  const releases = albums.filter(album => belongsToArtist(album, artist) && albumId(album));
  const grouped = new Map();
  for (const album of releases) {
    const type = releaseType(album, fictionalDefaults);
    if (!grouped.has(type)) grouped.set(type, []);
    grouped.get(type).push(album);
  }
  const groups = TYPE_ORDER.filter(type => grouped.has(type)).map(type => ({
    type, label: TYPE_LABELS[type], albums: grouped.get(type).slice().sort((left, right) =>
      releaseDate(left).sort.localeCompare(releaseDate(right).sort)
      || albumName(left).localeCompare(albumName(right)) || albumId(left).localeCompare(albumId(right))),
  }));
  // Explicit [] suppresses the panel even with fictional defaults enabled.
  const defaults = fictionalDefaults ? FICTIONAL_ARTIST_VIEW_METADATA[artist.id] : null;
  const connections = config.connectedArtists ?? (defaults?.connectedIds || []).map(id => ({
    artist: artists.find(candidate => candidate.id === id),
    relationship: 'Fictional connection for this preview',
  }));
  const seen = new Set([text(artist.id)]);
  const connected = connections.filter(connection => {
    const id = text(connection.artist?.id);
    if (!id || !text(connection.artist?.name) || seen.has(id)) return false;
    seen.add(id);
    return true;
  }).map(connection => ({
    ...connection,
    albums: connection.albums ?? albums.filter(album => belongsToArtist(album, connection.artist)),
  }));
  return { artist, groups, connected, releases };
}

function discographyHtml(model, config, owners) {
  const renderItem = requireOwner(owners, 'renderNavigationItem');
  const artbox = requireOwner(owners, 'renderArtbox');
  if (!model.groups.length) return '<p class="mock-artist-view__empty">No releases are available for this artist.</p>';
  return model.groups.map((group, index) => {
    const heading = `${config.idPrefix}-release-type-${index}`;
    return `<section class="mock-artist-view__release-group" aria-labelledby="${escape(heading)}"><h3 class="gallery-divider" id="${escape(heading)}"><span>${escape(group.label)}</span><span class="gallery-divider__line" aria-hidden="true"></span><span>${group.albums.length}</span></h3><div class="navigation-tree mock-artist-tree">${group.albums.map(album => renderItem({
      variant: 'wide', action: true, key: albumId(album), label: albumName(album),
      year: releaseDate(album).year || 'Year unavailable',
      subtitle: [text(album.edition),Number.isFinite(owners.albumPopularity?.(album))?`${owners.albumPopularity(album).toLocaleString('en-US')} Plays`:''].filter(Boolean).join(' · '), selected: albumId(album) === text(config.selectedAlbumId),
      artworkHtml: artbox(album, { label: `${albumName(album)} artwork`, interactive: false, deferPreview: true }),
      attributes: { 'data-mock-artist-release': albumId(album) },
    })).join('')}</div></section>`;
  }).join('');
}

function connectedHtml(model, config, owners) {
  if (!model.connected.length) return '';
  const renderItem = requireOwner(owners, 'renderNavigationItem');
  const artbox = requireOwner(owners, 'renderArtbox');
  const rows = model.connected.map(connection => {
    const artist = connection.artist;
    const label = `${artist.name}${connection.relationship ? ` · ${connection.relationship}` : ''}`;
    // The composite Family is ordinary navigation, using Discography's native
    // row owner. Global Artist Family keeps its independent multi-select owner.
    return renderItem({
      variant: 'wide', action: true, key: artist.id, label: artist.name,
      subtitle: connection.relationship || '', count: connection.albums.length,
      selected: false,
      artworkHtml: artbox(connection.albums[0] || {}, { label: `${artist.name} album artwork`, interactive: false, deferPreview: true }),
      attributes: { 'data-mock-connected-artist': artist.id, 'data-mock-connected-label': `Open ${label}` },
    });
  }).join('');
  return `<section class="mock-module mock-artist-view__connected" aria-labelledby="${escape(config.idPrefix)}-connected-title"><header class="mock-module-header"><h2 id="${escape(config.idPrefix)}-connected-title">Artist Family</h2></header><div class="navigation-tree mock-artist-tree mock-artist-view__family gallery-scrollbar" data-mock-family-capped="${model.connected.length > 4}">${rows}</div></section>`;
}

/**
 * Render in the parent's existing single-page outlet. Native ArtistInfo is
 * mounted into the empty slot by mountArtistView, never duplicated in markup.
 */
export function renderArtistView(config, owners) {
  const normalized = { idPrefix: 'mock-artist-view', ...config };
  const model = viewModel(normalized);
  const action = requireOwner(owners, 'renderActionButton');
  const id = text(normalized.idPrefix);
  const back = action({ icon: 'back', ariaLabel: 'Back', title: 'Back', presentation: 'bare', className: 'mock-bar-action', attributes: { 'data-mock-artist-back': '' } });
  const gallery = action({ ariaLabel: 'Expand Discography', title: 'Expand Discography', className: 'mock-bar-action', attributes: { 'data-mock-artist-gallery': '' } });
  return `<div class="mock-artist-view" data-mock-artist-view="${escape(model.artist.id)}" aria-labelledby="${escape(id)}-title"><header class="mock-artist-view__header">${back}${renderArtistIdentity(model.artist, { fictionalDefaults: normalized.fictionalDefaults, id: `${id}-title` })}</header><div id="mock-artist-page-scroll" class="mock-artist-view__body gallery-scrollbar"><div class="mock-artist-view__columns"><div class="mock-artist-view__primary"><section class="mock-module mock-artist-view__information" aria-label="About ${escape(model.artist.name)}"><header class="mock-module-header"><h2>Artist Info</h2></header><div class="mock-artist-info-copy"><div data-mock-artist-info-slot></div>${normalized.fictionalDefaults ? '<p class="mock-artist-view__fixture-note">Fictional artist, release types and connections for this preview.</p>' : ''}</div></section><div data-mock-artist-album-slot hidden></div></div><div class="mock-artist-view__related"><section class="mock-module mock-artist-view__discography" aria-labelledby="${escape(id)}-discography-title"><header class="mock-module-header"><h2 id="${escape(id)}-discography-title">Discography</h2><div class="mock-header-actions">${gallery}</div></header><div class="mock-artist-view__releases gallery-scrollbar">${discographyHtml(model, normalized, owners)}</div></section>${connectedHtml(model, normalized, owners)}</div></div></div></div>`;
}

/**
 * The related column owns only its two scroll bodies. Measure actual native
 * rows so wrapping, font changes and late artwork never turn "four" into a
 * guessed pixel height. The outer page and Artist Info retain their owners.
 */
export function mountArtistRelatedLayout(view) {
  const related = view.querySelector('.mock-artist-view__related');
  if (!related) return () => {};
  const win = view.ownerDocument.defaultView;
  let mounted = true, frame = null, observed = new Set();
  const number = value => Number.parseFloat(value) || 0;
  const style = node => win.getComputedStyle(node);
  const verticalEdges = node => {
    if (!node) return 0;
    const value = style(node);
    return number(value.paddingTop) + number(value.paddingBottom)
      + number(value.borderTopWidth) + number(value.borderBottomWidth);
  };
  const outerHeight = node => {
    if (!node) return 0;
    const value = style(node);
    return node.getBoundingClientRect().height + number(value.marginTop) + number(value.marginBottom);
  };
  const keepFocusedRowVisible = () => {
    const focused = view.ownerDocument.activeElement;
    const body = focused?.closest?.('.mock-artist-view__family,.mock-artist-view__releases');
    if (!body || !related.contains(body) || !body.clientHeight) return;
    const row = focused.closest('[data-navigation-tree-item]') || focused;
    const item = row.getBoundingClientRect(), viewport = body.getBoundingClientRect();
    const top = viewport.top + body.clientTop, bottom = top + body.clientHeight;
    // Scroll only this module body; scrollIntoView would also move page/history
    // scroll owners. A row taller than its viewport keeps its focused control.
    const target = item.height > body.clientHeight ? focused.getBoundingClientRect() : item;
    if (target.top < top) body.scrollTop += target.top - top;
    else if (target.bottom > bottom) body.scrollTop += target.bottom - bottom;
  };
  const resize = new win.ResizeObserver(() => schedule());
  function measure() {
    if (!mounted) return;
    const family = related.querySelector('.mock-artist-view__family');
    const panel = family?.closest('.mock-artist-view__connected');
    const discography = related.querySelector('.mock-artist-view__discography');
    const releases = discography?.querySelector('.mock-artist-view__releases');
    const rows = family ? [...family.querySelectorAll('[data-mock-connected-artist]')]
      .filter(row => !row.hidden && style(row).display !== 'none') : [];
    const firstRelease = releases?.querySelector('[data-mock-artist-release]');
    const divider = firstRelease?.closest('.mock-artist-view__release-group')?.querySelector('h3');
    const familyHeader = panel?.querySelector('.mock-module-header');
    const discographyHeader = discography?.querySelector('.mock-module-header');
    const targets = new Set([related, family, familyHeader, discographyHeader, firstRelease, divider, ...rows.slice(0, 4)].filter(Boolean));
    for (const node of observed) if (!targets.has(node)) resize.unobserve(node);
    for (const node of targets) if (!observed.has(node)) resize.observe(node);
    observed = targets;
    if (panel && panel.hidden !== (rows.length === 0)) panel.hidden = rows.length === 0;
    if (!family || !rows.length) return;
    const capped = String(rows.length > 4);
    if (family.dataset.mockFamilyCapped !== capped) family.dataset.mockFamilyCapped = capped;
    // Hidden parents have no geometry; their next resize supplies the bounds.
    const first = rows.slice(0, 4), heights = first.map(outerHeight);
    if (!related.clientHeight || heights.some(height => !height)) return;
    const gap = number(style(family).rowGap);
    const intrinsic = heights.reduce((sum, height) => sum + height, 0)
      + gap * Math.max(0, first.length - 1) + verticalEdges(family);
    const relatedStyle = style(related);
    const available = related.clientHeight - number(relatedStyle.paddingTop) - number(relatedStyle.paddingBottom);
    // Leave at least the Discography header and its first native release row
    // available when the viewport permits it. Small viewports may show fewer
    // than four Family rows; they remain reachable in that body's scrollbar.
    const discographyMinimum = outerHeight(discographyHeader) + verticalEdges(discography)
      + verticalEdges(releases) + outerHeight(divider)
      + outerHeight(firstRelease || releases?.querySelector('.mock-artist-view__empty'));
    const sharedContentBudget = Math.max(0, available - number(relatedStyle.rowGap)
      - outerHeight(familyHeader) - verticalEdges(panel)
      - outerHeight(discographyHeader) - verticalEdges(discography) - verticalEdges(releases));
    // An unusually tall first release must not make Family unreachable. Both
    // bodies can scroll; keep a fair bounded share when the preferred row
    // reservation cannot fit, without changing the ordinary intrinsic case.
    const familyMinimum = Math.min(intrinsic, sharedContentBudget / 2);
    const bodyBudget = Math.max(familyMinimum, available - number(relatedStyle.rowGap)
      - outerHeight(familyHeader) - verticalEdges(panel) - discographyMinimum);
    const cap = `${Math.ceil(Math.min(intrinsic, bodyBudget) * 100) / 100}px`;
    if (family.style.getPropertyValue('--mock-artist-family-cap') !== cap)
      family.style.setProperty('--mock-artist-family-cap', cap);
    keepFocusedRowVisible();
  }
  function schedule() {
    if (!mounted || frame !== null) return;
    frame = win.requestAnimationFrame(() => { frame = null; measure(); });
  }
  const mutation = new win.MutationObserver(schedule);
  mutation.observe(related, {childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: ['class', 'style', 'hidden']});
  related.addEventListener('focusin', keepFocusedRowVisible);
  win.addEventListener('resize', schedule);
  measure();
  return () => {
    if (!mounted) return;
    mounted = false;
    if (frame !== null) win.cancelAnimationFrame(frame);
    resize.disconnect(); mutation.disconnect(); observed.clear();
    related.removeEventListener('focusin', keepFocusedRowVisible);
    win.removeEventListener('resize', schedule);
  };
}

/**
 * Call after insertion, in a layout effect. mountArtistInfo(artist, slot) must
 * synchronously rehost the same native overlay and return its cleanup function.
 * Call the returned cleanup BEFORE replacing/removing the rendered subtree.
 * It intentionally does not write browser history, select the global tree,
 * call play owners, intercept Escape, or handle any native ArtistInfo controls.
 */
export function mountArtistView(root, config, owners, callbacks) {
  const view = root?.matches?.('[data-mock-artist-view]') ? root : root?.querySelector?.('[data-mock-artist-view]');
  if (!view) throw new TypeError('Artist view must be rendered before mounting.');
  const model = viewModel(config);
  if (view.dataset.mockArtistView !== text(model.artist.id)) throw new TypeError('Rendered artist and mounted fixture do not match.');
  for (const name of ['onBack', 'onViewGallery', 'onOpenAlbum', ...(model.connected.length ? ['onOpenArtist'] : [])]) {
    if (typeof callbacks?.[name] !== 'function') throw new TypeError(`Artist view requires ${name}.`);
  }
  const mountInfo = requireOwner(owners, 'mountArtistInfo');
  const activate = requireOwner(owners, 'activate');
  const infoSlot = view.querySelector('[data-mock-artist-info-slot]');
  const unmountInfo = mountInfo(model.artist, infoSlot);
  if (typeof unmountInfo !== 'function') throw new TypeError('mountArtistInfo must return a cleanup function that preserves the live native overlay.');
  const icon = view.querySelector('[data-mock-artist-gallery] .action-button__icon');
  if (icon) icon.innerHTML = DISCOGRAPHY_EXPAND_GLYPH;
  // Preserve native row anatomy/selection while exposing two non-nested
  // controls: artwork selects the compact panel, title opens the full page.
  for(const source of view.querySelectorAll('[data-mock-artist-release]')){
    const row=document.createElement('div');for(const attribute of source.attributes)if(attribute.name!=='type')row.setAttribute(attribute.name,attribute.value);
    row.setAttribute('role','group');row.replaceChildren(...source.childNodes);source.replaceWith(row);
    const artwork=row.querySelector('.navigation-tree-artwork'),title=row.querySelector('.utility-list-item-title');
    const selectHost=document.createElement('span');selectHost.innerHTML=owners.renderActionButton({ariaLabel:'Select album: '+title.textContent,title:'Select album: '+title.textContent,presentation:'bare',className:'mock-discography-select'});
    const select=selectHost.firstElementChild;select.replaceChildren(...artwork.childNodes);artwork.append(select);
    const open=document.createElement('button');open.type='button';open.className='mock-native-link';open.dataset.mockArtistAlbumTitle=row.dataset.mockArtistRelease;open.textContent=title.textContent;open.title='Open album page: '+title.textContent;open.setAttribute('aria-label',open.title);title.replaceChildren(open);
  }
  for (const row of view.querySelectorAll('[data-mock-connected-artist]')) {
    row.setAttribute('aria-label', row.dataset.mockConnectedLabel);
    row.title = row.dataset.mockConnectedLabel;
  }
  const releases = new Map(model.releases.map(album => [albumId(album), album]));
  const connected = new Map(model.connected.map(connection => [text(connection.artist.id), connection.artist]));
  const onClick = event => {
    const button = event.target.closest?.('[data-mock-artist-back],[data-mock-artist-gallery],[data-mock-artist-release],[data-mock-connected-artist]');
    if (!button || !view.contains(button) || button.disabled || button.getAttribute('aria-disabled') === 'true') return;
    event.preventDefault();
    event.stopPropagation();
    const context = { artist: model.artist, opener: button, event };
    if (button.hasAttribute('data-mock-artist-back')) callbacks.onBack(context);
    else if (button.hasAttribute('data-mock-artist-gallery')) callbacks.onViewGallery(model.artist, context);
    else if (button.hasAttribute('data-mock-artist-release')) {
      const album = releases.get(button.dataset.mockArtistRelease);
      if(album){if(event.target.closest('[data-mock-artist-album-title]'))callbacks.onOpenAlbum(album,context);else (callbacks.onSelectAlbum||callbacks.onOpenAlbum)(album,context);}
    } else {
      const artist = connected.get(button.dataset.mockConnectedArtist);
      if (artist) { owners.paintFamilySelection?.(view, artist.id); callbacks.onOpenArtist(artist, context); }
    }
  };
  const onDoubleClick=event=>{const row=event.target.closest('[data-mock-artist-release]');if(!row||!view.contains(row)||event.target.closest('[data-mock-artist-album-title]'))return;event.preventDefault();event.stopPropagation();const album=releases.get(row.dataset.mockArtistRelease);if(album)callbacks.onOpenAlbum(album,{artist:model.artist,opener:row,event});};
  view.addEventListener('click', onClick);view.addEventListener('dblclick',onDoubleClick);
  let unmountRelated = () => {};
  try { activate(view); unmountRelated = mountArtistRelatedLayout(view); }
  catch (error) { view.removeEventListener('click', onClick);view.removeEventListener('dblclick',onDoubleClick); unmountRelated(); unmountInfo(); throw error; }
  let mounted = true;
  return () => {
    if (!mounted) return;
    mounted = false;
    view.removeEventListener('click', onClick);view.removeEventListener('dblclick',onDoubleClick);
    unmountRelated();unmountInfo();
  };
}

// Load once after the existing mock/native CSS. The existing .mock-module
// surface is retained: pending panel-color proposals are not applied here.
// The outer page retains its history scroll owner and short-viewport fallback.
// Related module bodies scroll inside the same height budget as the left stack.
export const artistViewStyles = `
.mock-artist-view{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0;height:100%;color:var(--text)}
.mock-artist-view__header{display:flex;align-items:center;gap:10px;flex:none;min-height:54px;padding:0 0 12px}
.mock-artist-view__identity{flex:1;min-width:0}
.mock-artist-view__identity :is(h1,h2,strong){display:block;margin:0;font-size:1.06rem;line-height:1.3;font-weight:750;overflow-wrap:anywhere}
.mock-artist-view__identity p{margin:3px 0 0;color:var(--muted);font-size:.76rem;line-height:1.4;overflow-wrap:anywhere}
.mock-artist-view__body{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;padding-bottom:var(--mock-artist-player-clearance,calc(var(--player-height,0px) + 12px))}
.mock-artist-view__columns{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(280px,1fr);align-items:start;gap:12px;height:100%;min-height:480px}
.mock-artist-view__primary{display:grid;grid-template-rows:minmax(0,1fr);gap:12px;min-width:0;min-height:0;height:100%}
.mock-artist-view__primary:has(>[data-mock-artist-album-slot]:not([hidden])){grid-template-rows:minmax(148px,.36fr) minmax(320px,.64fr)}
.mock-artist-view__information{padding:0;overflow:hidden;height:100%;min-height:0}
.mock-artist-info-copy{display:flow-root;padding:14px;flex:1;min-height:0;overflow:auto}
.mock-artist-view__prominent{display:flex;gap:7px 14px;flex-wrap:wrap;margin:0 0 10px;font-size:.87rem}
.mock-artist-info-copy [data-mock-artist-info-slot]>.artist-info-overlay{display:contents!important}
.mock-artist-info-copy [data-mock-artist-info-slot] .artist-info-overlay__body{display:contents!important}
.mock-artist-info-copy .mock-global-popularity{margin:9px 0 0}
.mock-artist-info-copy .mock-artist-view__fixture-note{clear:both}
.mock-discography-select.action-button{width:42px;height:42px;min-width:42px;min-height:42px}
.mock-discography-select>.album-artbox{width:42px;height:42px}
[data-mock-artist-album-slot]{min-width:0;min-height:0;height:100%;overflow:hidden}
[data-mock-artist-album-slot]:not([hidden]){animation:mock-artist-album-rise 240ms ease both}
[data-mock-artist-album-slot][hidden]{display:none!important}
[data-mock-artist-album-slot]>#mock-album-panel{height:100%;min-height:0}
[data-mock-artist-album-slot] #mock-album-heading>.mock-native-link{display:block;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
@keyframes mock-artist-album-rise{from{opacity:0;transform:translateY(24px)}to{opacity:1;transform:none}}
@media(prefers-reduced-motion:reduce){[data-mock-artist-album-slot]:not([hidden]){animation:none}}
.mock-artist-view__related{display:flex;flex-direction:column;gap:12px;min-width:0;min-height:0;height:100%;overflow:hidden}
.mock-artist-view__discography{flex:1 1 0;min-height:0}
.mock-artist-view__connected{flex:0 0 auto;min-height:0;max-height:100%}
.mock-artist-view .mock-module-header h2{margin:0;font-size:1.06rem;line-height:1.3;font-weight:750;min-width:0}
.mock-artist-view .mock-header-actions{align-self:center}
.mock-artist-view [data-mock-artist-gallery] svg{width:18px;height:18px;display:block;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.mock-artist-view__releases{padding:12px;flex:1;min-height:0;overflow:auto;scrollbar-gutter:stable}
.mock-artist-view__release-group + .mock-artist-view__release-group{margin-top:18px}
.mock-artist-view__release-group .gallery-divider{margin:0 0 6px;font-weight:500}
.mock-artist-view .mock-artist-tree .navigation-tree-item--wide{min-height:62px}
.mock-artist-view .navigation-tree-artwork{width:42px;height:42px;flex:0 0 42px}
.mock-artist-view .navigation-tree-artwork > .album-artbox{width:100%;height:100%;border-radius:7px}
.mock-artist-view .utility-list-item-title{white-space:normal;overflow-wrap:anywhere}
.mock-artist-view__family{padding:12px;box-sizing:border-box;min-height:0;overflow:auto;max-height:var(--mock-artist-family-cap,none);scrollbar-gutter:stable}
.mock-artist-view__family>[data-mock-connected-artist]{flex:0 0 auto}
.mock-artist-view__facts{margin:14px 0 0;font-size:.8rem}
.mock-artist-view__facts > div{display:flex;gap:10px}
.mock-artist-view__facts dt{color:var(--muted)}
.mock-artist-view__facts dd{margin:0;overflow-wrap:anywhere}
.mock-artist-view__fixture-note{margin:12px 0 0;color:var(--muted);font-size:.7rem;line-height:1.5}
.mock-artist-view__empty{margin:8px 0;color:var(--muted);font-size:.85rem}
.mock-artist-view [data-mock-artist-info-slot]{min-width:0}
.mock-artist-view [data-mock-artist-info-slot] > .artist-info-overlay{position:static!important;inset:auto!important;display:flow-root!important;width:100%!important;max-width:none!important;max-height:none!important;min-height:0;margin:0;padding:0;border:0;border-radius:0;box-shadow:none;background:transparent;overflow:visible;z-index:auto!important;transform:none!important}
.mock-artist-view [data-mock-artist-info-slot] > .artist-info-overlay::before,.mock-artist-view [data-mock-artist-info-slot] > .artist-info-overlay::after{display:none!important}
.mock-artist-view [data-mock-artist-info-slot] .mobile-artist-info-close,.mock-artist-view [data-artist-info-full-page]{display:none!important}
.mock-artist-view [data-mock-artist-info-slot] .artist-info-overlay > header{display:contents;padding:0}
.mock-artist-view [data-mock-artist-info-slot] .artist-info-overlay > header > div:not(.artist-info-overlay__image){display:none}
.mock-artist-view [data-mock-artist-info-slot] .artist-info-overlay__image{float:inline-start;width:clamp(132px,35%,208px)!important;height:auto!important;aspect-ratio:1;max-width:100%;margin:0 18px 12px 0;object-fit:cover}
.mock-artist-view [data-mock-artist-info-slot] .artist-info-overlay__body{display:block;max-height:none!important;overflow:visible;padding:0;font-size:.9rem;line-height:1.6}
.mock-artist-view [data-mock-artist-info-slot] .artist-info-overlay__body > p:first-child{margin-top:0}
.mock-artist-view [data-mock-artist-info-slot] [data-artist-info-summary]{display:block;-webkit-line-clamp:unset;overflow:visible;white-space:pre-line}
.mock-artist-view [data-mock-artist-info-slot] [data-artist-info-read-more]{display:none}
@media(max-width:900px){
 .mock-artist-view__columns{grid-template-columns:minmax(0,1fr);height:auto;min-height:0}
 .mock-artist-view__related{height:calc(100dvh - 160px);min-height:480px}
 .mock-artist-view__primary{height:auto;grid-template-rows:auto}
 .mock-artist-view__primary:has(>[data-mock-artist-album-slot]:not([hidden])){height:calc(100dvh - 160px);min-height:480px}
 .mock-artist-view__primary:not(:has(>[data-mock-artist-album-slot]:not([hidden]))) .mock-artist-info-copy{overflow:visible}
 .mock-artist-view__information{padding:0}
 .mock-artist-view__header{padding-bottom:10px}
 .mock-artist-view .mock-module-header h2{font-size:1rem}
}
@media(max-width:420px){
 .mock-artist-view [data-mock-artist-info-slot] .artist-info-overlay__image{width:116px!important;margin-inline-end:12px}
}
`;
