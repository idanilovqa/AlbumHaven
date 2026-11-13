const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const repoRoot = path.join(__dirname, '..', '..', '..');

function loadTrackTable() {
  const context = {
    escapeHtml: (value) => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'),
    encodeURIComponent,
    ButtonComponent: require(path.join(repoRoot, 'music_app', 'static', 'js', 'button-component.js')),
  };
  vm.createContext(context);
  for (const filename of ['compact-data-table.js', 'album-track-table.js']) {
    vm.runInContext(
      fs.readFileSync(path.join(repoRoot, 'music_app', 'static', 'js', 'runtime', filename), 'utf8'),
      context,
    );
  }
  return context;
}

function createSelectionHarness(context) {
  const listeners = new Map();
  const scrollListeners = new Map();
  const timers = new Map();
  let nextTimer = 1;
  context.scheduleBrowserTimeout = (callback, delay) => {
    const id = nextTimer++;
    timers.set(id, { callback, delay });
    return id;
  };
  context.clearBrowserTimeout = (id) => timers.delete(id);
  const classList = () => {
    const values = new Set();
    return {
      add: value => values.add(value),
      remove: value => values.delete(value),
      contains: value => values.has(value),
    };
  };
  const rows = ['one', 'two', 'three', 'four'].map((path) => ({
    dataset: { trackRowPath: path },
    classList: classList(),
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = String(value); },
    removeAttribute(name) { delete this.attributes[name]; },
    closest(selector) {
      return selector === '[data-track-row-path]' ? this : null;
    },
  }));
  const scrollTarget = {
    scrollTop: 0,
    scrollLeft: 0,
    addEventListener(type, handler) { scrollListeners.set(type, handler); },
    removeEventListener(type) { scrollListeners.delete(type); },
  };
  let queryCount = 0;
  const root = {
    addEventListener(type, handler) { listeners.set(type, handler); },
    removeEventListener(type) { listeners.delete(type); },
    querySelectorAll() { queryCount += 1; return rows; },
    closest() { return scrollTarget; },
  };
  const dispatch = (type, row, overrides = {}) => listeners.get(type)?.({
    target: row,
    pointerId: 1,
    pointerType: 'mouse',
    button: 0,
    clientX: 0,
    clientY: 0,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    preventDefault() {},
    stopImmediatePropagation() {},
    ...overrides,
  });
  const runTimers = (delay) => {
    [...timers].forEach(([id, timer]) => {
      if (timer.delay !== delay) return;
      timers.delete(id);
      timer.callback();
    });
  };
  return { root, rows, scrollTarget, scrollListeners, listeners, dispatch, runTimers, queryCount: () => queryCount };
}

test('AlbumTrackTable changes only the inner Play and Pause glyphs to centered shared SVGs', () => {
  const context = loadTrackTable();
  const idle = context.buildAlbumTrackPlayButtonHtml({ path: 'idle.flac', title: 'Idle' });
  const playing = context.buildAlbumTrackPlayButtonHtml({ path: 'playing.flac', title: 'Playing', isPlaying: true });

  assert.match(idle, /^<button class="play-track-button album-track-table__play"[^>]*type="button" aria-label="Play track"><svg class="ui-icon album-track-table__play-icon ui-icon--play"/);
  assert.match(playing, /^<button class="play-track-button album-track-table__play"[^>]*type="button" aria-label="Pause track"><svg class="ui-icon album-track-table__play-icon ui-icon--pause"/);
  assert.doesNotMatch(idle, /&#x25B6;|&#x23F8;/);
  assert.doesNotMatch(playing, /&#x25B6;|&#x23F8;/);
  assert.match(idle, /aria-hidden="true" focusable="false"/);
  assert.match(playing, /aria-hidden="true" focusable="false"/);
  const buttonCss = fs.readFileSync(path.join(repoRoot, 'music_app', 'static', 'css', 'button-component.css'), 'utf8');
  assert.match(buttonCss, /\.ui-icon\s*\{[^}]*width:\s*1em[^}]*height:\s*1em[^}]*display:\s*block/s);
  assert.match(buttonCss, /\.ui-icon--play,[\s\S]*\.ui-icon--pause\s*\{[^}]*fill:\s*currentColor[^}]*stroke:\s*none/s);
});

