const test=require('node:test'),assert=require('node:assert/strict');
const {harness,plain,deferred,settle,F}=require('./album-tops-membership-fixtures/navigation-owner-fixture.cjs');
const register=h=>{assert.equal(typeof h.navigation.setCollectionDraftOwner,'function');const release=h.navigation.setCollectionDraftOwner(h.owner);assert.equal(typeof release,'function');return release;};

test('neutral inline ownership registers against the existing entry without a form, history write or Playlist retained marker',()=>{
  const h=harness(),before=plain(h.history.state),writes=h.calls.history.length,url=h.location.href;const release=register(h);
  assert.equal(h.calls.history.length,writes);assert.deepEqual(plain(h.history.state),before);assert.equal(h.location.href,url);
  assert.equal(h.navigation.retainedPlaylistDraft(),null);
  assert.equal(h.navigation.isPlaylistDraftCurrent({token:h.owner.token,scopeKey:h.owner.scopeKey}),false);
  assert.equal(h.navigation.retainPlaylistDraftNavigation(h.owner.token,()=>assert.fail('Top must not become a retained Playlist draft')),false);
  release();release();assert.equal(h.calls.discard,0);assert.equal(h.navigation.deferCollectionDraftNavigation(()=>assert.fail('No active owner')),false);
});

for(const gateway of ['neutral','mobile','settings'])test(`actual ${gateway} departure declines before touching the destination, then accepts exactly once`,async()=>{
  const h=harness();register(h);h.decision(false);
  const leave=()=>gateway==='neutral'?h.navigation.deferCollectionDraftNavigation(()=>h.destination()):gateway==='mobile'?h.context.deferAppFormPageReplacement(()=>h.destination()):h.navigation.navigate('/account');
  assert.equal(await leave(),false);assert.equal(h.calls.confirm,1);assert.equal(h.calls.discard,0);assert.equal(h.calls.fetch.length,0);assert.equal(h.calls.navigation.length,0);
  assert.equal(h.index(),1);assert.equal(h.settings.hidden,true);h.decision(true);await leave();
  assert.equal(h.calls.confirm,2);assert.equal(h.calls.discard,1);
  assert.equal(h.calls.fetch.length,gateway==='settings'?1:0);assert.equal(h.calls.navigation.length,gateway==='settings'?0:1);
});

test('neutral and Playlist compatibility aliases share one pending departure and cannot register competing owners',async()=>{
  const h=harness(),answer=deferred();register(h);h.decision(answer.promise);
  const first=h.navigation.deferCollectionDraftNavigation(()=>h.destination());await settle();
  assert.equal(await h.navigation.deferPlaylistDraftNavigation(()=>assert.fail('Duplicate alias departure')),false);
  assert.equal(await h.context.deferAppFormPageReplacement(()=>assert.fail('Duplicate mobile departure')),false);
  assert.equal(h.navigation.setPlaylistDraftOwner({...h.owner,token:'competing:playlist'}),false);
  assert.equal(h.calls.confirm,1);answer.resolve(true);assert.equal(await first,true);assert.equal(h.calls.discard,1);assert.equal(h.calls.navigation.length,1);
});

test('browser Back decline restores the exact displayed entry; accept and Forward cannot resurrect an inline owner',async()=>{
  const h=harness(),original=plain(h.history.state);register(h);h.decision(false);
  h.history.go(-1);await settle();assert.equal(h.index(),1);assert.deepEqual(plain(h.history.state),original);assert.equal(h.calls.discard,0);assert.equal(h.calls.gallery,0);
  h.decision(true);h.history.go(-1);await settle();assert.equal(h.index(),0);assert.equal(h.calls.discard,1);assert.equal(h.calls.gallery,1);
  h.history.go(1);await settle();assert.equal(h.index(),1);assert.equal(h.calls.discard,1);assert.equal(h.calls.confirm,2);
  assert.equal(h.history.state.playlistDraft,undefined);assert.equal(h.navigation.deferCollectionDraftNavigation(()=>assert.fail('Retired owner resurrected')),false);
});

for(const change of ['owner invalidated','unregistered','newer history'])test(`late acceptance after ${change} never replays obsolete destination`,async()=>{
  const h=harness(),answer=deferred(),release=register(h);h.decision(answer.promise);
  const pending=h.navigation.deferCollectionDraftNavigation(()=>h.destination());await settle();
  if(change==='owner invalidated')h.invalidate();else if(change==='unregistered')release();else h.navigation.pushLibraryHistory('/?artist=Newer',{});
  answer.resolve(true);assert.equal(await pending,false);assert.equal(h.calls.navigation.length,0);
  assert.equal(h.calls.discard,change==='owner invalidated'?1:0);
});

test('legacy Playlist marker, retain and aliases remain the exact default behavior',async()=>{
  const h=harness(),owner={...h.owner,token:'playlist:one'};delete owner.ownsHistoryEntry;
  const release=h.navigation.setPlaylistDraftOwner(owner);assert.equal(typeof release,'function');
  const marker={token:owner.token,scopeKey:F.SCOPE};h.navigation.writeLibraryHistory('/?surface=playlists',{playlistDraft:marker},{mode:'push'});
  assert.equal(h.navigation.isPlaylistDraftCurrent(marker),true);
  assert.equal(h.navigation.retainPlaylistDraftNavigation(owner.token,()=>{
    assert.deepEqual(plain(h.navigation.retainedPlaylistDraft()),marker);
    assert.equal(h.navigation.deferPlaylistDraftNavigation(()=>assert.fail('Retained Playlist departure')),false);return true;}),true);
  assert.equal(h.navigation.retainedPlaylistDraft(),null);h.decision(false);h.history.go(-1);await settle();assert.equal(h.index(),2);assert.equal(h.calls.discard,0);
  release();assert.equal(h.navigation.isPlaylistDraftCurrent(marker),false);
});

test('composed shared owner still sanitizes history without touching live private data or draft markers',()=>{
  const h=harness();register(h);assert.equal(typeof h.context.AlbumHavenSettingsNavigation.sanitizeHistorySnapshot,'function');
  const row={title:'Visible',canonical_track_ref:'private:canonical',inventory_track_ref:'private:inventory',track_preference:{rating:5},track_preference_state:{},can_edit_preferences:true,track_preference_overlay:{}};
  const input={albumHavenNavigationPosition:1,display:{rows:[row]},playlistDraft:{token:'legacy',scopeKey:'scope'}};
  h.navigation.writeLibraryHistory(h.location.href,input,{mode:'replace'});
  assert.deepEqual(plain(h.history.state.display.rows),[{title:'Visible'}]);assert.deepEqual(plain(h.history.state.playlistDraft),input.playlistDraft);
  assert.equal(row.canonical_track_ref,'private:canonical');assert.equal(row.can_edit_preferences,true);
  assert.equal(h.calls.confirm,0);assert.equal(h.calls.discard,0);
});
