const test = require('node:test');
const assert = require('node:assert/strict');
let finish;
test.before(async () => {({completeDeletedPlaylistNavigation: finish} = await import('../../../music_app/static/js/playlists/shell.mjs'));});
test('acknowledged Delete and recovered Delete use native directory navigation after form return', async () => {
  for (const recovery of ['immediate', 'lost-before-response', 'lost-before-server']) {
    const mutation = {action: 'deletePlaylist', status: 'ready', playlist_id: 'deleted'};
    const state = {scopeKey: 'scope', selectedPlaylistId: null, mutation};
    const controller = {getSnapshot: () => state}, calls = []; let returnFromForm;
    const runtime = {snapshot: () => ({scopeKey: 'scope', visible: true, playlistId: 'deleted'}),
      deferFormNavigation: callback => {returnFromForm = callback; return Promise.resolve(true);},
      navigate: async value => {calls.push(value); return true;}};
    await finish(controller, runtime, mutation); assert.equal(calls.length, 0, recovery);
    await returnFromForm(); assert.deepEqual(calls, [{playlist_id: null}], recovery);
  }
});
test('Delete recovery cannot navigate a new actor or newer selected resource', async () => {
  for (const replace of [state => {state.scopeKey = 'new';}, state => {state.selectedPlaylistId = 'other';}, state => {state.mutation = {status: 'idle'};}]) {
    const mutation = {action: 'deletePlaylist', status: 'ready', playlist_id: 'deleted'}, state = {scopeKey: 'scope', selectedPlaylistId: null, mutation};
    let returned, calls = 0;
    const runtime = {snapshot: () => ({scopeKey: 'scope', visible: true, playlistId: 'deleted'}),
      deferFormNavigation: callback => {returned = callback; return Promise.resolve(true);}, navigate: () => {calls++;}};
    await finish({getSnapshot: () => state}, runtime, mutation); replace(state); await returned(); assert.equal(calls, 0);
  }
});