test('AlbumTrackTable composes CompactDataTable compact rows and preserves playback hooks', () => {
  const context = loadTrackTable();
  const html = context.buildAlbumTrackTableHtml({
    groups: [{
      discNumber: 1,
      discLabel: 'CD 1',
      tracks: [{ path: 'C:/Music/song.flac', title: 'Mystery Train', trackNumber: 3, duration: '6:52', isPlaying: true }],
    }],
    multiDisc: false,
    totalLength: '1h 17m 13s',
    playingAnimation: true,
  });

  assert.match(html, /data-cdt-density="compact"/);
  assert.match(html, /class="[^"]*album-track-table__row--playing/);
  assert.match(html, /class="play-track-button/);
  assert.match(html, /data-track-row-path="C:\/Music\/song\.flac"/);
  assert.match(html, /Mystery Train/);
  assert.match(html, /6:52/);
  assert.doesNotMatch(html, />Tracks</);
  assert.doesNotMatch(html, /album-track-table__disc-heading/);
  assert.match(html, /class="album-track-table__total"/);
});

test('AlbumTrackTable renders shared loading rows with the real table geometry', () => {
  const context = loadTrackTable();
  const html = context.buildAlbumTrackTableHtml({
    groups: [{ discLabel: 'Loading', loadingRows: 4 }],
    showPath: true,
    collapsibleGroups: true,
    ariaLabel: 'Loading loose tracks',
  });

  assert.match(html, /aria-busy="true"/);
  assert.equal((html.match(/album-track-table__row--skeleton/g) || []).length, 4);
  assert.match(html, /album-track-table__skeleton--heading/);
  assert.match(html, /data-cdt-column="path"/);
  assert.doesNotMatch(html, />Loading<\/summary>/);
});

test('collapsible AlbumTrackTable groups reuse the PF shared disclosure component', () => {
  const context = loadTrackTable();
  const html = context.buildAlbumTrackTableHtml({
    groups: [{ discLabel: 'Custom Collection — Road trip', tracks: [{ path: 'one', title: 'One' }] }],
    forceGroupLabels: true,
    collapsibleGroups: true,
  });

  assert.match(html, /<summary class="utility-section-toggle album-track-table__disc-heading"/);
  assert.match(html, /class="utility-section-chevron"[^>]*width="14" height="14"/);
  assert.match(html, /class="album-track-table__disc-content"/);
  assert.doesNotMatch(html, /summary::before/);
});

test('AlbumTrackTable marks named sections for shared row styling', () => {
  const context = loadTrackTable();
  const html = context.buildAlbumTrackTableHtml({
    groups: [{ namedSection: true, discLabel: 'Second movement', tracks: [{ path: 'two.flac', title: 'Two' }] }],
  });

  assert.match(html, /album-track-table__disc--named/);
  assert.match(html, /album-track-table__disc-heading[^>]*>Second movement<\/h4>/);
  const css = fs.readFileSync(path.join(repoRoot, 'music_app', 'static', 'css', 'runtime', 'album-track-table.css'), 'utf8');
  assert.match(css, /album-track-table__disc--named[\s\S]*padding:\s*7px 10px[\s\S]*background:\s*color-mix/);
});

test('AlbumTrackTable uses an opaque member identity without inventing another table', () => {
  const context = loadTrackTable();
  const html = context.buildAlbumTrackTableHtml({
    groups: [{ tracks: [{
      media_ref: 'opaque-resume-token',
      playback_ref: 'opaque-playback-ref',
      playback_ref_expires_at: '2099-01-01T00:00:00Z',
      title: 'Path-free song',
    }] }],
  });

  assert.match(html, /data-track-row-path="opaque-resume-token"/);
  assert.match(html, /data-media-ref="opaque-resume-token"/);
  assert.match(html, /data-playback-ref="opaque-playback-ref"/);
  assert.match(html, /data-playback-ref-expires-at="2099-01-01T00:00:00Z"/);
  assert.match(html, /data-src="\/track\?ref=opaque-resume-token"/);
  assert.doesNotMatch(html, /data-cdt-column="path"/);
});

