// Isolated component inputs, actual Loose consumer/NativePlaytables/native owner.
// These fixtures do not claim production navigation or Postgres authority.
const fs = require('node:fs');
const path = require('node:path');
const {createRequire} = require('node:module');
const root = process.env.ALBUM_RESPONSIVE_REPOSITORY_ROOT || path.resolve(__dirname, '../..');
const fromRoot = createRequire(path.join(root, 'package.json'));
const {test: base, expect} = fromRoot('@playwright/test');
const {nativeDelivery}=require('./albumPlaytableNativeDelivery.cjs');

const test = base.extend({
  loose: async ({page}, use) => {
    const errors = []; page.on('pageerror', error => errors.push(String(error)));
    try {await use({
      async mount(width = 390, {choiceAvailable = true, canonicalShell = false, livePlayback = false} = {}) {
        await page.setViewportSize({width, height: 844});
        // A supplied static shell state tests CSS containment only. It neither
        // drives nor establishes mobile navigation/history lifecycle coverage.
        const modal = '<div class="non-album-modal is-mobile-page" id="non-album-modal"><div class="non-album-modal-dialog"><div class="non-album-modal-table-wrap"><div class="non-album-modal-table" id="table-host"></div></div></div></div>';
        const body = canonicalShell
          ? `<div class="shell-layout" id="app-shell"><main class="shell-main-surface has-mobile-page"><div class="mobile-page-outlet">${modal}</div></main></div>`
          : '<main id="non-album-modal"><div id="table-host"></div></main>';
        await page.route('https://albumhaven.test/**',nativeDelivery(root,`<!doctype html><html><head></head><body>${body}</body></html>`,['albumPlaytableNativeEntry.mjs']));
        await page.goto('https://albumhaven.test/');
        await page.evaluate(({available, livePlayback}) => {
          window.fixtureScope = 'scope-A';
          window.fixtureCalls = {choices: [], closed: 0, played: 0, queueReads: 0, preferenceCalls: 0};
          const forbidden = () => {fixtureCalls.preferenceCalls++; throw new Error('Layout has no preference authority');};
          window.TrackActionsRuntime = {scope: () => ({token: fixtureScope}),
            readBatch: forbidden, preference: forbidden, setLove: forbidden, subscribePreferences: forbidden};
          window.retainTrackModalPreferenceRows = forbidden;
          window.getTrackModalPreferenceSource = forbidden;
          window.AlbumHavenPlaylistRuntime = {snapshot: () => ({scopeKey: 'component'})};
          window.state = {view: {}, player: {current: {path: 'fixture-rarity.flac'}}};
          window.fixturePlayback = {currentTime: 0, duration: 180, paused: false, ended: false};
          window.formatTrackDuration = livePlayback
            ? seconds => `${Math.floor(Number(seconds) / 60)}:${String(Math.floor(Number(seconds) % 60)).padStart(2, '0')}`
            : seconds => seconds === 6023 ? '100:23 / 100:23' : `${seconds / 60}:00`;
          window.formatAlbumDuration = livePlayback ? seconds => `${seconds}s` : () => '107m 23s';
          window.getPlayerPlaybackSnapshot = () => fixturePlayback;
          window.getProblematicAlbumForTrackPath = value => value === 'fixture-interview.flac' ? {} : null;
          window.activateSharedTrackButton = () => fixtureCalls.played++;
          window.captureNativeLooseQueueSources = () => {fixtureCalls.queueReads++; return [];};
          window.showToast = message => {throw new Error(message);};
          if (available) window.openUtilityChoiceDropdown = (anchor, config) => {
            fixtureCalls.choices.push({anchor, config});
            return {close() {fixtureCalls.closed++;}};
          };
          window.fixtureItems = [
            {path: 'fixture-rarity.flac', title: 'A very long Loose title that keeps its secondary artist readable '.repeat(3),
              artist: 'Rarity artist', duration_seconds: 240, exception_type: 'Non-album rarity',
              display_path: 'fixture/rarity.flac', album_rating: 5, love_tier: 'off', playback_state: {can_start_here: true}},
            {path: 'fixture-interview.flac', title: 'Interview title', artist: 'Interview artist', duration_seconds: 6023,
              exception_type: 'Interview', display_path: 'fixture/interview.flac', playback_state: {can_start_here: true}},
            {path: 'fixture-other.flac', title: 'Missing other title', artist: 'Other artist', duration_seconds: 180,
              exception_type: '', display_path: 'fixture/other.flac', availability: 'missing'},
          ];
          if (livePlayback) fixtureItems = fixtureItems.map(item => ({...item, duration_seconds: 180}));
          state.view.non_album_tracks = fixtureItems;
        }, {available: choiceAvailable, livePlayback});
        for (const file of ['button-component.js', 'runtime/markup-format-helpers.js', 'runtime/compact-data-table.js',
          'runtime/album-track-table.js', 'runtime/playtable-source.js', 'runtime/modal-and-overlay-helpers.js']) {
          await page.addScriptTag({content: fs.readFileSync(path.join(root, 'music_app/static/js', file), 'utf8')});
        }
        if (livePlayback) await page.addScriptTag({content: fs.readFileSync(path.join(root,
          'music_app/static/js/runtime/tag-editor-and-optimistic-updates.js'), 'utf8')});
        const template = fs.readFileSync(path.join(root, 'music_app/templates/index.html'), 'utf8');
        const styles = new Set(['button-component.css', ...[...template.matchAll(/css\/([a-zA-Z0-9_\/-]+\.css)/g)].map(match => match[1])]);
        for (const file of styles) await page.addStyleTag({content: fs.readFileSync(path.join(root, 'music_app/static/css', file), 'utf8')});
        await page.addStyleTag({content: 'body{margin:0;height:auto;overflow:auto}main{width:100%;min-width:0}'});
        await page.evaluate(()=>import('/__album_playtable_fixture__/albumPlaytableNativeEntry.mjs').then(()=>undefined));
        await page.evaluate(() => {
          window.fixtureHost = document.querySelector('#table-host');
          window.renderLooseFixture = () => {
            fixtureHost.innerHTML = buildNonAlbumTrackSectionsMarkup(fixtureItems);
            if (!NativePlaytables.mount('loose-tracks', fixtureHost)) throw new Error('Native Loose mount failed');
          };
          renderLooseFixture();
        });
        await expect(page.locator('[data-track-table-columns]')).toHaveCount(1);
        await expect(page.locator('.compact-data-table[data-cdt-responsive]')).toHaveCount(3);
      },
      async choose(key) {
        await page.locator('[data-track-table-columns]').click();
        await page.evaluate(value => {
          const menu = fixtureCalls.choices.at(-1).config;
          if (!menu.formats.some(item => item.value === value)) throw new Error(`Missing column ${value}`);
          menu.onSelect(value);
        }, key);
      },
      async rememberMenu() {
        await page.locator('[data-track-table-columns]').click();
        await page.evaluate(() => {window.oldLooseMenu = fixtureCalls.choices.at(-1).config;});
      },
      async change(kind) {
        await page.evaluate(value => {
          if (value === 'scope') fixtureScope = 'scope-B';
          if (value === 'source') state.view = {...state.view};
          if (value === 'close') NativePlaytables.retire('loose-tracks');
          if (value === 'refresh') fixtureItems = fixtureItems.map(item => ({...item, title: item.title + ' refreshed'}));
          renderLooseFixture();
        }, kind);
        await expect(page.locator('.compact-data-table[data-cdt-responsive]')).toHaveCount(3);
      },
      async dimensions() {
        return page.evaluate(() => ({pageWidth: document.documentElement.scrollWidth, viewport: innerWidth,
          hostWidth: fixtureHost.clientWidth,
          wrappers: [...document.querySelectorAll('.mobile-page-outlet,.non-album-modal-table-wrap')].map(node => ({client: node.clientWidth, scroll: node.scrollWidth})),
          tables: [...document.querySelectorAll('.compact-data-table')].map(table => ({client: table.clientWidth, scroll: table.scrollWidth,
            left: table.getBoundingClientRect().left, right: table.getBoundingClientRect().right,
            rows: [...table.querySelectorAll('.compact-data-table-header,.compact-data-table-row')].map(row => ({
              grid: getComputedStyle(row).gridTemplateColumns,
              cells: [...row.querySelectorAll(':scope > [data-cdt-column]')].filter(cell => getComputedStyle(cell).display !== 'none').map(cell => {
                const rect = cell.getBoundingClientRect(), range = document.createRange();
                range.selectNodeContents(cell);
                return {key: cell.dataset.cdtColumn, left: rect.left, right: rect.right, width: rect.width, textWidth: range.getBoundingClientRect().width};
              }),
            })),
          })),
        }));
      },
      async playback(currentTime, duration) {
        await page.evaluate(value => {
          fixturePlayback.currentTime = value.currentTime; fixturePlayback.duration = value.duration;
          refreshNonAlbumModalPlaybackState();
        }, {currentTime, duration});
      },
      async startPress() {
        await page.locator('.compact-data-table-header').dispatchEvent('pointerdown', {
          bubbles: true, pointerType: 'touch', pointerId: 1, isPrimary: true, button: 0, clientX: 40, clientY: 20});
      },
      async waitForPress() {await page.waitForTimeout(650);},
    });} finally {
      try {if (!page.isClosed()) await page.evaluate(() => {if (typeof NativePlaytables !== 'undefined') NativePlaytables.retire('loose-tracks');});}
      finally {expect(errors).toEqual([]);}
    }
  },
});

