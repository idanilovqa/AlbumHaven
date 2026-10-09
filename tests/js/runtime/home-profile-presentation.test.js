const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const React = require('react');
const {pathToFileURL} = require('node:url');
const {buildSync} = require('esbuild');

const source = path.resolve(__dirname, '../../../music_app/static/js/home-friends');
const model = import(pathToFileURL(path.join(source, 'model.mjs')).href);
const bundle = buildSync({entryPoints: [path.join(source, 'app.jsx')], bundle: true, platform: 'node',
  format: 'cjs', write: false, external: ['react', 'react-dom']}).outputFiles[0].text;
const elements = node => React.isValidElement(node) ? [node, ...React.Children.toArray(node.props.children).flatMap(elements)] : [];
const components = (tree, name) => elements(tree).filter(element => element.type?.name === name);

function renderer() {
  const slots = []; let cursor = 0;
  const hooks = {...React,
    useRef(initial) {const index = cursor++; return slots[index] ||= {current: initial};},
    useState(initial) {
      const index = cursor++; slots[index] ||= {value: typeof initial === 'function' ? initial() : initial};
      return [slots[index].value, next => {slots[index].value = typeof next === 'function' ? next(slots[index].value) : next;}];
    },
    useMemo(factory) {cursor++; return factory();},
    useEffect() {}, useLayoutEffect() {},
  };
  const fixture = {exports: {}};
  vm.runInNewContext(bundle, {module: fixture, exports: fixture.exports, console,
    require: name => name === 'react' ? hooks : require(name)});
  return props => {cursor = 0; return fixture.exports.HomeFriendsView(props);};
}
const friends = () => ({friends: [{account_ref: 'friend:one', display_name: 'Friend One', relationship: 'accepted',
  allowed_actions: {can_view_profile: true, can_view_activity: true, can_compare: true}}],
  requests: [{request_ref: 'request:one', account_ref: 'member:one', display_name: 'Member One', direction: 'incoming',
    allowed_actions: {can_view_profile: true, can_accept: true, can_decline: true}}],
  profile: {display_name: 'Current owner', allowed_actions: {can_edit: true}}, allowed_actions: {can_discover_members: true}});

async function fixture(t, {profileResult, profileRef = null} = {}) {
  const {createHomeFriendsController} = await model;
  const controller = createHomeFriendsController({providers: {readFriends: friends,
    readProfile: ({account_ref}) => profileResult ?? {account_ref, display_name: 'Current member profile', relationship: 'none',
      allowed_actions: {can_view_profile: true}}}});
  controller.setScope('actor/library'); await controller.loadFriends();
  if (profileRef) {assert.equal(controller.selectProfile(profileRef), true); await controller.loadProfile();}
  t.after(() => controller.dispose());
  const navigations = [], saved = [];
  const runtime = {savePresentation: value => saved.push(value), navigate: value => navigations.push(value),
    alertHtml: ({message}) => `<p>${message}</p>`};
  const shell = {scopeKey: 'actor/library', section: 'friends', friendRef: null, profileRef, entryKey: 'entry:one',
    presentation: {kind: 'tracks', kindExplicit: true, views: {tracks: 'grouped', artists: 'list'}}};
  const render = renderer();
  return {controller, runtime, shell, navigations, saved,
    render: () => render({runtime, controller, state: controller.getSnapshot(), shell})};
}

test('profile route uses independent member presentation without starting a listening/comparison surface', async t => {
  const h = await fixture(t, {profileRef: 'member:one'}), tree = h.render();
  const member = components(tree, 'MemberProfile');
  assert.equal(member.length, 1); assert.equal(member[0].props.accountRef, 'member:one');
  assert.equal(member[0].props.showIdentity, false, 'the shared page header owns profile identity');
  assert.equal(components(tree, 'ActivityPanel').length, 0);
  assert.equal(components(tree, 'ComparisonPanel').length, 0);
  assert.equal(components(tree, 'FriendsDirectory').length, 0);
  const identity = components(tree, 'ProfileIdentity')[0];
  assert.equal(identity.props.profile.display_name, 'Current member profile');
  assert.equal(identity.props.own, false);
});

test('denied profile response cannot expose the own profile or stale member facts in the shared header', async t => {
  const h = await fixture(t, {profileRef: 'member:one', profileResult: {status: 'denied',
    data: {account_ref: 'member:one', display_name: 'Private stale value'}}});
  const identity = components(h.render(), 'ProfileIdentity')[0];
  assert.equal(identity.props.profile, null); assert.equal(identity.props.own, false);
  assert.equal(identity.props.fallbackName, 'Profile');
});

test('directory profile action rechecks current grant and scope before writing the native route', async t => {
  const h = await fixture(t), directory = components(h.render(), 'FriendsDirectory')[0];
  directory.props.onProfile('member:one');
  assert.deepEqual(JSON.parse(JSON.stringify(h.navigations)), [{section: 'friends', friend: '', profile: 'member:one'}]);
  h.controller.setScope('replacement/library');
  directory.props.onProfile('member:one');
  assert.equal(h.navigations.length, 1, 'an old directory callback cannot navigate another account');
});

test('request entry mounts the current native request dialog and rejects a retired request', async t => {
  const h = await fixture(t), directory = components(h.render(), 'FriendsDirectory')[0];
  directory.props.onRequest('request:one', null);
  const dialog = components(h.render(), 'FriendRequestDialog')[0];
  assert.ok(dialog); assert.equal(dialog.props.requestRef, 'request:one');
  dialog.props.onClose();
  h.controller.setScope('replacement/library');
  directory.props.onRequest('request:one', null);
  assert.equal(components(h.render(), 'FriendRequestDialog').length, 0);
});

test('profile listening callbacks independently reject stale relationship grants', async t => {
  const h = await fixture(t, {profileRef: 'friend:one'}), member = components(h.render(), 'MemberProfile')[0];
  h.controller.setScope('replacement/library');
  member.props.onActivity('friend:one'); member.props.onCompare('friend:one');
  assert.equal(h.navigations.length, 0);
});