test('AlbumTrackTable carries opaque CUE identity through the shared play button', () => {
  const context = loadTrackTable();
  const html = context.buildAlbumTrackTableHtml({
    groups: [{ tracks: [{ cue_segment_ref: 'cue:logical-track', title: 'Logical CUE track' }] }],
  });

  assert.match(html, /data-track-row-path="cue:logical-track"/);
  assert.match(html, /data-cue-segment-ref="cue:logical-track"/);
  assert.match(html, /data-src="\/track\?cue=cue%3Alogical-track"/);
  assert.doesNotMatch(html, /data-cdt-column="path"/);
});

test('AlbumTrackTable reserves a headerless problem column immediately before Length', () => {
  const context = loadTrackTable();
  const html = context.buildAlbumTrackTableHtml({
    groups: [{
      discNumber: 1,
      tracks: [
        { path: 'problem.flac', title: 'Problem Track', trackNumber: 1, duration: '4:05', isProblematic: true },
        { path: 'clean.flac', title: 'Clean Track', trackNumber: 2, duration: '3:22' },
      ],
    }],
  });

  assert.match(html, /--cdt-columns: 36px minmax\(0, 1fr\) 20px minmax\(54px, auto\)/);
  assert.doesNotMatch(html, /data-cdt-column="play"/);
  assert.match(html, /data-cdt-column="title"[^>]*>Track<\/div><div data-cdt-column="problem" data-cdt-action aria-hidden="true"><\/div><div role="columnheader" data-cdt-column="duration"/);
  assert.match(html, /data-cdt-column="title"[^>]*><span[^>]*>Problem Track<\/span><\/div><div role="cell" data-cdt-column="problem" data-cdt-action><button class="track-problem-link"/);
  assert.match(html, /data-cdt-column="problem" data-cdt-action><button[\s\S]*data-open-track-problematic="1"[\s\S]*aria-label="Open this track in Problematic Files">!<\/button><\/div><div role="cell" data-cdt-column="duration"/);
  assert.match(html, /data-cdt-row-key="clean\.flac"[\s\S]*data-cdt-column="problem" data-cdt-action><\/div><div role="cell" data-cdt-column="duration"/);
});

