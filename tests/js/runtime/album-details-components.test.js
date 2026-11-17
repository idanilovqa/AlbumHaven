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

test('Loose Tracks header delegates every slot to the shared GalleryBar renderer', () => {
  const context = loadComponents();
  let received = null;
  context.buildGalleryBarContentsHtml = config => {
    received = config;
    return '<shared-gallery-bar>';
  };

  const html = context.buildLooseTracksPageHeaderHtml({
    title: 'Женя машина',
    subtitle: '85 tracks',
    leadingHtml: '<artbox>',
    actionsHtml: '<actions>',
  });

  assert.equal(html, '<shared-gallery-bar>');
  assert.deepEqual(JSON.parse(JSON.stringify(received)), {
    pageHeading: true,
    leadingHtml: '<artbox>',
    title: 'Женя машина',
    titleId: 'non-album-modal-title',
    summary: '85 tracks',
    summaryId: 'non-album-modal-subtitle',
    actionsHtml: '<actions>',
  });
});

test('Album Details consumes only authorized selected-cover presentation slots', () => {
  const context = loadComponents();
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.resolveAlbumDetailsCoverSlots({
      selected_covers_loaded: true,
      selected_covers: [
        { selection_id: 'front', image_url: '/cover?selection_id=front', path: 'C:/private/front.jpg' },
        { selection_id: 'back', unavailable: true, path: 'C:/private/back.jpg' },
      ],
    }))),
    [
      { selectionId: 'front', imageUrl: '/cover?selection_id=front', unavailable: false },
      { selectionId: 'back', imageUrl: '', unavailable: true },
    ],
  );
  assert.equal(context.resolveAlbumDetailsCoverSlots({ selected_covers: [] }).length, 0);
});

test('Album Details keeps a singleton on the existing artbox', () => {
  const context = loadComponents();
  const frontHtml = '<span class="album-artbox">Front</span>';
  const html = context.buildAlbumDetailsCoverStackHtml({
    frontHtml,
    albumName: 'Album',
    slots: [{ selection_id: 'front', image_url: '/cover?selection_id=front' }],
  });

  assert.equal(html, frontHtml);
});

test('Album Details keeps an unavailable saved slot explicit when only the primary is available', () => {
  const context = loadComponents();
  const html = context.buildAlbumDetailsCoverStackHtml({
    frontHtml: '<span class="album-artbox">Front</span>',
    albumName: 'Album',
    slots: [
      { selection_id: 'front', image_url: '/cover?selection_id=front' },
      { selection_id: 'missing', unavailable: true },
    ],
  });

  assert.match(html, /album-details-cover-stack/);
  assert.match(html, /is-unavailable[^>]*role="img"/);
  assert.doesNotMatch(html, /data-album-details-cover-step/);
});

test('Album Details stacks authorized covers in saved order with shared buttons', () => {
  const context = loadComponents();
  const html = context.buildAlbumDetailsCoverStackHtml({
    frontHtml: '<span class="album-artbox">Front</span>',
    albumName: 'Album',
    activeIndex: 0,
    slots: [
      { selection_id: 'front', image_url: '/cover?selection_id=front' },
      { selection_id: 'back', image_url: '/cover?selection_id=back' },
      { selection_id: 'insert', unavailable: true },
    ],
  });

  assert.match(html, /album-details-cover-stack/);
  assert.match(html, /data-album-details-cover-index="1"[\s\S]*selection_id=back/);
  assert.match(html, /class="album-details-cover-stack__rear is-bottom is-unavailable"[^>]*data-album-details-cover-index="2"/);
  assert.match(html, /data-album-details-cover-step="-1"/);
  assert.match(html, /data-album-details-cover-step="1"/);
  assert.match(html, /action-button--bare/);
  assert.doesNotMatch(html, /[A-Z]:\\|data-cover-path|\/Music\//);
});

test('Album Details stack exposes bounded pointer-position variables', () => {
  const context = loadComponents();
  const listeners = {};
  const values = new Map();
  const stack = {
    dataset: {},
    style: {
      setProperty(name, value) { values.set(name, value); },
      removeProperty(name) { values.delete(name); },
    },
    addEventListener(type, listener) { listeners[type] = listener; },
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 100, height: 200 }),
  };

  context.bindAlbumDetailsCoverStackPointer(stack);
  listeners.pointermove({ clientX: 110, clientY: 20 });
  assert.equal(values.get('--album-cover-pointer-x'), '2.000px');
  assert.equal(values.get('--album-cover-pointer-y'), '-2.000px');
  assert.equal(values.get('--album-cover-pointer-rotation'), '0.600deg');
  listeners.pointerup();
  assert.equal(values.size, 0);
  listeners.pointermove({ clientX: 110, clientY: 20 });
  listeners.pointerleave();
  assert.equal(values.size, 0);
});

