const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.join(__dirname, '..', '..', '..');

function loadComponents() {
  const context = {
    escapeHtml: (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(
    fs.readFileSync(path.join(repoRoot, 'music_app', 'static', 'js', 'button-component.js'), 'utf8'),
    context,
  );
  for (const filename of ['gallery-main-components.js', 'alert-components.js', 'album-details-components.js']) {
    vm.runInContext(
      fs.readFileSync(path.join(repoRoot, 'music_app', 'static', 'js', 'runtime', filename), 'utf8'),
      context,
    );
  }
  return context;
}

test('Album Details headers never render library source markers', () => {
  const context = loadComponents();
  const html = context.buildAlbumDetailsHeaderHtml({
    layout: 'classic_bar',
    artist: 'Artist',
    album: 'Album',
    sourceCategories: ['main_library', 'hoard', 'new_arrivals'],
    actionsHtml: '<button type="button">Close</button>',
  });

  assert.doesNotMatch(html, /album-details-source-markers|aria-label="Hoard"|aria-label="New Arrivals"/);
  assert.match(html, /album-details-header__actions/);
});

test('Album Details renders the backend poor-art classification as a focusable SmallAlert beside the title', () => {
  const context = loadComponents();
  const html = context.buildAlbumDetailsHeaderHtml({
    layout: 'classic_bar',
    artist: 'Sandy Alex G',
    album: 'Rocket',
    year: '2017',
    poorArtQuality: true,
  });

  assert.match(html, /album-details-header__primary-row/);
  assert.match(html, /small-alert small-alert--warning album-details-header__quality-alert/);
  assert.match(html, /aria-label="Poor art quality"/);
  assert.match(html, /tabindex="0"/);
  assert.match(html, /small-alert__text">Poor art quality</);
  assert.doesNotMatch(
    context.buildAlbumDetailsHeaderHtml({ album: 'Rocket', poorArtQuality: false }),
    /Poor art quality|album-details-header__quality-alert/,
  );
});

test('Album Details renders noninteractive source markers below the cover', () => {
  const context = loadComponents();
  const html = context.buildAlbumCoverSourceMarkersHtml({
    root_provenance: { categories: ['main_library', 'hoard', 'new_arrivals'] },
  });

  assert.match(html, /album-details-cover-source-markers/);
  assert.match(html, /aria-label="Hoard"/);
  assert.match(html, /aria-label="New Arrivals"/);
  assert.doesNotMatch(html, /<button|data-open-tracklist/);
  assert.equal(context.buildAlbumCoverSourceMarkersHtml({ source: 'main_library' }), '');
});

test('Album Details source markers reuse the gallery source glyphs and obey the icon preference', () => {
  const context = loadComponents();
  const hoardGlyph = context.buildLibrarySourceGlyphHtml('hoard');
  const arrivalsGlyph = context.buildLibrarySourceGlyphHtml('new_arrivals');
  assert.match(hoardGlyph, /viewBox="0 0 48 48"/);
  assert.match(arrivalsGlyph, /viewBox="0 0 48 48"/);

  const css = fs.readFileSync(
    path.join(repoRoot, 'music_app', 'static', 'css', 'runtime', 'album-details-components.css'),
    'utf8',
  );
  assert.match(css, /\.album-details-source-markers\s*\{[^}]*display:\s*inline-flex/s);
  assert.match(css, /:root\[data-library-source-icons="false"\][^}]*\.album-details-source-markers\s*\{[^}]*display:\s*none/s);
});

test('Album Details render path places source markers after the cover shell', () => {
  const source = fs.readFileSync(
    path.join(repoRoot, 'music_app', 'static', 'js', 'runtime', 'tag-editor-and-optimistic-updates.js'),
    'utf8',
  );
  const renderStart = source.indexOf('function renderTrackModalRelease(album)');
  const renderEnd = source.indexOf('\nfunction ', renderStart + 1);
  const render = source.slice(renderStart, renderEnd < 0 ? undefined : renderEnd);
  assert.doesNotMatch(render, /sourceCategories:\s*resolveAlbumSourceMarkerCategories\(album\)/);
  assert.match(render, /const coverSourceMarkersHtml = buildAlbumCoverSourceMarkersHtml\(album\)/);
  assert.match(render, /track-modal-cover-shell[\s\S]*?<\/div>\s*\$\{coverSourceMarkersHtml\}/);
  assert.equal([...render.matchAll(/\$\{coverSourceMarkersHtml\}/g)].length, 3);
});

test('mobile Album Details keeps source markers with the cover instead of either header', () => {
  const navigation = fs.readFileSync(
    path.join(repoRoot, 'music_app', 'static', 'js', 'runtime', 'mobile-navigation.js'),
    'utf8',
  );
  const components = fs.readFileSync(
    path.join(repoRoot, 'music_app', 'static', 'js', 'runtime', 'album-details-components.js'),
    'utf8',
  );
  const mobileCss = fs.readFileSync(
    path.join(repoRoot, 'music_app', 'static', 'css', 'mobile-layout.css'),
    'utf8',
  );
  const trackModalCss = fs.readFileSync(
    path.join(repoRoot, 'music_app', 'static', 'css', 'runtime', 'track-modal-and-lightbox.css'),
    'utf8',
  );

  assert.doesNotMatch(navigation, /mobile-album-source-markers|buildAlbumSourceMarkerItemsHtml/);
  assert.doesNotMatch(components, /mobile-album-overview__source-markers/);
  assert.doesNotMatch(mobileCss, /mobile-album-source-markers|mobile-album-overview__source-markers/);
  assert.match(components, /overview\.appendChild\(sourceMarkers\)/);
  assert.match(mobileCss, /mobile-album-overview\s*>\s*\.album-details-cover-source-markers[^}]*grid-column:\s*1[^}]*grid-row:\s*1/s);
  assert.match(mobileCss, /album-details-cover-source-markers[^}]*flex-direction:\s*column/s);
  assert.match(mobileCss, /\.album-details-cover-source-markers/);
  assert.match(mobileCss, /mobile-album-overview \.track-modal-cover[^}]*aspect-ratio:\s*auto/);
  assert.match(trackModalCss, /\.track-modal-cover:has\(> \.album-details-cover-source-markers\)[^}]*aspect-ratio:\s*auto/);
  assert.match(
    mobileCss,
    /data-mobile-album-layout="stacked_bar"[^}]*\.mobile-album-identity[^}]*align-self:\s*start/s,
  );
});