test('AlbumTrackTable Loose Tracks variant inserts File path before the existing problem slot', () => {
  const context = loadTrackTable();
  const html = context.buildAlbumTrackTableHtml({
    showPath: true,
    forceGroupLabels: true,
    ariaLabel: 'Loose tracks',
    groups: [{
      discLabel: 'Non-album rarity',
      tracks: [{
        path: 'C:/Music/Artist/Rare.flac',
        title: 'Rare Song',
        secondaryArtist: 'Guest Artist',
        displayPath: 'Artist/Rare.flac',
        trackNumber: 1,
        duration: '4:05',
      }],
    }],
    totalLength: '4:05',
  });

  assert.match(html, /--cdt-columns: 36px minmax\(180px, 1fr\) minmax\(220px, \.9fr\) 20px minmax\(54px, auto\)/);
  assert.match(html, /aria-label="Loose tracks — Non-album rarity"/);
  assert.match(html, /album-track-table__disc-heading[^>]*>Non-album rarity<\/h4>/);
  assert.match(html, /data-cdt-column="number"[^>]*>#<[\s\S]*data-cdt-column="title"[^>]*>Track<[\s\S]*data-cdt-column="path"[^>]*>File path<[\s\S]*data-cdt-column="problem"[^>]*aria-hidden="true"[\s\S]*data-cdt-column="duration"[^>]*>Length/);
  assert.match(html, /class="album-track-table__secondary">Guest Artist<\/span>/);
  assert.match(html, /data-cdt-column="path"[^>]*><span class="album-track-table__path" title="Artist\/Rare\.flac">Artist\/Rare\.flac<\/span>/);
  assert.match(html, /data-cdt-column="problem" data-cdt-action><\/div><div role="cell" data-cdt-column="duration"/);
  assert.match(html, /class="album-track-table__total"><div class="album-track-table__aggregate-total">Total Length: 4:05<\/div><\/div>/);
});

test('AlbumTrackTable composes caller-owned optional columns and a narrow title supplement', () => {
  const context = loadTrackTable();
  const html = context.buildAlbumTrackTableHtml({
    groups: [{ tracks: [{ path: 'track.flac', title: 'Track', rating: 4, plays: 23 }] }],
    optionalColumns: [
      {
        key: 'rating', label: 'Rating', width: '72px', visibility: 'desktop',
        cell: track => `<span class="test-rating">${track.rating}/5</span>`,
      },
      {
        key: 'plays', label: 'Plays', width: '48px',
        cell: track => `<span class="test-plays">${track.plays}</span>`,
      },
    ],
    mobile: 'grouped',
    mobileColumns: '36px minmax(0, 1fr) 48px minmax(54px, auto)',
    mobileTitleSupplement: track => `<span class="test-mobile-meta">${track.rating}/5</span>`,
  });

  assert.match(html, /--cdt-columns: 36px minmax\(0, 1fr\) 72px 48px 20px minmax\(54px, auto\)/);
  assert.match(html, /--cdt-mobile-columns: 36px minmax\(0, 1fr\) 48px minmax\(54px, auto\)/);
  assert.match(html, /data-cdt-mobile="grouped"/);
  assert.match(html, /data-cdt-column="rating" data-cdt-visibility="desktop"/);
  assert.match(html, /class="test-rating">4\/5/);
  assert.match(html, /class="test-plays">23/);
  assert.match(html, /album-track-table__mobile-meta[^>]*><span class="test-mobile-meta">4\/5/);
});

test('TrackSelectionController supports desktop range drag and additive taps', () => {
  const context = loadTrackTable();
  const harness = createSelectionHarness(context);
  const changes = [];
  const controller = new context.TrackSelectionController(harness.root, {
    onChange: paths => changes.push([...paths]),
  });

  harness.dispatch('pointerdown', harness.rows[0]);
  harness.dispatch('pointermove', harness.rows[2], { clientY: 40 });
  harness.dispatch('pointerup', harness.rows[2], { clientY: 40 });
  assert.deepEqual(Array.from(controller.getSelectedPaths()), ['one', 'two', 'three']);

  harness.dispatch('pointerdown', harness.rows[3], { ctrlKey: true });
  harness.dispatch('pointerup', harness.rows[3], { ctrlKey: true });
  assert.deepEqual(Array.from(controller.getSelectedPaths()), ['one', 'two', 'three', 'four']);
  assert.deepEqual(changes.at(-1), ['one', 'two', 'three', 'four']);
  let doubleClickPrevented = false;
  let doubleClickStopped = false;
  harness.dispatch('dblclick', harness.rows[1], {
    preventDefault: () => { doubleClickPrevented = true; },
    stopImmediatePropagation: () => { doubleClickStopped = true; },
  });
  assert.equal(doubleClickPrevented, true);
  assert.equal(doubleClickStopped, true);
  for (const row of harness.rows) {
    assert.equal(row.classList.contains('album-track-table__row--selected'), true);
    assert.equal(row.attributes['aria-selected'], 'true');
  }
});

test('TrackSelectionController caches rows, suppresses native drag selection, and clears in one action', () => {
  const context = loadTrackTable();
  const harness = createSelectionHarness(context);
  let pointerDownPrevented = 0;
  const controller = new context.TrackSelectionController(harness.root);

  harness.dispatch('pointerdown', harness.rows[0], { preventDefault: () => { pointerDownPrevented += 1; } });
  harness.dispatch('pointermove', harness.rows[3], { clientY: 60 });
  harness.dispatch('pointerup', harness.rows[3], { clientY: 60 });

  assert.equal(pointerDownPrevented, 1);
  assert.equal(harness.queryCount(), 1, 'drag selection must not rescan rendered rows');
  assert.deepEqual(Array.from(controller.getSelectedPaths()), ['one', 'two', 'three', 'four']);
  controller.clear();
  assert.deepEqual(Array.from(controller.getSelectedPaths()), []);
  assert.equal(harness.queryCount(), 1, 'clear must reuse the cached row index');
});

test('TrackSelectionController requires a stationary 550 ms touch hold and cleans up', () => {
  const context = loadTrackTable();
  const harness = createSelectionHarness(context);
  const changes = [];
  const controller = new context.TrackSelectionController(harness.root, {
    onChange: paths => changes.push([...paths]),
  });

  harness.dispatch('pointerdown', harness.rows[0], { pointerType: 'touch' });
  harness.scrollTarget.scrollTop = 12;
  harness.scrollListeners.get('scroll')();
  harness.runTimers(550);
  assert.deepEqual(Array.from(controller.getSelectedPaths()), []);

  harness.scrollTarget.scrollTop = 0;
  harness.dispatch('pointerdown', harness.rows[0], { pointerType: 'touch' });
  harness.runTimers(550);
  assert.deepEqual(Array.from(controller.getSelectedPaths()), ['one']);

  harness.dispatch('pointermove', harness.rows[2], {
    pointerType: 'touch', clientX: 0, clientY: 40,
  });
  harness.dispatch('pointerup', harness.rows[2], {
    pointerType: 'touch', clientX: 0, clientY: 40,
  });
  assert.deepEqual(
    Array.from(controller.getSelectedPaths()),
    ['one', 'two', 'three'],
    'dragging after the hold extends the touch selection range',
  );

  harness.dispatch('pointerdown', harness.rows[3], { pointerType: 'touch' });
  harness.dispatch('pointerup', harness.rows[3], { pointerType: 'touch' });
  assert.deepEqual(Array.from(controller.getSelectedPaths()), ['one', 'two', 'three', 'four']);

  harness.dispatch('pointerdown', harness.rows[1], { pointerType: 'touch' });
  harness.dispatch('pointercancel', harness.rows[1], { pointerType: 'touch' });
  harness.runTimers(550);
  assert.deepEqual(Array.from(controller.getSelectedPaths()), ['one', 'two', 'three', 'four']);

  controller.destroy();
  assert.deepEqual(changes.at(-1), []);
  assert.equal(harness.listeners.size, 0);
  assert.equal(harness.scrollListeners.size, 0);
  for (const row of harness.rows) {
    assert.equal(row.classList.contains('album-track-table__row--selected'), false);
    assert.equal(row.attributes['aria-selected'], undefined);
  }
});

test('AlbumTrackTable splits a main disc and bonus disc into separate tables without a CD 1 label', () => {
  const context = loadTrackTable();
  const html = context.buildAlbumTrackTableHtml({
    groups: [
      { discNumber: 1, discLabel: 'CD 1', isBonus: false, tracks: [{ path: 'one', title: 'One', trackNumber: 1, duration: '3:01', isSearchMatch: true }] },
      { discNumber: 2, discLabel: 'Bonus Disc', isBonus: true, tracks: [{ path: 'two', title: 'Two', trackNumber: 1, duration: '2:02' }] },
    ],
    multiDisc: true,
  });
  assert.equal((html.match(/class="compact-data-table"/g) || []).length, 2);
  assert.equal((html.match(/class="compact-data-table-header"/g) || []).length, 1);
  assert.doesNotMatch(html, /album-track-table__disc-heading[^>]*>CD 1/);
  assert.match(html, /<section class="album-track-table__disc">[\s\S]*One[\s\S]*<\/section><section class="album-track-table__disc">[\s\S]*album-track-table__disc-heading[^>]*>Bonus Disc<\/h4>[\s\S]*Two[\s\S]*<\/section>/);
  assert.match(html, /data-cdt-headers="visible"[\s\S]*data-cdt-headers="absent"/);
  assert.match(html, /album-track-table__row--search-match/);
});

test('AlbumTrackTable retains aggregate and explicit main and bonus duration summaries in its shared frame', () => {
  const html = loadTrackTable().buildAlbumTrackTableHtml({
    groups: [
      { discNumber: 1, discLabel: 'CD 1', isBonus: false, tracks: [{ path: 'main', title: 'Main' }] },
      { discNumber: 2, discLabel: 'Bonus Disc', isBonus: true, tracks: [{ path: 'bonus', title: 'Bonus' }] },
    ],
    totalLength: '25m 30s', mainLength: '3:00', bonusLength: '22:30',
  });
  assert.match(html, /class="album-track-table__aggregate-total">Total Length: 25m 30s<\/div>/);
  assert.match(html, /class="album-track-table__main-total">Total Main Album Length: 3:00<\/div>/);
  assert.match(html, /class="album-track-table__bonus-total">Bonus Disc Length: 22:30<\/div>/);
  assert.equal((html.match(/class="album-track-table__total"/g) || []).length, 1);
  assert.doesNotMatch(html, /album-track-table__disc-heading[^>]*>CD 1/);
  assert.equal((html.match(/class="compact-data-table-header"/g) || []).length, 1);
});

test('AlbumTrackTable escapes named duration summaries and omits absent summaries', () => {
  const context = loadTrackTable();
  const html = context.buildAlbumTrackTableHtml({ totalLength: '25m', bonusLength: '<img src=x>' });
  assert.match(html, /Bonus Disc Length: &lt;img src=x&gt;/);
  assert.doesNotMatch(html, /album-track-table__main-total/);
  const ordinary = context.buildAlbumTrackTableHtml({ totalLength: '18m' });
  assert.doesNotMatch(ordinary, /album-track-table__(?:main|bonus)-total/);
});

test('AlbumTrackTable labels every main disc outside its separately framed table', () => {
  const context = loadTrackTable();
  const html = context.buildAlbumTrackTableHtml({
    groups: [
      { discNumber: 1, discLabel: 'CD 1', isBonus: false, tracks: [{ path: 'one', title: 'One' }] },
      { discNumber: 2, discLabel: 'CD 2', isBonus: false, tracks: [{ path: 'two', title: 'Two' }] },
    ],
    multiDisc: true,
    totalLength: '42:00',
  });

  assert.match(html, /album-track-table__frame/);
  assert.equal((html.match(/class="compact-data-table"/g) || []).length, 2);
  assert.equal((html.match(/class="compact-data-table-header"/g) || []).length, 1);
  assert.match(html, /<section class="album-track-table__disc">\s*<h4[^>]*>CD 1<\/h4>\s*<div class="compact-data-table"/);
  assert.match(html, /<section class="album-track-table__disc">\s*<h4[^>]*>CD 2<\/h4>\s*<div class="compact-data-table"/);
  assert.match(html, /CD 1[\s\S]*One[\s\S]*CD 2[\s\S]*Two[\s\S]*album-track-table__total/);
});

test('playing spectra share the exact row outline path at opposite offsets and footer has no left edge', () => {
  const css = fs.readFileSync(
    path.join(repoRoot, 'music_app', 'static', 'css', 'runtime', 'album-track-table.css'),
    'utf8',
  );
  assert.match(css, /conic-gradient\(/);
  assert.match(css, /0\.5turn/);
  assert.match(css, /mask:[^;]*linear-gradient/s);
  assert.match(css, /border-radius:\s*inherit/);
  assert.match(css, /animation-duration:\s*var\(--album-track-playing-period/);
  assert.match(css, /\.album-track-table__row--playing\s*\{[^}]*outline:/s);
  assert.match(css, /\.album-track-table__row--playing::before/);
  assert.match(css, /\.album-track-table__row--playing::after/);
  assert.match(css, /--album-track-spectrum-offset:\s*0\.5turn/);
  assert.match(css, /\.album-track-table__total\s*\{[^}]*border-left:\s*0[^}]*border-top:\s*0/s);
  assert.match(css, /linear-gradient\(to left/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
});

test('collapsing any loose-track section also collapses the aggregate length', () => {
  const css = fs.readFileSync(
    path.join(repoRoot, 'music_app', 'static', 'css', 'runtime', 'album-track-table.css'),
    'utf8',
  );
  assert.match(css, /\.album-track-table--partially-collapsed \.album-track-table__total\s*\{[^}]*display:\s*none/s);
  assert.doesNotMatch(css, /:has\(\.album-track-table__disc--collapsible:not\(\[open\]\)\)/);
});

test('the final table right outline fades into the footer without a corner glow layer', () => {
  const css = fs.readFileSync(
    path.join(repoRoot, 'music_app', 'static', 'css', 'runtime', 'album-track-table.css'),
    'utf8',
  );
  assert.match(
    css,
    /\.album-track-table--has-total \.album-track-table__disc:last-of-type \.compact-data-table\s*\{[^}]*border-bottom-right-radius:\s*0/s,
  );
  assert.match(css, /\.album-track-table__total\s*\{[^}]*margin:\s*-1px 0 0 auto/s);
  assert.match(css, /\.album-track-table__total::before\s*\{[^}]*border-right:\s*1px solid color-mix\(in srgb, var\(--album-track-accent\) 75%, transparent\)/s);
  assert.match(css, /\.album-track-table__total::before\s*\{[^}]*background:\s*linear-gradient\(to left,/s);
  assert.match(css, /\.album-track-table__total\s*\{[^}]*border-right:\s*1px solid transparent/s);
  assert.doesNotMatch(css.match(/\.album-track-table__total\s*\{[^}]*\}/s)[0], /mask-image:/);
  assert.match(
    css,
    /\.album-track-table--has-total \.album-track-table__disc:last-of-type \.compact-data-table::after\s*\{[^}]*position:\s*absolute[^}]*right:\s*-1px[^}]*bottom:\s*-1px[^}]*width:\s*1px[^}]*background:\s*linear-gradient\(to bottom,\s*transparent[\s\S]*var\(--album-track-accent\) 75%/s,
  );
  assert.doesNotMatch(css, /\.album-track-table__total::after/);
});

test('AlbumTrackTable uses theme text tokens, plain durations, and a subtly dissolved spectrum', () => {
  const css = fs.readFileSync(
    path.join(repoRoot, 'music_app', 'static', 'css', 'runtime', 'album-track-table.css'),
    'utf8',
  );
  assert.match(css, /\.album-track-table \.compact-data-table(?:,[^{]+)?\s*\{[^}]*color:\s*var\(--appearance-ink,\s*var\(--text\)\)/s);
  assert.match(css, /\.album-track-table \[role="columnheader"\][^}]*color:\s*var\(--appearance-muted,\s*var\(--muted\)\)/s);
  assert.match(css, /\.album-track-table \.track-duration\s*\{[^}]*margin-left:\s*0[^}]*color:\s*var\(--appearance-ink,\s*var\(--text\)\)/s);
  assert.match(css, /album-track-table__row--animated::after\s*\{[^}]*opacity:\s*\.84/s);
});

