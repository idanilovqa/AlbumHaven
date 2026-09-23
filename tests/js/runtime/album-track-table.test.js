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

test('the final table right outline fades into the footer without a corner glow layer', () => {
  const css = fs.readFileSync(
    path.join(repoRoot, 'music_app', 'static', 'css', 'runtime', 'album-track-table.css'),
    'utf8',
  );
  assert.match(
    css,
    /\.album-track-table__frame:has\(\.album-track-table__total\)[^{]*\.album-track-table__disc:last-of-type \.compact-data-table\s*\{[^}]*border-bottom-right-radius:\s*0/s,
  );
  assert.match(css, /\.album-track-table__total\s*\{[^}]*margin:\s*-1px 0 0 auto/s);
  assert.match(css, /\.album-track-table__total::before\s*\{[^}]*border-right:\s*1px solid color-mix\(in srgb, var\(--album-track-accent\) 75%, transparent\)/s);
  assert.match(css, /\.album-track-table__total::before\s*\{[^}]*background:\s*linear-gradient\(to left,/s);
  assert.match(css, /\.album-track-table__total\s*\{[^}]*border-right:\s*1px solid transparent/s);
  assert.doesNotMatch(css.match(/\.album-track-table__total\s*\{[^}]*\}/s)[0], /mask-image:/);
  assert.match(
    css,
    /\.album-track-table__frame:has\(\.album-track-table__total\)[^{]*\.album-track-table__disc:last-of-type \.compact-data-table::after\s*\{[^}]*position:\s*absolute[^}]*right:\s*-1px[^}]*bottom:\s*-1px[^}]*width:\s*1px[^}]*background:\s*linear-gradient\(to bottom,\s*transparent[\s\S]*var\(--album-track-accent\) 75%/s,
  );
  assert.doesNotMatch(css, /\.album-track-table__total::after/);
});

test('AlbumTrackTable uses theme text tokens, plain durations, and a subtly dissolved spectrum', () => {
  const css = fs.readFileSync(
    path.join(repoRoot, 'music_app', 'static', 'css', 'runtime', 'album-track-table.css'),
    'utf8',
  );
  assert.match(css, /\.album-track-table \.compact-data-table\s*\{[^}]*color:\s*var\(--appearance-ink,\s*var\(--text\)\)/s);
  assert.match(css, /\.album-track-table \[role="columnheader"\][^}]*color:\s*var\(--appearance-muted,\s*var\(--muted\)\)/s);
  assert.match(css, /\.album-track-table \.track-duration\s*\{[^}]*margin-left:\s*0[^}]*color:\s*var\(--appearance-ink,\s*var\(--text\)\)/s);
  assert.match(css, /album-track-table__row--animated::after\s*\{[^}]*opacity:\s*\.84/s);
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
