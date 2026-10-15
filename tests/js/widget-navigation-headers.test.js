const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const fs = require('node:fs');
const {pathToFileURL} = require('node:url');
const {createNativeHomeRuntime, requireOwner, buttonNamed} = require('./runtime/native-home-harness.cjs');

const homeSource = path.resolve(__dirname, '../../music_app/static/js/home-friends');
const helpers = import(pathToFileURL(path.join(homeSource, 'selection-presentation.mjs')));
const plain = value => JSON.parse(JSON.stringify(value));
const labels = node => node.querySelectorAll('button').map(button => button.getAttribute('aria-label') || button.textContent);

function nativeWidgets({backHost = false, actions = ['Play', 'Collapse', 'More', 'Close']} = {}) {
  const env = createNativeHomeRuntime({dashboard: true}), root = env.document.createElement('main');
  const pageHeader = env.document.createElement('header');
  pageHeader.innerHTML = '<div class="gallery-bar__context"><h1>My music</h1></div>';
  env.document.body.append(pageHeader, root);
  const widgets = ['album', 'artist'].map(key => {
    const element = env.document.createElement('section'), holder = env.document.createElement('div');
    holder.innerHTML = env.context.buildAlbumDetailsHeaderHtml({artist: 'Native artist', album: `Native ${key}`,
      titleId: `${key}-title`, subtitleId: `${key}-subtitle`, actionsHtml: actions.map(label =>
        env.context.ButtonComponent.renderActionButton({ariaLabel: label, icon: label === 'Close' ? 'close' : 'more'})).join('')});
    const header = holder.firstElementChild, body = env.document.createElement('div');
    body.innerHTML = '<button type="button" aria-label="Embedded control">Embedded control</button>';
    element.append(header, body); root.append(element);
    return {key, element, header, body, ...(backHost ? {backHost: pageHeader.querySelector('.gallery-bar__context')} : {})};
  });
  const intents = [], before = root.innerHTML, headerBefore = pageHeader.innerHTML;
  const owner = requireOwner(env, 'Dashboard').mount(root, {widgets, onSizeIntent: (...args) => intents.push(args)});
  return {...env, root, pageHeader, widgets, owner, intents, before, headerBefore};
}

// These execute the native owners in the existing bounded DOM fixture. DOM
// order, callback ownership and disposal are covered; painted layout is not.
test('shared widget actions put Full size first and retain only supplied middle and trailing actions', () => {
  for (const actions of [['Play', 'Collapse', 'More', 'Close'], ['More', 'Close'], ['Play'], []]) {
    const h = nativeWidgets({actions});
    for (const widget of h.widgets) {
      const group = widget.header.querySelector('.album-details-header__actions');
      assert.deepEqual(labels(group), ['Full size', ...actions]);
    }
    h.owner.dispose();
    assert.equal(h.root.innerHTML, h.before);
    assert.deepEqual(h.forbiddenCalls, []);
  }
});

test('every expanded native widget including AlbumDetails gets a left-header Back controlled by the existing owner', () => {
  const h = nativeWidgets(), foreground = h.document.createElement('button'); h.document.body.append(foreground);
  h.document.activeElement = foreground;
  for (const widget of h.widgets) {
    const body = widget.body, embedded = body.firstElementChild;
    body.scrollTop = 117; body.scrollLeft = 9;
    let embeddedCalls = 0; embedded.addEventListener('click', () => embeddedCalls++);
    const before = h.root.innerHTML;
    h.click(buttonNamed(widget.header, /^Full size$/));
    assert.equal(h.root.innerHTML, before, 'a sizing intent does not mutate controlled presentation');
    assert.deepEqual(h.intents.at(-1), [widget.key, widget.key]);
    h.owner.update({expandedKey: widget.key});
    const back = buttonNamed(widget.header, /^Back$/), actions = widget.header.querySelector('.album-details-header__actions');
    assert.equal(actions.contains(back), false, 'Back belongs to the header start, outside trailing actions');
    assert.equal(widget.header.firstElementChild === back || widget.header.firstElementChild.contains(back), true);
    assert.equal(buttonNamed(widget.header, /Widget size|Full size/, false), null);
    assert.deepEqual(labels(actions), ['Play', 'Collapse', 'More', 'Close']);
    h.click(embedded); assert.equal(embeddedCalls, 1); assert.equal(h.intents.length % 2, 1);
    const expandedMarkup = h.root.innerHTML;
    h.click(back.querySelector('path'));
    assert.deepEqual(h.intents.at(-1), [widget.key, null]);
    assert.equal(h.root.innerHTML, expandedMarkup, 'Back also waits for the controlled update');
    h.owner.update({expandedKey: null});
    assert.equal(buttonNamed(widget.header, /^Back$/, false), null);
    assert.deepEqual(labels(actions), ['Full size', 'Play', 'Collapse', 'More', 'Close']);
    assert.equal(widget.body, body); assert.equal(body.firstElementChild, embedded);
    assert.equal(body.scrollTop, 117); assert.equal(body.scrollLeft, 9);
    assert.equal(h.document.activeElement, foreground);
  }
  h.owner.dispose(); h.owner.dispose();
  assert.equal(h.root.innerHTML, h.before); assert.deepEqual(h.forbiddenCalls, []);
});