test('a paused current track keeps a dim, still highlight and its play button', () => {
  const css = fs.readFileSync(
    path.join(repoRoot, 'music_app', 'static', 'css', 'runtime', 'album-track-table.css'),
    'utf8',
  );
  const paused = css.match(/\.album-track-table__row--current:not\(\.album-track-table__row--playing\)\s*\{([^}]*)\}/s);
  assert.ok(paused, 'the paused current row has its own highlight');
  assert.match(paused[1], /outline:\s*1px solid color-mix\(in srgb, var\(--album-track-accent\) 50%/);
  assert.match(paused[1], /background:\s*color-mix\(in srgb, var\(--album-track-accent\) 8%/);
  assert.doesNotMatch(paused[1], /animation|box-shadow/, 'only the playing row glows and moves');
  assert.match(css, /:is\([^)]*\.album-track-table__row--current\) \.album-track-table__play \{ opacity: 1; \}/);
});

test('play activation is transient and live playback refresh can own the component state classes', () => {
  const context = loadTrackTable();
  assert.equal(typeof context.triggerAlbumTrackPlayActivation, 'function');
  const source = fs.readFileSync(
    path.join(repoRoot, 'music_app', 'static', 'js', 'runtime', 'tag-editor-and-optimistic-updates.js'),
    'utf8',
  );
  assert.match(source, /album-track-table__row--current/);
  assert.match(source, /album-track-table__row--playing/);
  assert.match(source, /album-track-table__row--animated/);
});

