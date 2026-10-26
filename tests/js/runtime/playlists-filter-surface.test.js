const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {filterFixture, settle} = require('./playlist-filter-native-fixture.cjs');
const repo = path.resolve(__dirname, '../../..');
let mountPlaylistFilterSurface, mountCreationSearch, mountChoice;
test.before(async () => {
  ({mountPlaylistFilterSurface} = await import('../../../music_app/static/js/playlists/native-filter-surface.mjs'));
  ({mountCreationSearch} = await import('../../../music_app/static/js/playlists/native-creation.mjs'));
  ({mountChoice} = await import('../../../music_app/static/js/home-friends/native-controls.mjs'));
});
function fixture(phone = false, withMedia = true, options = {}) {
  const env = filterFixture({phone, withMedia, delayed: phone, ...options});
  const trigger = env.document.createElement('button'); env.document.body.append(trigger);
  const closes = []; let mounts = 0, disposals = 0, owner;
  const props = {id: 'owned-filters', returnFocus: () => trigger, onClose: value => closes.push(value),
    mount(host) {mounts++; const searchHost = env.document.createElement('div'); host.append(searchHost);
      const search = mountCreationSearch(searchHost, env.runtime, {id: 'filter-surface-query', value: '', label: 'Find tracks'});
      return {dispose() {disposals++; search.dispose();}};
    }};
  return {...env, trigger, notifications: closes,
    render() {owner ||= mountPlaylistFilterSurface(env.host, env.runtime, props); return env.document.querySelector('#owned-filters');},
    section: () => env.document.querySelector('#owned-filters'),
    counts: () => ({mounts, disposals}),
    unmount() {owner.dispose(); env.host.remove(); trigger.remove();},
    escape(options = {}) {const event = Object.assign(new env.context.Event('keydown', {key: 'Escape'}), options);
      env.host.dispatchEvent(event); return event;},
  };
}

test('desktop keeps an inline region; ordinary Escape returns focus while Choice and held-key ownership survive', () => {
  const f = fixture(), section = f.render();
  assert.equal(section.tagName, 'SECTION'); assert.equal(section.id, 'owned-filters');
  assert.match(section.className, /--inline/); assert.equal(section.getAttribute('aria-label'), 'Playlist filters');
  for (const options of [{defaultPrevented: true}, {repeat: true}, {isComposing: true}]) f.escape(options);
  const choiceHost = f.document.createElement('span'); section.append(choiceHost);
  const choice = mountChoice(choiceHost, f.runtime, {label: 'Test choice', value: 'one', options: [['one', 'One'], ['two', 'Two']]});
  const trigger = choiceHost.querySelector('button'); f.click(trigger);
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  f.escape(); assert.equal(f.notifications.length, 0);
  choice.dispose(); choiceHost.remove(); const event = f.escape();
  assert.equal(event.defaultPrevented, true); assert.equal(event.stopped, true);
  assert.equal(f.notifications.length, 1); assert.equal(f.document.activeElement, f.trigger); f.unmount();
});

test('phone delegates its whole filter page and close footer to the native form owner', async () => {
  const f = fixture(true), section = f.render(), form = f.forms[0];
  assert.equal(form.options.title, 'Playlist filters'); assert.equal(form.options.pageId, 'playlist-filters');
  assert.equal(form.options.contentOwnsFooter, false);
  assert.equal(f.document.getElementById('app-form-cancel').hidden, false);
  assert.equal(section.tagName, 'SECTION'); assert.match(section.className, /--form/);
  assert.equal(section.querySelector('input').getAttribute('aria-label'), 'Find tracks');
  f.click(f.document.getElementById('app-form-cancel')); await f.returnParent();
  assert.equal(f.notifications.length, 1); assert.equal(f.notifications[0].restoreFocusRequested, true); f.unmount();
});

test('desktop-to-phone resize collapses instead of opening an unexpected page and retains the current trigger', () => {
  const f = fixture(); f.render(); f.resize(true);
  assert.equal(f.notifications.length, 1); assert.equal(f.document.activeElement, f.trigger);
  assert.equal(f.closes.length, 0); assert.equal(f.forms.length, 0); f.unmount();
});