test('shared Back can occupy an existing page header without becoming another navigation or focus owner', () => {
  const h = nativeWidgets({backHost: true}), context = h.pageHeader.firstElementChild, identity = context.firstElementChild;
  h.owner.update({expandedKey: 'album'});
  const back = buttonNamed(context, /^Back$/);
  assert.equal(context.firstElementChild, back);
  assert.equal(identity.parentNode, context); assert.equal(identity.textContent, 'My music');
  assert.equal(h.root.querySelectorAll('[aria-label="Back"]').length, 0);
  h.click(back.querySelector('svg')); assert.deepEqual(h.intents, [['album', null]]);
  h.owner.update({expandedKey: 'artist'});
  assert.equal(context.querySelectorAll('[aria-label="Back"]').length, 1);
  const retired = buttonNamed(context, /^Back$/);
  h.owner.dispose(); h.click(retired);
  assert.deepEqual(h.intents, [['album', null]]);
  assert.equal(h.pageHeader.innerHTML, h.headerBefore); assert.equal(h.root.innerHTML, h.before);
  assert.deepEqual(h.forbiddenCalls, []);
});

test('Queue and Recent preserve independent bounded presentation in the same selection history', async () => {
  const {selectionQueryKey, selectionEntry, selectionPresentation, updateSelectionEntry} = await helpers;
  const recent = {section: 'recent', account_ref: null, kind: 'tracks', period: 'week'};
  const queue = {...recent, homeSection: 'queue'};
  assert.notEqual(selectionQueryKey(queue), selectionQueryKey(recent));
  let entries = updateSelectionEntry([], recent, {tracks: {rowIds: ['recent:one']}, expanded: 'artist', pane: 'artist', scroll: {source: 88}});
  entries = updateSelectionEntry(entries, queue, {tracks: {rowIds: ['queue:one'], native_media: '/private.flac'}, expanded: 'recent', pane: 'recent', scroll: {source: 23}});
  entries = selectionPresentation(plain(entries));
  assert.equal(entries.length, 2);
  assert.equal(selectionEntry(entries, recent).expanded, 'artist');
  assert.equal(selectionEntry(entries, recent).pane, 'artist');
  assert.deepEqual(selectionEntry(entries, recent).tracks.rowIds, ['recent:one']);
  assert.equal(selectionEntry(entries, recent).scroll.source, 88);
  assert.equal(selectionEntry(entries, queue).expanded, 'recent');
  assert.deepEqual(selectionEntry(entries, queue).tracks.rowIds, ['queue:one']);
  assert.equal(selectionEntry(entries, queue).scroll.source, 23);
  assert.doesNotMatch(JSON.stringify(entries), /native_media|private\.flac/);
});

const {homeFixture, assertOwnQueue, queuedSource} = require('./runtime/widget-native-home-fixture.cjs');

test('Queue selection, expansion, row inspection and Back keep the own profile header and native widget composition', async t => {
  const h=await homeFixture(t);let tree=h.section('queue');assertOwnQueue(tree);
  h.selectQueue('queue:one');tree=await h.settle();assertOwnQueue(tree);assert.equal(h.queueSnapshot().album.ref,'queue:album');
  const body=h.nodes.get('recent').querySelector('.home-friends__widget-body');body.scrollTop=74;
  for(const key of ['recent','artist','album']) {
    h.env.click(buttonNamed(h.nodes.get(key),/^Full size$/));tree=h.render();assertOwnQueue(tree);
    assert.equal(h.dashboard.getAttribute('data-dashboard-expanded-key'),key);
    const back=buttonNamed(h.pageHeader,/^Back$/),leading=h.pageHeader.querySelector('.home-header__leading');
    assert.equal(h.pageHeader.firstElementChild,leading);assert.equal(leading.contains(back),true);
    if(key==='recent')h.inspectQueue('queue:one');else h.env.click(back.querySelector('svg'));
    tree=await h.settle();assertOwnQueue(tree);assert.equal(h.dashboard.getAttribute('data-dashboard-expanded-key'),null);
    assert.equal(buttonNamed(h.pageHeader,/^Back$/,false),null);
    assert.equal(h.nodes.get('recent').querySelector('.home-friends__widget-body'),body);assert.equal(body.scrollTop,74);
  }
  assert.deepEqual(h.navigation,[]);assert.deepEqual(h.env.forbiddenCalls,[]);
});

