const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {pathToFileURL} = require('node:url');
const {createNativeHomeRuntime, requireOwner, buttonNamed} = require('./native-home-harness.cjs');
const {withDomPlatform} = require('./artist-host-fixtures/dom-platform.cjs');
const {fixture: fullFixture, settle} = require('./home-friends-native-app-fixture.cjs');
const repo = path.resolve(__dirname, '../../..');
const load = name => import(pathToFileURL(path.join(repo, 'music_app/static/js/home-friends', name)).href);
function nativeRuntime({choice = false} = {}) {
  const env = withDomPlatform(createNativeHomeRuntime({home: true}));
  // Choice's shared surface listeners are outside the RecentAlbums lifetime.
  for (const file of ['in-page-tabs.js', ...(choice ? ['trigger-anchor.js', 'library-settings.js'] : [])]) {
    vm.runInContext(fs.readFileSync(path.join(repo, 'music_app/static/js/runtime', file), 'utf8'), env.context);
  }
  const owner = requireOwner(env, 'HomeRecent'), mounts = [], intents = [];
  const runtime = {
    buttonHtml: config => env.context.ButtonComponent.renderButton(config),
    actionHtml: config => env.context.ButtonComponent.renderActionButton(config),
    openChoice: env.context.openUtilityChoiceDropdown,
    alertHtml: config => env.context.buildOnPageAlertHtml(config),
    tabsHtml: config => env.context.buildInPageTabsHtml(config),
    mountTabs: node => env.context.mountInPageTabs(node),
    mountRecent: (host, callbacks) => {const mounted = owner.mount(host, callbacks); mounts.push(mounted); return mounted;},
    albumIntent: (kind, ref) => {intents.push([kind, ref]); return Promise.resolve();},
  };
  return {...env, runtime, mounts, intents};
}

// Explicit native mount/update/dispose driver; no renderer, hooks or reconciliation.
async function lifecycle(env, name) {
  const controls = await load('native-controls.mjs');
  const host = env.document.createElement('section'); env.document.body.append(host);
  const mount = controls[`mount${name}`];
  let owner, runtime;
  return {host,
    render(props) {
      const {children, runtime: nextRuntime, ...rest} = props;
      const options = name === 'Button' ? {...rest, label: children} : rest;
      if (owner && runtime !== nextRuntime) throw new Error('Dispose the native owner before replacing its runtime.');
      runtime = nextRuntime;
      if (owner) owner.update(options); else owner = mount(host, runtime, options);
      return owner;
    },
    click(target) {env.click(target);},
    dispose() {owner?.dispose(); owner = null; runtime = null;},
  };
}
const album = (extra = {}) => ({row_kind: 'local_album', local_match_state: 'matched_local', album_ref: 'album:one',
  name: 'A recent album', album_artist: 'Artist', listen_event_count: 2, listened_track_count: 1,
  listened_duration_seconds: null, last_listened_at: null,
  allowed_actions: {can_open_album: true, can_play_album: true}, ...extra});
const recent = rows => ({status: 'ready', data: {recent_local_albums: rows, recent_not_local_albums: []}});
const propsFor = env => ({runtime: env.runtime, value: recent([album()]), selected: null,
  onSelect() {}, onError() {}, retry() {}});
test('button and icon wrappers retain native accessible markup and text escaping', async () => {
  const env = nativeRuntime(), fixture = await lifecycle(env, 'Button'), runtime = env.runtime;
  fixture.render({runtime, children: '<Save>', selected: true, disabled: true});
  const plain = fixture.host.innerHTML;
  assert.match(plain, /ui-button/); assert.match(plain, /&lt;Save&gt;/);
  assert.match(plain, /aria-pressed="true"/); assert.match(plain, /disabled/);
  fixture.render({runtime, icon: 'close', children: 'Close selection'});
  const icon = fixture.host.innerHTML;
  assert.match(icon, /aria-label="Close selection"/); assert.match(icon, /action-button--bare/);
  fixture.render({runtime, icon: 'add', children: 'Create', disabled: true,
    ariaLabel: 'Create playlist', title: 'Playlist creation is unavailable for this account.'});
  const unavailable = fixture.host.innerHTML;
  assert.match(unavailable, /aria-label="Create playlist"/);
  assert.match(unavailable, /title="Playlist creation is unavailable for this account\."/);
  assert.equal(fixture.host.querySelector('button').disabled, true);
  const invalid = env.document.createElement('em'); invalid.textContent = 'Invalid child';
  // Preserved negative contract: an element cannot be accepted as a text label.
  // Bound source must include the independently approved text-label contract.
  try {assert.throws(() => fixture.render({runtime, children: invalid}), /expects text/);}
  finally {fixture.dispose();}
});

