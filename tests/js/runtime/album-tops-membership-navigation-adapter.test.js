const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {harness,deferred,settle,F}=require('./album-tops-membership-fixtures/navigation-owner-fixture.cjs');
function fixture(){
  const h=harness(),c=h.context;let token=200,current=true,answer=true;
  Object.assign(h.shell.dataset,{nativeAccountId:'account:one',nativeLibraryId:'library:one',privateUiContext:'a'.repeat(64)});
  const root=h.document.createElement('div');root.id='album-tops-root';h.shell.appendChild(root);
  Object.assign(c,{crypto:{randomUUID:()=>F.id(token++)},getLibrarySidebarMode:()=> 'album_tops',selectLibrarySidebarMode:()=>true,
    closeArtistsDrawer(){},AlbumHavenHomeRuntime:{},activeAppConfirmDialog:null,activeAppFormDialog:null});
  h.calls.nativeConfirm=0;h.calls.cancelled=0;h.calls.retired=0;
  c.showAppConfirmDialog=()=>{
    h.calls.nativeConfirm++;const pending=deferred();let finished=false;
    const owner={promise:pending.promise,cancel(){h.calls.cancelled++;if(!finished){finished=true;pending.resolve(false);}}};c.activeAppConfirmDialog=owner;
    Promise.resolve(answer).then(value=>{if(!finished){finished=true;pending.resolve(value);}});
    pending.promise.finally(()=>{if(c.activeAppConfirmDialog===owner)c.activeAppConfirmDialog=null;});return pending.promise;
  };
  for(const file of ['runtime/private-ui-transport.js','runtime/album-tops-react-bridge.js'])vm.runInContext(fs.readFileSync(path.join(F.ROOT,'music_app/static/js',file),'utf8'),c,{filename:file});
  const runtime=c.AlbumHavenAlbumTopsRuntime;
  const register=()=>{assert.equal(typeof runtime.registerDraftNavigation,'function');return runtime.registerDraftNavigation({isCurrent:()=>current,
    confirmLeave:confirm=>{assert.equal(typeof confirm,'function','Adapter supplies retained-context confirmation for popped destinations');return confirm('Discard these unsaved Album Top changes?');},
    onDiscard:()=>{h.calls.retired++;current=false;}});};
  return{...h,runtime,root,register,answer(value){answer=value;},invalidate(){current=false;}};
}

for(const value of [undefined,null,'1',NaN,Infinity])test(`Top adapter rejects unrecognized history position ${String(value)} without history or hidden-form mutation`,()=>{
  const h=fixture(),state={...h.history.state};if(value===undefined)delete state.albumHavenNavigationPosition;else state.albumHavenNavigationPosition=value;
  h.history.replaceState(state,'',h.location.href);const before=h.calls.history.length;
  assert.equal(h.register(),false);assert.equal(h.calls.history.length,before);assert.equal(h.calls.retired,0);assert.equal(h.calls.nativeConfirm,0);
});

test('Top adapter owns one existing route entry, releases idempotently, and never creates a Playlist history identity',()=>{
  const h=fixture(),before=h.calls.history.length,url=h.location.href,snapshot=structuredClone(h.history.state);
  const release=h.register();assert.equal(typeof release,'function');assert.equal(h.register(),false);
  assert.equal(h.calls.history.length,before);assert.equal(h.location.href,url);assert.deepEqual(h.history.state,snapshot);
  assert.equal(h.navigation.retainedPlaylistDraft(),null);release();release();assert.equal(h.calls.retired,0);
  assert.equal(h.runtime.deferDraftNavigation(()=>assert.fail('Released owner replayed')),false);
});

test('Top adapter holds original painted context while browser Back points at Settings, and decline restores it',async()=>{
  const h=fixture(),answer=deferred();h.entries[0].url='https://albumhaven.test/account';h.answer(answer.promise);h.register();
  h.history.go(-1);await settle();assert.equal(h.location.pathname,'/account');assert.equal(h.calls.nativeConfirm,1);
  assert.equal(h.root.hidden,false);assert.equal(h.shell.hidden,false);assert.equal(h.calls.fetch.length,0);assert.equal(h.calls.retired,0);
  answer.resolve(false);await settle();assert.equal(h.index(),1);assert.equal(h.location.pathname,'/');assert.equal(h.calls.retired,0);assert.equal(h.calls.fetch.length,0);
});

for(const change of ['scope','view','owner','unregister'])test(`Top adapter late discard after ${change} change cannot navigate`,async()=>{
  const h=fixture(),answer=deferred();h.answer(answer.promise);const release=h.register();let destination=0;
  const pending=h.runtime.deferDraftNavigation(()=>{destination++;});await settle();assert.equal(h.calls.nativeConfirm,1);
  if(change==='scope'){h.shell.dataset.nativeAccountId='account:two';h.runtime.sync();}
  else if(change==='view'){h.context.state.view={surface:{active:'album_tops'},top_ref:F.OTHER};h.runtime.sync();}
  else if(change==='owner')h.invalidate();else release();
  answer.resolve(true);await pending;assert.equal(destination,0);assert.equal(h.calls.nativeConfirm,1);
});