test('a mouse press on the cover arrows or rear covers neither selects text nor takes focus', () => {
  const context = loadComponents();
  const listeners = {};
  const stack = { dataset: {}, style: { setProperty() {}, removeProperty() {} }, addEventListener(type, listener) { listeners[type] = listener; } };
  context.bindAlbumDetailsCoverStackPointer(stack);
  const press = (button, matches) => {
    let prevented = false;
    listeners.mousedown({ button, target: { closest: () => (matches ? {} : null) }, preventDefault() { prevented = true; } });
    return prevented;
  };
  assert.equal(press(0, true), true);
  assert.equal(press(0, false), false, 'the front cover keeps its normal press');
  assert.equal(press(2, true), false, 'a right press keeps its context menu');
});

test('Album Details stack reserves layout room and is static under reduced motion', () => {
  const css = fs.readFileSync(
    path.join(repoRoot, 'music_app', 'static', 'css', 'runtime', 'track-modal-and-lightbox.css'),
    'utf8',
  );
  assert.match(css, /\.track-modal-dialog:has\(\.album-details-cover-stack\)[^}]*width:\s*min\(892px/s);
  assert.match(css, /\.track-modal-body:has\(\.album-details-cover-stack\)[^}]*grid-template-columns:\s*minmax\(260px, 320px\)/s);
  assert.match(css, /\.album-details-cover-stack\s*\{[^}]*padding-block:\s*12px/s);
  assert.match(css, /\.album-details-cover-stack__rear\.is-top[^}]*--album-cover-pointer-x/s);
  assert.match(css, /\.album-details-cover-nav\s*\{[^}]*border:\s*0[^}]*background:\s*transparent/s);
  assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*\.album-details-cover-stack__rear[^}]*transition:\s*none/s);
});

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