test('AlbumDetailsHeader supports the three approved layouts and fat-dot identity separators', () => {
  const context = loadComponents();
  for (const layout of ['classic_bar', 'stacked_bar', 'editorial_canvas']) {
    const html = context.buildAlbumDetailsHeaderHtml({
      layout,
      artist: 'Transatlantic',
      album: 'SMPTe',
      year: '2000',
      releaseType: 'ALBUM',
      tags: ['Missing'],
    });
    assert.match(html, new RegExp(`data-album-details-layout="${layout}"`));
    assert.match(html, /Transatlantic/);
    assert.match(html, /SMPTe/);
    assert.match(html, /2000/);
    assert.match(html, /ALBUM/);
  }
  const classic = context.buildAlbumDetailsHeaderHtml({
    layout: 'classic_bar', artist: 'Transatlantic', album: 'SMPTe', year: '2000', releaseType: 'ALBUM', tags: ['Missing'],
  });
  assert.match(classic, /Transatlantic <span aria-hidden="true">•<\/span> SMPTe <span aria-hidden="true">•<\/span> 2000/);
  assert.match(classic, /class="album-details-header__release-type">ALBUM<\/span>/);
  assert.doesNotMatch(classic, /class="album-details-header__tag">ALBUM<\/span>/);
  assert.match(classic, /class="album-details-header__tag album-details-header__tag--missing">Missing<\/span>/);
});

test('missing Album Details uses OnPageAlert and renders no track table', () => {
  const context = loadComponents();
  const html = context.buildMissingAlbumDetailsHtml({
    canRemove: true,
    albumKey: 'album-1',
  });
  assert.match(html, /Album details unavailable/);
  assert.match(html, /Remove from library/);
  assert.match(html, /Keep as missing/);
  assert.doesNotMatch(html, /small-alert/);
  assert.doesNotMatch(html, /album-track-table/);
});

