const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const React = require('react');
const {buildSync} = require('esbuild');
const source = path.resolve(__dirname, '../../../music_app/static/js/home-friends/app.jsx');
const slotsToVisit = ['children', 'identity', 'leading', 'actions', 'outsideActions', 'finalAction'];
const elements = node => React.isValidElement(node) ? [node, ...slotsToVisit.flatMap(key => React.Children.toArray(node.props[key]).flatMap(elements))] : [];
const named = (tree, name) => elements(tree).filter(node => node.type?.name === name);
const slotChildren = value => React.Children.toArray(value).flatMap(node => node.type === React.Fragment ? slotChildren(node.props.children) : [node]);
// Real view state and prop contracts only. No effects, browser reconciliation,
// transport, focus or geometry are claimed by this bounded composition driver.
function fixture({section = 'recent', presentation = {}, friend = null, status = 'ready', total = 73} = {}) {
  const slots = []; let cursor = 0;
  const hooks = {...React,
    useRef(initial) {return slots[cursor++] ||= {current: initial};},
    useState(initial) {const index = cursor++, slot = slots[index] ||= {value: typeof initial === 'function' ? initial() : initial};
      return [slot.value, next => {slot.value = typeof next === 'function' ? next(slot.value) : next;}];},
    useMemo(factory) {cursor++; return factory();}, useEffect() {cursor++;}, useLayoutEffect() {cursor++;},
  };
  const bundle = buildSync({entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', write: false,
    external: ['react', 'react-dom']}).outputFiles[0].text;
  const loaded = {exports: {}};
  vm.runInNewContext(bundle, {module: loaded, exports: loaded.exports, require: name => name === 'react' ? hooks : require(name),
    window: {innerWidth: 1200, matchMedia: () => ({matches: false})}, console});
  const own = {display_name: 'Owner', handle: 'owner', allowed_actions: {can_edit: true}};
  const query = {account_ref: friend?.account_ref || null, kind: presentation.kind || 'tracks', period: section === 'friends' ? presentation.friendPeriod || 'week' : presentation.period || 'week'};
  const state = {scopeKey: 'actor/library', selectedFriendRef: friend?.account_ref || null,
    friends: {status: 'ready', data: {profile: own, friends: friend ? [friend] : [], requests: []}},
    recent: {status, data: {total_listens: total, recent_local_albums: [], recent_not_local_albums: []}},
    activity: {status, data: {rows: [], total_listens: total, range_label: 'Chosen period range'}},
    activityNavigation: {query, status: 'idle'}, comparison: {status: 'unavailable', data: null}, mutation: {status: 'idle'}};
  const shell = {section, friendRef: friend?.account_ref || '', presentation: {kind: 'tracks', kindExplicit: true, ...presentation}};
  const navigations = [], runtime = {navigate: next => navigations.push(next)};
  const controller = {getSnapshot: () => state};
  return {state, shell, navigations, render() {cursor = 0; return loaded.exports.HomeFriendsView({runtime, controller, state, shell});}};
}

