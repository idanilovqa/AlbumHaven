// Post-admission apply ownership: real readBatch and receipt subscribers may
// synchronously replace an owner while its returned rows are being admitted.
const nodeTest = require('node:test');
const test = (name, body) => nodeTest(name, {timeout: 5000}, body);
const assert = require('node:assert/strict');
const {createLooseAuthorityFixture, looseRow, browsePayload, overlay, outcome, settle} = require('./shared-request-unit-fixture.cjs').looseAuthority();
const baseUrl = '/view-data?surface=albums&gallery_page_size=50';
const page = (rows, revision = 'r1', more = true) => browsePayload(rows, {
  artist_groups: [{artist: 'Fixture Artist', albums: [{key: `album-${revision}`}]}],
  gallery_page: {revision, next_cursor: more ? `next-${revision}` : null, has_more: more},
});

async function advanceEpochByGenuineAlbumRead(f) {
  const before = f.runtime.readEpoch(), index = f.requests.length;
  const row = looseRow(990, {track_preference: overlay('loved', false)});
  const pending = f.context.fetchTrackModalAlbumDetails('reentrant-epoch-control');
  f.respond(index, {ok: true, album: {key: 'reentrant-epoch-control', tracks: [row]}});
  await pending;
  assert.ok(f.runtime.readEpoch() > before, 'The independent real read-only Album receipt advances the preference epoch');
}

async function startOwner(f, owner, {advanceBeforeRestart = false} = {}) {
  const original = page([looseRow(71)]);
  await f.load(original, baseUrl);
  assert.ok(f.source(original.non_album_tracks[0]), 'Setup must establish its receipt through the actual browse owner');
  if (owner === 'foreground') {
    const index = f.requests.length, pending = f.read(baseUrl);
    return {original, index, pending, epoch: f.requests[index].dispatchEpoch};
  }
  const continuationIndex = f.requests.length, pending = outcome(f.context.loadNextRootGalleryPage());
  assert.match(f.requests[continuationIndex].url, /gallery_cursor=next-r1/);
  const continuationEpoch = f.requests[continuationIndex].dispatchEpoch;
  if (advanceBeforeRestart) await advanceEpochByGenuineAlbumRead(f);
  const index = f.requests.length;
  f.respond(continuationIndex, {ok: false, restart_required: true}, 409);
  await settle();
  assert.equal(f.requests.length, index + 1, 'The genuine continuation owner must dispatch one 409 restart');
  assert.doesNotMatch(f.requests[index].url, /gallery_cursor|omit_sidebar/);
  return {original, index, pending, epoch: f.requests[index].dispatchEpoch, continuationEpoch};
}

function subscribe(f, kind, callback) {
  return kind === 'TrackActionsRuntime'
    ? f.runtime.subscribePreferences(callback)
    : f.context.subscribeTrackModalPreferences(callback);
}