test('Album Details delegates action geometry to ActionButton and aligns stacked actions to line one', () => {
  const css = fs.readFileSync(
    path.join(repoRoot, 'music_app', 'static', 'css', 'runtime', 'album-details-components.css'),
    'utf8',
  );
  assert.doesNotMatch(css, /\.album-details-header__action\s*\{[^}]*width:\s*34px[^}]*height:\s*34px/s);
  assert.match(css, /\.album-details-header\s*\{[^}]*width:\s*100%[^}]*align-items:\s*center/s);
  assert.match(css, /\.album-details-header__actions\s*\{[^}]*margin-left:\s*auto/s);
  assert.match(
    css,
    /\.album-details-header__release-type,\s*\.album-details-header__tag\s*\{[^}]*--album-details-tag-accent:[^}]*padding:\s*2px 8px[^}]*border:\s*1px solid[^}]*color:\s*var\(--album-details-tag-accent\)[^}]*font-weight:\s*750/s,
  );
  assert.match(css, /\.album-details-header__tag--missing\s*\{[^}]*--album-details-tag-accent:\s*var\(--appearance-error/s);
  assert.match(css, /data-album-details-layout="stacked_bar"[^}]*align-items:\s*flex-start/s);
});

test('Album Details header actions use the approved outline icons instead of text or emoji glyphs', () => {
  const context = loadComponents();
  const html = context.buildAlbumDetailsHeaderActionsHtml({ missing: false });

  assert.match(html, /album-details-header__action-icon--edit/);
  assert.match(html, /album-details-header__action-icon--folder/);
  assert.match(html, /album-details-header__action-icon--close/);
  assert.match(html, /aria-hidden="true"/);
  assert.match(html, /ui-button--icon ui-button--medium action-button/);
  assert.doesNotMatch(html, /&#9998;|📁|✕/);
  assert.match(html, /data-open-track-modal-editor="1"/);
  assert.match(html, /data-open-track-modal-folder="1"/);
});

test('Loose Tracks uses the shared Album Details header with custom copy and actions', () => {
  const context = loadComponents();
  const html = context.buildAlbumDetailsHeaderHtml({
    variant: 'copy',
    title: 'Loose Tracks',
    subtitle: 'Non-album tracks found in Folkstone and family artist folders.',
    titleId: 'non-album-modal-title',
    subtitleId: 'non-album-modal-subtitle',
    actionsHtml: context.buildLooseTracksHeaderActionsHtml(),
  });

  assert.match(html, /class="album-details-header"/);
  assert.match(html, /data-album-details-variant="copy"/);
  assert.match(html, /id="non-album-modal-title">Loose Tracks</);
  assert.match(html, /id="non-album-modal-subtitle">Non-album tracks found in Folkstone and family artist folders\.<\/div>/);
  assert.match(html, /id="non-album-modal-edit-tags"/);
  assert.match(html, /data-open-non-album-tag-editor="1"/);
  assert.match(html, /album-details-header__action-icon--edit/);
  assert.match(html, /id="non-album-modal-close"/);
  assert.match(html, /data-close-non-album-modal="1"/);
  assert.match(html, /album-details-header__action-icon--close/);
  assert.equal((html.match(/ui-button--icon ui-button--medium action-button/g) || []).length, 2);
  assert.doesNotMatch(html, /album-details-header__action-icon--folder|&#9998;|✕/);
});

test('Loose Tracks template delegates its header contents to AlbumDetailsHeader', () => {
  const template = fs.readFileSync(
    path.join(repoRoot, 'music_app', 'templates', 'partials', 'primary-modals.html'),
    'utf8',
  );
  const modalStart = template.indexOf('<div class="non-album-modal"');
  const modalEnd = template.indexOf('</div>\n\n  <div', modalStart);
  const modal = template.slice(modalStart, modalEnd);

  assert.match(modal, /<div class="non-album-modal-header" id="non-album-modal-header"><\/div>/);
  assert.doesNotMatch(modal, /&#9998;|>✕<|class="icon-button/);
});

test('missing Album Details disables edit and folder actions while leaving Close active', () => {
  const context = loadComponents();
  const html = context.buildAlbumDetailsHeaderActionsHtml({ missing: true });
  const editButton = html.match(/<button[^>]*id="track-modal-edit-tags"[^>]*>/)?.[0] || '';
  const folderButton = html.match(/<button[^>]*id="track-modal-folder"[^>]*>/)?.[0] || '';
  const closeButton = html.match(/<button[^>]*id="track-modal-close"[^>]*>/)?.[0] || '';

  for (const unavailableButton of [editButton, folderButton]) {
    assert.match(unavailableButton, /\sdisabled(?:\s|>)/);
    assert.match(unavailableButton, /aria-disabled="true"/);
    assert.doesNotMatch(unavailableButton, /data-open-track-modal-(?:editor|folder)/);
  }
  assert.doesNotMatch(closeButton, /\sdisabled(?:\s|>)/);
  assert.match(closeButton, /data-close-track-modal="1"/);
});

test('Album Details owns icon masks but delegates disabled treatment to ActionButton', () => {
  const css = fs.readFileSync(
    path.join(repoRoot, 'music_app', 'static', 'css', 'runtime', 'album-details-components.css'),
    'utf8',
  );

  assert.match(css, /\.album-details-header__action-icon\s*\{[^}]*width:\s*18px[^}]*height:\s*18px[^}]*background:\s*currentColor/s);
  assert.match(css, /album-details-header__action-icon--edit[^}]*tabler-tag\.svg/s);
  assert.match(css, /album-details-header__action-icon--folder[^}]*tabler-folder-open\.svg/s);
  assert.match(css, /album-details-header__action-icon--close[^}]*tabler-x\.svg/s);
  assert.doesNotMatch(css, /\.album-details-header__action:disabled/);
});

