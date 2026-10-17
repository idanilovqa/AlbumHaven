const test = require('node:test');
const assert = require('node:assert/strict');
const {fixture: nativeFixture, load} = require('./home-friends-native-app-fixture.cjs');
let nativeOwners;
test.before(async () => {nativeOwners = await load('comparison.mjs');});
const side = (listen_count, play_count = null) => ({listen_count, play_count, full_listen_count: null, rating: null, favorite: null});
const row = (id, yours, friend, extra = {}) => ({id, title: `Title ${id}`, artist: 'An artist', kind: 'track',
  yours: side(yours), friend: side(friend), ...extra});
const value = rows => ({status: 'ready', data: {rows}});
const state = extra => ({friendRef: 'friend:1', kind: 'tracks', period: 'week', commonOnly: false,
  order: 'general', ascending: false, view: 'rows', selection: null, ...extra});

// Mount delivered owners and transparently retain actual callback seams as well as DOM controls.
function fixture(t, extra = {}, initialPhone = false, entry = 'ComparisonPanel') {
  const h = nativeFixture(t), {host, document, runtime, c} = h;
  const media = c.matchMedia('(max-width: 900px)'); media.matches = initialPhone;
  const changed = [], selected = [], choiceCalls = [], viewCalls = [];
  const openChoice = runtime.openChoice, mountViewChooser = runtime.mountViewChooser;
  runtime.openChoice = (trigger, options) => {
    const owner = openChoice(trigger, options); choiceCalls.push({trigger, options, owner}); return owner;
  };
  runtime.mountViewChooser = (element, options) => {
    const owner = mountViewChooser(element, options); viewCalls.push({element, options, owner}); return owner;
  };
  let props = {friendName:'Maya', friendRef:'friend:1', kind:'tracks', period:'week',
    value:value([row('a',1,7),row('b',4,1)]), presentation:state(),
    onPresentationChange:next=>changed.push(next), onSelection:next=>selected.push(next), ...extra};
  if (props.viewControlsHost) {props.viewControlsHost = document.createElement('header'); document.body.append(props.viewControlsHost);}
  const viewHost = props.viewControlsHost || host;
  let owner;
  const emit = (node,type='click') => {assert.ok(node); const event = new c.Event(type,{bubbles:true}); node.dispatchEvent(event); return event;};
  return {...h, changed, selected, media, viewHost, emit, choiceCalls, viewCalls,
    render(next={}) {props={...props,...next}; if(owner)owner.update(props);else owner=h.own(nativeOwners[`mount${entry}`](host,runtime,props));return host;},
    resize(phone){media.matches=phone;for(const callback of [...media.listeners])callback();},
    click(key){const button=host.querySelector(`[data-cdt-sort="${key}"]`);assert.ok(button,`native heading ${key}`);button.focus();assert.equal(emit(button).defaultPrevented,true);},
    order(value){emit(host.querySelector('.home-comparison__order button'));const option=document.querySelector(`[data-foobar-format="${value}"]`);emit(option);},
    common(checked){const input=host.querySelector('input');input.checked=checked;emit(input,'change');},
    ids(){return host.querySelectorAll('[data-comparison-id]').map(node=>node.dataset.comparisonId);},
    last(){return changed.at(-1);},
    dispose(){owner?.dispose();props.viewControlsHost?.remove();host.remove();},
  };
}
const details = h => h.host.querySelector('.home-comparison__details');
const controls = h => h.host.querySelector('.home-comparison__controls');
const view = h => h.viewHost.querySelector('[aria-label="Comparison album view"]');
// The unchanged harness records the exact callbacks registered by actual native
// owners. Capture them before retirement, then invoke directly even after their
// listeners have been removed. This is not redispatch-only coverage.
function retainListeners(target, type, boundary) {
  const result = [];
  for (let node = target; node; node = node.parentNode) {
    for (const entry of node.listeners || []) if (entry.type === type) result.push({...entry, originalTarget:target});
    if (node === boundary) break;
  }
  return result;
}
function retained(h) {
  const old = {controls:controls(h), input:h.host.querySelector('input'), order:h.host.querySelector('.home-comparison__order button'),
    view:view(h), cards:h.host.querySelector('.home-comparison__cards'), select:h.host.querySelector('[data-home-comparison-select]')};
  old.inputCallbacks = old.input ? retainListeners(old.input,'change',old.controls) : [];
  old.selectCallbacks = old.select ? retainListeners(old.select,'click',h.host) : [];
  if (old.input) assert.ok(old.inputCallbacks.length, 'capture actual Common-only callback before retirement');
  if (old.select) assert.ok(old.selectCallbacks.length, 'capture actual table/card selection callback before retirement');
  if (old.order) {
    h.emit(old.order);
    const call = h.choiceCalls.at(-1); assert.strictEqual(call.trigger,old.order);
    old.onOrder = call.options.onSelect; old.menuOwner = call.owner;
    assert.equal(typeof old.onOrder,'function');
  }
  if (old.view) {
    const call = h.viewCalls.find(call=>call.element===old.view); assert.ok(call);
    old.onView = call.options.onSelect; assert.equal(typeof old.onView,'function');
  }
  return old;
}
function replay(h, old) {
  // Direct calls preserve the original stale-closure contract independently of
  // whether a detached node can still dispatch through a current owner.
  old.onOrder?.('friend'); old.onView?.('rows'); old.onView?.('covers');
  if(old.input)old.input.checked=true;
  for(const entry of [...old.inputCallbacks,...old.selectCallbacks]) {
    const event=h.event(entry.type,entry.originalTarget);event.currentTarget=entry.target;
    entry.callback.call(entry.target,event);
  }
  if(old.menuOwner)assert.equal(old.menuOwner.isOpen,false,'retired native Choice menu is closed');
  // Keep detached DOM replay and listener teardown coverage too.
  if(old.input)h.emit(old.input,'change');
  if(old.order)h.emit(old.order);
  if(old.select)h.emit(old.select);
  if(old.view)for(const button of old.view.querySelectorAll('[data-action-value]'))h.emit(button);
  for(const entry of old.inputCallbacks)assert.equal(entry.target.listeners.some(l=>l.callback===entry.callback),false);
  for(const entry of old.selectCallbacks)if(!entry.target.isConnected)assert.equal(entry.target.listeners.some(l=>l.callback===entry.callback),false);
}

