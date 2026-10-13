const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const root = path.resolve(process.env.ALBUMHAVEN_FRONTEND_ROOT || path.join(__dirname, '../../..'));
const local = createRequire(path.join(root, 'package.json'));
const React = local('react');
const {renderToStaticMarkup} = local('react-dom/server');
const {buildSync} = local('esbuild');
const {createNativeHomeRuntime} = local('./tests/js/runtime/native-home-harness.cjs');
const code = buildSync({entryPoints: [path.join(root, 'music_app/static/js/home-friends/shared-header.jsx')],
  bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react', 'react-dom']}).outputFiles[0].text;

// Supply existing SharedHeader hook state, then serialize its unmodified output
// through the actual installed React DOM server renderer. This isolates boolean
// attribute semantics; it does not claim measured geometry or browser behavior.
function output({compact, outside, open}) {
  let stateIndex = 0;
  const values = [{compact, outside}, open, {}];
  const hooks = {...React, useRef: value => ({current: value}),
    useState: () => [values[stateIndex++], () => {}], useCallback: callback => callback,
    useLayoutEffect() {}, useEffect() {}};
  const loaded = {exports: {}};
  vm.runInNewContext(code, {module: loaded, exports: loaded.exports, require: name => name === 'react' ? hooks : local(name)});
  const native = createNativeHomeRuntime();
  const runtime = {buttonHtml: value => native.context.ButtonComponent.renderButton(value),
    actionHtml: value => native.context.ButtonComponent.renderActionButton(value)};
  const mark = name => React.createElement('button', {'data-boundary-slot': name}, name);
  const tree = loaded.exports.SharedHeader({runtime, id: 'inert-boundary', identity: 'Identity',
    leading: mark('leading'), actions: mark('ordinary'), outsideActions: mark('outside'), finalAction: mark('final')});
  const host = native.document.createElement('div'); host.innerHTML = renderToStaticMarkup(tree);
  return host;
}
for (const [name, state, expected] of [
  ['desktop', {compact: false, outside: false, open: false}, {actions: false, outside: false}],
  ['compact closed', {compact: true, outside: false, open: false}, {actions: true, outside: true}],
  ['compact open', {compact: true, outside: false, open: true}, {actions: false, outside: false}],
  ['compact outside closed', {compact: true, outside: true, open: false}, {actions: true, outside: false}],
  ['compact outside open', {compact: true, outside: true, open: true}, {actions: false, outside: false}],
]) test(`real React boundary preserves SharedHeader inert ownership: ${name}`, () => {
  const host = output(state), header = host.querySelector('[data-shared-header="inert-boundary"]');
  assert.ok(header);
  for (const slot of ['actions', 'outside']) {
    const container = header.querySelector(`.home-header__${slot}`);
    assert.equal(container.hasAttribute('inert'), expected[slot], `${name}: actual React-rendered ${slot} inert attribute`);
    assert.equal(container.getAttribute('aria-hidden') === 'true', expected[slot]);
  }
  assert.equal(header.querySelector('.home-header__leading').hasAttribute('inert'), false);
  const tools = header.querySelector('[data-header-tools]'); assert.ok(tools);
  assert.equal(tools.getAttribute('aria-expanded'), String(state.open));
  assert.equal(header.querySelector('.home-header__tools').hasAttribute('hidden'), !state.compact);
  for (const slot of ['leading', 'ordinary', 'outside', 'final']) {
    assert.equal(header.querySelectorAll(`[data-boundary-slot="${slot}"]`).length, 1, `${slot} remains mounted once`);
  }
});
