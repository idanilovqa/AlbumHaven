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
const GALLERY_GLYPH = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 15h18M7 18h6"/></svg>';

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
export function renderArtistIdentity(artist, { fictionalDefaults = false, heading = 'h1', id = '' } = {}) {
  if (!artist) throw new TypeError('Artist identity requires an artist fixture.');
  const tag = ['h1', 'h2', 'strong'].includes(heading) ? heading : 'h1';
  const identity = artistMetadata(artist, fictionalDefaults);
  return `<div class="mock-artist-view__identity"><${tag}${id ? ` id="${escape(id)}"` : ''}>${escape(identity.name)}</${tag}><p>${escape([identity.styles, identity.years].filter(Boolean).join(' · '))}</p></div>`;
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
      subtitle: [text(album.edition),Number.isFinite(owners.albumPopularity?.(album))?`${owners.albumPopularity(album).toLocaleString('en-US')} Last.fm plays`:''].filter(Boolean).join(' · '), selected: albumId(album) === text(config.selectedAlbumId),
      artworkHtml: artbox(album, { label: `${albumName(album)} artwork`, interactive: false, deferPreview: true }),
      attributes: { 'data-mock-artist-release': albumId(album) },
    })).join('')}</div></section>`;
  }).join('');
}

function connectedHtml(model, config, owners) {
  if (!model.connected.length) return '';
  const renderFamilyItem = requireOwner(owners, 'renderFamilyItem');
  const artbox = requireOwner(owners, 'renderArtbox');
  const rows = model.connected.map(connection => {
    const artist = connection.artist;
    const label = `${artist.name}${connection.relationship ? ` · ${connection.relationship}` : ''}`;
    // This shares Artist Family's renderer/anatomy, but navigating to a person
    // is not the global Family multi-select action. Do not emit its attributes.
    return renderFamilyItem({
      label: artist.name, title: label, ariaLabel: `Open ${label}`, count: connection.albums.length,
      selected: false, className: 'artist-family-panel__artist', draggable: false,
      partClasses: { marker: 'artist-family-panel__marker', artwork: 'artist-family-panel__artwork', label: 'artist-family-panel__name', count: 'artist-family-panel__count' },
      artworkHtml: artbox(connection.albums[0] || {}, { label: `${artist.name} album artwork`, interactive: false, deferPreview: true }),
      dataAttributes: { 'mock-connected-artist': artist.id },
    }).replace(/ aria-pressed="(?:true|false)"/g, '');
  }).join('');
  return `<section class="mock-module mock-artist-view__connected" aria-labelledby="${escape(config.idPrefix)}-connected-title"><header class="mock-module-header"><h2 id="${escape(config.idPrefix)}-connected-title">Connected Artists</h2></header><div class="artist-family-panel__body">${rows}</div></section>`;
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
  const gallery = action({ ariaLabel: 'View as gallery', title: 'View as gallery', className: 'mock-bar-action', attributes: { 'data-mock-artist-gallery': '' } });
  return `<div class="mock-artist-view" data-mock-artist-view="${escape(model.artist.id)}" aria-labelledby="${escape(id)}-title"><header class="mock-artist-view__header">${back}${renderArtistIdentity(model.artist, { fictionalDefaults: normalized.fictionalDefaults, id: `${id}-title` })}</header><div class="mock-artist-view__body gallery-scrollbar"><div class="mock-artist-view__columns"><section class="mock-module mock-artist-view__information" aria-label="About ${escape(model.artist.name)}"><div data-mock-artist-info-slot></div>${text(model.artist.place) ? `<dl class="mock-artist-view__facts"><div><dt>From</dt><dd>${escape(model.artist.place)}</dd></div></dl>` : ''}${normalized.fictionalDefaults ? '<p class="mock-artist-view__fixture-note">Fictional artist, release types and connections for this preview.</p>' : ''}</section><div class="mock-artist-view__related"><section class="mock-module mock-artist-view__discography" aria-labelledby="${escape(id)}-discography-title"><header class="mock-module-header"><h2 id="${escape(id)}-discography-title">Discography</h2><div class="mock-header-actions">${gallery}</div></header><div class="mock-artist-view__releases">${discographyHtml(model, normalized, owners)}</div></section>${connectedHtml(model, normalized, owners)}</div></div></div></div>`;
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
  if (icon) icon.innerHTML = GALLERY_GLYPH;
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
      if (album) callbacks.onOpenAlbum(album, context);
    } else {
      const artist = connected.get(button.dataset.mockConnectedArtist);
      if (artist) callbacks.onOpenArtist(artist, context);
    }
  };
  view.addEventListener('click', onClick);
  try { activate(view); }
  catch (error) { view.removeEventListener('click', onClick); unmountInfo(); throw error; }
  let mounted = true;
  return () => {
    if (!mounted) return;
    mounted = false;
    view.removeEventListener('click', onClick);
    unmountInfo();
  };
}

// Load once after the existing mock/native CSS. The existing .mock-module
// surface is retained: pending panel-color proposals are not applied here.
// Single outer scroller keeps the final content reachable above the player.
export const artistViewStyles = `
.mock-artist-view{display:flex;flex-direction:column;flex:1;min-width:0;min-height:0;height:100%;color:var(--text)}
.mock-artist-view__header{display:flex;align-items:center;gap:10px;flex:none;min-height:54px;padding:0 0 12px}
.mock-artist-view__identity{flex:1;min-width:0}
.mock-artist-view__identity :is(h1,h2,strong){display:block;margin:0;font-size:1.06rem;line-height:1.3;font-weight:750;overflow-wrap:anywhere}
.mock-artist-view__identity p{margin:3px 0 0;color:var(--muted);font-size:.76rem;line-height:1.4;overflow-wrap:anywhere}
.mock-artist-view__body{flex:1;min-height:0;overflow:auto;overscroll-behavior:contain;padding-bottom:var(--mock-artist-player-clearance,calc(var(--player-height,0px) + 12px))}
.mock-artist-view__columns{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(280px,1fr);align-items:start;gap:12px}
.mock-artist-view__information{padding:18px;overflow:visible}
.mock-artist-view__related{display:grid;gap:12px;min-width:0}
.mock-artist-view .mock-module-header h2{margin:0;font-size:1.06rem;line-height:1.3;font-weight:750;min-width:0}
.mock-artist-view .mock-header-actions{align-self:center}
.mock-artist-view [data-mock-artist-gallery] svg{width:18px;height:18px;display:block;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
.mock-artist-view__releases{padding:12px}
.mock-artist-view__release-group + .mock-artist-view__release-group{margin-top:18px}
.mock-artist-view__release-group .gallery-divider{margin:0 0 6px;font-weight:500}
.mock-artist-view .mock-artist-tree .navigation-tree-item--wide{min-height:62px}
.mock-artist-view .navigation-tree-artwork{width:42px;height:42px;flex:0 0 42px}
.mock-artist-view .navigation-tree-artwork > .album-artbox{width:100%;height:100%;border-radius:7px}
.mock-artist-view .utility-list-item-title{white-space:normal;overflow-wrap:anywhere}
.mock-artist-view__connected .artist-family-panel__body{overflow:visible;padding:12px}
.mock-artist-view__connected .artist-family-panel__artist:last-child{margin-bottom:0}
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
 .mock-artist-view__columns{grid-template-columns:minmax(0,1fr)}
 .mock-artist-view__information{padding:14px}
 .mock-artist-view__header{padding-bottom:10px}
 .mock-artist-view .mock-module-header h2{font-size:1rem}
}
@media(max-width:420px){
 .mock-artist-view [data-mock-artist-info-slot] .artist-info-overlay__image{width:116px!important;margin-inline-end:12px}
}
`;
