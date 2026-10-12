const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const React = require('react');
const {buildSync} = require('esbuild');
const bundle = buildSync({entryPoints: [path.resolve(__dirname, '../../../music_app/static/js/home-friends/queue.jsx')],
  bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react', 'react-dom']}).outputFiles[0].text;
const elements = node => React.isValidElement(node) ? [node, ...React.Children.toArray(node.props.children).flatMap(elements)] : [];
function fixture() {
  const cleanups = [], calls = [], confirms = []; let resolve, scope = 'scope:one';
  const hooks = {...React, useRef: value => ({current: value}), useState: value => [value, () => {}],
    useEffect: callback => {const clean = callback(); if (clean) cleanups.push(clean);},
    useLayoutEffect: callback => {const clean = callback(); if (clean) cleanups.push(clean);}};
  const module = {exports: {}};
  vm.runInNewContext(bundle, {module, exports: module.exports, require: name => name === 'react' ? hooks : require(name)});
  const api = {clear: ids => calls.push(ids)}, value = {enabled: true, entries: [{id: 'queued:one'}], revision: 1};
  const runtime = {snapshot: () => ({scopeKey: scope}), confirm: (...args) => {confirms.push(args); return new Promise(done => {resolve = done;});}};
  const tree = module.exports.QueueHeader({runtime, api, value});
  return {calls, confirms, clear: () => elements(tree).find(node => node.props.children === 'Clear queue').props.onClick(),
    accept: answer => resolve(answer), changeScope: () => {scope = 'scope:two';}, dispose: () => cleanups.forEach(fn => fn())};
}
const settle = () => new Promise(resolve => setImmediate(resolve));
test('review v2: Queue Clear uses the native string confirmation contract', async () => {
  const f = fixture(); f.clear(); assert.equal(typeof f.confirms[0][0], 'string');
  f.accept(false); await settle(); assert.equal(f.calls.length, 0); f.dispose();
});
test('review v2: Queue Clear confirmation cannot act after header unmount or scope change', async () => {
  for (const retire of [f => f.dispose(), f => f.changeScope()]) {
    const f = fixture(); f.clear(); retire(f); f.accept(true); await settle();
    assert.equal(f.calls.length, 0); f.dispose();
  }
});
test('review v2: declined Queue Clear leaves the queued tracks intact', async () => {
  const f = fixture(); f.clear(); f.accept(false); await settle(); assert.equal(f.calls.length, 0); f.dispose();
});

function panelFixture({currentMiddle = false} = {}) {
  const cleanups = [], calls = {reorder: [], play: [], refresh: []};
  const hooks = {...React, useRef: value => ({current: value}), useState: value => [typeof value === 'function' ? value() : value, () => {}], useMemo: callback => callback(),
    useEffect: callback => {const clean = callback(); if (clean) cleanups.push(clean);}, useLayoutEffect: callback => {const clean = callback(); if (clean) cleanups.push(clean);}};
  const module = {exports: {}};
  vm.runInNewContext(bundle, {module, exports: module.exports, AbortController, require: name => name === 'react' ? hooks : require(name)});
  const value = {enabled: true, revision: 4, entries: [
    {id: 'current', current: true, sourceReadable: true, title: 'Current'},
    {id: 'a', sourceReadable: true, title: 'A', canPlay: true}, {id: 'b', sourceReadable: true, title: 'B', canPlay: true}]};
  if (currentMiddle) value.entries.splice(1, 0, value.entries.shift());
  const api = {getSnapshot: () => value, subscribe: () => () => {}, timingOptions: () => [],
    refresh: options => {calls.refresh.push(options);}, reorder: ids => calls.reorder.push(ids), play: (id, options) => calls.play.push({id, options})};
  const runtime = {escapeHtml: String, tableHtml: () => '', buttonHtml: () => '', actionHtml: () => ''};
  const tree = module.exports.QueuePanel({runtime, api, value, scopeKey: 'scope:one'});
  const click = dataset => elements(tree).find(node => node.type?.name === 'NativeHtml').props.onClick({target: {closest: () => ({dataset})}});
  return {calls, click, dispose: () => cleanups.forEach(fn => fn())};
}
test('Queue reordering excludes the current occurrence and play retires on panel unmount', () => {
  const f = panelFixture();
  f.click({queueUp: 'b'}); assert.deepEqual(Array.from(f.calls.reorder[0]), ['b', 'a']);
  f.click({queueUp: 'a'}); assert.equal(f.calls.reorder.length, 1, 'current row is not a reorder target');
  f.click({queuePlay: 'b'}); assert.equal(f.calls.play[0].options.isCurrent(), true);
  assert.equal(f.calls.refresh.length, 1); f.dispose();
  assert.equal(f.calls.play[0].options.signal.aborted, true); assert.equal(f.calls.play[0].options.isCurrent(), false);
  assert.equal(f.calls.refresh[0].signal.aborted, true);
});

test('Queue keyboard reorder crosses the current display row using pending neighbors only', () => {
  const f = panelFixture({currentMiddle:true}); f.click({queueUp:'b'});
  assert.deepEqual(Array.from(f.calls.reorder[0]), ['b','a']); f.dispose();
});
