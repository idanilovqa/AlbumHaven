const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.resolve(__dirname, '../../../music_app/static/js/runtime/private-ui-transport.js'), 'utf8');
function setup() {
  const shell = {dataset: {privateUiContext: 'a'.repeat(64)}}, calls = [];
  let respond = async () => ({ok: true, json: async () => ({context_ref: shell.dataset.privateUiContext, value: 1})});
  const window = {};
  vm.runInNewContext(source, {window, document: {getElementById: () => shell}, URLSearchParams,
    fetch: async (...args) => {calls.push(args); return respond(...args);}});
  return {api: window.AlbumHavenPrivateUITransport, shell, calls, setResponse: fn => {respond = fn;}};
}
test('private read sends same-origin no-store context and admits exact stamp', async () => {
  const {api, calls} = setup(); assert.equal((await api.request('/home/activity')).value, 1);
  assert.equal(calls[0][1].credentials, 'same-origin'); assert.equal(calls[0][1].cache, 'no-store');
  assert.equal(calls[0][1].headers['X-AlbumHaven-Context'], 'a'.repeat(64));
});
test('missing and foreign response stamps never admit private data', async () => {
  for (const context_ref of [undefined, 'b'.repeat(64)]) {
    const env = setup(); env.setResponse(async () => ({ok: true, json: async () => ({context_ref})}));
    await assert.rejects(env.api.request('/friends'), error => error.code === 'stale_context');
  }
});
test('actor switch during JSON decoding rejects result even with original stamp', async () => {
  const env = setup(); env.setResponse(async () => ({ok: true, json: async () => {
    env.shell.dataset.privateUiContext = 'b'.repeat(64); return {context_ref: 'a'.repeat(64)};
  }}));
  await assert.rejects(env.api.request('/friends'), error => error.name === 'AbortError');
});
test('missing shell context blocks dispatch and writes never retry', async () => {
  const env = setup(); env.shell.dataset.privateUiContext = '';
  await assert.rejects(env.api.request('/playlists', {method: 'POST', body: {}})); assert.equal(env.calls.length, 0);
  env.shell.dataset.privateUiContext = 'a'.repeat(64); env.setResponse(async () => {throw new TypeError('Disconnected');});
  await assert.rejects(env.api.request('/playlists', {method: 'POST', body: {}})); assert.equal(env.calls.length, 1);
});
test('context retirement notifies private map owners', () => {
  const env = setup(); let retired = 0; env.api.subscribe(() => retired++);
  env.shell.dataset.privateUiContext = 'b'.repeat(64); env.api.context(); assert.equal(retired, 1);
});