test('button updates preserve the native element while reconciling label, disabled and selected state', async () => {
  const env = nativeRuntime(), fixture = await lifecycle(env, 'Button'); let calls = 0;
  const props = {runtime: env.runtime, children: 'Save', onClick: () => {calls++;}, selected: false};
  fixture.render(props);
  const button = fixture.host.querySelector('button');
  fixture.click(button.firstElementChild || button); assert.equal(calls, 1);
  fixture.render({...props, children: 'Saving', disabled: true, selected: true});
  assert.equal(fixture.host.querySelector('button'), button);
  assert.equal(button.disabled, true); assert.equal(button.getAttribute('aria-pressed'), 'true');
  assert.match(button.textContent, /Saving/);
  fixture.click(button); assert.equal(calls, 1);
  fixture.render({...props, selected: undefined});
  assert.equal(fixture.host.querySelector('button'), button);
  assert.equal(button.disabled, false); assert.equal(button.hasAttribute('aria-pressed'), false);
  fixture.click(button); assert.equal(calls, 2);
  fixture.dispose(); assert.deepEqual(env.forbiddenCalls, []);
});

test('Friends and Compare icons retain the shared toggle state across selected, unselected and ordinary modes', async () => {
  for (const [icon, label] of [['friends', 'Friends'], ['compare', 'Compare with you']]) {
    const env = nativeRuntime(), fixture = await lifecycle(env, 'Button');
    fixture.render({runtime: env.runtime, icon, children: label, selected: true});
    const button = fixture.host.querySelector('button');
    for (const selected of [true, false, undefined]) {
      fixture.render({runtime: env.runtime, icon, children: label, selected});
      assert.equal(fixture.host.querySelector('button'), button);
      assert.equal(button.classList.contains('action-button--toggle'), selected !== undefined);
      assert.equal(button.getAttribute('aria-pressed'), selected === undefined ? null : String(selected));
      assert.equal(button.getAttribute('aria-label'), label);
    }
    fixture.dispose(); assert.deepEqual(env.forbiddenCalls, []);
  }
});

test('statuses use native alert roles and retry is offered only for errors', async () => {
  const env = nativeRuntime(), fixture = await lifecycle(env, 'Status'), runtime = env.runtime;
  for (const status of ['loading', 'empty', 'denied', 'unavailable', 'error']) {
    fixture.render({runtime, value: {status, data: {private: 'must not render'}}, label: 'Friends', retry() {}});
    const html = fixture.host.outerHTML;
    assert.match(html, status === 'error' ? /role="alert"/ : /role="status"/);
    if (status === 'error') assert.match(html, /Retry/); else assert.doesNotMatch(html, /Retry/);
    if (status === 'loading') assert.match(html, /aria-busy="true"/);
    assert.doesNotMatch(html, /must not render/);
  }
  fixture.render({runtime, value: {status: 'ready'}, label: 'Friends'});
  assert.equal(fixture.host.hidden, true); assert.equal(fixture.host.textContent, '');
  assert.equal(fixture.host.querySelector('button'), null); fixture.dispose();
});

test('period control distinguishes unknown totals from zero and passes the selected period unchanged', async t => {
  const env = fullFixture(t), {runtime, document} = env, changes = [];
  const {mountPeriod} = await load('period.mjs'), {mountListensBadge} = await load('shared-header.mjs');
  const host = document.createElement('div'), badgeHost = document.createElement('span'); env.host.append(badgeHost, host);
  const props = {value: 'week', total: null, range: 'Server range <safe>', onChange: value => changes.push(value)};
  const badge = env.own(mountListensBadge(badgeHost, runtime, props));
  const owner = env.own(mountPeriod(host, runtime, props));
  assert.equal(badgeHost.getAttribute('aria-label'), 'Listens: –');
  assert.equal(badgeHost.title, 'Server range <safe>');
  assert.match(host.innerHTML, /Server range &lt;safe&gt;/);
  badge.update({...props, total: 0}); assert.equal(badgeHost.getAttribute('aria-label'), 'Listens: 0');
  const trigger = host.querySelector('button[aria-label="Period: Last week"]');
  // User-requested native presentation: icon-only trigger; text remains in menu.
  assert.equal(trigger.classList.contains('action-button--bare'), true);
  assert.equal(trigger.getAttribute('aria-haspopup'), 'menu');
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(host.querySelector('select'), null);
  env.click(trigger); env.drain();
  const choices = [...document.querySelectorAll('[role="menuitemradio"]')];
  assert.deepEqual(choices.map(node => node.getAttribute('data-foobar-format')), ['week', 'month', 'six', 'year', 'all']);
  assert.deepEqual(choices.map(node => node.textContent.trim()), ['Last week', 'Last month', 'Last 6 months', 'Last year', 'All time']);
  env.click(choices.find(node => node.getAttribute('data-foobar-format') === 'six')); env.drain();
  assert.deepEqual(changes, ['six']);
  owner.update({...props, value: 'six'});
  assert.ok(host.querySelector('button[aria-label="Period: Last 6 months"]'));
});

