const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const repoRoot = path.resolve(__dirname, '..', '..');
const basePageUrl = pathToFileURL(
  path.join(repoRoot, 'tests', 'e2e', 'poms', 'basePage.js'),
).href;

test('bootstrap parser selects the literal assignment from multiple raw script sources', async () => {
  const { parseProductionBootstrapPayloadScriptSources } = await import(basePageUrl);

  const payload = parseProductionBootstrapPayloadScriptSources([
    'window.unrelated = {"initial_view":"wrong"};',
    'window.__ALBUM_HAVEN_BOOTSTRAP_PAYLOAD__ = {"initial_view":{"selected_artist":"Devin Townsend"},"bootstrap":{"source":"server"}};',
    'window.afterBootstrap = true;',
  ]);

  assert.equal(payload.initial_view.selected_artist, 'Devin Townsend');
  assert.equal(payload.bootstrap.source, 'server');
});

test('BasePage reads raw script text without visible-text or hasText filtering', async () => {
  const { BasePage } = await import(basePageUrl);
  const locatorCalls = [];
  const page = {
    locator(selector) {
      locatorCalls.push(selector);
      return {
        async allTextContents() {
          return [
            'window.styleLikeText = "not visible";',
            'window.__ALBUM_HAVEN_BOOTSTRAP_PAYLOAD__ = {"initial_view":{"query":"morse"}};',
          ];
        },
      };
    },
  };

  const payload = await new BasePage(page).readProductionBootstrapPayload();

  assert.deepEqual(locatorCalls, ['script']);
  assert.equal(payload.initial_view.query, 'morse');
});

test('bootstrap parser rejects a malformed literal assignment loudly', async () => {
  const { parseProductionBootstrapPayloadScriptSources } = await import(basePageUrl);

  assert.throws(
    () => parseProductionBootstrapPayloadScriptSources([
      'window.__ALBUM_HAVEN_BOOTSTRAP_PAYLOAD__ = {"initial_view":};',
    ]),
    /invalid JSON/i,
  );
});

test('bootstrap parser rejects a document without the literal assignment loudly', async () => {
  const { parseProductionBootstrapPayloadScriptSources } = await import(basePageUrl);

  assert.throws(
    () => parseProductionBootstrapPayloadScriptSources([
      'window.__ALBUM_HAVEN_BOOTSTRAP_PAYLOAD_BACKUP__ = {};',
      'window.unrelated = true;',
    ]),
    /Expected the production bootstrap payload script/i,
  );
});
