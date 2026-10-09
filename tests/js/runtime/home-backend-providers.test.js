const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const modulePath = pathToFileURL(path.resolve(__dirname, '../../../music_app/static/js/home-friends/backend-providers.mjs')).href;
async function setup(reply) {
  const {createHomeBackendProviders} = await import(modulePath), calls = [];
  let context = 'a'.repeat(64), retired;
  const transport = {context: () => context, subscribe: fn => {retired = fn;},
    query: (route, values) => `${route}?${new URLSearchParams(Object.entries(values).filter(([,v]) => v != null))}`,
    request: async (route, options) => {calls.push({route, options}); return reply(route, options);}};
  return {providers: createHomeBackendProviders(transport), calls, change() {context = 'b'.repeat(64); retired();}};
}
const member = (state, direction = null) => ({account_ref: 'friend-id', display_name: 'Friend', username_display: 'friend',
  relationship: {state, direction, revision: 4, allowed_actions: {can_view_profile: true, can_request: state === 'none',
    can_accept: direction === 'incoming', can_read_history: state === 'accepted', can_compare_taste: state === 'accepted'}}});
test('Friends combines actual paginated modes and preserves only explicit grants', async () => {
  const env = await setup(async route => {
    const mode = new URL(route, 'https://example.invalid').searchParams.get('mode');
    return {members: mode === 'accepted' ? [member('accepted')] : [], next_cursor: null,
      current_user: {display_name: 'Owner', username_display: 'owner'}, allowed_actions: {can_discover_members: true}};
  });
  const result = await env.providers.readFriends({scopeKey: 'scope'});
  assert.equal(result.data.friends[0].allowed_actions.can_view_activity, true);
  assert.equal(result.data.profile.allowed_actions.can_edit, false);
  assert.equal(result.data.allowed_actions.can_request, false);
  assert.equal(JSON.stringify(result).includes('revision'), false);
  assert.equal(env.calls.length, 3);
});
test('request transitions use retained backend revision and exact target', async () => {
  const env = await setup(async route => route.startsWith('/friends?') ? {
    members: route.includes('mode=incoming') ? [member('pending', 'incoming')] : [], next_cursor: null
  } : {revision: 5, state: 'accepted'});
  await env.providers.readFriends({scopeKey: 'scope'});
  assert.deepEqual(await env.providers.acceptRequest({scopeKey: 'scope', request_ref: 'friend-id'}), {ok: true});
  assert.equal(env.calls.at(-1).route, '/friends/friend-id/accept');
  assert.deepEqual(env.calls.at(-1).options.body, {expected_revision: 4});
  await assert.rejects(env.providers.acceptRequest({scopeKey: 'scope', request_ref: 'friend-id'}));
});
test('Home numbered continuation supplies pinned snapshot without client subject authority', async () => {
  const env = await setup(async () => ({status: 'ready', data: {snapshot_ref: 'history-1', rows: []}}));
  await env.providers.readActivity({scopeKey: 'scope', kind: 'tracks', period: 'all'});
  await env.providers.readActivity({scopeKey: 'scope', kind: 'tracks', period: 'all', pagination: {page: 2, page_size: 100}});
  assert.equal(env.calls[0].route, '/home/activity?kind=tracks&period=all');
  assert.equal(env.calls[1].route, '/home/activity?kind=tracks&period=all&snapshot_ref=history-1&page=2&page_size=100');
});
test('Friend history verifies top-level subject and does not accept a data-only alias', async () => {
  const env = await setup(async () => ({status: 'ready', data: {snapshot_ref: 's', account_ref: 'friend-id', rows: []}}));
  await assert.rejects(env.providers.readActivity({scopeKey: 'scope', account_ref: 'friend-id', kind: 'tracks', period: 'week'}));
});
test('expired history retires snapshot instead of silently refreshing', async () => {
  let count = 0;
  const env = await setup(async () => {if (++count > 1) throw Object.assign(new Error('Expired'), {status: 410});
    return {status: 'ready', data: {snapshot_ref: 's', rows: []}};});
  const options = {scopeKey: 'scope', kind: 'tracks', period: 'week'};
  await env.providers.readActivity(options);
  await assert.rejects(env.providers.readActivity({...options, cursor: 'next'}));
  await assert.rejects(env.providers.readActivity({...options, cursor: 'next'}));
  assert.equal(env.calls.length, 2);
});
test('same-account session context rotation erases retained history handles', async () => {
  const env = await setup(async () => ({status: 'ready', data: {snapshot_ref: 's', rows: []}}));
  const options = {scopeKey: 'scope', kind: 'tracks', period: 'week'};
  await env.providers.readActivity(options); env.change();
  await assert.rejects(env.providers.readActivity({...options, cursor: 'next'})); assert.equal(env.calls.length, 1);
});
test('comparison stays one explicit page per UI request', async () => {
  const env = await setup(async () => ({status: 'ready', account_ref: 'friend-id', data: {snapshot_ref: 's', rows: [], next_cursor: 'next'}}));
  const options = {scopeKey: 'scope', account_ref: 'friend-id', kind: 'tracks', period: 'week'};
  const first = await env.providers.readComparison(options); assert.equal(first.data.next_cursor, 'next'); assert.equal(env.calls.length, 1);
  await env.providers.readComparison({...options, cursor: 'next'});
  assert.equal(env.calls[1].route, '/friends/friend-id/comparison?kind=tracks&period=week&snapshot_ref=s&cursor=next');
});

test('native activity target sends exact receipt origin and accepts unordered equivalent JSON keys', async () => {
  const env = await setup(async (_route, options) => ({status: 'ready', data: {row_ref: options.body.row_ref,
    intent: options.body.intent, origin: Object.fromEntries(Object.entries(options.body.origin).reverse()),
    native_target: {path: '/private/song', track_ref: '/private/song'}}}));
  const value = await env.providers.resolveActivityNativeTarget({scopeKey: 'scope', account_ref: null, kind: 'tracks',
    period: 'week', snapshot_ref: 'snapshot', rowId: 'activity_one', intent: 'play'});
  assert.equal(value.path, '/private/song'); assert.equal(env.calls[0].route, '/home/activity/native-target');
  assert.deepEqual(env.calls[0].options.body.origin, {audience: 'own', subject_ref: null, kind: 'tracks', period: 'week', snapshot_ref: 'snapshot'});
  assert.equal(env.calls[0].options.expected, 'a'.repeat(64));
});
