const test = require('node:test'), assert = require('node:assert/strict');
const {fixture} = require('./playlist-native-review-fixture.cjs');
const shared = () => import('../../../music_app/static/js/collections/native-filter-surface.mjs');
const playlist = () => import('../../../music_app/static/js/playlists/native-filter-surface.mjs');
const config = {title: 'Top filters', pageId: 'album-top-filters'};

function surfaceFixture(phone = false) {
  const h = fixture(), mediaListeners = new Set(), forms = [], closes = [], children = [];
  const media = {matches: phone,
    addEventListener(type, fn) {assert.equal(type, 'change'); mediaListeners.add(fn);},
    removeEventListener(type, fn) {assert.equal(type, 'change'); mediaListeners.delete(fn);},
  };
  h.context.matchMedia = () => media;
  const openForm = h.runtime.openForm;
  h.runtime.openForm = options => {forms.push(options); return openForm(options);};
  const trigger = h.document.createElement('button'); h.document.body.append(trigger);
  const props = {id: 'owned-filters', returnFocus: () => trigger, onClose: value => closes.push(value),
    mount(section) {
      const input = h.document.createElement('input'); section.append(input);
      const child = {input, updates: [], disposals: 0,
        update(value) {this.updates.push(value);}, dispose() {this.disposals++; input.remove();},
      };
      children.push(child); return child;
    },
  };
  return {...h, props, trigger, forms, closes, children, mediaListeners,
    resize(next) {media.matches = next; for (const fn of [...mediaListeners]) fn();},
    escape(patch = {}) {
      const event = new h.context.Event('keydown', {key: 'Escape'}); Object.assign(event, patch);
      h.host.dispatchEvent(event); return event;
    },
  };
}

test('configured desktop surface updates its mounted child and Escape returns to its live trigger', async t => {
  const {mountCollectionFilterSurface} = await shared(), h = surfaceFixture();
  const surface = mountCollectionFilterSurface(h.host, h.runtime, config, h.props); t.after(() => surface.dispose());
  assert.equal(h.forms.length, 0); assert.equal(h.host.querySelector('section').getAttribute('aria-label'), 'Top filters');
  assert.equal(h.host.querySelector('section').id, 'owned-filters');
  const childProps = {query: 'updated'}; surface.update({...h.props, childProps});
  assert.deepEqual(h.children[0].updates, [childProps]);
  const event = h.escape(); assert.equal(event.defaultPrevented, true);
  assert.deepEqual(h.closes, [{restoreFocusRequested: true}]); assert.equal(h.document.activeElement, h.trigger);
});

test('desktop Escape leaves nested expanded controls and consumed/composing/repeated keys to their owners', async t => {
  const {mountCollectionFilterSurface} = await shared(), h = surfaceFixture();
  const surface = mountCollectionFilterSurface(h.host, h.runtime, config, h.props); t.after(() => surface.dispose());
  const nested = h.document.createElement('button'); nested.setAttribute('aria-expanded', 'true');
  h.host.querySelector('section').append(nested); assert.equal(h.escape().defaultPrevented, false);
  nested.setAttribute('aria-expanded', 'false');
  for (const patch of [{defaultPrevented: true}, {repeat: true}, {isComposing: true}]) h.escape(patch);
  assert.equal(h.closes.length, 0);
  h.trigger.disabled = true; h.escape(); assert.notEqual(h.document.activeElement, h.trigger);
});

test('Playlist compatibility wrapper preserves its native dialog title, page identity and existing hooks', async t => {
  const {mountPlaylistFilterSurface} = await playlist(), h = surfaceFixture(true);
  const surface = mountPlaylistFilterSurface(h.host, h.runtime, h.props); t.after(() => surface.dispose());
  assert.equal(h.forms.length, 1); assert.equal(h.forms[0].title, 'Playlist filters');
  assert.equal(h.forms[0].pageId, 'playlist-filters'); assert.equal(h.forms[0].contentOwnsFooter, false);
  assert.equal(h.forms[0].returnFocus(), h.trigger);
  const section = h.document.getElementById('owned-filters');
  assert.equal(section.getAttribute('aria-label'), 'Playlist filters');
  assert.equal(section.classList.contains('playlists__filter-surface--form'), true);
  assert.equal(section.classList.contains('collection-filter-surface--form'), true);
  h.escape(); assert.equal(h.closes.length, 0, 'phone Escape remains owned by the native form');
});

