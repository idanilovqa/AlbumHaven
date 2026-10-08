const test = require('node:test');
const assert = require('node:assert/strict');
const {createNativeHomeRuntime} = require('./native-home-harness.cjs');
const {installNativeSearch} = require('./native-search-harness.cjs');
function fixture() {const env = createNativeHomeRuntime(); return {...env, ...installNativeSearch(env)};}
test('client Search renders the canonical macro without copying live global state', () => {
  const env = fixture(), template = env.template.innerHTML;
  const live = env.document.createElement('input'); live.id = 'search-input'; live.setAttribute('value', 'private global query'); env.document.body.appendChild(live);
  const host = env.document.createElement('div'); host.innerHTML = env.render({id: 'creation-search', value: '<track & artist>', label: 'Search "tracks"', placeholder: 'Find albums'});
  const input = host.querySelector('input');
  assert.equal(input.id, 'creation-search'); assert.equal(input.getAttribute('value'), '<track & artist>');
  assert.equal(input.getAttribute('aria-label'), 'Search "tracks"'); assert.equal(input.getAttribute('name'), null);
  assert.equal(host.querySelector('[data-search-clear]').hasAttribute('hidden'), false);
  assert.equal(host.querySelector('[data-search-submit]').getAttribute('type'), 'button');
  assert.equal(env.template.innerHTML, template); assert.equal(live.getAttribute('value'), 'private global query');
  assert.doesNotMatch(host.innerHTML, /data-global-search|recent-search-popover|role="combobox"/);
});
test('disabled Search exposes native inert controls and never leaves Clear enabled', () => {
  const env = fixture(), host = env.document.createElement('div');
  host.innerHTML = env.render({id: 'creation-search', value: 'text', disabled: true});
  for (const control of host.querySelectorAll('input,button')) {
    assert.equal(control.hasAttribute('disabled'), true); assert.equal(control.getAttribute('aria-disabled'), 'true');
  }
  assert.equal(host.querySelector('[data-search-clear]').hasAttribute('hidden'), true);
  host.innerHTML = env.render({id: 'creation-search', value: ''});
  assert.equal(host.querySelector('input').hasAttribute('disabled'), false);
  assert.equal(host.querySelector('[data-search-clear]').hasAttribute('hidden'), true);
});
test('Search rejects global/reserved or invalid identities and missing templates', () => {
  const env = fixture();
  for (const id of [null, '', 'search-input', '<injected>', 'space id']) assert.throws(() => env.render({id}));
  env.template.remove(); assert.throws(() => env.render({id: 'creation-search'}), /template is unavailable/);
});
