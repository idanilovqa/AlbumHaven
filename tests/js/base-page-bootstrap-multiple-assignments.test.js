const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const basePageUrl = pathToFileURL(path.resolve(__dirname, '../e2e/poms/basePage.js')).href;

test('bootstrap JSON remains readable when playback permissions follow in the same script', async () => {
  const { parseProductionBootstrapPayloadScriptSources } = await import(basePageUrl);
  const expected = {
    initial_view: { selected_artist: 'Artist', artist_groups: [{ albums: [{ title: 'Album' }] }] },
    bootstrap: { source: 'server' },
  };
  const source = `window.__ALBUM_HAVEN_BOOTSTRAP_PAYLOAD__ = ${JSON.stringify(expected)};
window.__ALBUM_HAVEN_PLAYBACK_ALLOWED_ACTIONS__ = {"library.playback.play":true};`;
  assert.deepEqual(parseProductionBootstrapPayloadScriptSources([source]), expected);
});

test('bootstrap extraction preserves quoted braces and escapes without executing trailing script', async () => {
  const { parseProductionBootstrapPayloadScriptSources } = await import(basePageUrl);
  const expected = { initial_view: { query: 'A } ; "quoted" \\ value {', related_artists: ['Nested { artist }'] } };
  const source = `window.__ALBUM_HAVEN_BOOTSTRAP_PAYLOAD__ = ${JSON.stringify(expected)};
throw new Error('Script text must never execute while reading bootstrap JSON');`;
  assert.deepEqual(parseProductionBootstrapPayloadScriptSources([source]), expected);
});

test('bootstrap extraction rejects executable expressions in place of JSON', async () => {
  const { parseProductionBootstrapPayloadScriptSources } = await import(basePageUrl);
  assert.throws(() => parseProductionBootstrapPayloadScriptSources([
    'window.__ALBUM_HAVEN_BOOTSTRAP_PAYLOAD__ = (() => { throw new Error("executed"); })();',
  ]), /invalid JSON/i);
});
