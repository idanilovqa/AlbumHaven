const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createNativeHomeRuntime} = require('./native-home-harness.cjs');
const {installPrivateContext} = require('./private-context-harness.cjs');
const read = name => fs.readFileSync(path.resolve(__dirname, '../../../music_app/static/js/runtime', name), 'utf8');
const denied = patch => Object.assign(new Error('Synthetic source denial'),
  {responseRejected: true, status: 403, code: 'source_unavailable'}, patch);
const deferred = () => {let reject; const promise = new Promise((_, no) => {reject = no;}); return {promise, reject};};
const canonical = ref => ({kind: 'album', ref, allowed_actions: {can_view_details: true},
  native_actions: {album_ref: ref, allowed_actions: {can_open_album: true}}});

// Real native source and resource-selection owners, with generated DTOs and a
// bounded native lease sink. This is source-lifetime coverage, not browser QA.
async function setup(account_ref = null) {
  const env = createNativeHomeRuntime(), c = env.context, d = env.document;
  const shell = d.createElement('div'); shell.id = 'app-shell';
  Object.assign(shell.dataset, {nativeAccountId: 'actor:one', nativeLibraryId: 'library:one'}); d.body.appendChild(shell);
  const home = d.createElement('div'); home.id = 'mobile-home'; d.body.appendChild(home);
  const overlay = d.createElement('div'); overlay.id = 'track-modal'; overlay.hidden = true; d.body.appendChild(overlay);
  c.location = new URL('https://albumhaven.test/?surface=home'); c.history = {state: {albumHavenNavigationPosition: 1}};
  c.addEventListener = d.addEventListener.bind(d); c.removeEventListener = d.removeEventListener.bind(d);
  c.dispatchEvent = d.dispatchEvent.bind(d); c.AbortController = AbortController;
  c.shouldShowMobileHome = () => !shell.hidden;
  c.state = {ui: {}, player: {playbackQueue: {untouched: true}}, view: {recent_local_albums: [
    {album_ref: 'recent:one', name: 'Recent', row_kind: 'local_album', local_match_state: 'matched_local',
      allowed_actions: {can_open_album: true}}], recent_not_local_albums: []}};
  c.fetchTrackModalAlbumDetails = async ref => ({key: ref, tracks: []}); c.albumRequiresHydration = () => false;
  let releases = 0;
  c.acquireTrackModalSelection = () => ({release() {releases++;}});
  installPrivateContext(c);
  for (const name of ['track-actions.js', 'resource-selection.js', 'playtable-source.js']) vm.runInContext(read(name), c);
  let retainResource;
  const nativeSelection = c.AlbumHavenResourceSelection;
  c.AlbumHavenResourceSelection = {...nativeSelection, create(options) {retainResource = options.retainResource; return nativeSelection.create(options);}};
  vm.runInContext(read('home-friends-bridge.js'), c);
  const bridge = c.AlbumHavenHomeRuntime, scopeKey = bridge.snapshot().scopeKey;
  const query = {scopeKey, account_ref, kind: 'tracks', period: 'week'};
  let snapshot = 'snapshot:one', reads = 0;
  const reader = bridge.configureActivityProvider({readActivity: async () => {
    reads++; return {snapshot_ref: snapshot, rows: ['allowed', 'denied-occurrence'].map(id => ({id, kind: 'track',
      title: id, album_target: canonical(`album:${id}`), source_readable: true,
      allowed_actions: {can_view_details: true, can_select_for_playlist: true}, inventory_track_ref: 'inventory-track:1:2'}))};
  }});
  let result = await reader(query);
  const origin = () => ({audience: account_ref == null ? 'own' : 'friend', subject_ref: account_ref,
    kind: query.kind, period: query.period, snapshot_ref: snapshot});
  const receipt = (row = result.rows[0]) => retainResource(row.album_target, {scopeKey, origin: row.album_target.origin});
  const options = () => ({scopeKey, origin: origin(), row_refs: ['allowed', 'denied-occurrence'], isCurrent: () => true});
  return {...env, c, d, shell, bridge, scopeKey, query, reader, receipt, options,
    get result() {return result;}, get reads() {return reads;}, get releases() {return releases;},
    async refresh(ref = 'snapshot:two') {snapshot = ref; result = await reader(query); return result;},
    recentReceipt() {const selected = bridge.albumDetailSelection('recent:one', scopeKey);
      return retainResource(selected, {scopeKey, origin: {source: 'recent', account_ref: null, kind: 'albums', period: 'week'}});},
    async mount(row = result.rows[0]) {
      const host = d.createElement('section'); d.body.appendChild(host);
      let ready; const completed = new Promise(resolve => {ready = resolve;});
      const mounted = bridge.mountResourceSelection(host, {selection: row.album_target, scopeKey, origin: row.album_target.origin,
        onState: state => {if (state === 'ready') ready();}, onError: error => ready(error)});
      const error = await completed; if (error) throw error; return mounted;
    }};
}

