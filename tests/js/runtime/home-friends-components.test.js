const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const {pathToFileURL} = require('node:url');
const React = require('react');
const {renderToStaticMarkup} = require('react-dom/server');
const {buildSync} = require('esbuild');
const {createNativeHomeRuntime, requireOwner, buttonNamed} = require('./native-home-harness.cjs');

const repo = path.resolve(__dirname, '../../..');
const built = buildSync({entryPoints: [path.join(repo, 'music_app/static/js/home-friends/components.jsx')],
  bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react']}).outputFiles[0].text;
const loaded = new Module(`${__filename}.fixture.cjs`, module);
loaded.filename = `${__filename}.fixture.cjs`; loaded.paths = module.paths;
loaded._compile(built, loaded.filename);
const {Button, Status, Period} = loaded.exports;

function nativeRuntime({choice = false} = {}) {
  const env = createNativeHomeRuntime({home: true});
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

// This bounded hook driver exercises wrapper setup/update/cleanup with the real
// native owners. It does not emulate React reconciliation, focus, a browser, or
// an application transport. Native owner listeners execute in the shared DOM fixture.
function lifecycle(env, name) {
  const slots = []; let cursor = 0, pending = [], mounted = false, tree;
  const hooks = {...React,
    useRef(initial) {const index = cursor++; return slots[index] ||= {current: initial};},
    useLayoutEffect(effect, deps) {
      const index = cursor++, old = slots[index];
      if (!old || deps.some((value, i) => !Object.is(value, old.deps[i]))) {
        pending.push(() => {old?.cleanup?.(); slots[index] = {deps, cleanup: effect()};});
      }
    },
  };
  const fixtureModule = {exports: {}};
  vm.runInNewContext(built, {module: fixtureModule, exports: fixtureModule.exports,
    require: name => name === 'react' ? hooks : require(name), document: env.document, console});
  const host = env.document.createElement('section'); env.document.body.append(host);
  return {
    host,
    render(props) {
      cursor = 0; pending = [];
      tree = fixtureModule.exports[name](props);
      slots[0].current = host;
      if (!mounted && tree.props.dangerouslySetInnerHTML) host.innerHTML = tree.props.dangerouslySetInnerHTML.__html;
      mounted = true;
      for (const effect of pending) effect();
      return tree;
    },
    click(target) {tree.props.onClick(env.event('click', target));},
    dispose() {for (const slot of slots) slot?.cleanup?.(); mounted = false;},
  };
}
const album = (extra = {}) => ({row_kind: 'local_album', local_match_state: 'matched_local', album_ref: 'album:one',
  name: 'A recent album', album_artist: 'Artist', listen_event_count: 2, listened_track_count: 1,
  listened_duration_seconds: null, last_listened_at: null,
  allowed_actions: {can_open_album: true, can_play_album: true}, ...extra});
const recent = rows => ({status: 'ready', data: {recent_local_albums: rows, recent_not_local_albums: []}});
const propsFor = env => ({runtime: env.runtime, value: recent([album()]), selected: null,
  onSelect() {}, onError() {}, retry() {}});
const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, props));

test('button and icon wrappers retain native accessible markup and text escaping', () => {
  const {runtime, document} = nativeRuntime();
  const plain = render(Button, {runtime, children: '<Save>', selected: true, disabled: true});
  assert.match(plain, /ui-button/); assert.match(plain, /&lt;Save&gt;/);
  assert.match(plain, /aria-pressed="true"/); assert.match(plain, /disabled/);
  const icon = render(Button, {runtime, icon: 'close', children: 'Close selection'});
  assert.match(icon, /aria-label="Close selection"/); assert.match(icon, /action-button--bare/);
  const unavailable = render(Button, {runtime, icon: 'add', children: 'Create', disabled: true,
    ariaLabel: 'Create playlist', title: 'Playlist creation is unavailable for this account.'});
  assert.match(unavailable, /aria-label="Create playlist"/);
  assert.match(unavailable, /title="Playlist creation is unavailable for this account\."/);
  const host = document.createElement('div'); host.innerHTML = unavailable;
  assert.equal(host.querySelector('button').disabled, true);
  assert.throws(() => render(Button, {runtime, children: React.createElement('em', null, 'Invalid child')}), /expects text children/);
});

test('button updates preserve the native element while reconciling label, disabled and selected state', () => {
  const env = nativeRuntime(), fixture = lifecycle(env, 'Button'); let calls = 0;
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

test('Friends and Compare icons retain the shared toggle state across selected, unselected and ordinary modes', () => {
  for (const [icon, label] of [['friends', 'Friends'], ['compare', 'Compare with you']]) {
    const env = nativeRuntime(), fixture = lifecycle(env, 'Button');
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

test('statuses use native alert roles and retry is offered only for errors', () => {
  const {runtime} = nativeRuntime();
  for (const status of ['loading', 'empty', 'denied', 'unavailable', 'error']) {
    const html = render(Status, {runtime, value: {status, data: {private: 'must not render'}}, label: 'Friends', retry() {}});
    assert.match(html, status === 'error' ? /role="alert"/ : /role="status"/);
    if (status === 'error') assert.match(html, /Retry/); else assert.doesNotMatch(html, /Retry/);
    if (status === 'loading') assert.match(html, /aria-busy="true"/);
    assert.doesNotMatch(html, /must not render/);
  }
  assert.equal(render(Status, {runtime, value: {status: 'ready'}, label: 'Friends'}), '');
});

test('period control distinguishes unknown totals from zero and passes the selected period unchanged', () => {
  const {runtime, document} = nativeRuntime({choice: true}), changes = [];
  const props = {runtime, value: 'week', total: null, range: 'Server range <safe>', onChange: value => changes.push(value)};
  const html = render(Period, props);
  assert.match(html, /Listens: –/); assert.match(html, /Server range &lt;safe&gt;/);
  assert.match(render(Period, {...props, total: 0}), /Listens: 0/);
  const host = document.createElement('div'); host.innerHTML = html;
  const trigger = host.querySelector('button[aria-label="Period: Last week"]');
  assert.equal(trigger.classList.contains('ui-choice__trigger--header'), true);
  assert.equal(trigger.getAttribute('aria-haspopup'), 'menu');
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(host.querySelector('select'), null);
  const children = React.Children.toArray(Period(props).props.children);
  const choice = children.find(child => child.type?.name === 'NativeChoice');
  assert.deepEqual(choice.props.options.map(([value]) => value), ['week', 'month', 'six', 'year', 'all']);
  assert.deepEqual(choice.props.options.map(([, label]) => label), ['Last week', 'Last month', 'Last 6 months', 'Last year', 'All time']);
  choice.props.onChange('six');
  assert.deepEqual(changes, ['six']);
  host.innerHTML = render(Period, {...props, value: 'six'});
  assert.ok(host.querySelector('button[aria-label="Period: Last 6 months"]'));
});

test('the shared header Choice modifier preserves the AppBar, open state and native interaction paint', () => {
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

test('tab wrapper delegates selection to the native owner and reports only a changed key', () => {
  const env = nativeRuntime(), fixture = lifecycle(env, 'Tabs'), changes = [];
  const props = {runtime: env.runtime, id: 'home-test', label: 'Views', items: [['albums', 'Albums'], ['tracks', 'Tracks']],
    value: 'albums', onChange: value => changes.push(value)};
  fixture.render(props);
  const albums = fixture.host.querySelector('[data-in-page-tab="albums"]');
  env.click(albums); fixture.click(albums); assert.deepEqual(changes, []);
  const tracks = fixture.host.querySelector('[data-in-page-tab="tracks"]');
  env.click(tracks); fixture.click(tracks);
  assert.deepEqual(changes, ['tracks']);
  assert.equal(tracks.getAttribute('aria-selected'), 'true');
  fixture.render({...props, value: 'tracks'});
  assert.equal(fixture.host.querySelector('[data-in-page-tab="tracks"]').getAttribute('aria-selected'), 'true');
  assert.equal(fixture.host.querySelectorAll('[role="tablist"]').length, 1);
  fixture.dispose(); assert.deepEqual(env.forbiddenCalls, []);
});

test('disabled native tabs remain inaccessible and cannot become selected by click', () => {
  const env = nativeRuntime(), fixture = lifecycle(env, 'Tabs'), changes = [];
  fixture.render({runtime: env.runtime, id: 'home-sections', label: 'Home sections',
    items: [['recent', 'Recent'], ['news', 'News', {disabled: true}]], value: 'recent', onChange: value => changes.push(value)});
  const recentTab = fixture.host.querySelector('[data-in-page-tab="recent"]');
  const newsTab = fixture.host.querySelector('[data-in-page-tab="news"]');
  assert.equal(newsTab.disabled, true);
  assert.equal(newsTab.getAttribute('aria-disabled'), 'true');
  assert.equal(newsTab.getAttribute('tabindex'), '-1');
  env.click(newsTab); fixture.click(newsTab);
  assert.equal(recentTab.getAttribute('aria-selected'), 'true');
  assert.equal(newsTab.getAttribute('aria-selected'), 'false');
  assert.deepEqual(changes, []);
  fixture.dispose(); assert.deepEqual(env.forbiddenCalls, []);
});

test('RecentAlbums retains informative cards and native selection when old presentation choices are supplied', () => {
  const env = nativeRuntime(), fixture = lifecycle(env, 'RecentAlbums'), props = propsFor(env);
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
  const env = nativeRuntime(), fixture = lifecycle(env, 'RecentAlbums'), selections = [], props = propsFor(env);
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

test('RecentAlbums exposes detail-only native selection only while the custom-reader mode is current', () => {
  const env = nativeRuntime(), fixture = lifecycle(env, 'RecentAlbums'), selections = [];
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

test('empty and blocked recent projections purge cards; native retry uses the latest callback', () => {
  const env = nativeRuntime(), fixture = lifecycle(env, 'RecentAlbums'), props = propsFor(env), retries = [];
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
  const env = nativeRuntime(), fixture = lifecycle(env, 'RecentAlbums'), errors = [], props = propsFor(env);
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

test('switching the runtime disposes the old recent owner before mounting its replacement', () => {
  const env = nativeRuntime(), fixture = lifecycle(env, 'RecentAlbums'), props = propsFor(env);
  fixture.render(props); const oldBody = env.mounts[0].body;
  fixture.render({...props, runtime: {...env.runtime}});
  assert.equal(env.mounts.length, 2);
  assert.equal(fixture.host.contains(oldBody), false);
  assert.equal(oldBody.listeners.length, 0);
  assert.equal(fixture.host.contains(env.mounts[1].body), true);
  assert.equal(fixture.host.querySelectorAll('.album-card').length, 1, 'replacement receives the existing projection immediately');
  fixture.dispose(); assert.equal(env.listeners().length, 0);
});

test('selected recent album never grants a custom detail reader access from native open permission', async () => {
  const appBundle = buildSync({entryPoints: [path.join(repo, 'music_app/static/js/home-friends/app.jsx')],
    bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react', 'react-dom']}).outputFiles[0].text;
  // Inspect the real view's child props, without mounting its unrelated shell.
  const hooks = {...React, useRef: value => ({current: value}), useState: value => [typeof value === 'function' ? value() : value, () => {}],
    useEffect() {}, useLayoutEffect() {}, useMemo: factory => factory()};
  const appModule = {exports: {}};
  vm.runInNewContext(appBundle, {module: appModule, exports: appModule.exports,
    require: name => name === 'react' ? hooks : require(name), console});
  const {createDetailProjectionController} = await import(pathToFileURL(path.join(repo, 'music_app/static/js/home-friends/detail-projection.mjs')));
  const elements = node => React.isValidElement(node) ? [node, ...React.Children.toArray(node.props.children).flatMap(elements)] : [];
  let reads = 0; const requests = [];
  const readDetail = async args => {reads++; requests.push(args); return {status: 'empty', data: null};};
  for (const [allowed_actions, expected] of [[{can_open_album: true}, 'denied'],
    [{can_open_album: true, can_view_details: 'true'}, 'denied'],
    [Object.assign(Object.create({can_view_details: true}), {can_open_album: true}), 'denied'],
    [{can_view_details: true}, 'empty']]) {
    const state = {scopeKey: 'account/library', recent: recent([album({allowed_actions})]),
      friends: {status: 'unavailable', data: null}, activity: {status: 'unavailable', data: null},
      comparison: {status: 'unavailable', data: null}, mutation: {status: 'idle'}, selectedFriendRef: null};
    const shell = {section: 'recent', presentation: {selectedAlbum: 'album:one'}};
    const view = appModule.exports.HomeFriendsView({runtime: {albumDetailSelection() {assert.fail('custom reader must use its own explicit grant');}},
      state, shell, controller: {}, readDetail});
    assert.equal(elements(view).find(element => element.type?.name === 'RecentAlbums').props.selectionMode, 'details');
    const detail = elements(view).find(element => element.props.readDetail === readDetail && element.props.selection);
    assert.ok(detail, 'the selected album supplies a detail boundary');
    assert.equal(detail.props.selection.allowed_actions, allowed_actions, 'the view must not fabricate a detail grant');
    const controller = createDetailProjectionController({readDetail});
    controller.setScope(state.scopeKey); controller.select(detail.props.selection);
    assert.equal((await controller.load()).status, expected);
    controller.dispose();
  }
  assert.equal(reads, 1);
  assert.equal(requests[0].scopeKey, 'account/library');
  assert.equal(requests[0].kind, 'album');
  assert.equal(requests[0].ref, 'album:one');
  assert.deepEqual(requests[0].origin, {source: 'recent', account_ref: null, kind: 'albums', period: 'week'});
});
