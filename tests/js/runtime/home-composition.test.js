const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const React = require('react');
const {buildSync} = require('esbuild');

const source = path.resolve(__dirname, '../../../music_app/static/js/home-friends/app.jsx');
const bundle = buildSync({entryPoints: [source], bundle: true, platform: 'node', format: 'cjs',
  write: false, external: ['react', 'react-dom']}).outputFiles[0].text;
const elements = node => React.isValidElement(node)
  ? [node, ...React.Children.toArray(node.props.children).flatMap(elements)] : [];
const find = (tree, predicate) => elements(tree).find(predicate);
const kinds = tree => find(tree, node => node.props.id === 'home-recent-kinds');

// Exercise the real view's state and child contracts, without claiming DOM
// reconciliation, native dashboard geometry, or browser/player verification.
function viewFixture({width = 1200, presentation, section = 'recent', friend = null, activity} = {}) {
  const slots = [], saved = [], listeners = new Set(); let cursor = 0, effects = [];
  const window = {innerWidth: width, matchMedia: () => media};
  const media = {matches: width <= 900, addEventListener: (_event, handler) => listeners.add(handler),
    removeEventListener: (_event, handler) => listeners.delete(handler)};
  const hooks = {...React,
    useRef(value) {const index = cursor++; return slots[index] ||= {current: value};},
    useState(initial) {
      const index = cursor++;
      if (!slots[index]) slots[index] = {value: typeof initial === 'function' ? initial() : initial};
      return [slots[index].value, value => {slots[index].value = typeof value === 'function' ? value(slots[index].value) : value;}];
    },
    useEffect(effect, deps) {
      const index = cursor++, previous = slots[index];
      if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) {
        effects.push(() => {previous?.cleanup?.(); slots[index] = {deps, cleanup: effect()};});
      }
    },
    useMemo(factory, deps) {
      const index = cursor++, previous = slots[index];
      if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) slots[index] = {deps, value: factory()};
      return slots[index].value;
    },
    useLayoutEffect() {cursor++;},
  };
  const fixtureModule = {exports: {}};
  vm.runInNewContext(bundle, {module: fixtureModule, exports: fixtureModule.exports, window,
    require: name => name === 'react' ? hooks : require(name), clearTimeout, setTimeout, console});
  const state = {scopeKey: 'viewer/library', selectedFriendRef: friend?.account_ref || null,
    recent: {status: 'ready', data: {recent_local_albums: [], recent_not_local_albums: []}},
    friends: friend ? {status: 'ready', data: {friends: [friend]}} : {status: 'unavailable', data: null},
    activity: activity ? {status: 'ready', data: {rows: [], total_listens: 0, range_label: 'Supplied date range'}} : {status: 'unavailable', data: null},
    activityNavigation: {query: activity, status: 'idle'}, comparison: {status: 'unavailable', data: null}, mutation: {status: 'idle'}};
  const shell = {section, friendRef: friend?.account_ref || '', presentation};
  const runtime = {savePresentation: value => saved.push(value)};
  const controller = {selectFriend() {return true;}, loadActivity() {}, getSnapshot: () => state};
  return {
    saved,
    render() {
      cursor = 0; effects = [];
      const tree = fixtureModule.exports.HomeFriendsView({runtime, controller, state, shell});
      for (const effect of effects) effect();
      return tree;
    },
    resize(nextWidth) {window.innerWidth = nextWidth; media.matches = nextWidth <= 900; for (const handler of listeners) handler();},
    dispose() {for (const slot of slots) slot?.cleanup?.(); assert.equal(listeners.size, 0);},
  };
}

test('fresh Home defaults to Tracks at phone widths and Albums on desktop', () => {
  for (const [width, expected] of [[320, 'tracks'], [390, 'tracks'], [900, 'tracks'], [901, 'albums'], [1440, 'albums']]) {
    const fixture = viewFixture({width}), tree = fixture.render();
    assert.equal(kinds(tree).props.value, expected);
    assert.equal(fixture.saved.at(-1).kindExplicit, false);
    fixture.dispose();
  }
});

test('implicit defaults follow the viewport until a deliberate tab choice is saved', () => {
  const fixture = viewFixture(), first = fixture.render();
  assert.equal(kinds(first).props.value, 'albums');
  fixture.resize(390); const phone = fixture.render();
  assert.equal(kinds(phone).props.value, 'tracks');
  kinds(phone).props.onChange('artists'); fixture.render();
  assert.equal(fixture.saved.at(-1).kindExplicit, true);
  fixture.resize(1440); assert.equal(kinds(fixture.render()).props.value, 'artists');
  const restored = viewFixture({width: 320, presentation: fixture.saved.at(-1)});
  assert.equal(kinds(restored.render()).props.value, 'artists');
  restored.dispose(); fixture.dispose();
});

