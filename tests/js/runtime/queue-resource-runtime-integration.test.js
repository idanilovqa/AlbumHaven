const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createNativeHomeRuntime} = require('./native-home-harness.cjs');
const read = file => fs.readFileSync(path.resolve(__dirname, '../../../music_app/static/js/runtime', file), 'utf8');


// The source DTO and renderer remain controlled seams. State, private scope,
// preference subscriptions, Queue, resource ownership and modal leases are real.
function environment(overrides) {
  const h = createNativeHomeRuntime(), context = h.context, document = h.document;
  const shell = document.createElement('div'); shell.id = 'app-shell';
  Object.assign(shell.dataset, {nativeAccountId: 'actor-one', nativeLibraryId: 'library-one', privateUiContext: 'a'.repeat(64)});
  document.body.appendChild(shell);
  context.Node.prototype.before = function(node) {this.parentNode?.insertBefore(node, this);};
  context.Node.prototype.replaceWith = function(node) {if (this.parentNode) {this.before(node); this.remove();}};
  document.createComment = () => new context.Node(8);
  const overlay = document.createElement('div'); overlay.id = 'track-modal'; overlay.hidden = true;
  overlay.innerHTML = '<div class="track-modal-dialog" role="dialog" aria-modal="true"><div class="album-details-header__primary">Album</div><div id="track-modal-list"></div></div>';
  document.body.appendChild(overlay);
  const host = document.createElement('section'); document.body.appendChild(host);
  Object.assign(context, {AbortController, activateSharedTrackButton() {throw Error('Metadata must not activate playback');}, AlbumHavenCapabilities: {allows: () => true}, playerTrackSelectionToken: 0,
    addEventListener: document.addEventListener.bind(document), removeEventListener: document.removeEventListener.bind(document),
    resolveNextPlaybackContextQueue: () => null, peekNextOrdinaryQueuedTrack: () => null,
    getTrackModalElements: () => ({overlay}),
    renderTrackModalRelease: album => {assert.equal(album.key, 'native-one');},
  });
  for (const file of ['bootstrap-state.js', 'core-state-and-helpers.js', 'player-streaming-engine.js',
    'track-modal-lightbox-helpers.js', 'private-ui-transport.js', 'playlist-queue.js', 'track-actions.js',
    'explicit-queue-planner.js', 'explicit-queue-runtime.js', 'resource-selection.js', 'queue-resource-selection.js']) {
    vm.runInContext(read(file), context, {filename: file});
  }
  context.getPlayerPlaybackSnapshot = context.getStreamingPlaybackSnapshot;
  assert.equal(context.streamingEngineState(), h.owner('state').player.streaming);
  assert.equal(context.streamingEngineState().roles.current, null);
  Object.assign(context, overrides);
  let mounts = 0, releases = 0;
  const acquire = context.acquireTrackModalSelection;
  context.acquireTrackModalSelection = (...args) => {
    const lease = acquire(...args);
    if (lease) {
      mounts++;
      assert.equal(host.contains(lease.dialog), true);
      const release = lease.release;
      lease.release = reason => {
        const owned = context.getTrackModalSelectionLease() === lease;
        release(reason); if (owned) releases++;
      };
    }
    return lease;
  };
  return {context, shell, host, mounts: () => mounts, releases: () => releases};
}

test('real Queue runtime source403 notification retires already-mounted native details permanently', async () => {
  let denied = false, plays = 0, transferred = null;
  const env = environment({
    playTrackFromPayload: async () => {plays++; return true;},
    fetchTrackModalAlbumDetails: async key => ({key, tracks: []}),
    openTrackModal: (album, options) => {transferred = options.sourcePageOwner;},
  });
  const {context} = env;
  const queue = context.window.AlbumHavenExplicitQueue;
  const target = {kind:'album',ref:'album-one',identity_ref:'catalog-one',allowed_actions:{can_view_details:true},
    native_actions:{album_ref:'native-one',allowed_actions:{can_open_album:true,can_play_album:true}}};
  const readTarget = async () => {
    if (denied) throw Object.assign(new Error('Source revoked'), {status: 403});
    return {path: '/private/track.flac', source_readable: true, availability: 'local',
      allowed_actions: {can_read: true, can_play: true}, playback_state: {can_start_here: true}, track_preference: null};
  };
  const [id] = await queue.enqueue([{display: {title: 'Queued track'}, isCurrent: () => true,
    resolveMetadata: readTarget, resolve: readTarget,
    async resolveDetails() {return {target,data:{kind:'album',ref:'album-one',title:'Album'},isCurrent:()=>true};}}]);
  assert.equal(queue.getSnapshot().entries[0].track_preference, null, 'details and readable media never grant Love');
  const owner = context.window.AlbumHavenQueueResourceSelection.create({queue,scopeKey:'actor-one/library-one',isCurrent:()=>true});
  await owner.select([id]); const selected = owner.getSnapshot().album;
  const lease = owner.mountResourceSelection(env.host,
    {selection:selected,scopeKey:'actor-one/library-one',origin:selected.origin});
  await new Promise(resolve=>setImmediate(resolve)); assert.equal(env.mounts(),1); assert.equal(env.releases(),0); assert.equal(plays,0);
  denied=true; await queue.refresh();
  assert.equal(owner.getSnapshot().album,null); assert.equal(env.releases(),1);
  denied=false; await queue.refresh();
  assert.equal(owner.getSnapshot().album,null); assert.equal(env.mounts(),1); assert.equal(env.releases(),1);
  await owner.select([id]); assert.equal(owner.getSnapshot().album.kind,'album');
  lease.dispose();
  const refreshed = owner.getSnapshot().album;
  await owner.resourceIntent('open',refreshed,{scopeKey:'actor-one/library-one',origin:refreshed.origin});
  assert.equal(transferred.isCurrent(),true); owner.dispose();
  // A detached history entry need not poll its source during the revocation.
  denied=true; await queue.refresh(); denied=false; await queue.refresh();
  assert.equal(transferred.isCurrent(),false); assert.equal(plays,0);
});

