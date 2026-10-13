// Component-only: real MountedSelection / MountedPreferences and shared Love
// controller, with a controlled async write boundary. No native authority, app
// boot, network, server, persistence or production E2E claim.
const fs = require('node:fs');
const path = require('node:path');
const {createRequire} = require('node:module');
const root = process.env.ALBUM_RESPONSIVE_REPOSITORY_ROOT || path.resolve(__dirname, '../..');
const fromRoot = createRequire(path.join(root, 'package.json'));
const {test, expect} = fromRoot('@playwright/test');
const bundle = fromRoot('esbuild').buildSync({stdin: {contents: `
  import {mountPlaytableSelection} from './music_app/static/js/playtables/selection.jsx';
  window.mountPreferenceFixture = mountPlaytableSelection;
`, resolveDir: root, loader: 'jsx'}, bundle: true, write: false, platform: 'browser', format: 'iife'}).outputFiles[0].text;
const errors = new WeakMap();
test.afterEach(async ({page}) => expect(errors.get(page) || []).toEqual([]));
async function mount(page) {
  const seen = []; errors.set(page, seen); page.on('pageerror', error => seen.push(String(error)));
  await page.setContent('<!doctype html><html><body><main id="tracks"></main></body></html>');
  for (const file of ['button-component.js', 'runtime/markup-format-helpers.js', 'runtime/compact-data-table.js', 'runtime/album-track-table.js']) {
    await page.addScriptTag({content: fs.readFileSync(path.join(root, 'music_app/static/js', file), 'utf8')});
  }
  await page.addScriptTag({content: bundle});
  await page.evaluate(() => {
    window.fixtureCalls = {writes: [], plays: 0, errors: []};
    window.fixtureHost = document.querySelector('#tracks');
    window.preferenceListeners = new Set();
    window.fixtureRows = [{rowKey: 'one', readable: true, selectable: true, title: 'Synthetic track'}];
    window.fixtureValue = {identity: 'opaque-fixture:one', love_tier: 'off', rating: null,
      allowed_actions: {can_set_love_tier: true}};
    window.fixtureSourceCurrent = true;
    window.fixtureSource = {snapshot: () => fixtureSourceCurrent ? {scopeKey: 'fixture', instance: 'A', revision: 1, rows: fixtureRows} : null,
      subscribe: () => () => {}};
    window.fixtureRuntime = {
      buttonHtml: config => ButtonComponent.renderButton(config),
      actionHtml: config => ButtonComponent.renderActionButton(config),
      iconHtml: (name, options) => ButtonComponent.renderIconSvg(name, options), escapeHtml,
    };
    window.fixturePreferenceRuntime = {
      trackPreference: row => fixtureRows.includes(row) ? fixtureValue : null,
      setTrackLove(operation) {
        fixtureCalls.writes.push(operation);
        return new Promise((resolve, reject) => {window.resolveFixtureWrite = resolve; window.rejectFixtureWrite = reject;});
      },
      subscribeTrackPreferences(listener) {preferenceListeners.add(listener); return () => preferenceListeners.delete(listener);},
    };
    fixtureHost.innerHTML = buildAlbumTrackTableHtml({selection: 'multiple', groups: [{tracks: [{
      ...fixtureRows[0], path: 'synthetic-fixture', duration: '3:00',
    }]}]});
    window.fixtureMount = mountPreferenceFixture(fixtureHost, {runtime: fixtureRuntime,
      sourceAdapter: fixtureSource, tableKey: 'album-tracks',
      trackPreferences: {rows: fixtureRows, context: {scopeKey: 'fixture'}, runtime: fixturePreferenceRuntime},
      onPlay: () => fixtureCalls.plays++, onError: message => fixtureCalls.errors.push(message),
    });
  });
  await expect(page.getByRole('button', {name: 'Love: Synthetic track', exact: true})).toBeVisible();
}
async function expectNoRowAction(page) {
  expect(await page.evaluate(() => fixtureCalls.plays)).toBe(0);
  expect(await page.evaluate(() => fixtureMount.getSnapshot().selectedCount)).toBe(0);
}

function waitForLoveWrite(page) {
  return expect.poll(() => page.evaluate(() => fixtureCalls.writes.length)).toBe(1);
}

function waitForLoveAbort(page) {
  return expect.poll(() => page.evaluate(() => fixtureCalls.writes[0].signal.aborted)).toBe(true);
}

function settlePreferenceFrames(page) {
  return page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function replacePreferenceSource(page) {
  await page.evaluate(() => {
    fixtureSourceCurrent = false;
    fixtureRows = [{rowKey: 'replacement', readable: true, selectable: true, title: 'Replacement track'}];
    fixtureValue = null;
    fixtureHost.innerHTML = buildAlbumTrackTableHtml({selection: 'multiple', groups: [{tracks: [fixtureRows[0]]}]});
    fixtureMount.update({sourceAdapter: {snapshot: () => ({scopeKey: 'fixture', instance: 'B', revision: 1, rows: fixtureRows}), subscribe: () => () => {}},
      trackPreferences: {rows: fixtureRows, context: {scopeKey: 'fixture'}, runtime: fixturePreferenceRuntime}});
  });
}

module.exports = {test, expect, mount, expectNoRowAction, waitForLoveWrite, waitForLoveAbort, settlePreferenceFrames, replacePreferenceSource};