test('history preserves legacy explicit choices but re-evaluates saved automatic defaults', () => {
  for (const [presentation, width, expected, explicit] of [
    [{kind: 'albums'}, 320, 'albums', true],
    [{kind: 'tracks', kindExplicit: true}, 1440, 'tracks', true],
    [{kind: 'albums', kindExplicit: false}, 320, 'tracks', false],
    [{kind: 'tracks', kindExplicit: false}, 1440, 'albums', false],
    [{kind: 'unknown', kindExplicit: true}, 390, 'tracks', false],
  ]) {
    const fixture = viewFixture({presentation, width});
    assert.equal(kinds(fixture.render()).props.value, expected);
    assert.equal(fixture.saved.at(-1).kindExplicit, explicit);
    fixture.dispose();
  }
});

test('Home places native Recent and disabled News with Period above one content scroll owner', () => {
  const fixture = viewFixture({width: 320}), tree = fixture.render();
  const widget = find(tree, node => node.props['data-home-widget'] === 'recent');
  const children = React.Children.toArray(widget.props.children);
  const header = children.find(node => node.type === 'header');
  const body = children.find(node => node.props.className?.includes('home-friends__widget-body'));
  assert.ok(header); assert.ok(body);
  const sections = find(header, node => node.props.label === 'Home sections');
  assert.deepEqual(JSON.parse(JSON.stringify(sections.props.items)), [['recent', 'Recent'], ['news', 'News', {disabled: true}], ['queue', 'Queue']]);
  assert.equal(sections.props.value, 'recent');
  assert.ok(find(header, node => node.type?.name === 'Period'));
  assert.ok(find(header, node => node.props.id === 'home-recent-kinds'));
  assert.equal(find(body, node => node.type?.name === 'Tabs'), undefined);
  assert.equal(elements(tree).filter(node => node.props.label === 'Home sections').length, 1);
  fixture.dispose();
});

test('a changed responsive default clears only the unrelated Recent scroll position', () => {
  const fixture = viewFixture({width: 390, presentation: {kind: 'albums', kindExplicit: false,
    scroll: {recent: 440, friends: 120, page: 30}}});
  fixture.render();
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.saved.at(-1).scroll)), {recent: 0, friends: 120, page: 30});
  fixture.dispose();
});

test('Recent Albums ignores saved rows and no-info choices for every period', () => {
  for (const view of ['list', 'covers']) for (const period of ['week', 'month']) {
    const fixture = viewFixture({presentation: {kind: 'albums', period, views: {albums: view}},
      activity: {account_ref: null, kind: 'albums', period}});
    const tree = fixture.render(), recent = find(tree, node => node.props['data-home-widget'] === 'recent');
    assert.equal(find(recent, node => node.type?.name === 'ViewControl'), undefined);
    assert.equal(fixture.saved.at(-1).views.albums, 'cards');
    if (period === 'week') {
      assert.ok(find(recent, node => node.type?.name === 'RecentAlbums'));
    } else {
      const activity = find(recent, node => node.type?.name === 'ActivityPanel');
      assert.equal(activity.props.view, 'cards');
      assert.equal(activity.props.account_ref, null); assert.equal(activity.props.period, period);
    }
    fixture.dispose();
  }
});

test('Home and Friends activity receive the complete current account and period query', () => {
  const friend = {account_ref: 'friend:one', display_name: 'Friend', allowed_actions: {can_view_activity: true}};
  for (const own of [true, false]) {
    const account_ref = own ? null : friend.account_ref, period = own ? 'month' : 'six';
    const fixture = viewFixture({section: own ? 'recent' : 'friends', friend: own ? null : friend,
      presentation: {kind: 'tracks', period, friendKind: 'tracks', friendPeriod: period},
      activity: {account_ref, kind: 'tracks', period}});
    const tree = fixture.render(), activity = find(tree, node => node.type?.name === 'ActivityPanel');
    assert.equal(activity.props.scopeKey, 'viewer/library');
    assert.equal(activity.props.account_ref, account_ref); assert.equal(activity.props.period, period);
    fixture.dispose();
  }
});