test('Recent expansion and selection survive an independent Queue visit and source-only return', async t => {
  const h=await homeFixture(t);h.render();h.selectRecent('recent:one');h.render();
  h.env.click(buttonNamed(h.nodes.get('artist'),/^Full size$/));h.render();h.section('queue');
  assert.equal(h.dashboard.getAttribute('data-dashboard-expanded-key'),null,'Queue does not inherit Recent expansion');
  h.selectQueue('queue:one');await h.settle();h.env.click(buttonNamed(h.nodes.get('album'),/^Full size$/));h.render();h.section('recent');
  assert.equal(h.selection('recent')[0],'recent:one');assert.equal(h.page.querySelector('[data-home-activity-row="recent:one"]').getAttribute('aria-selected'),'true');
  assert.equal(h.dashboard.getAttribute('data-dashboard-expanded-key'),'artist');assert.equal(h.page.querySelector('[data-queue-row]'),null);
  h.section('queue');const tree=await h.settle();assertOwnQueue(tree);assert.equal(h.dashboard.getAttribute('data-dashboard-expanded-key'),'album');
  assert.deepEqual(plain(h.selection('queue')),['queue:one']);assert.equal(h.page.querySelector('[data-queue-row="queue:one"]').getAttribute('aria-selected'),'true');
  assert.deepEqual(h.navigation,[]);
});

test('Queue is absent on friend and member profile routes and retired callbacks cannot reopen its selection', async t => {
  for(const route of [{friendRef:'friend:one'},{profileRef:'member:one'}]) {
    const h=await homeFixture(t);h.section('queue');h.selectQueue('queue:one');await h.settle();
    const retiredSelect=h.retiredRow(),retiredNotifications=[...h.queue.listeners];
    h.shell={...h.shell,section:'friends',...route};h.render();
    assert.equal(h.page.querySelector('[data-queue-row]'),null);assert.equal(buttonNamed(h.page,/^Clear queue$/,false),null);
    assert.equal(h.page.querySelector('#home-recent-sections [data-in-page-tab="queue"]'),null);
    const readCount=h.queue.reads.length;retiredSelect();for(const notify of retiredNotifications)notify();await h.settle();
    assert.equal(h.queue.reads.length,readCount);assert.equal(h.page.querySelector('[data-queue-row]'),null);
    assert.equal(h.pageHeader.querySelectorAll('[aria-label="Back"]').length,0);h.dispose();
    assert.equal(h.queue.listeners.size,0);assert.deepEqual(h.env.forbiddenCalls,[]);
  }
});

function nativeHistory() {
  const {installPrivateContext} = require('./runtime/private-context-harness.cjs');
  const home = {dataset: {accountName: 'Current listener'}}, shell = {dataset: {nativeAccountId: 'account', nativeLibraryId: 'library'}};
  const nodes = new Map([['mobile-home', home], ['app-shell', shell]]), replacements = [];
  const window = {location: new URL('https://albumhaven.test/?surface=home'), addEventListener() {}, dispatchEvent() {},
    history: {state: {albumHavenNavigationPosition: 9},
      replaceState(value) {this.state = value; replacements.push(value);},
      pushState() {assert.fail('presentation must not add history entries');}, back() {assert.fail('presentation must not traverse browser history');}}};
  const context = vm.createContext({window, document: {getElementById: id => nodes.get(id)}, URL, Event, AbortController,
    state: {view: {recent_local_albums: [], recent_not_local_albums: []}, ui: {}}, shouldShowMobileHome: () => true,
    fetch() {assert.fail('saving presentation cannot read a provider');}, escapeHtml: String});
  installPrivateContext(context);
  vm.runInContext(fs.readFileSync(path.resolve(homeSource, '../runtime/home-friends-bridge.js'), 'utf8'), context);
  return {bridge: window.AlbumHavenHomeRuntime, window, replacements};
}