function expectAligned(result) {
  expect(result.pageWidth).toBeLessThanOrEqual(result.viewport);
  const header = result.tables[0].rows[0];
  expect(header.cells.map(cell => cell.key)).toEqual(expect.arrayContaining(['number', 'title', 'love', 'duration']));
  expect(header.cells.find(cell => cell.key === 'title').width).toBeGreaterThanOrEqual(100);
  for (const table of result.tables) {
    expect(table.client).toBe(result.tables[0].client);
    for (const row of table.rows) {
      expect(row.grid).toBe(header.grid);
      expect(row.cells.map(cell => cell.key)).toEqual(header.cells.map(cell => cell.key));
      row.cells.forEach((cell, index) => {
        const heading = header.cells[index];
        if (['duration', 'problem'].includes(cell.key)) expect(Math.abs(cell.right - heading.right)).toBeLessThanOrEqual(1);
        else {
          expect(Math.abs(cell.left - heading.left)).toBeLessThanOrEqual(1);
          if (cell.key !== 'number') expect(Math.abs(cell.right - heading.right)).toBeLessThanOrEqual(1);
        }
      });
    }
  }
}

function expectDurationGrowth(loose, originalWidth) {
  return expect.poll(async () => parseFloat((await loose.dimensions()).tables[0].rows[0].grid.split(/\s+/).at(-1)))
    .toBeGreaterThan(originalWidth);
}

module.exports = {test, expect, expectAligned, expectDurationGrowth};