async function denialFixture(count = 1) {
  let denied = false;
  const staleSources = new Set();
  const env = environment({
    playTrackFromPayload: async () => {throw Error('No playback during source denial');},
    fetchTrackModalAlbumDetails: async key => ({key, tracks: []}),
  });
  const {context} = env;
  const queue=context.window.AlbumHavenExplicitQueue;
  const target={kind:'album',ref:'album-one',identity_ref:'catalog-one',allowed_actions:{can_view_details:true},
    native_actions:{album_ref:'native-one',allowed_actions:{can_open_album:true,can_play_album:true}}};
  const captures = Array.from({length: count}, (_, index) => {
    const readTarget = async () => {
      if (denied) throw Object.assign(Error('Source denied'), {status: 403});
      return {path: `/private/${index}.flac`, source_readable: true, availability: 'local',
        allowed_actions: {can_read: true, can_play: true}, playback_state: {can_start_here: true}, track_preference: null};
    };
    return {display: {title: `Queued ${index}`}, isCurrent: () => !staleSources.has(index),
      resolveMetadata: readTarget, resolve: readTarget,
      async resolvePlaylistItem() {const ref = `inventory-track:1:${index + 1}`; return {inventory_track_ref: ref, source_provenance: {kind: 'inventory', track_ref: ref}};},
      async resolveDetails() {return {target, data: {kind: 'album', ref: 'album-one', title: 'Album'}, isCurrent: () => true};}};
  });
  const ids=await queue.enqueue(captures);
  const owner=context.window.AlbumHavenQueueResourceSelection.create({queue,scopeKey:'actor-one/library-one',isCurrent:()=>true});
  return {...env, queue, owner, ids, captures, setDenied: value => {denied = value;}, retireSource: index => staleSources.add(index)};
}

for(const status of [403,404]) test(`review: retained source capture${status} synchronously retires mounted Queue details`,async()=>{
  const f=await denialFixture(),receipt=await f.queue.playlistSelection(f.ids);
  await f.owner.select(f.ids);const selected=f.owner.getSnapshot().album;
  const lease=f.owner.mountResourceSelection(f.host,
    {selection:selected,scopeKey:'actor-one/library-one',origin:selected.origin});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(f.mounts(),1);
  assert.equal(receipt.rejectSourceRead(status),true);
  assert.equal(receipt.isCurrent(),false);assert.equal(f.queue.getSnapshot().entries[0].sourceReadable,false);
  assert.equal(f.owner.getSnapshot().album,null);assert.equal(f.releases(),1);
  assert.equal(receipt.rejectSourceRead(status),false,'repeated callback cannot advance authority again');
  await f.queue.refresh();assert.equal(f.queue.getSnapshot().entries[0].sourceReadable,true);
  assert.equal(receipt.rejectSourceRead(status),false,'old epoch cannot poison restored source');
  assert.equal(f.owner.getSnapshot().album,null,'old detail cannot resurrect after source restoration');
  lease.dispose();f.owner.dispose();
});

test('review: source denial callback rejects non-authoritative error classes without retiring receipt',async()=>{
  const f=await denialFixture(),receipt=await f.queue.playlistSelection(f.ids);
  for(const status of [undefined,null,0,400,401,408,409,410,429,500,503,'403',{status:403}]) {
    assert.equal(receipt.rejectSourceRead(status),false);assert.equal(receipt.isCurrent(),true);
    assert.equal(f.queue.getSnapshot().entries[0].sourceReadable,true);
  }
  f.owner.dispose();
});

for(const kind of ['aborted','view','removed','actor','epoch','source']) test(`review: stale ${kind} source-denial callback cannot retire remaining or newer authority`,async()=>{
  const f=await denialFixture(2),request=new AbortController();let view=true;
  const receipt=await f.queue.playlistSelection(f.ids,{signal:request.signal,isCurrent:()=>view});
  if(kind==='source')f.retireSource(0);
  if(kind==='aborted')request.abort();
  if(kind==='view')view=false;
  if(kind==='removed')f.queue.remove(f.ids[0]);
  if(kind==='actor'){f.shell.dataset.nativeAccountId='actor-two';await f.queue.enqueue([f.captures[0]]);}
  if(kind==='epoch'){f.setDenied(true);await f.queue.refresh();f.setDenied(false);await f.queue.refresh();}
  const before=f.queue.getSnapshot();
  assert.equal(receipt.rejectSourceRead(403),false);
  const after=f.queue.getSnapshot();assert.equal(after.revision,before.revision);
  assert.ok(after.entries.length);
  assert.deepEqual(after.entries.map(row=>row.sourceReadable),before.entries.map(row=>row.sourceReadable));
  assert.ok(after.entries.some(row=>row.sourceReadable===true));
  f.owner.dispose();
});
