const test = require('node:test');
const assert = require('node:assert/strict');
const {fixture: nativeFixture, load} = require('./home-friends-native-app-fixture.cjs');

async function fixture(t, kind) {
  const h = nativeFixture(t);
  const mount = kind === 'artist' ? (await load('artist-selection.mjs')).mountArtistSelectionRows
    : (await load('friends-directory.mjs')).mountPersonNavigation;
  let owner;
  const button = () => h.host.querySelector(kind === 'artist' ? '[data-home-artist-select]' : '[data-home-person-row]');
  function render(props) {
    const next = kind === 'artist' ? {rows: [props.row], selectedId: props.selected ? props.row.id : null, onSelect: props.onSelect} : props;
    if (owner) owner.update(next); else owner = h.own(mount(h.host, h.runtime, next));
    return button();
  }
  return {...h, root: h.host, render, button, click() {h.click(button());},
    frame() {const callbacks = [...h.frames.values()]; h.frames.clear(); callbacks.forEach(callback => callback());},
    dispose() {owner?.dispose();}};
}
const artist = patch => ({id: 'artist:one', title: 'Artist One', listen_count: 3, source_readable: true, allowed_actions: {can_read: true}, ...patch});
const person = {account_ref: 'member:one', display_name: 'Person One', handle: 'person', avatar_url: null};
const personProps = patch => ({person, rowKey: 'person:one', selected: false, disabled: false, ...patch});

for (const kind of ['artist', 'person']) test(`${kind} row retains its actual native button while native updates reconcile current state`, async t => {
  const h = await fixture(t, kind);
  const initial = kind === 'artist' ? {row: artist(), selected: false} : personProps();
  const first = h.render(initial); first.focus();
  assert.equal(h.render({...initial}), first);
  const changed = kind === 'artist' ? {...initial, selected: true, row: artist({title: 'Artist Updated'})}
    : {...initial, selected: true, person: {...person, display_name: 'Person Updated'}};
  assert.equal(h.render(changed), first);
  assert.equal(h.button(), first); assert.equal(first.getAttribute('aria-current'), 'true');
  assert.match(first.textContent, /Updated/); assert.equal(h.document.activeElement, first); h.dispose();
});

test('ArtistRow uses latest readable row callback and blocks a revoked native row', async t => {
  const h = await fixture(t, 'artist'), calls = [];
  const first = artist(), updated = artist({title: 'New'});
  h.render({row: first, onSelect: row => calls.push(['old', row])});
  h.render({row: updated, onSelect: row => calls.push(['new', row])}); h.click();
  assert.deepEqual(calls, [['new', updated]]);
  h.render({row: artist({source_readable: false}), onSelect: row => calls.push(['revoked', row])});
  assert.equal(h.button().disabled, true); assert.match(h.root.textContent, /Unavailable artist/);
  h.click(); assert.equal(calls.length, 1); h.dispose();
});

test('PersonNavigation selected parent rerender does not retire two-frame activation or its latest callback', async t => {
  const h = await fixture(t, 'person'), calls = []; let selected = false;
  const props = () => personProps({selected, onSelect() {selected = true; h.render(props());}, onActivate: () => calls.push(selected ? 'current' : 'old')});
  const first = h.render(props()); h.click();
  assert.equal(h.render(props()), first);
  assert.equal(h.button().getAttribute('aria-current'), 'true');
  assert.deepEqual(calls, []); h.frame(); assert.deepEqual(calls, []); h.frame(); assert.deepEqual(calls, ['current']); h.dispose();
});

for (const retirement of ['disabled', 'hidden', 'unmount']) test(`PersonNavigation cancels deferred activation after ${retirement}`, async t => {
  const h = await fixture(t, 'person'), calls = [];
  const props = personProps({onActivate: () => calls.push('activate')}); h.render(props); h.click(); h.frame();
  if (retirement === 'disabled') h.render({...props, disabled: true});
  if (retirement === 'hidden') h.root.hidden = true;
  if (retirement === 'unmount') h.dispose();
  h.frame(); assert.deepEqual(calls, []);
  if (retirement !== 'unmount') h.dispose(); assert.equal(h.frames.size, 0);
});

test('newer same-row activation cancels an earlier pending frame chain', async t => {
  const h = await fixture(t, 'person'), calls = [];
  h.render(personProps({onActivate: () => calls.push('activate')}));
  h.click(); h.frame(); h.click(); h.frame(); assert.deepEqual(calls, []);
  h.frame(); assert.deepEqual(calls, ['activate']); h.dispose();
});