test('Album Details renders source markers as focusable shared SmallAlerts below the desktop cover', () => {
  const context = loadComponents();
  const html = context.buildAlbumCoverSourceMarkersHtml({
    root_provenance: { categories: ['main_library', 'hoard', 'new_arrivals'] },
  });

  assert.match(html, /album-details-cover-source-markers/);
  assert.match(html, /aria-label="Hoard"/);
  assert.match(html, /aria-label="New Arrivals"/);
  assert.equal((html.match(/small-alert small-alert--info small-alert--fit-content album-details-source-marker/g) || []).length, 2);
  assert.equal((html.match(/tabindex="0"/g) || []).length, 2);
  assert.match(html, /small-alert__text">Hoard</);
  assert.match(html, /small-alert__text">New Arrivals</);
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

test('mobile Album Details keeps source alerts on the artwork instead of either header or the rail', () => {
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
  assert.doesNotMatch(components, /mobile-album-overview__source-markers|mobileHeader\?\.querySelector\([^\n]*album-details-cover-source-markers/);
  assert.doesNotMatch(mobileCss, /mobile-album-source-markers|mobile-album-overview__source-markers|mobile-page-header > \.album-details-cover-source-markers/);
  assert.match(components, /overview\.prepend\(rail\)/);
  assert.doesNotMatch(components, /(?:rail|mobileHeader)\.appendChild\(sourceMarkers\)/);
  assert.match(navigation, /mobile-album-overview__rail/);
  assert.match(
    mobileCss,
    /mobile-album-overview__rail[^}]*grid-column:\s*1[^}]*grid-row:\s*1[^}]*flex-direction:\s*column[^}]*gap:\s*8px/s,
  );
  assert.doesNotMatch(mobileCss, /mobile-album-overview\s*>\s*\.album-details-cover-source-markers[^}]*grid-row:\s*1/s);
  assert.match(mobileCss, /track-modal-cover\s*\{[^}]*position:\s*relative/s);
  assert.match(mobileCss, /album-details-cover-source-markers[^}]*position:\s*absolute[^}]*left:\s*12px[^}]*bottom:\s*12px[^}]*flex-direction:\s*column[^}]*align-items:\s*flex-start/s);
  assert.match(mobileCss, /album-details-cover-source-markers \.album-details-source-marker[^}]*--mobile-source-marker-size:\s*32px[^}]*--mobile-source-glyph-size:\s*20px[^}]*width:\s*var\(--mobile-source-marker-size\)[^}]*height:\s*var\(--mobile-source-marker-size\)/s);
  assert.match(mobileCss, /album-details-source-marker \.small-alert__icon[^}]*width:\s*calc\(var\(--mobile-source-marker-size\) - 2px\)[^}]*height:\s*calc\(var\(--mobile-source-marker-size\) - 2px\)/s);
  assert.match(mobileCss, /album-details-source-marker svg[^}]*width:\s*var\(--mobile-source-glyph-size\)[^}]*height:\s*var\(--mobile-source-glyph-size\)/s);
  assert.match(mobileCss, /data-album-details-layout="classic_bar"[^}]*album-details-source-marker[^}]*--mobile-source-marker-size:\s*34px[^}]*--mobile-source-glyph-size:\s*18px/s);
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