test('phone-to-desktop resize waits for the native parent return before mounting inline and focusing a field', async () => {
  const f = fixture(true); f.render(); f.resize(false); f.resize(false);
  assert.equal(f.closes.length, 1); assert.equal(f.closes[0].reason, 'resize');
  assert.equal(f.closes[0].restoreFocus, false);
  assert.equal(f.host.querySelector('.playlists__filter-surface--inline'), null);
  assert.equal(f.notifications.length, 0);
  await f.returnParent(); const inline = f.section();
  assert.equal(inline.tagName, 'SECTION'); assert.match(inline.className, /--inline/);
  assert.equal(f.notifications.length, 0); assert.equal(f.document.activeElement, inline.querySelector('input')); f.unmount();
});

test('newer native navigation prevents a pending resize from reopening or focusing filters', async () => {
  const f = fixture(true); f.render(); f.resize(false);
  const destination = f.document.createElement('button'); f.document.body.append(destination); destination.focus();
  await f.returnParent(false);
  assert.equal(f.notifications.length, 1); assert.equal(f.document.activeElement, destination);
  assert.equal(f.host.querySelector('.playlists__filter-surface--inline'), null); f.unmount();
});

test('a second narrow resize before native close leaves the page closed instead of reopening a stale inline row', async () => {
  const f = fixture(true); f.render(); f.resize(false); f.resize(true);
  await f.returnParent(); assert.equal(f.notifications.length, 1);
  assert.equal(f.host.querySelector('.playlists__filter-surface--inline'), null); f.unmount();
});

test('resource unmount retires resize listeners and late native closure cannot write or focus a replacement', async () => {
  const f = fixture(true); f.render(); f.resize(false); f.unmount();
  const counts = f.counts(), replacement = f.document.createElement('button'); f.document.body.append(replacement); replacement.focus();
  await f.returnParent(); f.resize(false);
  assert.equal(f.notifications.length, 0); assert.deepEqual(f.counts(), counts);
  assert.equal(counts.mounts, counts.disposals); assert.equal(f.document.activeElement, replacement);
  assert.equal(f.media.listeners.length, 0);
});

test('width-only environments keep the same responsive ownership and remove their fallback listener', () => {
  const f = fixture(false, false); f.render(); f.resize(true);
  assert.equal(f.notifications.length, 1); f.unmount();
  assert.equal(f.winEvents.listeners.length, f.windowListenerBaseline.length);
  f.windowListenerBaseline.forEach((before, index) => {
    const after = f.winEvents.listeners[index];
    for (const field of ['target', 'type', 'callback', 'capture', 'once']) assert.equal(after[field], before[field], field);
  });
});

test('inline dismissal never focuses an unavailable trigger', () => {
  for (const kind of ['disabled', 'removed']) {
    const f = fixture(); f.render();
    if (kind === 'disabled') f.trigger.disabled = true; else f.trigger.remove();
    const other = f.document.createElement('button'); f.document.body.append(other); other.focus();
    f.escape(); assert.equal(f.document.activeElement, other); f.unmount();
  }
});

test('compact filter CSS changes layout only and keeps the native Choice and Search surfaces', () => {
  const css = fs.readFileSync(path.join(repo, 'music_app/static/css/runtime/collection-surfaces.css'), 'utf8');
  const template = fs.readFileSync(path.join(repo, 'music_app/templates/index.html'), 'utf8');
  assert.match(template, /css\/runtime\/collection-surfaces\.css/);
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, selector]) => selector.includes('.collection-filter-surface'));
  assert.ok(rules.length > 0, 'the served shared compact filter rules must exist');
  const section = rules.map(([rule]) => rule).join('\n');
  assert.match(section, /--inline \.ui-choice__label \{ display: none;/);
  assert.match(section, /--form :is\(\.collection-filter-fields, \.playlists__filters\) \{ display: grid;/);
  assert.match(section, /--inline :is\(\.collection-filter-search, \.playlists-filter__search\) \{ --search-field-height: 28px;/);
  assert.doesNotMatch(section, /background|color:|border|outline|box-shadow|#[0-9a-f]/i);
});

test('native close can refuse without an onClose notification, allowing a later resize attempt', async () => {
  const f = fixture(true, true, {refuse: true}); f.render();
  f.resize(false); await settle();
  assert.match(f.section().className, /--form/);
  f.resize(false); await settle();
  assert.equal(f.closes.length, 2); assert.equal(f.notifications.length, 0); f.unmount(); await f.returnParent();
});
