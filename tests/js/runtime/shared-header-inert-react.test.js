const test = require('node:test');
const assert = require('node:assert/strict');
const {nativeEnvironment, load} = require('./album-tops-native-fixtures/actual-native-runtime.cjs');

// Actual native measurement policy over explicit DOM-platform rectangles.
// This is unit coverage of inert ownership, never browser/CSS geometry acceptance.
async function output({compact, outside, open}) {
  const {mountSharedHeader} = await load('home-friends/shared-header.mjs');
  const env = nativeEnvironment(), {document, host, runtime} = env;
  const owner = mountSharedHeader(host, runtime, {id: 'inert-boundary'});
  const children = {};
  for (const [slot, name] of [['leading', 'leading'], ['actions', 'ordinary'],
    ['outsideActions', 'outside'], ['finalAction', 'final']]) {
    const node = document.createElement('button'); node.setAttribute('data-boundary-slot', name); node.textContent = name;
    owner.slots[slot].append(node); children[name] = node;
  }
  owner.slots.identity.textContent = 'Identity';
  const box = (node, width, height = 30) => {
    env.setRect(node, {x: 10, y: 40, width, height});
    Object.assign(node, {scrollWidth: width, scrollHeight: height, offsetHeight: height, clientHeight: height});
  };
  // In addition to rects, naturalWidth reads scrollWidth on measured descendants.
  for (const node of [owner.element, ...owner.element.querySelectorAll('*')]) box(node, 0);
  box(owner.element, compact ? (outside ? 250 : 150) : 500);
  box(owner.slots.leading, 20); box(owner.slots.identity, 100); box(owner.slots.content, 0);
  box(children.ordinary, 80); box(children.final, 80); box(children.outside, 60);
  box(owner.element.querySelector('.home-header__tools'), 34);
  const flush = () => {
    const pending = [...env.frames]; env.frames.clear();
    for (const [, callback] of pending) callback();
    assert.equal(env.frames.size, 0, 'measurement settles without an unbounded frame loop');
  };
  owner.refresh(); flush();
  if (open) {env.click(owner.element.querySelector('[data-header-tools]')); flush();}
  return {...env, owner, children};
}
for (const [name, state, expected] of [
  ['desktop', {compact: false, outside: false, open: false}, {actions: false, outside: false}],
  ['compact closed', {compact: true, outside: false, open: false}, {actions: true, outside: true}],
  ['compact open', {compact: true, outside: false, open: true}, {actions: false, outside: false}],
  ['compact outside closed', {compact: true, outside: true, open: false}, {actions: true, outside: false}],
  ['compact outside open', {compact: true, outside: true, open: true}, {actions: false, outside: false}],
]) test(`real native boundary preserves SharedHeader inert ownership: ${name}`, async () => {
  const env = await output(state), {host, owner} = env;
  try {
  const header = host.querySelector('[data-shared-header="inert-boundary"]');
  assert.ok(header);
  assert.equal(header.getAttribute('data-header-compact'), String(state.compact));
  assert.equal(header.getAttribute('data-header-outside'), String(state.outside));
  for (const slot of ['actions', 'outside']) {
    const container = header.querySelector(`.home-header__${slot}`);
    assert.equal(container.hasAttribute('inert'), expected[slot], `${name}: actual native-rendered ${slot} inert attribute`);
    assert.equal(container.getAttribute('aria-hidden') === 'true', expected[slot]);
  }
  assert.equal(header.querySelector('.home-header__leading').hasAttribute('inert'), false);
  const tools = header.querySelector('[data-header-tools]'); assert.ok(tools);
  assert.equal(tools.getAttribute('aria-expanded'), String(state.open));
  assert.equal(header.querySelector('.home-header__tools').hasAttribute('hidden'), !state.compact);
  for (const slot of ['leading', 'ordinary', 'outside', 'final']) {
    assert.equal(header.querySelectorAll(`[data-boundary-slot="${slot}"]`).length, 1, `${slot} remains mounted once`);
    assert.equal(header.querySelector(`[data-boundary-slot="${slot}"]`), env.children[slot], `${slot} retains its actual node`);
  }
  const ordered = header.querySelectorAll('button');
  assert.ok(ordered.indexOf(env.children.ordinary) < ordered.indexOf(env.children.final));
  } finally {
    owner.dispose(); owner.dispose();
    assert.equal(host.querySelector('[data-shared-header]'), null);
    env.assertClean();
  }
});