test('Loose Tracks main-window header uses bare Edit Tags and a frameless clearable selection status', () => {
  const context = loadComponents();
  const html = context.buildAlbumDetailsHeaderHtml({
    variant: 'copy',
    title: 'Loose Tracks',
    subtitle: 'Non-album tracks found in Folkstone and family artist folders.',
    titleId: 'non-album-modal-title',
    subtitleId: 'non-album-modal-subtitle',
    actionsHtml: context.buildLooseTracksHeaderActionsHtml({ showClose: false }),
  });

  assert.match(html, /class="album-details-header"/);
  assert.match(html, /data-album-details-variant="copy"/);
  assert.match(html, /id="non-album-modal-title">Loose Tracks</);
  assert.match(html, /id="non-album-modal-subtitle">Non-album tracks found in Folkstone and family artist folders\.<\/div>/);
  assert.match(html, /id="non-album-modal-edit-tags"/);
  assert.match(html, /data-non-album-selection-status[^>]*hidden/);
  assert.match(html, /data-non-album-selection-count[^>]*role="status"[^>]*><\/span>/);
  assert.doesNotMatch(html, /0 selected/);
  assert.match(html, /data-open-non-album-tag-editor="1"/);
  assert.match(html, /album-details-header__action-icon--edit/);
  assert.match(html, /data-clear-non-album-track-selection="1"/);
  assert.match(html, /aria-label="Clear track selection"/);
  assert.equal((html.match(/action-button--bare/g) || []).length, 2);
  assert.doesNotMatch(html, /id="non-album-modal-close"|data-close-non-album-modal/);
  assert.equal((html.match(/ui-button--icon ui-button--medium action-button/g) || []).length, 2);
  assert.doesNotMatch(html, /album-details-header__action-icon--folder|&#9998;|✕/);
});

test('copy header renders shared leading content inside its identity owner', () => {
  const context = loadComponents();
  const html = context.buildAlbumDetailsHeaderHtml({
    variant: 'copy',
    title: 'Night',
    leadingHtml: '<span data-compact-artbox="1"></span>',
  });

  assert.match(html, /album-details-header__identity"><span data-compact-artbox="1"><\/span><div class="album-details-header__copy">/);
});

test('Loose Tracks disables Edit Tags when the capability bootstrap denies it', () => {
  const context = loadComponents();
  context.AlbumHavenCapabilities = { allows: () => false };

  const html = context.buildLooseTracksHeaderActionsHtml();
  const editButton = html.match(/<button[^>]*id="non-album-modal-edit-tags"[^>]*>/)?.[0] || '';

  assert.match(editButton, /\sdisabled(?:\s|>)/);
  assert.match(editButton, /aria-disabled="true"/);
  assert.doesNotMatch(editButton, /data-open-non-album-tag-editor/);
});

test('Loose Tracks template delegates its header contents to AlbumDetailsHeader', () => {
  const template = fs.readFileSync(
    path.join(repoRoot, 'music_app', 'templates', 'partials', 'primary-modals.html'),
    'utf8',
  );
  const modalStart = template.indexOf('<div class="non-album-modal"');
  const modalEnd = template.indexOf('</div>\n\n  <div', modalStart);
  const modal = template.slice(modalStart, modalEnd);

  // Since a943cda48 the empty header container is also the shared page GalleryBar; its contents stay delegated.
  assert.match(modal, /<div class="non-album-modal-header gallery-bar page-gallery-bar" id="non-album-modal-header" data-gallery-bar data-gallery-bar-instance="page"><\/div>/);
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

test('an album whose tag names another artist shows its MusicBrainz artist, display only', () => {
  const context = loadComponents();
  const greyAlbum = {
    album_artist: 'Jay-Z',
    musicbrainz_artist: { canonical_name: 'Danger Mouse', tag_differs: true },
  };

  assert.equal(context.albumDisplayArtist(greyAlbum), 'Danger Mouse');
  assert.equal(context.albumTaggedArtistNote(greyAlbum), 'Tagged as Jay-Z');
  // An identity that agrees with the tag, or none, keeps the tag and adds no note.
  // A split artist's album names its own MusicBrainz artist.
  assert.equal(context.albumTaggedArtistNote({ album_artist: 'Amarok', musicbrainz_artist: {
    canonical_name: 'Amarok', disambiguation: 'Spanish fusion band', tag_differs: false, split: true } }),
  'MusicBrainz: Amarok (Spanish fusion band)');
  for (const album of [{ album_artist: 'Amarok', musicbrainz_artist: { canonical_name: 'Amarok', tag_differs: false } },
    { album_artist: 'Amarok' }]) {
    assert.equal(context.albumDisplayArtist(album), 'Amarok');
    assert.equal(context.albumTaggedArtistNote(album), '');
  }
});

test('an artist matched under another name is titled with its MusicBrainz name, display only', () => {
  const context = loadComponents();
  const credited = { canonical_name: 'Danger Mouse', credited_as: 'Jay-Z' };

  assert.equal(context.galleryArtistDisplayName('Jay-Z', credited), 'Danger Mouse');
  assert.equal(context.galleryArtistDisplayName('Amarok', { canonical_name: 'Amarok' }), 'Amarok');
  assert.equal(context.galleryArtistDisplayName('Amarok', { identities: [] }), 'Amarok');
  assert.match(context.buildGalleryBarHtml({ contextKind: 'artist', artist: 'Jay-Z', albumCount: 1, artist_musicbrainz: credited }),
    /data-gallery-context-name>Danger Mouse<\/span>.*data-artist="Jay-Z"/s, 'the info trigger still names the tag');
});

test('a split artist\'s panel lists each MusicBrainz artist with its albums and link', () => {
  const context = loadComponents();
  context.document = { querySelector: () => null, getElementById: () => null, addEventListener() {} };
  vm.runInContext(
    fs.readFileSync(path.join(repoRoot, 'music_app', 'static', 'js', 'runtime', 'gallery-main-interactions.js'), 'utf8'),
    context,
  );
  const html = context.buildGalleryArtistIdentitiesHtml({ identities: [
    { artist_mbid: '75d43a2e-ba60-427c-b2c7-bb666053d2f1', musicbrainz_url: 'https://musicbrainz.org/artist/75d43a2e-ba60-427c-b2c7-bb666053d2f1', canonical_name: 'Amarok',
      disambiguation: 'Polish progressive rock band', album_count: 4 },
    { artist_mbid: 'b42d111d-5932-4c00-8562-8bbf7203f850', musicbrainz_url: 'https://musicbrainz.org/artist/b42d111d-5932-4c00-8562-8bbf7203f850', canonical_name: 'Amarok',
      disambiguation: 'Spanish fusion band', album_count: 1 },
  ] });

  assert.match(html, /Your albums belong to 2 MusicBrainz artists:/);
  assert.match(html, /Amarok \(Polish progressive rock band\) · 4 albums.*href="https:\/\/musicbrainz\.org\/artist\/75d43a2e-ba60-427c-b2c7-bb666053d2f1"/s);
  assert.match(html, /Amarok \(Spanish fusion band\) · 1 album<.*href="https:\/\/musicbrainz\.org\/artist\/b42d111d-5932-4c00-8562-8bbf7203f850"/s);
  assert.equal(context.buildGalleryArtistIdentitiesHtml({ canonical_name: 'Amarok' }), '');

  // Owner 2026-11-14: a person and their same-named band are separate artists; nothing
  // lists a band "also on MusicBrainz" under the person any more.
  assert.equal(context.buildGalleryArtistIdentitiesHtml({ canonical_name: 'Alice Cooper', associated: [
    { artist_mbid: '4d7928cd-7ed2-4282-8c29-c0c9f966f1bd', canonical_name: 'Alice Cooper', album_count: 7 },
  ] }), '');
});

test('Editorial Album Details wraps long titles without covering header actions', () => {
  const css = fs.readFileSync(
    path.join(repoRoot, 'music_app/static/css/runtime/album-details-components.css'),
    'utf8',
  );

  assert.match(
    css,
    /data-album-details-layout="editorial_canvas"\] \.album-details-header__primary\s*\{[^}]*white-space:\s*normal;[^}]*overflow-wrap:\s*anywhere;/s,
  );
  assert.match(
    css,
    /data-album-details-layout="editorial_canvas"\] \.album-details-header__actions\s*\{[^}]*grid-column:\s*2;/s,
  );
});

test('Album Details callers use presentation-only title and year values', () => {
  const runtimeRoot = path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'js', 'runtime');
  const tagEditorSource = fs.readFileSync(
    path.join(runtimeRoot, 'tag-editor-and-optimistic-updates.js'),
    'utf8',
  );
  const mobileSource = fs.readFileSync(path.join(runtimeRoot, 'album-details-components.js'), 'utf8');

  assert.match(tagEditorSource, /album:\s*album\.display_name\s*\|\|\s*album\.name/);
  assert.match(tagEditorSource, /year:\s*album\.display_year\s*\|\|\s*album\.year/);
  assert.match(mobileSource, /title:\s*album\.display_name\s*\|\|\s*album\.name/);
  assert.match(mobileSource, /album\.display_year\s*\|\|\s*album\.year/);
});

test('cover arrows never flash a ring when the cursor leaves them', () => {
  // Owner 2026-11-16: "after I click if I move the mouse away from the arrow the white circle around arrow
  // flashes". The hover-only `outline: none` reset the outline colour to white, which faded out on leave.
  const css = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'music_app', 'static', 'css', 'runtime', 'track-modal-and-lightbox.css'), 'utf8');
  // One block covers the arrows at rest and on hover/press, so hover never resets the outline on its own
  // and out-ranks the shared bare-button hover fill (owner 2026-11-17: no hover circle).
  const rule = css.match(/\.album-details-cover-stack \.album-details-cover-nav\.action-button--bare,\s*[^{]*\.album-details-cover-nav\.action-button--bare:is\(:hover, :active\):not\(:disabled\):not\(\[aria-disabled='true'\]\) \{([^}]*)\}/)?.[1] || '';
  assert.match(rule, /background: transparent !important;/);
  assert.match(rule, /outline: none !important;/);
  assert.match(rule, /outline-color: transparent !important;/);
  assert.match(rule, /transition: none;/);
});
