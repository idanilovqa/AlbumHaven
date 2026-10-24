const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const React = require('react');
const {buildSync} = require('esbuild');
const code = buildSync({entryPoints: [path.resolve(__dirname, '../../../music_app/static/js/playlists/mutation-status.jsx')],
  bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react', '../home-friends/components.jsx']}).outputFiles[0].text;
function render(props) {
  const hooks = {...React, useState: initial => [initial, () => {}], useRef: value => ({current: value}), useEffect: effect => effect()};
  const module = {exports: {}};
  vm.runInNewContext(code, {module, exports: module.exports, require: name => name === 'react' ? hooks : {Button() {}, NativeHtml() {}}});
  return module.exports.RetryOriginalRequest(props).props.children[0];
}
test('original-request retry requires native confirmation and current source afterward', async () => {
  for (const allowed of [false, true]) {
    let retries = 0, current = true;
    const button = render({available: true, scopeKey: 'scope', runtime: {confirmRetryOriginal: async scope => {
      assert.equal(scope, 'scope'); if (allowed) current = false; return allowed;}},
      current: () => current, retry: () => {retries++;}});
    await button.props.onClick(); assert.equal(retries, 0);
  }
});
test('duplicate activation opens one confirmation and dispatches one explicit retry', async () => {
  let resolve, confirms = 0, retries = 0;
  const button = render({available: true, scopeKey: 'scope', runtime: {confirmRetryOriginal: () => {
    confirms++; return new Promise(done => {resolve = done;});}}, current: () => true,
    retry: async () => {retries++; return true;}});
  const first = button.props.onClick(), second = button.props.onClick();
  assert.equal(confirms, 1); resolve(true); await first; await second; assert.equal(retries, 1);
});
