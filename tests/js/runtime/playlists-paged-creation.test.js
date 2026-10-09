const test = require('node:test');
const assert = require('node:assert/strict');
let model;
test.before(async () => {model = await import('../../../music_app/static/js/playlists/creation.mjs');});
const grants = {can_read: true, can_use_for_playlist: true};
const source = {kind: 'library', ref: 'source:one', revision: 'rev:one', source_protocol: 'library_selection_v1', allowed_actions: grants};
const context = {scopeKey: 'scope:one', mode: 'ordinary', canCreate: true, source};
const row = (identity, receipt = identity, title = identity) => ({selection_ref: identity, entry_ref: receipt, title,
  allowed_actions: {can_read: true, can_select: true}, availability: 'unresolved', canonical_track_ref: null,
  parent_album: {state: 'unknown'}});
const page = (rows, patch = {}) => ({status: 'ready', data: {scopeKey: context.scopeKey, mode: 'ordinary', source,
  source_protocol: 'library_selection_v1', entries_complete: false, entries: rows, allowed_actions: grants,
  query: '', search_revision: 'search:one', limit: 100, has_more: false, next_cursor: null, ...patch}});
const waitForPage = controller => controller.getSnapshot().pageStatus !== 'loading' ? Promise.resolve() : new Promise(resolve => {
  const unsubscribe = controller.subscribe(() => {if (controller.getSnapshot().pageStatus !== 'loading') {unsubscribe(); resolve();}});
});
const setup = async read => {
  const writes = [], controller = model.createPlaylistCreationController({providers: {readPlaylistCreationSource: read,
    createPlaylistFromSelection: async request => {writes.push(request); return {status: 'ready', data: {
      scopeKey: request.scopeKey, playlist_id: 'created:one', revision: '1', request_key: request.request_key}};}}});
  controller.setContext(context); assert.equal(await controller.load(), true); controller.edit({title: 'Paged source'});
  return {controller, writes};
};

test('paged library remains incomplete and retains server ordering rather than client sorting', async () => {
  const {controller} = await setup(async () => page([row('z'), row('a')]));
  const state = controller.getSnapshot();
  assert.equal(state.sourceResource.data.entries_complete, false);
  assert.deepEqual(model.projectCreationState(state).entries.map(value => value.title), ['z', 'a']);
  assert.equal(model.canSubmitCreation(state), true);
  assert.equal(controller.seed(['z'], state.sourceResource), false);
  const completeLie = page([], {entries_complete: true});
  assert.equal(model.normalizeCreationResult(completeLie, context).status, 'error');
  controller.dispose();
});

test('server query changes preserve old immutable selections; deselect/reselect captures newer receipt', async () => {
  const reads = [];
  const {controller, writes} = await setup(async request => {
    reads.push(request);
    return request.q ? page([row('a', 'new:a', 'New title'), row('b')], {query: 'New title', search_revision: 'search:two'})
      : page([row('a', 'old:a', 'Original title')]);
  });
  controller.toggle('selection:a');
  controller.setQuery(' New   title '); await waitForPage(controller);
  assert.equal(reads[1].q, ' New   title ');
  assert.equal(model.projectCreationState(controller.getSnapshot()).selectedEntries[0].entry_ref, 'old:a');
  controller.toggle('selection:a'); controller.toggle('selection:a');
  assert.equal(model.projectCreationState(controller.getSnapshot()).selectedEntries[0].entry_ref, 'new:a');
  controller.setQuery(''); await waitForPage(controller);
  assert.equal(model.projectCreationState(controller.getSnapshot()).selectedEntries[0].entry_ref, 'new:a');
  assert.ok(await controller.submit());
  assert.equal(writes[0].source_protocol, 'library_selection_v1');
  assert.deepEqual(writes[0].entry_refs, ['new:a']);
  controller.dispose();
});

test('empty intermediate pages can continue and deduplicate selection identities without replacing pins', async () => {
  const cursors = [];
  const {controller} = await setup(async request => {
    cursors.push(request.cursor);
    if (!request.cursor) return page([row('a', 'old:a')], {has_more: true, next_cursor: 'cursor:one'});
    if (request.cursor === 'cursor:one') return page([], {has_more: true, next_cursor: 'cursor:two'});
    return page([row('a', 'new:a'), row('b')]);
  });
  controller.toggle('selection:a');
  assert.equal(await controller.loadMore(), true); assert.equal(await controller.loadMore(), true);
  assert.deepEqual(cursors, [undefined, 'cursor:one', 'cursor:two']);
  const state = controller.getSnapshot();
  assert.deepEqual(state.sourceResource.data.entries.map(value => value.entry_ref), ['new:a', 'b']);
  assert.deepEqual(model.projectCreationState(state).selectedEntries.map(value => value.entry_ref), ['old:a']);
  assert.equal(state.sourceResource.data.entries_complete, false);
  controller.dispose();
});