for (const owner of ['foreground', '409-restart continuation']) {
  for (const kind of ['TrackActionsRuntime', 'shared exact-receipt']) {
    for (const change of ['abort', 'new request', 'view replacement', 'tag-edit replacement']) {
      test(`${owner} never applies or succeeds after ${kind} admission subscriber causes ${change}`, async () => {
        const f = createLooseAuthorityFixture(), active = await startOwner(f, owner);
        const staleRow = looseRow(72, {track_preference: overlay('obsessed')});
        const stale = page([staleRow], 'r2', false);
        const beforeApply = f.applied.length, beforePaint = f.paint.length, beforeBatch = f.batches.length;
        const signal = f.requests[active.index].options.signal;
        const protectedView = browsePayload([looseRow(73)], {selected_artist: 'New visible state'});
        let witness = null, next = null, callbackError = null;
        const unsubscribe = subscribe(f, kind, () => {
          if (witness) return;
          witness = {applies: f.applied.length, batches: f.batches.length,
            track: f.batches.at(-1)?.sources[0]?.track_ref};
          // Product subscribers intentionally isolate callback exceptions. Save
          // any fixture failure explicitly so it cannot masquerade as RED.
          try {
            if (change === 'abort') {
              if (owner === 'foreground') f.state.ui.activeViewRequestController.abort();
              else f.context.cancelRootGalleryPageRequest();
            } else if (change === 'new request') {
              const index = f.requests.length;
              const pending = f.read('/view-data?surface=albums&artist=NewOwner');
              next = {index, pending};
            } else {
              const key = change === 'view replacement' ? 'viewStateRevision' : 'tagEditOptimisticMutationRevision';
              f.state.ui[key] = Number(f.state.ui[key] || 0) + 1;
              // Unit setup models the newer optimistic/navigation view at its
              // real currentness seam; admission and apply owners stay real.
              f.state.view = protectedView;
            }
          } catch (error) {callbackError = error;}
        });
        f.respond(active.index, stale);
        const result = await active.pending;
        assert.ifError(callbackError); assert.ifError(result.error);
        assert.ok(witness, 'The real synchronous admission subscriber must actually fire');
        assert.equal(witness.track, staleRow.path, 'The callback must come from this genuine response admission');
        assert.equal(witness.batches, beforeBatch + 1);
        assert.equal(witness.applies, beforeApply, 'Reentrancy happens after admission starts and before the apply sink');
        assert.equal(f.batches[beforeBatch].epoch, active.epoch, 'Reentrant handling cannot restamp the dispatch epoch');
        assert.equal(result.value, false, 'An owner lost during admission must not report a successful apply');
        assert.equal(f.applied.length, beforeApply, 'No stale payload may cross the actual apply boundary');
        assert.equal(f.paint.length, beforePaint, 'No stale view or groups may be painted after ownership loss');
        assert.equal(f.state.view, change.endsWith('replacement') ? protectedView : active.original,
          'The older response cannot overwrite either the retained view or the newer optimistic view');
        if (change === 'abort' || change === 'new request') assert.equal(signal.aborted, true);
        unsubscribe();
        if (next) {
          assert.equal(next.index, active.index + 1, 'The callback dispatched the real successor owner');
          const fresh = browsePayload([looseRow(74, {track_preference: overlay('loved')})], {selected_artist: 'NewOwner'});
          f.respond(next.index, fresh);
          const successor = await next.pending;
          assert.ifError(successor.error); assert.equal(successor.value, true);
          assert.equal(f.state.view, fresh); assert.equal(f.applied.length, beforeApply + 1);
          assert.equal(f.preference(fresh.non_album_tracks[0]).love_tier, 'loved');
        }
        assert.equal(f.directReads.length, 0, 'All admission remains owned by the genuine batch path');
      });
    }
  }
}

for (const owner of ['foreground', '409-restart continuation']) {
  test(`${owner} still applies once with passive real subscribers and its original dispatch epoch`, async () => {
    const f = createLooseAuthorityFixture(), active = await startOwner(f, owner, {advanceBeforeRestart: true});
    const beforeApply = f.applied.length, beforeBatch = f.batches.length;
    const events = [], subscriptions = ['TrackActionsRuntime', 'shared exact-receipt'].map(kind =>
      subscribe(f, kind, () => events.push({kind, applies: f.applied.length})));
    const row = looseRow(75, {track_preference: overlay('loved')}), response = page([row], 'r2', false);
    f.respond(active.index, response); const result = await active.pending;
    assert.ifError(result.error); assert.equal(result.value, true);
    assert.equal(f.applied.length, beforeApply + 1); assert.equal(f.state.view.non_album_tracks[0], row);
    assert.equal(f.batches.length, beforeBatch + 1); assert.equal(f.batches[beforeBatch].epoch, active.epoch);
    assert.deepEqual(f.batches[beforeBatch].sources.map(source => source.track_ref), [row.path]);
    assert.equal(f.preference(row).love_tier, 'loved');
    for (const kind of ['TrackActionsRuntime', 'shared exact-receipt']) {
      assert.ok(events.some(event => event.kind === kind));
      assert.ok(events.filter(event => event.kind === kind).every(event => event.applies === beforeApply));
    }
    if (owner !== 'foreground') assert.ok(active.epoch > active.continuationEpoch,
      'The restart uses its own pre-dispatch epoch, not the older continuation epoch');
    subscriptions.forEach(unsubscribe => unsubscribe());
  });

  test(`${owner} cannot renew a pre-epoch-change response during the post-admission currentness check`, async () => {
    const f = createLooseAuthorityFixture(), active = await startOwner(f, owner);
    const beforeApply = f.applied.length;
    await advanceEpochByGenuineAlbumRead(f);
    const beforeBatch = f.batches.length, row = looseRow(76), response = page([row], 'r2', false);
    f.respond(active.index, response); const result = await active.pending;
    assert.ifError(result.error); assert.equal(result.value, true, 'Preference epoch loss alone does not reject the still-current display payload');
    assert.equal(f.applied.length, beforeApply + 1); assert.equal(f.state.view.non_album_tracks[0], row);
    assert.equal(f.batches.length, beforeBatch + 1); assert.equal(f.batches[beforeBatch].epoch, active.epoch);
    assert.ok(f.runtime.readEpoch() > active.epoch); assert.equal(f.source(row), null);
    assert.ok(f.source(active.original.non_album_tracks[0]), 'Stale preference epoch cannot revoke the prior legitimate receipt');
  });
}