test('person headings toggle one whole-pair order and General restores the combined baseline', t => {
  const h = fixture(t); let tree = h.render();
  assert.deepEqual(h.ids(), ['a', 'b']);
  h.click('yours'); tree = h.render(); assert.deepEqual(h.ids(), ['b', 'a']);
  assert.equal(h.last().order, 'yours'); assert.equal(h.last().ascending, false);
  assert.equal(h.host.querySelector('[data-cdt-column="yours"]').getAttribute('aria-sort'), 'descending');
  assert.match(h.document.activeElement.getAttribute('aria-label'), /Activate for ascending order/);
  h.click('yours'); tree = h.render(); assert.deepEqual(h.ids(), ['a', 'b']);
  assert.equal(h.last().ascending, true);
  h.click('friend'); tree = h.render(); assert.equal(h.last().order, 'friend'); assert.equal(h.last().ascending, false);
  h.order('general'); h.render();
  assert.deepEqual(h.ids(), ['a', 'b']); assert.equal(h.last().order, 'general');
  assert.equal(h.last().ascending, false); assert.equal(h.last().metricSort, null); h.dispose();
});

test('native metric sorting cycles both directions then baseline, preserving zero, unknown and pair identity', t => {
  const rows = [row('high', 9, 1, {friend: side(1, 8)}), row('zero', 1, 2, {friend: side(2, 0)}),
    row('unknown', 99, 1, {friend: side(1, null)})];
  const h = fixture(t, {value: value(rows)}); h.render();
  h.click('friend:play_count'); h.render(); assert.deepEqual(h.ids(), ['zero', 'high', 'unknown']);
  assert.deepEqual(JSON.parse(JSON.stringify(h.last().metricSort)), {side: 'friend', key: 'play_count', direction: 'ascending'});
  assert.equal(h.document.activeElement.dataset.cdtSort, 'friend:play_count');
  assert.match(h.document.activeElement.getAttribute('aria-label'), /Sort by Maya PC: ascending/);
  h.click('friend:play_count'); h.render(); assert.deepEqual(h.ids(), ['high', 'zero', 'unknown']);
  h.click('friend:play_count'); h.render(); assert.deepEqual(h.ids(), ['unknown', 'high', 'zero']);
  for (const pair of h.host.querySelectorAll('[data-comparison-id]')) {
    assert.deepEqual(pair.querySelectorAll('[data-home-comparison-select]').map(button => button.dataset.homeComparisonSelect), [pair.dataset.comparisonId, pair.dataset.comparisonId]);
  }
  assert.equal(h.last().metricSort, null); h.dispose();
});