test('native history roundtrip restores Queue occurrences through a fresh owner and preserves the separate Recent entry', async t => {
  const history=nativeHistory(),queue=queuedSource(),h=await homeFixture(t,{kind:'tracks'},queue);
  h.render();h.selectRecent('recent:one');h.render();h.env.click(buttonNamed(h.nodes.get('artist'),/^Full size$/));h.render();
  h.section('queue');h.selectQueue('queue:one');await h.settle();h.env.click(buttonNamed(h.nodes.get('recent'),/^Full size$/));h.render();
  const pending=h.saves.at(-1);assert.equal(history.bridge.savePresentation({...pending,provider_dto:{private_media:'/private/song.flac'}},history.bridge.snapshot()),true);
  assert.equal(history.window.history.state.albumHavenNavigationPosition,9);const saved=plain(history.bridge.snapshot().presentation);
  assert.equal(saved.selectionPresentation.length,2,'the native serializer must not merge Queue into Recent');
  assert.doesNotMatch(JSON.stringify(saved),/provider_dto|private_media|queue:album|queue:artist|\/private\//);
  const readsBefore=queue.reads.length;h.dispose();assert.equal(queue.listeners.size,0);
  const replay=await homeFixture(t,saved,queue);replay.render();const tree=await replay.settle();assertOwnQueue(tree);
  assert.deepEqual(plain(replay.selection('queue')),['queue:one']);assert.equal(replay.page.querySelector('[data-queue-row="queue:one"]').getAttribute('aria-selected'),'true');
  assert.equal(replay.dashboard.getAttribute('data-dashboard-expanded-key'),'recent');
  assert.ok(queue.reads.length>readsBefore,'restoration must refresh the captured occurrence through the actual Queue authority');
  assert.equal(replay.queueSnapshot().album.ref,'queue:album');
  replay.env.click(buttonNamed(replay.pageHeader,/^Back$/));replay.render();replay.section('recent');
  assert.equal(replay.selection('recent')[0],'recent:one');assert.equal(replay.dashboard.getAttribute('data-dashboard-expanded-key'),'artist');
  assert.equal(history.window.history.state.albumHavenNavigationPosition,9);
});

test('removed or unreadable saved Queue occurrences do not return from history and unmount cannot steal focus', async t => {
  for(const entries of [[],[{id:'queue:one',sourceReadable:false}]]) {
    const queue=queuedSource();queue.replace({entries});
    const presentation={kind:'tracks',homeSection:'queue',selectionPresentation:[{query:{section:'recent',account_ref:null,kind:'tracks',period:'week',homeSection:'queue'},tracks:{rowIds:['queue:one'],snapshotRef:null},pane:'album',expanded:'album'}]};
    const h=await homeFixture(t,presentation,queue);h.render();const tree=await h.settle();assertOwnQueue(tree);
    assert.deepEqual(plain(h.selection('queue')),[]);assert.equal(h.page.querySelector('[data-queue-row][aria-selected="true"]'),null);
    assert.equal(h.page.querySelector('.home-detail__selection'),null);assert.equal(h.dashboard.getAttribute('data-dashboard-expanded-key'),null);
    assert.deepEqual(queue.reads,[]);const foreground=h.env.document.createElement('button');h.env.document.body.append(foreground);
    h.env.document.activeElement=foreground;h.dispose();assert.equal(h.env.document.activeElement,foreground);
    assert.equal(queue.listeners.size,0);assert.deepEqual(h.env.forbiddenCalls,[]);
  }
});

test('embedded native AlbumDetails puts its page action first while retaining the native lease and Close owner', () => {
  const h = createNativeHomeRuntime(), c = h.context, d = h.document;
  c.Node.prototype.before = function (node) {this.parentNode.insertBefore(node, this);};
  c.Node.prototype.replaceWith = function (node) {this.before(node); this.remove();};
  d.createComment = () => new c.Node(8);
  c.addEventListener = d.addEventListener.bind(d); c.removeEventListener = d.removeEventListener.bind(d);
  const overlay = d.createElement('div'); overlay.id = 'track-modal'; overlay.hidden = true;
  const dialog = d.createElement('div'); dialog.className = 'track-modal-dialog';
  dialog.innerHTML = c.buildAlbumDetailsHeaderHtml({artist: 'Native artist', album: 'Native Album',
    titleId: 'embedded-title', subtitleId: 'embedded-subtitle', actionsHtml: ['Play', 'More', 'Close'].map(label =>
      c.ButtonComponent.renderActionButton({ariaLabel: label, icon: label === 'Close' ? 'close' : 'more'})).join('')});
  overlay.append(dialog); const host = d.createElement('section'); d.body.append(overlay, host);
  c.state = {ui: {}, modalReleases: [], modalReleaseIndex: 0};
  c.renderTrackModalRelease = () => {};
  // Rendering the existing native header above is sufficient for the lease
  // decorator; clearing unrelated table markup is outside this header seam.
  c.getTrackModalElements = () => ({overlay});
  vm.runInContext(fs.readFileSync(path.resolve(homeSource, '../runtime/track-modal-lightbox-helpers.js'), 'utf8'), c);
  const actions = dialog.querySelector('.album-details-header__actions'), close = buttonNamed(actions, /^Close$/);
  let pageCalls = 0, closeCalls = 0; close.addEventListener('click', () => closeCalls++);
  const lease = c.acquireTrackModalSelection(host, {key: 'native:one', tracks: []}, {
    isCurrent: () => true, canPlay: () => true, canPage: () => true, onPage: () => pageCalls++, canOpen: () => false});
  assert.ok(lease); assert.equal(host.firstElementChild, dialog);
  assert.deepEqual(labels(actions), ['Full size', 'Play', 'More', 'Close']);
  h.click(buttonNamed(actions, /^Full size$/).querySelector('svg')); assert.equal(pageCalls, 1); assert.equal(closeCalls, 0);
  h.click(close); assert.equal(closeCalls, 1); assert.equal(pageCalls, 1);
  // A newer content owner prevents release from clearing its state, while the
  // actual lease still restores the retained dialog and header nodes.
  c.state.ui.pendingTrackModalLoadToken++;
  lease.release(); assert.equal(overlay.firstElementChild, dialog); assert.equal(buttonNamed(actions, /^Close$/), close);
  assert.deepEqual(h.forbiddenCalls, []);
});

function dashboardActionHidingSelectors(css) {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(([, , declarations]) => /\bdisplay:\s*none\s*(?:!important)?\s*;/.test(declarations))
    .flatMap(([, selectors]) => selectors.split(',').map(selector => selector.trim()))
    .filter(selector => selector.includes('[data-dashboard-action]'));
}
function narrowHomeSelectors() {
  const css = fs.readFileSync(path.resolve(__dirname, '../../music_app/static/css/runtime/home-friends.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const media = css.match(/@media\s*\(max-width:\s*900px\)\s*\{([\s\S]*?)\n\}/)?.[1];
  assert.ok(media, 'Home owns its existing narrow pane breakpoint');
  return dashboardActionHidingSelectors(media);
}

test('Home narrow suppression covers its Dashboard actions without hiding generic consumers', () => {
  const h = nativeWidgets({backHost: true}), expand = buttonNamed(h.widgets[0].header, /^Full size$/);
  assert.equal(expand.getAttribute('data-dashboard-action'), 'expand');
  h.owner.update({expandedKey: 'album'});
  const back = buttonNamed(h.pageHeader, /^Back$/), embedded = h.widgets[0].body.firstElementChild;
  assert.equal(back.getAttribute('data-dashboard-action'), 'back');
  assert.equal(h.root.contains(back), false, 'the generic consumer can also use an external header');
  const selectors = narrowHomeSelectors();
  assert.ok(selectors.length, 'the pane-owning Home surface suppresses its desktop actions at narrow widths');
  const shared = fs.readFileSync(path.resolve(__dirname, '../../music_app/static/css/runtime/dashboard.css'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  for (const control of [expand, back]) {
    assert.equal(selectors.some(selector => control.matches(selector)), false, 'Home-specific suppression excludes a generic Dashboard');
    assert.equal(dashboardActionHidingSelectors(shared).some(selector => control.matches(selector)), false,
      'generic Dashboard does not hide controls for consumers without an alternative pane navigator');
  }
  assert.equal(selectors.some(selector => embedded.matches(selector)), false);
  h.click(back); assert.deepEqual(h.intents, [['album', null]], 'generic return remains available to its controlled owner');
  assert.equal(buttonNamed(h.pageHeader, /^Back$/), back);
  h.owner.dispose();
  assert.equal(h.pageHeader.innerHTML, h.headerBefore); assert.equal(h.root.innerHTML, h.before);
});

test('desktop expansion remains saved across narrow pane navigation while external Dashboard Back shares suppression', async t => {
  const h=await homeFixture(t);h.section('queue');h.selectQueue('queue:one');await h.settle();
  h.env.click(buttonNamed(h.nodes.get('album'),/^Full size$/));h.render();assert.equal(h.dashboard.getAttribute('data-dashboard-expanded-key'),'album');
  let tree=h.resize(390);const externalBack=buttonNamed(h.pageHeader,/^Back$/),selectors=narrowHomeSelectors();
  assert.ok(selectors.some(selector=>externalBack.matches(selector)),'Home suppression includes its external page-header Back');
  const ordinaryExpand=buttonNamed(h.nodes.get('recent'),/^Full size$/);
  assert.ok(selectors.some(selector=>ordinaryExpand.matches(selector)),'Home retains suppression of ordinary widget expansion');
  assert.equal(tree.getAttribute('data-home-pane'),'recent');h.selectPane('artist');tree=h.render();assert.equal(tree.getAttribute('data-home-pane'),'artist');
  const back=buttonNamed(h.page.querySelector('.home-friends__pane-navigation'),/^Back to Queue$/);assert.equal(back.disabled,false);
  h.env.click(back);tree=h.render();assert.equal(tree.getAttribute('data-home-pane'),'recent');
  assert.equal(h.dashboard.getAttribute('data-dashboard-expanded-key'),'album','narrow pane return does not overwrite desktop expansion');
  tree=h.resize(1200);assertOwnQueue(tree);assert.equal(h.dashboard.getAttribute('data-dashboard-expanded-key'),'album');
  assert.equal(buttonNamed(h.pageHeader,/^Back$/),externalBack);assert.deepEqual(h.navigation,[]);assert.deepEqual(h.env.forbiddenCalls,[]);
  // CSS cascade and painted placement remain a separate browser gate.
});

test('controlled focus follows only outgoing Dashboard controls and disposal preserves embedded focus', () => {
  const h = nativeWidgets({backHost: true}), focusCalls = [];
  const prototype = h.context.HTMLElement.prototype, originalFocus = prototype.focus;
  prototype.focus = function (options) {focusCalls.push({node: this, options}); if (this.isConnected) h.document.activeElement = this;};
  try {
    const expand = buttonNamed(h.widgets[0].header, /^Full size$/);
    h.document.activeElement = expand;
    h.click(expand.querySelector('svg'));
    assert.equal(h.document.activeElement, expand); assert.equal(focusCalls.length, 0, 'an intent cannot move focus before its controlled update');
    h.owner.update({expandedKey: 'album'});
    const back = buttonNamed(h.pageHeader, /^Back$/);
    assert.equal(h.document.activeElement, back); assert.equal(focusCalls.length, 1);
    assert.deepEqual(plain(focusCalls[0].options), {preventScroll: true});
    h.owner.update({expandedKey: 'album'}); assert.equal(focusCalls.length, 1, 'an unchanged expansion does not refocus');
    h.click(back.querySelector('svg')); assert.equal(h.document.activeElement, back);
    h.owner.update({expandedKey: null});
    assert.equal(buttonNamed(h.widgets[0].header, /^Full size$/), expand);
    assert.equal(h.document.activeElement, expand); assert.equal(focusCalls.length, 2);
    assert.deepEqual(plain(focusCalls[1].options), {preventScroll: true});
    const embedded = h.widgets[0].body.firstElementChild;
    h.document.activeElement = embedded;
    h.owner.update({expandedKey: 'album'}); h.owner.update({expandedKey: 'artist'});
    assert.equal(h.document.activeElement, embedded); assert.equal(focusCalls.length, 2);
    const retiredBack = buttonNamed(h.pageHeader, /^Back$/), intents = plain(h.intents);
    h.owner.dispose(); h.owner.dispose(); h.click(retiredBack); h.click(expand); h.owner.update({expandedKey: 'album'});
    assert.deepEqual(plain(h.intents), intents); assert.equal(h.document.activeElement, embedded); assert.equal(focusCalls.length, 2);
    assert.equal(h.pageHeader.innerHTML, h.headerBefore); assert.equal(h.root.innerHTML, h.before);
    assert.deepEqual(h.forbiddenCalls, []);
  } finally {prototype.focus = originalFocus; h.owner.dispose();}
});