test('superseded query results and continuation search-revision changes cannot replace selected data', async () => {
  let finishOld;
  const {controller} = await setup(async request => {
    if (request.cursor) return page([row('changed')], {query: 'new', search_revision: 'search:changed'});
    if (request.q === 'old') return new Promise(resolve => {finishOld = () => resolve(page([row('old')], {query: 'old'}));});
    if (request.q === 'new') return page([row('new')], {query: 'new', search_revision: 'search:new', has_more: true, next_cursor: 'cursor:new'});
    return page([row('a')]);
  });
  controller.toggle('selection:a');
  controller.setQuery('old'); controller.setQuery('new'); await waitForPage(controller);
  finishOld(); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(controller.getSnapshot().sourceResource.data.entries.map(value => value.title), ['new']);
  assert.deepEqual(controller.getSnapshot().selectedKeys, ['selection:a']);
  assert.equal(await controller.loadMore(), false);
  assert.equal(controller.getSnapshot().pageStatus, 'error');
  assert.deepEqual(controller.getSnapshot().sourceResource.data.entries.map(value => value.title), ['new']);
  controller.dispose();
});

test('a repeated cursor cannot masquerade as advancing pages', async () => {
  const {controller} = await setup(async () => page([row('a')], {has_more: true, next_cursor: 'cursor:one'}));
  assert.equal(await controller.loadMore(), false);
  assert.equal(controller.getSnapshot().pageStatus, 'error'); controller.dispose();
});

test('offscreen selected entries can be removed and selection page denial clears all pins', async () => {
  const {controller} = await setup(async request => request.q === 'denied' ? {status: 'denied'}
    : request.q ? page([], {query: request.q}) : page([row('a')]));
  controller.toggle('selection:a'); controller.setQuery('nothing'); await waitForPage(controller);
  controller.setTab('selected');
  assert.equal(model.projectCreationState(controller.getSnapshot()).entries.length, 1);
  assert.equal(controller.toggle('selection:a'), true);
  assert.equal(model.projectCreationState(controller.getSnapshot()).selectedCount, 0);
  controller.setQuery(''); await waitForPage(controller); controller.toggle('selection:a');
  controller.setQuery('denied'); await waitForPage(controller);
  assert.deepEqual(controller.getSnapshot().pinnedEntries, []);
  assert.equal(controller.getSnapshot().sourceResource.status, 'denied'); controller.dispose();
});

test('reentrant retirement during page loading never dispatches a retired source read', async () => {
  let reads = 0;
  const {controller} = await setup(async () => {reads++; return page([row('a')]);});
  controller.subscribe(() => {if (controller.getSnapshot().pageStatus === 'loading') controller.pauseSource();});
  controller.setQuery('new'); await Promise.resolve();
  assert.equal(reads, 1); assert.equal(controller.getSnapshot().sourceResource.status, 'loading');
  controller.dispose();
});

test('expired search erases source facts and pins while retaining safe metadata and forbidding Save', async () => {
  let reads = 0;
  const {controller, writes} = await setup(async request => {
    reads++; if (request.q) throw Object.assign(new Error('Expired'), {status: 410, code: 'source_expired'});
    return page([row('private:row', 'private:receipt', 'Sensitive title')]);
  });
  controller.toggle('selection:private:row'); controller.edit({description: 'Keep my note'});
  controller.setQuery('expire'); await waitForPage(controller);
  const state = controller.getSnapshot();
  assert.equal(state.sourceResource.status, 'expired'); assert.equal(state.sourceResource.data, null);
  assert.deepEqual(state.pinnedEntries, []); assert.deepEqual(state.selectedKeys, []); assert.equal(state.reviewKey, null);
  assert.equal(state.title, 'Paged source'); assert.equal(state.description, 'Keep my note');
  assert.doesNotMatch(JSON.stringify(state), /Sensitive title|private:receipt|private:row/);
  assert.equal(model.canSubmitCreation(state), false); assert.equal(await controller.submit(), false);
  controller.setContext(context); assert.equal(await controller.load(), false); assert.equal(reads, 2); assert.equal(writes.length, 0);
  controller.dispose();
});

test('expiry rejection after submit clears sensitive selection but keeps the exact submitted operation key', async () => {
  let submitted;
  const controller = model.createPlaylistCreationController({providers: {readPlaylistCreationSource: async () => page([row('private')]),
    createPlaylistFromSelection: async request => {submitted = request; throw Object.assign(new Error('Expired'), {status: 410, code: 'source_expired'});}}});
  controller.setContext(context); await controller.load(); controller.edit({title: 'Keep my name'}); controller.toggle('selection:private');
  assert.equal(await controller.submit(), false);
  const state = controller.getSnapshot();
  assert.equal(state.mutation.request_key, submitted.request_key); assert.equal(state.sourceResource.status, 'expired');
  assert.equal(state.sourceResource.data, null); assert.deepEqual(state.selectedKeys, []); assert.deepEqual(state.pinnedEntries, []);
  assert.equal(await controller.submit(), false); controller.dispose();
});