test('sorting retains selected identity and native trigger while selection changes alone do not replace rows', t => {
  const h = fixture(t); let tree = h.render();
  const button = h.host.querySelector('[data-home-comparison-select="a"]');
  button.focus();
  h.emit(button);
  tree = h.render();
  assert.equal(h.host.querySelector('[data-home-comparison-select="a"]'), button);
  assert.equal(button.getAttribute('aria-pressed'), 'true');
  h.click('yours'); tree = h.render();
  assert.equal(h.last().selection.id, 'a');
  assert.equal(details(h).querySelector('h3').textContent, 'Title a');
  assert.equal(h.document.activeElement.dataset.cdtSort, 'yours'); h.dispose();
});

test('replaced sources retire old controls and selection gestures while preserving valid local presentation', t => {
  const first = value([row('first', 3, 2)]), second = value([row('second', 1, 4)]);
  const h = fixture(t, {value: first}); h.render(); const oldControls = controls(h), old = retained(h);
  const oldButton = h.host.querySelector('[data-home-comparison-select="first"]');
  let tree = h.render({value: second});
  assert.notEqual(controls(h), oldControls); assert.equal(oldControls.isConnected, false);
  replay(h, old); h.emit(oldButton);
  tree = h.render();
  assert.equal(h.last().order, 'general'); assert.equal(h.last().commonOnly, false);
  assert.deepEqual(h.selected, []); assert.deepEqual(h.ids(), ['second']); h.dispose();
});

test('friend, kind and period changes reset scoped sort/view and retire header portal callbacks', t => {
  for (const next of [{friendRef: 'friend:2'}, {kind: 'tracks'}, {period: 'month'}]) {
    const h = fixture(t, {kind: 'albums', value: value([row('album:1', 2, 3, {kind: 'album'})]),
      presentation: state({kind: 'albums', view: 'covers', metricSort: {side: 'friend', key: 'rating', direction: 'descending'}}),
      viewControlsHost: {name: 'native header'}});
    h.render(); const old = retained(h), oldView = view(h);
    assert.equal(h.viewHost.tagName, 'HEADER'); assert.ok(h.viewHost.contains(oldView));
    let tree = h.render(next); tree = h.render();
    replay(h, old); tree = h.render();
    assert.equal(h.last().view, 'rows'); assert.equal(h.last().order, 'general'); assert.equal(h.last().metricSort, null);
    if (view(h)) assert.equal(view(h).getAttribute('aria-label'), 'Comparison album view');
    if (next.kind) assert.equal(view(h), null);
    else assert.notEqual(view(h), oldView);
    h.dispose();
  }
});

test('new page, common filter and denial clear selection, and unreadable sources never retain details', t => {
  for (const replacement of [value([row('other', 3, 2)]), {status: 'denied', data: null}, {status: 'empty', data: {rows: []}}]) {
    const h = fixture(t, {presentation: state({selection: {id: 'selected', kind: 'track'}}), value: value([row('selected', 3, 2)])});
    h.render(); assert.equal(details(h).querySelector('h3').textContent, 'Title selected');
    let tree = h.render({value: replacement}); tree = h.render();
    assert.equal(details(h).hidden, true); assert.equal(details(h).textContent, ''); assert.equal(h.last().selection, null);
    assert.equal(h.selected.at(-1), null); h.dispose();
  }
  const h = fixture(t, {presentation: state({selection: {id: 'own-only', kind: 'track'}}), value: value([row('own-only', 3, null)])});
  let tree = h.render(); h.common(true); tree = h.render(); h.render();
  assert.equal(details(h).hidden, true); assert.equal(details(h).textContent, ''); assert.equal(h.last().selection, null); h.dispose();
});