test('the shared header Choice modifier preserves the AppBar, open state and native interaction paint', async () => {
  const css = fs.readFileSync(path.join(repo, 'music_app/static/css/choice-component.css'), 'utf8');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, selector]) => selector.includes('ui-choice__trigger--header'));
  assert.equal(rules.length, 2);
  for (const [, selector, declarations] of rules) {
    assert.match(selector, /:not\(\.trigger-anchor-open\)/);
    assert.match(selector, /:not\(\.app-bar \*\)/);
    assert.doesNotMatch(declarations, /outline|box-shadow|!important/);
  }
  const background = rules.find(([, , declarations]) => declarations.includes('background'));
  assert.match(background[1], /:not\(:hover\):not\(:active\)/);
  assert.match(background[2], /background:\s*transparent/);
});

test('tab wrapper delegates selection to the native owner and reports only a changed key', async () => {
  const env = nativeRuntime(), fixture = await lifecycle(env, 'Tabs'), changes = [];
  const props = {runtime: env.runtime, id: 'home-test', label: 'Views', items: [['albums', 'Albums'], ['tracks', 'Tracks']],
    value: 'albums', onChange: value => changes.push(value)};
  fixture.render(props);
  const albums = fixture.host.querySelector('[data-in-page-tab="albums"]');
  fixture.click(albums); assert.deepEqual(changes, []);
  const tracks = fixture.host.querySelector('[data-in-page-tab="tracks"]');
  fixture.click(tracks);
  assert.deepEqual(changes, ['tracks']);
  assert.equal(tracks.getAttribute('aria-selected'), 'true');
  fixture.render({...props, value: 'tracks'});
  assert.equal(fixture.host.querySelector('[data-in-page-tab="tracks"]').getAttribute('aria-selected'), 'true');
  assert.equal(fixture.host.querySelectorAll('[role="tablist"]').length, 1);
  fixture.dispose(); assert.deepEqual(env.forbiddenCalls, []);
});

test('disabled native tabs remain inaccessible and cannot become selected by click', async () => {
  const env = nativeRuntime(), fixture = await lifecycle(env, 'Tabs'), changes = [];
  fixture.render({runtime: env.runtime, id: 'home-sections', label: 'Home sections',
    items: [['recent', 'Recent'], ['news', 'News', {disabled: true}]], value: 'recent', onChange: value => changes.push(value)});
  const recentTab = fixture.host.querySelector('[data-in-page-tab="recent"]');
  const newsTab = fixture.host.querySelector('[data-in-page-tab="news"]');
  assert.equal(newsTab.disabled, true);
  assert.equal(newsTab.getAttribute('aria-disabled'), 'true');
  assert.equal(newsTab.getAttribute('tabindex'), '-1');
  fixture.click(newsTab);
  assert.equal(recentTab.getAttribute('aria-selected'), 'true');
  assert.equal(newsTab.getAttribute('aria-selected'), 'false');
  assert.deepEqual(changes, []);
  fixture.dispose(); assert.deepEqual(env.forbiddenCalls, []);
});

test('RecentAlbums retains informative cards and native selection when old presentation choices are supplied', async () => {
  const env = nativeRuntime(), fixture = await lifecycle(env, 'RecentAlbums'), props = propsFor(env);
  fixture.render(props);
  const owner = env.mounts[0], card = fixture.host.querySelector('.album-card');
  assert.equal(env.mounts.length, 1); assert.equal(owner.element, fixture.host);
  fixture.render({...props, selected: 'album:one', displayMode: 'covers'});
  assert.equal(env.mounts.length, 1); assert.equal(env.mounts[0], owner);
  assert.equal(fixture.host.contains(owner.header), true); assert.equal(fixture.host.contains(owner.body), true);
  assert.equal(fixture.host.querySelector('.album-card'), card);
  assert.equal(fixture.host.querySelector('[data-gallery-card-intent="select"]').getAttribute('aria-pressed'), 'true');
  assert.equal(fixture.host.querySelector('[data-home-display]').dataset.homeDisplay, 'cards');
  assert.equal(card.getAttribute('data-gallery-display'), 'cards');
  assert.match(card.textContent, /A recent album/);
  fixture.dispose(); assert.equal(fixture.host.childNodes.length, 0);
  assert.equal(env.listeners().length, 0); assert.deepEqual(env.forbiddenCalls, []);
});