test('React Home headers do not enlist a second imperative dashboard insertion owner', () => {
  const text = fs.readFileSync(source, 'utf8');
  assert.doesNotMatch(text, /runtime\.mountDashboard\s*\(/, 'Home must not mount Dashboard over React-owned header actions');
  const h = fixture(), tree = h.render();
  const dashboards = elements(tree).filter(node => node.props['data-dashboard'] !== undefined);
  assert.equal(dashboards.length, 1, 'one React-owned dashboard container');
  assert.equal(dashboards[0].props['data-dashboard-layout'], 'single');
  assert.ok(named(tree, 'SharedHeader').length >= 3, 'page and both native widget headers use shared ownership');
});

test('own header exposes one authorized period count beside the identity', () => {
  const h = fixture(), tree = h.render(), badges = named(tree, 'ListensBadge');
  assert.equal(badges.length, 1); assert.equal(badges[0].props.total, 73);
  const owner = named(tree, 'SharedHeader').find(node => named(node.props.identity, 'ProfileIdentity').length);
  assert.ok(owner, 'SharedHeader identity owns profile');
  assert.equal(named(owner.props.identity, 'ListensBadge').length, 1, 'count sits with the person, not catalog controls');
  const periods = named(tree, 'Period'); assert.ok(periods.length); assert.equal(periods[0].props.value, 'week');
  periods[0].props.onChange('month');
  assert.equal(named(h.render(), 'Period')[0].props.value, 'month');
});

test('friend header count belongs to selected friend and disappears when activity permission is revoked', () => {
  const friend = {account_ref: 'friend:one', display_name: 'Friend', relationship: 'accepted', allowed_actions: {can_view_activity: true, can_compare: true}};
  const h = fixture({section: 'friends', friend, total: 19, presentation: {friendKind: 'tracks', friendPeriod: 'month'}});
  let tree = h.render();
  assert.equal(named(tree, 'ProfileIdentity')[0].props.profile.account_ref, 'friend:one');
  assert.equal(named(tree, 'ListensBadge').length, 1); assert.equal(named(tree, 'ListensBadge')[0].props.total, 19);
  friend.allowed_actions.can_view_activity = false;
  tree = h.render();
  assert.equal(named(tree, 'ListensBadge').some(node => node.props.total === 19), false, 'old private count cannot survive permission loss');
});

test('denied recent payload never discloses a stale supplied count', () => {
  const h = fixture({status: 'denied', total: 99999});
  assert.equal(named(h.render(), 'ListensBadge').some(node => node.props.total === 99999), false);
});

test('Missing remains native and last ordinary action; View is the only outside action in Home', () => {
  const h = fixture(), headers = named(h.render(), 'SharedHeader');
  const recent = headers.find(node => named(React.createElement(React.Fragment, null, node.props.actions), 'ActivityMissingAction').length);
  assert.ok(recent, 'Recent header keeps canonical Missing action');
  const actions = slotChildren(recent.props.actions);
  assert.equal(actions.at(-1).type?.name, 'ActivityMissingAction');
  const outside = slotChildren(recent.props.outsideActions);
  assert.equal(outside.length, 1); assert.equal(outside[0].type?.name, 'ViewControl');
});

const dashboardNode = tree => elements(tree).find(node => node.props['data-dashboard'] !== undefined);
const widgetNode = (tree, key) => elements(tree).find(node => node.props['data-home-widget'] === key);
const headerNode = (tree, id) => named(tree, 'SharedHeader').find(node => node.props.id === id);
function selectedTrackFixture() {
  const h = fixture(), origin = {source: 'activity', account_ref: null, kind: 'tracks', period: 'week'};
  const target = kind => ({kind, ref: `${kind}:one`, identity_ref: `${kind}:one`, origin, allowed_actions: {can_view_details: true}});
  h.state.activity.data.rows = [{id: 'track:one', kind: 'track', title: 'Track', source_readable: true,
    allowed_actions: {can_view_details: true}, album_target: target('album'), artist_target: target('artist')}];
  let tree = h.render(); named(tree, 'ActivityPanel')[0].props.onTracksSelect(['track:one']); tree = h.render();
  assert.ok(widgetNode(tree, 'artist')); assert.ok(widgetNode(tree, 'album'));
  return {h, tree};
}

test('native React Full size and Back callbacks control a single dashboard without imperative insertions', () => {
  const {h} = selectedTrackFixture();
  for (const key of ['recent', 'artist', 'album']) {
    let tree = h.render(); assert.equal(dashboardNode(tree).props['data-dashboard-layout'], 'ordinary');
    const expand = named(headerNode(tree, `home-${key}`).props.leading, 'Button')[0];
    assert.equal(expand.props.attributes['data-dashboard-action'], 'expand');
    expand.props.onClick(); tree = h.render();
    assert.equal(dashboardNode(tree).props['data-dashboard-layout'], 'expanded');
    assert.equal(dashboardNode(tree).props['data-dashboard-expanded-key'], key);
    for (const widget of ['recent', 'artist', 'album']) assert.equal(widgetNode(tree, widget).props['data-dashboard-widget-state'], widget === key ? 'expanded' : 'suppressed');
    const back = named(headerNode(tree, 'home-page').props.leading, 'Button')[0];
    assert.equal(back.props.attributes['data-dashboard-action'], 'back');
    assert.equal(named(tree, 'Button').filter(node => node.props.attributes?.['data-dashboard-action'] === 'back').length, 1);
    back.props.onClick(); tree = h.render();
    assert.equal(dashboardNode(tree).props['data-dashboard-layout'], 'ordinary');
    assert.equal(dashboardNode(tree).props['data-dashboard-expanded-key'], undefined);
  }
});

test('Queue navigation retains shared Home header while retiring Recent detail and gallery controls', () => {
  const {h, tree} = selectedTrackFixture();
  const sections = elements(tree).find(node => node.props.id === 'home-recent-sections');
  assert.ok(sections.props.items.some(([key]) => key === 'queue'));
  sections.props.onChange('queue');
  let next = h.render();
  assert.ok(headerNode(next, 'home-page')); assert.ok(headerNode(next, 'home-recent'));
  assert.equal(named(next, 'QueuePanel').length, 1); assert.equal(named(next, 'ActivityPanel').length, 0);
  assert.equal(named(next, 'Period').length, 0); assert.equal(named(next, 'ViewControl').length, 0);
  assert.equal(widgetNode(next, 'artist'), undefined); assert.equal(widgetNode(next, 'album'), undefined);
  assert.equal(dashboardNode(next).props['data-dashboard-layout'], 'single');
  h.shell.section = 'friends'; next = h.render();
  assert.equal(named(next, 'QueuePanel').length, 0, 'another person/directory route never mounts the own Queue');
  assert.equal(widgetNode(next, 'recent').props.hidden, true);
});

test('retired Full size callbacks cannot expand stale detail after source or route changes', () => {
  const {h, tree} = selectedTrackFixture();
  const retiredExpand = named(headerNode(tree, 'home-artist').props.leading, 'Button')[0].props.onClick;
  h.state.activity = {status: 'denied', data: null};
  let next = h.render(); assert.equal(widgetNode(next, 'artist'), undefined);
  retiredExpand(); next = h.render();
  assert.equal(dashboardNode(next).props['data-dashboard-layout'], 'single');
  assert.equal(dashboardNode(next).props['data-dashboard-expanded-key'], undefined);
  assert.equal(named(next, 'Button').some(node => node.props.attributes?.['data-dashboard-action'] === 'back'), false);
});
