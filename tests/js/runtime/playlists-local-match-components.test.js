const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const React = require('react');
const {renderToStaticMarkup} = require('react-dom/server');
const {buildSync} = require('esbuild');
const {createNativeHomeRuntime} = require('./native-home-harness.cjs');
const built = buildSync({entryPoints: [path.resolve(__dirname, '../../../music_app/static/js/playlists/draft-local-match.jsx')],
  bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react', 'react-dom']});
const loaded = new Module(__filename + '.match', module); loaded.filename = __filename + '.match'; loaded.paths = module.paths;
loaded._compile(built.outputFiles[0].text, loaded.filename);
const {DraftLocalMatchContent} = loaded.exports;
const native = createNativeHomeRuntime();
const runtime = {buttonHtml: native.context.ButtonComponent.renderButton, alertHtml: native.context.buildOnPageAlertHtml, openChoice() {}};
const elements = node => React.isValidElement(node) ? [node, ...React.Children.toArray(node.props.children).flatMap(elements)] : [];
const button = (tree, label) => elements(tree).find(node => node.type?.name === 'Button' && node.props.children === label);
const setup = patch => {
  let state = {status: 'ready', selectedKey: '', candidates: [{key: 'safe-choice', title: 'Candidate <title>', artist: 'Candidate artist',
    album_title: 'Candidate album', duration_seconds: 42}], suggestionsComplete: false, ...patch};
  let accepted = 0, closed = 0, loaded = 0, selected = [];
  const controller = {getSnapshot: () => state, blocking: () => ['uncertain', 'accepting'].includes(state.status),
    select(key) {selected.push(key);}, async accept() {accepted++; return true;}, load() {loaded++;}};
  const props = {runtime, state, controller, row: {title: 'Original <title>', artist: 'Artist', album_title: 'Album'}, close() {closed++;}};
  return {props, tree: DraftLocalMatchContent(props), replace: () => {state = {...state};}, counts: () => ({accepted, closed, loaded, selected})};
};
test('shared choice and explicit Accept preserve original identity and truthfully label bounded suggestions', () => {
  const fixture = setup({}), tree = fixture.tree;
  assert.equal(button(tree, 'Accept match').props.disabled, true);
  const choice = elements(tree).find(node => node.type?.name === 'NativeChoice');
  assert.equal(choice.props.value, ''); assert.equal(choice.props.options[0][0], '');
  choice.props.onChange('safe-choice');
  assert.deepEqual(fixture.counts(), {accepted: 0, closed: 0, loaded: 0, selected: ['safe-choice']});
  const html = renderToStaticMarkup(React.createElement(DraftLocalMatchContent, fixture.props));
  assert.match(html, /Original &lt;title&gt;/); assert.match(html, /limited set of local tracks/); assert.match(html, /Choose local match/);
});
test('only an explicit current accept activates matching; stale controls do nothing', async () => {
  const fixture = setup({selectedKey: 'safe-choice'});
  assert.equal(button(fixture.tree, 'Accept match').props.disabled, false);
  await button(fixture.tree, 'Accept match').props.onClick();
  assert.equal(fixture.counts().accepted, 1); assert.equal(fixture.counts().closed, 1);
  fixture.replace(); await button(fixture.tree, 'Accept match').props.onClick();
  assert.equal(fixture.counts().accepted, 1);
});
test('uncertain acceptance exposes exact retry and blocks cancellation or replacement choice', async () => {
  const fixture = setup({status: 'uncertain', selectedKey: 'safe-choice'});
  assert.equal(button(fixture.tree, 'Cancel').props.disabled, true);
  assert.equal(elements(fixture.tree).find(node => node.type?.name === 'NativeChoice').props.disabled, true);
  assert.equal(button(fixture.tree, 'Check match result').props.disabled, false);
  await button(fixture.tree, 'Check match result').props.onClick(); assert.equal(fixture.counts().accepted, 1);
});
test('empty candidates do not assert a confirmed absence or enable acceptance', () => {
  const fixture = setup({candidates: [], suggestionsComplete: true});
  const html = renderToStaticMarkup(React.createElement(DraftLocalMatchContent, fixture.props));
  assert.match(html, /No suggested local match was found in the checked tracks/);
  assert.equal(button(fixture.tree, 'Accept match').props.disabled, true);
  assert.equal(elements(fixture.tree).some(node => node.type?.name === 'NativeChoice'), false);
});