test('native recent selection, open and play invoke current callbacks with opaque refs only', async () => {
  const env = nativeRuntime(), fixture = await lifecycle(env, 'RecentAlbums'), selections = [], props = propsFor(env);
  fixture.render({...props, onSelect: ref => selections.push(['old', ref])});
  env.click(fixture.host.querySelector('[data-gallery-card-intent="select"]'));
  fixture.render({...props, onSelect: ref => selections.push(['new', ref])});
  env.click(fixture.host.querySelector('[data-gallery-card-intent="select"]'));
  env.click(fixture.host.querySelector('[data-gallery-card-intent="open"]'));
  env.click(fixture.host.querySelector('[data-gallery-card-intent="play"]'));
  await Promise.resolve();
  assert.deepEqual(selections, [['old', 'album:one'], ['new', 'album:one']]);
  assert.deepEqual(env.intents, [['open', 'album:one'], ['play', 'album:one']]);
  fixture.dispose(); assert.deepEqual(env.forbiddenCalls, []);
});

test('RecentAlbums exposes detail-only native selection only while the custom-reader mode is current', async () => {
  const env = nativeRuntime(), fixture = await lifecycle(env, 'RecentAlbums'), selections = [];
  const props = {...propsFor(env), value: recent([album({allowed_actions: {can_view_details: true, can_open_album: false, can_play_album: true}})]),
    onSelect: ref => selections.push(ref)};
  fixture.render(props);
  assert.equal(fixture.host.querySelector('[data-gallery-card-intent="select"]'), null);
  const card = fixture.host.querySelector('.album-card');
  fixture.render({...props, selectionMode: 'details'});
  assert.equal(fixture.host.querySelector('.album-card'), card, 'the existing native card is retained');
  const select = fixture.host.querySelector('[data-gallery-card-intent="select"]'); assert.ok(select);
  assert.equal(fixture.host.querySelector('[data-gallery-card-intent="open"]'), null);
  assert.equal(fixture.host.querySelector('[data-gallery-card-intent="play"]'), null);
  env.click(select); assert.deepEqual(selections, ['album:one']); assert.deepEqual(env.intents, []);
  fixture.render({...props, selectionMode: 'native'});
  assert.equal(fixture.host.querySelector('[data-gallery-card-intent="select"]'), null);
  card.append(select); env.click(select);
  assert.deepEqual(selections, ['album:one'], 'retired custom-reader controls cannot select in native mode');
  fixture.dispose(); assert.deepEqual(env.forbiddenCalls, []);
});

test('empty and blocked recent projections purge cards; native retry uses the latest callback', async () => {
  const env = nativeRuntime(), fixture = await lifecycle(env, 'RecentAlbums'), props = propsFor(env), retries = [];
  fixture.render(props);
  fixture.render({...props, value: {status: 'empty', data: null}});
  assert.match(fixture.host.textContent, /No recent listens/);
  assert.equal(fixture.host.querySelectorAll('.album-card').length, 0);
  for (const status of ['loading', 'denied', 'unavailable', 'error']) {
    fixture.render({...props, value: {...props.value, status}, retry: () => retries.push(status)});
    assert.equal(fixture.host.querySelectorAll('.album-card').length, 0);
    assert.doesNotMatch(fixture.host.textContent, /A recent album/);
  }
  env.click(buttonNamed(fixture.host, /^Retry$/)); assert.deepEqual(retries, ['error']);
  fixture.dispose(); assert.deepEqual(env.forbiddenCalls, []);
});

test('native album intent failures report useful errors while cancellation and post-disposal errors remain silent', async () => {
  const env = nativeRuntime(), fixture = await lifecycle(env, 'RecentAlbums'), errors = [], props = propsFor(env);
  const rejected = [];
  // The VM adopts the host promise before invoking its rejection callback.
  // Let that entire microtask chain settle, including intentionally silent paths.
  const settleIntents = () => new Promise(resolve => setImmediate(resolve));
  env.runtime.albumIntent = () => new Promise((resolve, reject) => rejected.push(reject));
  fixture.render({...props, onError: message => errors.push(message)});
  env.click(fixture.host.querySelector('[data-gallery-card-intent="open"]'));
  rejected.shift()(new Error('Private transport detail')); await settleIntents();
  assert.deepEqual(errors, ['This album could not be opened. Please try again.']);
  env.click(fixture.host.querySelector('[data-gallery-card-intent="play"]'));
  rejected.shift()(Object.assign(new Error('Cancelled'), {name: 'AbortError'})); await settleIntents();
  assert.equal(errors.length, 1);
  env.click(fixture.host.querySelector('[data-gallery-card-intent="play"]'));
  fixture.dispose(); rejected.shift()(new Error('Late transport detail')); await settleIntents();
  assert.equal(errors.length, 1); assert.equal(env.listeners().length, 0);
});

