'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {pathToFileURL} = require('node:url');
const path = require('node:path');
const moduleUrl = pathToFileURL(path.resolve(__dirname, '../../../music_app/static/js/album-tops/backend-providers.mjs')).href;
const TOP = '00000000-0000-4000-8000-000000000001', KEY = '00000000-0000-4000-8000-000000000002';
const options = {scopeKey: 'actor:session:library'};
const command = {top_ref: TOP, request_key: KEY, active: false, activity_revision: '0'};
const row = activity => ({top_ref: TOP, revision: '7', title: 'Top', description: '', visibility: 'private',
  allowed_actions: {'library.browse.read': true, can_set_activity: true, can_manage_own_progress: activity.active},
  top_viewer_overlay: {activity, item_progress: {}}, items: []});
async function setup(reply) {
  const {createAlbumTopBackendProviders} = await import(moduleUrl);
  const calls = [], context = {actor: 'owner'};
  const providers = createAlbumTopBackendProviders({acceptsScope: value => value === options.scopeKey,
    transport: {context: () => context, request: async (url, args) => {calls.push({url, args});
      return {status: 'ready', context_ref: context, data: typeof reply === 'function' ? reply(url, args) : reply};}}});
  return {providers, calls};
}
test('provider retains private activity on detail and list without introducing playback permission', async () => {
  const activity = {active: false, activity_revision: '9223372036854775807'};
  const {providers} = await setup(url => url.startsWith('/album-tops?') ? {tops: [row(activity)], next_cursor: null, allowed_actions: {}} : row(activity));
  try {
    assert.deepEqual((await providers.read(TOP, options)).top_viewer_overlay, {activity, item_progress: {}});
    const listed = (await providers.list(options)).tops[0]; assert.deepEqual(listed.top_viewer_overlay, {activity});
    assert.equal(listed.allowed_actions.can_set_activity, true); assert.equal(listed.allowed_actions.can_manage_own_progress, false);
    assert.equal(Object.hasOwn(listed.allowed_actions, 'can_play'), false);
  } finally {providers.dispose();}
});
for (const activity of [{active: 0, activity_revision: '0'}, {active: false, activity_revision: '01'},
  {active: false, activity_revision: '-1'}, {active: false, activity_revision: '9223372036854775808'},
  {active: false}, null]) test(`provider rejects malformed activity ${JSON.stringify(activity)}`, async () => {
  const {providers} = await setup({...row({active: false, activity_revision: '0'}), top_viewer_overlay: {activity, item_progress: {}}});
  try {await assert.rejects(providers.read(TOP, options), /Invalid Album Top activity/);} finally {providers.dispose();}
});
test('provider sends exactly private activity fields and validates its historical receipt', async () => {
  const response = {...command, action: 'set_activity', activity_revision: '1', changed: true};
  const {providers, calls} = await setup(response);
  try {
    assert.deepEqual(await providers.execute('set_activity', command, options), response);
    assert.equal(calls[0].url, `/album-tops/${TOP}/set_activity`);
    assert.deepEqual(calls[0].args.body, {request_key: KEY, active: false, activity_revision: '0'});
    assert.equal(calls[0].args.method, 'POST');
  } finally {providers.dispose();}
});
for (const patch of [{active: 'false'}, {activity_revision: '01'}, {activity_revision: '9223372036854775808'},
  {revision: '7'}, {account_id: 1}, {active: undefined}]) test(`activity command rejects invalid fields ${JSON.stringify(patch)} before transport`, async () => {
  const {providers, calls} = await setup({});
  try {await assert.rejects(providers.execute('set_activity', {...command, ...patch}, options), /Invalid Album Top activity command/); assert.equal(calls.length, 0);}
  finally {providers.dispose();}
});
for (const patch of [{top_ref: KEY}, {request_key: TOP}, {active: true}, {activity_revision: '2'},
  {activity_revision: '9223372036854775808'}, {changed: 'true'}, {revision: '7'}]) test(`activity receipt rejects mismatched acknowledgment ${JSON.stringify(patch)}`, async () => {
  const {providers} = await setup({...command, action: 'set_activity', activity_revision: '1', changed: true, ...patch});
  try {await assert.rejects(providers.execute('set_activity', command, options), error => error.status === 502);} finally {providers.dispose();}
});
test('activity no-op receipt retains revision zero', async () => {
  const response = {...command, action: 'set_activity', changed: false}; const {providers} = await setup(response);
  try {assert.deepEqual(await providers.execute('set_activity', command, options), response);} finally {providers.dispose();}
});