test('per-track Play hover uses the main player Play color without affecting disabled controls', () => {
  const css = fs.readFileSync(
    path.join(repoRoot, 'music_app', 'static', 'css', 'runtime', 'album-track-table.css'),
    'utf8',
  );

  assert.match(
    css,
    /--album-track-play-hover:\s*var\(--appearance-play,\s*var\(--appearance-player-accent,\s*var\(--album-track-accent\)\)\)/,
  );
  assert.match(
    css,
    /\.album-track-table__play:hover:not\(:disabled\)\s*\{[^}]*outline:\s*2px solid var\(--album-track-play-hover\)[^}]*outline-offset:\s*2px/s,
  );
});

test('track number shares one cell with its original animated play control', () => {
  const row = loadTrackTable().buildAlbumTrackTableRow({path:'song',trackNumber:7});
  assert.equal(row.cells.play, undefined);
  assert.match(row.cells.number.content, /album-track-table__number">7</);
  assert.match(row.cells.number.content, /play-track-button/);
});

test('row double-click clears its word highlight and starts playback without toggling playing tracks', () => {
  const context = loadTrackTable();
  let plays = 0;
  let cleared = 0;
  const textNode = {};
  const selection = {anchorNode:textNode, focusNode:textNode, removeAllRanges(){cleared++;}};
  const row = {
    dataset:{trackPlaying:''},
    ownerDocument:{getSelection:()=>selection},
    contains:node=>node===textNode,
    querySelector:()=>({click(){plays++;}}),
  };
  const event = {target:{closest:()=>null}, currentTarget:row, preventDefault(){}};
  context.handleAlbumTrackRowDoubleClick(event);
  assert.equal(plays,1);
  assert.equal(cleared,1);
  row.dataset.trackPlaying='true';
  context.handleAlbumTrackRowDoubleClick(event);
  assert.equal(plays,1);
  assert.equal(cleared,2);
  selection.anchorNode={};
  context.handleAlbumTrackRowDoubleClick(event);
  assert.equal(cleared,2);
  row.dataset.trackPlaying='';
  event.target.closest=()=>({});
  context.handleAlbumTrackRowDoubleClick(event);
  assert.equal(plays,1);
  assert.equal(cleared,2);
});

function loadTrackTableWithRating() {
  const context = loadTrackTable();
  vm.runInContext(
    fs.readFileSync(path.join(repoRoot, 'music_app', 'static', 'js', 'runtime', 'gallery-main-components.js'), 'utf8'),
    context,
  );
  return context;
}

function discHeaders(html) {
  return [...html.matchAll(/<div class="album-track-table__disc-header">([\s\S]*?)<\/div><\/div><\/div>/g)].map((match) => match[1]);
}

test('AlbumTrackTable shows a later disc rating on its heading only when both are rated and they differ', () => {
  const context = loadTrackTableWithRating();
  const track = (name) => ({ path: `C:/Music/${name}.flac`, title: name, trackNumber: 1, duration: '3:00' });
  const render = (discRating, albumRating, { firstDiscRating = null, secondLabel = 'CD 2', isBonus = false } = {}) => (
    context.buildAlbumTrackTableHtml({
      albumRating,
      groups: [
        { discNumber: 1, discLabel: 'CD 1', tracks: [track('main')], discRating: firstDiscRating },
        { discNumber: 2, discLabel: secondLabel, isBonus, tracks: [track('second')], discRating },
      ],
      multiDisc: true,
    })
  );

  // The Pineapple Thief "All the Wars": album 5, disc 2 tagged "2/2" and rated 8.
  const rated = discHeaders(render(8, 5));
  assert.equal(rated.length, 1);
  assert.match(rated[0], /^<h4 class="album-track-table__disc-heading">CD 2<\/h4><div class="rating-row/);
  assert.match(rated[0], /class="rating-row album-track-table__disc-rating" data-rating-value="8"/);
  assert.match(rated[0], /aria-label="Disc rating 8\/10"/);
  assert.equal((rated[0].match(/class="star filled"/g) || []).length, 8);
  assert.match(rated[0], /<div class="rating-text">8\/10$/);
  assert.equal(discHeaders(render(9, 5, { secondLabel: 'Bonus CD', isBonus: true })).length, 1);

  for (const [discRating, albumRating, options] of [
    [5, 5, {}],
    [null, 5, {}],
    [0, 5, {}],
    [11, 5, {}],
    [8, null, {}],
    [8, 0, {}],
    [null, 5, { firstDiscRating: 8 }],
  ]) {
    const html = render(discRating, albumRating, options);
    assert.doesNotMatch(html, /album-track-table__disc-rating/, `no disc rating for ${discRating}/${albumRating}/${JSON.stringify(options)}`);
  }
});