test('switching the runtime disposes the old recent owner before mounting its replacement', async () => {
  const env = nativeRuntime(), fixture = await lifecycle(env, 'RecentAlbums'), props = propsFor(env);
  fixture.render(props); const oldBody = env.mounts[0].body;
  fixture.dispose(); // Native runtime identity is a mount-time ownership boundary.
  assert.equal(fixture.host.contains(oldBody), false, 'old body retires before replacement acquisition');
  assert.equal(oldBody.listeners.length, 0, 'old listeners retire before replacement acquisition');
  fixture.render({...props, runtime: {...env.runtime}});
  assert.equal(env.mounts.length, 2);
  assert.equal(fixture.host.contains(oldBody), false);
  assert.equal(oldBody.listeners.length, 0);
  assert.equal(fixture.host.contains(env.mounts[1].body), true);
  assert.equal(fixture.host.querySelectorAll('.album-card').length, 1, 'replacement receives the existing projection immediately');
  fixture.dispose(); assert.equal(env.listeners().length, 0);
});

test('selected recent album never grants a custom detail reader access from native open permission', async t => {
  const {createHomeFriendsController} = await load('model.mjs');
  const {mountHomeFriendsView} = await load('app.mjs');
  let reads = 0; const requests = [];
  const readDetail = async args => {reads++; requests.push(args); return {status: 'empty', data: null};};
  for (const [allowed_actions, expected] of [[{can_open_album: true}, 'denied'],
    [{can_open_album: true, can_view_details: 'true'}, 'denied'],
    [Object.assign(Object.create({can_view_details: true}), {can_open_album: true}), 'denied'],
    [{can_view_details: true}, 'empty']]) {
    const env = fullFixture(t), {runtime} = env;
    vm.runInContext(fs.readFileSync(path.join(repo, 'music_app/static/js/runtime/home-recent.js'), 'utf8'), env.context);
    const nativeRecent = requireOwner(env, 'HomeRecent'), updates = [];
    runtime.mountRecent = (host, callbacks) => {
      const owner = nativeRecent.mount(host, callbacks), update = owner.update.bind(owner);
      // Observation delegates every call unchanged to the actual canonical owner.
      owner.update = value => {updates.push(value); return update(value);};
      return owner;
    };
    Object.assign(runtime, {albumDetailSelection() {assert.fail('custom reader must use its own explicit grant');},
      savePresentation() {}, albumIntent() {assert.fail('detail selection must not dispatch a native album intent');}});
    const controller = createHomeFriendsController({readRecent: async () => recent([album({allowed_actions})]).data});
    controller.setScope('account/library'); await controller.loadRecent();
    const state = controller.getSnapshot();
    const shell = {section: 'recent', presentation: {selectedAlbum: 'album:one', kind: 'albums', kindExplicit: true}};
    const owner = env.own(mountHomeFriendsView(env.host, {runtime, state, shell, controller, readDetail}));
    await settle(); env.drain(); await settle();
    assert.equal(updates.at(-1).selectionMode, 'details');
    const detail = env.host.querySelector('[data-home-widget="album"] .home-detail');
    assert.ok(detail, 'the selected album supplies a mounted detail boundary');
    // Canonical model normalization may copy grants; no true grant may be fabricated.
    assert.equal(state.recent.data.recent_local_albums[0].allowed_actions.can_view_details,
      Object.hasOwn(allowed_actions, 'can_view_details') && allowed_actions.can_view_details === true);
    assert.match(detail.textContent, expected === 'denied' ? /don't have access to these album details/ : /No album details were returned/);
    assert.equal(reads, expected === 'empty' ? 1 : 0);
    owner.dispose(); controller.dispose();
  }
  assert.equal(reads, 1);
  assert.equal(requests[0].scopeKey, 'account/library');
  assert.equal(requests[0].kind, 'album');
  assert.equal(requests[0].ref, 'album:one');
  assert.deepEqual(requests[0].origin, {source: 'recent', account_ref: null, kind: 'albums', period: 'week'});
});
