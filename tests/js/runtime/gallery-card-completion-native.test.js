const test = require('node:test');
const assert = require('node:assert/strict');
const {createNativeHomeRuntime} = require('./native-home-harness.cjs');
function fixture() {
  const env = createNativeHomeRuntime();
  const host = env.document.createElement('div'); env.document.body.append(host);
  const render = env.owner('buildGalleryCardHtml');
  const base = {identity: 'item:1', actionRef: 'album:1', interaction: 'controlled', title: 'Album', actions: {complete: true}};
  return {env, host, base, render(options) {host.innerHTML = render({...base, ...options}); return host.querySelector('[data-gallery-card-intent="complete"]');}, html: render};
}
for (const completed of [false, true]) test(`controlled gallery completion exposes ${completed ? 'completed' : 'incomplete'} state`, () => {
  const {render} = fixture(), button = render({completion: {completed}});
  assert.ok(button); assert.equal(button.tagName, 'BUTTON'); assert.equal(button.disabled, false);
  assert.equal(button.getAttribute('data-gallery-card-ref'), 'album:1');
  assert.equal(button.getAttribute('aria-pressed'), String(completed));
  assert.equal(button.getAttribute('aria-label'), `${completed ? 'Clear completion' : 'Mark completed'}: Album`);
  assert.equal(button.getAttribute('type'), 'button');
});
test('completion requires explicit controlled authority, target and known boolean state', () => {
  const {render} = fixture();
  for (const options of [
    {interaction: 'none', completion: {completed: false}},
    {actions: {}, completion: {completed: false}},
    {actionRef: '', completion: {completed: false}},
    {completion: {}}, {completion: {completed: 'false'}}, {completion: null},
  ]) assert.equal(render(options), null);
});
test('busy completion uses canonical disabled semantics and rejects native activation', () => {
  const {render, env, host} = fixture(), button = render({completion: {completed: true, disabled: true}});
  let activated = 0; host.addEventListener('click', () => activated++);
  assert.equal(button.disabled, true); assert.equal(button.getAttribute('aria-disabled'), 'true');
  env.click(button); assert.equal(activated, 0);
  assert.equal(button.getAttribute('aria-pressed'), 'true');
});
test('completion labels and references remain escaped display data', () => {
  const {render, host} = fixture(), label = 'Complete <script>alert(1)</script> "album"', ref = 'album:"<img>';
  const button = render({actionRef: ref, completion: {completed: false, label}});
  assert.equal(button.getAttribute('aria-label'), label); assert.equal(button.getAttribute('data-gallery-card-ref'), ref);
  assert.equal(host.querySelector('script'), null); assert.equal(host.querySelector('img'), null);
});
test('completion is additive and does not change native album or selection-only markup', () => {
  const {html, base, render, host} = fixture();
  const native = {...base, interaction: 'native', albumKey: 'local:1'};
  assert.equal(html(native), html({...native, completion: {completed: true}}));
  assert.equal(render({actions: {select: true}, completion: {completed: false}}), null);
  assert.ok(host.querySelector('[data-gallery-card-intent="select"]'));
  assert.equal(host.querySelectorAll('[data-gallery-card-intent]').length, 1);
});
