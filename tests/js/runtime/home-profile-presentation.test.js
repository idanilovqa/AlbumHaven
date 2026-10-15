const test = require('node:test');
const assert = require('node:assert/strict');
const {environment, load, settle, visibleHtml} = require('./home-profile-native-observations.cjs');
const friends = () => ({friends: [{account_ref: 'friend:one', display_name: 'Friend One', relationship: 'accepted',
  allowed_actions: {can_view_profile: true, can_view_activity: true, can_compare: true}}],
  requests: [{request_ref: 'request:one', account_ref: 'member:one', display_name: 'Member One', direction: 'incoming',
    allowed_actions: {can_view_profile: true, can_accept: true, can_decline: true}}],
  profile: {display_name: 'Current owner', allowed_actions: {can_edit: true}}, allowed_actions: {can_discover_members: true}});

async function fixture(t, {profileResult, profileRef = null} = {}) {
  const h = environment(t), {createHomeFriendsController} = await load('model.mjs'), {mountHomeFriendsView} = await load('app.mjs');
  const privateReads = [];
  const controller = createHomeFriendsController({providers: {readFriends: friends,
    readActivity: () => {privateReads.push('activity'); return {status: 'unavailable'};},
    readComparison: () => {privateReads.push('comparison'); return {status: 'unavailable'};},
    readProfile: ({account_ref}) => profileResult ?? {account_ref, display_name: 'Current member profile', relationship: 'none',
      allowed_actions: {can_view_profile: true}}}});
  controller.setScope('actor/library'); await controller.loadFriends();
  if (profileRef) {assert.equal(controller.selectProfile(profileRef), true); await controller.loadProfile();}
  const navigations = [], saved = [];
  const runtime = {...h.runtime, savePresentation: value => saved.push(value), navigate: value => navigations.push(value)};
  const shell = {scopeKey: 'actor/library', section: 'friends', friendRef: null, profileRef, entryKey: 'entry:one',
    presentation: {kind: 'tracks', kindExplicit: true, views: {tracks: 'grouped', artists: 'list'}}};
  let owner;
  const props = () => ({runtime, controller, state: controller.getSnapshot(), shell});
  const unsubscribe = controller.subscribe(() => owner?.update(props()));
  owner = h.own(mountHomeFriendsView(h.host, props())); owner.update(props()); await settle(); h.drain();
  t.after(() => {owner.dispose(); unsubscribe(); controller.dispose();});
  return {...h, controller, runtime, shell, navigations, saved, privateReads, owner};
}

test('profile route uses independent member presentation without starting a listening/comparison surface', async t => {
  const h = await fixture(t, {profileRef: 'member:one'});
  const members = h.host.querySelectorAll('.home-member-profile'); assert.equal(members.length, 1);
  assert.equal(h.controller.getSnapshot().selectedProfileRef, 'member:one');
  assert.doesNotMatch(visibleHtml(members[0]), /home-profile__identity/, 'the shared page header owns profile identity');
  assert.equal(h.host.querySelectorAll('.home-friends__directory').length, 0);
  assert.equal(h.host.querySelectorAll('.home-activity').length, 0);
  assert.equal(h.host.querySelectorAll('.home-comparison').length, 0);
  assert.deepEqual(h.privateReads, []);
  const header = h.host.querySelector('[data-slot="page-header"]');
  assert.equal(header.querySelector('h1').textContent, 'Current member profile');
  assert.equal(h.named('Edit profile', header), undefined);
});

test('denied profile response cannot expose the own profile or stale member facts in the shared header', async t => {
  const h = await fixture(t, {profileRef: 'member:one', profileResult: {status: 'denied',
    data: {account_ref: 'member:one', display_name: 'Private stale value'}}});
  const header = h.host.querySelector('[data-slot="page-header"]');
  assert.doesNotMatch(header.innerHTML, /Current owner|Private stale value/);
  assert.equal(h.named('Edit profile', header), undefined);
  assert.equal(header.querySelector('h1').textContent, 'Profile');
});

test('directory profile action rechecks current grant and scope before writing the native route', async t => {
  const h = await fixture(t);
  // Incoming requests enter their native detail form before profile navigation.
  const row = h.host.querySelector('[data-home-person-row="request:request:one"]'); assert.ok(row);
  h.click(row); h.drain(); h.click(h.named('View profile'));
  assert.deepEqual(JSON.parse(JSON.stringify(h.navigations)), [{section: 'friends', friend: '', profile: 'member:one'}]);
  h.controller.setScope('replacement/library');
  h.click(row); h.drain();
  assert.equal(h.navigations.length, 1, 'an old directory control cannot navigate another account');
});

test('request entry mounts the current native request dialog and rejects a retired request', async t => {
  const h = await fixture(t), row = h.host.querySelector('[data-home-person-row="request:request:one"]');
  h.click(row); h.drain();
  assert.equal(h.form.hidden, false); assert.ok(h.form.querySelector('.home-friend-request'));
  assert.match(visibleHtml(h.form), /Member One/);
  h.click(h.named('Close', h.form));
  h.controller.setScope('replacement/library'); h.click(row); h.drain();
  assert.equal(h.form.hidden, true); assert.equal(h.form.querySelector('.home-friend-request'), null);
});

test('profile listening callbacks independently reject stale relationship grants', async t => {
  const h = await fixture(t, {profileRef: 'friend:one'});
  const activity = h.named('Listening activity'), compare = h.named('Compare with you'); assert.ok(activity); assert.ok(compare);
  h.controller.setScope('replacement/library'); h.click(activity); h.click(compare);
  assert.equal(h.navigations.length, 0);
});