test('Album Details loading shell uses the same outline icon treatment', () => {
  const template = fs.readFileSync(
    path.join(repoRoot, 'music_app', 'templates', 'partials', 'primary-modals.html'),
    'utf8',
  );
  const headerStart = template.indexOf('<div class="track-modal-header">');
  const headerEnd = template.indexOf('<div class="track-modal-tabs"', headerStart);
  const header = template.slice(headerStart, headerEnd);

  assert.match(header, /album-details-header__action-icon--edit/);
  assert.match(header, /album-details-header__action-icon--folder/);
  assert.match(header, /album-details-header__action-icon--close/);
  assert.match(header, /action_button/);
  assert.doesNotMatch(header, /&#9998;|📁|✕/);
});

test('Editorial Album Details aligns the track table with its title and metadata', () => {
  const css = fs.readFileSync(
    path.join(repoRoot, 'music_app', 'static', 'css', 'runtime', 'track-modal-and-lightbox.css'),
    'utf8',
  );
  assert.match(
    css,
    /\.track-modal-dialog:has\(> \.track-modal-header > \.album-details-header\[data-album-details-layout="editorial_canvas"\]\) \.track-modal-list\s*\{[^}]*padding-left:\s*0/s,
  );
});

test('Editorial mobile stacking wins the same-selector cascade after desktop layout rules', () => {
  const css = fs.readFileSync(path.join(repoRoot, 'music_app/static/css/runtime/track-modal-and-lightbox.css'), 'utf8');
  const dialog = '.track-modal-dialog:has(> .track-modal-header > .album-details-header[data-album-details-layout="editorial_canvas"])';
  for (const [selector, display] of [[dialog, 'flex'], [`${dialog} > .track-modal-body`, 'grid']]) {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rules = [...css.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'g'))];
    assert.ok(rules.length >= 2);
    assert.match(rules.at(-1)[1], new RegExp(`display:\\s*${display}\\s*;`), 'the mobile declaration must not be overridden by a later unconditional desktop declaration');
    assert.ok(css.lastIndexOf('@media (max-width: 720px)', rules.at(-1).index) > rules[0].index);
  }
});

test('missing Album Details host does not draw a second alert surface', () => {
  const css = fs.readFileSync(
    path.join(repoRoot, 'music_app', 'static', 'css', 'runtime', 'track-modal-and-lightbox.css'),
    'utf8',
  );
  assert.match(css, /\.track-modal-missing-warning\s*\{[^}]*padding:\s*0\s*;/s);
  assert.match(css, /\.track-modal-missing-warning\s*\{[^}]*border:\s*0\s*;/s);
  assert.match(css, /\.track-modal-missing-warning\s*\{[^}]*background:\s*transparent\s*;/s);
});
