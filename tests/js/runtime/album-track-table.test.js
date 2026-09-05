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

  assert.match(html, /--cdt-columns: 34px 36px minmax\(0, 1fr\) 20px minmax\(54px, auto\)/);
  assert.match(html, /data-cdt-column="play" aria-hidden="true"/);
  assert.match(html, /data-cdt-column="title"[^>]*>Track<\/div><div data-cdt-column="problem" data-cdt-action aria-hidden="true"><\/div><div role="columnheader" data-cdt-column="duration"/);
  assert.match(html, /data-cdt-column="title"[^>]*><span[^>]*>Problem Track<\/span><\/div><div role="cell" data-cdt-column="problem" data-cdt-action><button class="track-problem-link"/);
  assert.match(html, /data-cdt-column="problem" data-cdt-action><button[\s\S]*data-open-track-problematic="1"[\s\S]*aria-label="Open this track in Problematic Files">!<\/button><\/div><div role="cell" data-cdt-column="duration"/);
  assert.match(html, /data-cdt-row-key="clean\.flac"[\s\S]*data-cdt-column="problem" data-cdt-action><\/div><div role="cell" data-cdt-column="duration"/);
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
  assert.match(css, /\.album-track-table__total\s*\{[^}]*border-right:\s*1px solid color-mix\(in srgb, var\(--album-track-accent\) 75%, transparent\)/s);
  assert.match(css, /\.album-track-table__total\s*\{[^}]*background:\s*linear-gradient\(to left,/s);
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