test('phone-to-desktop resize closes native form without return focus and remounts one inline child', async t => {
  const {mountCollectionFilterSurface} = await shared(), h = surfaceFixture(true), closes = [];
  const openForm = h.runtime.openForm;
  h.runtime.openForm = options => openForm({...options,
    onMount(host, nativeClose) {options.onMount(host, (target, next) => {closes.push(next); return nativeClose(target, next);});},
  });
  const surface = mountCollectionFilterSurface(h.host, h.runtime, config, h.props); t.after(() => surface.dispose());
  assert.equal(h.forms[0].title, 'Top filters'); assert.equal(h.forms[0].pageId, 'album-top-filters');
  h.resize(false); await h.settle();
  assert.equal(closes[0].restoreFocus, false); assert.equal(closes[0].reason, 'resize');
  assert.equal(h.children.length, 2); assert.equal(h.children[0].disposals, 1);
  assert.equal(h.host.querySelector('section').classList.contains('collection-filter-surface--inline'), true);
  assert.equal(h.document.activeElement, h.children[1].input); assert.equal(h.closes.length, 0);
  h.resize(false); assert.equal(h.children.length, 2);
});

test('desktop-to-phone resize closes the disclosure and disposal removes listeners and mounted content', async () => {
  const {mountCollectionFilterSurface} = await shared(), h = surfaceFixture();
  const surface = mountCollectionFilterSurface(h.host, h.runtime, config, h.props);
  h.resize(true); assert.deepEqual(h.closes, [{restoreFocusRequested: true}]);
  assert.equal(h.document.activeElement, h.trigger); assert.equal(h.forms.length, 0);
  surface.dispose(); assert.equal(h.mediaListeners.size, 0); assert.equal(h.host.childNodes.length, 0);
  assert.equal(h.children[0].disposals, 1);
  h.escape(); h.resize(false); assert.equal(h.closes.length, 1);
});

test('refused phone resize retains the form and a later accepted resize can transfer ownership', async t => {
  const {mountCollectionFilterSurface} = await shared(), h = surfaceFixture(true), openForm = h.runtime.openForm;
  let allowed = false;
  h.runtime.openForm = options => openForm({...options,
    onMount(host, nativeClose) {options.onMount(host, (target, next) => allowed ? nativeClose(target, next) : false);},
  });
  const surface = mountCollectionFilterSurface(h.host, h.runtime, config, h.props);
  t.after(() => {allowed = true; surface.dispose();});
  h.resize(false); await h.settle();
  assert.equal(h.children.length, 1); assert.equal(h.children[0].disposals, 0);
  assert.equal(h.host.childNodes.length, 0); assert.equal(h.closes.length, 0);
  allowed = true; h.resize(false); await h.settle();
  assert.equal(h.children.length, 2); assert.equal(h.children[0].disposals, 1);
  assert.equal(h.document.activeElement, h.children[1].input);
});

test('retired phone source closes during resize without reviving an inline child', async t => {
  const {mountCollectionFilterSurface} = await shared(), h = surfaceFixture(true), openForm = h.runtime.openForm;
  h.runtime.openForm = options => openForm({...options,
    onClose(host, next) {options.onClose(host, {...next, current: false});},
  });
  const surface = mountCollectionFilterSurface(h.host, h.runtime, config, h.props); t.after(() => surface.dispose());
  h.resize(false); await h.settle();
  assert.equal(h.children.length, 1); assert.equal(h.children[0].disposals, 1);
  assert.equal(h.host.childNodes.length, 0); assert.equal(h.closes.length, 1);
  assert.equal(h.closes[0].current, false);
});