for (const [method, delegate] of [['readActivityMissingEligibility', 'activityMissingEligibility'], ['inspectActivityMissing', 'inspectActivityMissing']]) {
  for (const subject of [null, 'friend:one']) test(`${method} retires only the denied current ${subject ? 'Friend' : 'own'} snapshot and eagerly releases detail`, {timeout: 3000}, async () => {
    const h = await setup(subject), held = h.receipt(), recent = h.recentReceipt(), mounted = await h.mount();
    let calls = 0; h.c.AlbumHavenPlaylistUI = {[delegate]: async options => {calls++;
      assert.deepEqual(options.row_refs, ['allowed', 'denied-occurrence']); const error = denied(); options.onSourceDenied(error); throw error;}};
    await assert.rejects(h.bridge[method](h.options()), {code: 'source_unavailable'});
    assert.equal(held.isCurrent(), false); assert.equal(h.receipt(), null);
    assert.equal(recent.isCurrent(), true, 'unrelated Recent source remains readable');
    assert.equal(h.releases, 1, 'mounted detail is released without another gesture');
    assert.equal(h.reads, 1, 'denial does not automatically refresh'); assert.equal(calls, 1);
    await h.refresh(); assert.equal(h.receipt().isCurrent(), true, 'explicit later refresh establishes fresh authority');
    assert.equal(held.isCurrent(), false, 'old authority never revives'); mounted.dispose();
  });
}

for (const error of [denied({code: 'forbidden'}), denied({status: 409}), denied({status: 410}),
  denied({responseRejected: false}), new TypeError('Synthetic network failure')]) {
  test(`non-source denial preserves authority: ${error.code || error.name}/${error.status || 'network'}/${error.responseRejected}`, async () => {
    const h = await setup(), held = h.receipt(); h.c.AlbumHavenPlaylistUI = {activityMissingEligibility: async options => {options.onSourceDenied(error); throw error;}};
    await assert.rejects(h.bridge.readActivityMissingEligibility(h.options()), e => e === error);
    assert.equal(held.isCurrent(), true); assert.equal(h.reads, 1);
  });
}

for (const mismatch of ['scope', 'audience', 'subject', 'kind', 'period', 'snapshot', 'callback', 'abort', 'actor', 'replacement']) {
  test(`stale or unrelated Missing callback cannot retire current source: ${mismatch}`, async () => {
    const h = await setup('friend:one'), request = deferred(), options = h.options();
    let current = true; const abort = new AbortController(); options.isCurrent = () => current; options.signal = abort.signal;
    const fields = {scope: ['scopeKey', 'foreign'], audience: ['audience', 'own'], subject: ['subject_ref', 'friend:other'],
      kind: ['kind', 'listens'], period: ['period', 'month'], snapshot: ['snapshot_ref', 'snapshot:other']};
    if (fields[mismatch]) {const [key, value] = fields[mismatch]; if (key === 'scopeKey') options[key] = value; else options.origin[key] = value;}
    let markDenial; h.c.AlbumHavenPlaylistUI = {inspectActivityMissing: passed => {markDenial = passed.onSourceDenied; return request.promise;}};
    const pending = h.bridge.inspectActivityMissing(options);
    if (mismatch === 'callback') current = false;
    if (mismatch === 'abort') abort.abort();
    if (mismatch === 'actor') {h.shell.dataset.nativeAccountId = 'actor:other'; h.bridge.sync();}
    if (['actor', 'replacement'].includes(mismatch)) {
      // Actor changes intentionally invalidate old receipts. Establish another
      // current source independently, then ensure the stale response leaves it.
      if (mismatch === 'actor') h.query.scopeKey = h.bridge.snapshot().scopeKey;
      await h.refresh();
    }
    const selected = h.result.rows[0], activeScope = h.bridge.snapshot().scopeKey;
    assert.equal(h.bridge.canResourceIntent('embed', selected.album_target, {scopeKey: activeScope, origin: selected.album_target.origin}), true);
    const error = denied(); markDenial(error); request.reject(error); await assert.rejects(pending, {code: 'source_unavailable'});
    assert.equal(h.bridge.canResourceIntent('embed', selected.album_target, {scopeKey: activeScope, origin: selected.album_target.origin}), true);
  });
}

for (const proof of ['absent', 'different-error']) test(`typed rejection outside the exact source request preserves authority: ${proof}`, async () => {
  const h = await setup(), held = h.receipt();
  h.c.AlbumHavenPlaylistUI = {inspectActivityMissing: async options => {
    if (proof === 'different-error') options.onSourceDenied(denied());
    throw denied();
  }};
  await assert.rejects(h.bridge.inspectActivityMissing(h.options()), {code: 'source_unavailable'});
  assert.equal(held.isCurrent(), true); assert.equal(h.reads, 1);
});
