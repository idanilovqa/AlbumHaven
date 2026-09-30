const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const load = () => import(pathToFileURL(path.resolve(__dirname, '../e2e/actions/coverLookupActions.js')).href);

async function attempt(options = {}) {
  const { origin = 'http://127.0.0.1:4175', grantError } = options;
  const headless = Object.hasOwn(options, 'headless') ? options.headless : true;
  const events = [];
  const context = {
    async grantPermissions(permissions, options) {
      events.push({ permissions, ...options });
      if (grantError) throw grantError;
    },
    async newPage() { events.push('newPage'); throw new Error('page boundary'); },
  };
  const { CoverLookupActions } = await load();
  const actions = new CoverLookupActions({
    page: { context: () => context, on() {} },
    testInfo: { project: { use: { headless } }, config: { metadata: { providerBaseURL: origin } } },
  });
  let error;
  try { await actions.pasteComposerImageFromProvider('fixture-image'); } catch (caught) { error = caught; }
  return { events, error };
}

for (const origin of ['http://127.0.0.1:4175', 'http://localhost:5123/fixture']) {
  test(`native image copy scopes only write permission to ${origin}`, async () => {
    const result = await attempt({ origin });
    assert.deepEqual(result.events, [{ permissions: ['clipboard-write'], origin: new URL(origin).origin }, 'newPage']);
    assert.match(result.error.message, /page boundary/);
  });
}
for (const headless of [false, undefined, null]) {
  test(`native clipboard rejects non-headless value ${headless} before permissions`, async () => {
    const result = await attempt({ headless });
    assert.deepEqual(result.events, []);
    assert.match(result.error.message, /headless Chrome/);
  });
}
test('native clipboard rejects a non-loopback provider before permission or page creation', async () => {
  const result = await attempt({ origin: 'https://example.com' });
  assert.deepEqual(result.events, []);
  assert.ok(result.error);
});
test('native clipboard permission errors stop before external page or paste', async () => {
  const denied = new Error('clipboard permission denied');
  const result = await attempt({ grantError: denied });
  assert.deepEqual(result.events, [{ permissions: ['clipboard-write'], origin: 'http://127.0.0.1:4175' }]);
  assert.equal(result.error, denied);
});