test('unmount and blocked resource changes reject retained card/header callbacks', t => {
  for (const blocked of ['unmount', 'loading', 'denied', 'unavailable', 'error']) {
    const h = fixture(t, {kind: 'albums', presentation: state({kind: 'albums', view: 'covers'}), value: value([row('album', 3, 2, {kind: 'album'})])});
    h.render(); const old = retained(h);
    if (blocked === 'unmount') h.dispose(); else h.render({value: {status: blocked, data: null}});
    replay(h, old);
    assert.deepEqual(h.selected, []);
    if (blocked !== 'unmount') {
      const tree = h.render(); assert.equal(details(h).hidden, true); assert.equal(details(h).textContent, '');
      assert.equal(h.last().order, 'general'); assert.equal(h.last().view, 'covers'); h.dispose();
    }
  }
});


test('native phone resize switches covers to one shared identity and releases its media listener', t => {
  const h = fixture(t, {kind: 'albums', presentation: state({kind: 'albums', view: 'covers'}),
    value: value([row('album', 3, 2, {kind: 'album'})])}, true);
  let tree = h.render();
  assert.equal(h.host.querySelector('.home-comparison__cards'), null);
  assert.equal(h.host.querySelectorAll('.album-card').length, 1);
  assert.equal(h.host.querySelectorAll('[data-home-comparison-select]').length, 1);
  h.resize(false); tree = h.render();
  assert.equal(h.host.querySelector('.home-comparison__cards [data-comparison-id]').dataset.comparisonId, 'album');
  assert.equal(h.host.querySelector('.home-comparison__table').querySelectorAll('[data-home-comparison-select]').length, 0, 'the desktop sort strip has no duplicate row controls');
  h.resize(true); tree = h.render(); assert.equal(h.host.querySelector('.home-comparison__cards'), null);
  assert.equal(h.last().view, 'covers'); assert.equal(h.host.querySelectorAll('.album-card').length, 1);
  assert.equal(h.media.listeners.size, 2, 'panel and actual view chooser each own a media listener'); h.dispose(); assert.equal(h.media.listeners.size, 0);
});


test('cover focus highlights the matching stable identity and announces only that counterpart', t => {
  const rows = [row('album:a', 3, 0, {kind: 'album', title: 'Same name'}), row('album:b', 1, null, {kind: 'album', title: 'Same name'})];
  const h = fixture(t, {rows, kind: 'albums', onSelect() {}}, false, 'ComparisonCards');
  const sideOf = (id, side) => h.host.querySelector(`[data-comparison-id="${id}"] [data-comparison-side="${side}"]`);
  h.render();
  h.emit(sideOf('album:a', 'yours'), 'focus');
  assert.equal(sideOf('album:a','friend').getAttribute('data-comparison-highlighted'),'true');
  assert.equal(sideOf('album:b','friend').getAttribute('data-comparison-highlighted'),null);
  const announcement = h.host.querySelector('[role="status"]').textContent;
  assert.match(announcement,/Maya, matching album: Same name/);assert.match(announcement,/Track listens: 0/);
  h.render({rows:[...rows].reverse()});
  h.emit(sideOf('album:a','yours'),'focus');
  assert.equal(sideOf('album:a','friend').getAttribute('data-comparison-highlighted'),'true');
  assert.equal(sideOf('album:b','friend').getAttribute('data-comparison-highlighted'),null);
  h.render({rows:[rows[1]]});
  assert.equal(sideOf('album:b','friend').getAttribute('data-comparison-highlighted'),null);
  assert.equal(h.host.querySelector('[role="status"]').textContent,'');h.dispose();
});
