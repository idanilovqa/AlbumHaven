const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {harness,deferred,settle,F}=require('./album-tops-membership-fixtures/navigation-owner-fixture.cjs');
function fixture(){
  const h=harness(),c=h.context,answer=deferred();let sourceCurrent=true;
  Object.assign(h.shell.dataset,{nativeAccountId:'account:one',nativeLibraryId:'library:one',privateUiContext:'a'.repeat(64)});
  const root=h.document.createElement('div');root.id='album-tops-root';h.shell.appendChild(root);h.entries[0].url='https://albumhaven.test/account';
  Object.assign(c,{crypto:{randomUUID:()=>F.id(500)},getLibrarySidebarMode:()=> 'album_tops',selectLibrarySidebarMode:()=>true,closeArtistsDrawer(){},
    AlbumHavenHomeRuntime:{},activeAppConfirmDialog:null,activeAppFormDialog:null,showAppConfirmDialog(){
      h.calls.confirm++;const owner={promise:answer.promise,cancel(){answer.resolve(false);}};c.activeAppConfirmDialog=owner;
      answer.promise.finally(()=>{if(c.activeAppConfirmDialog===owner)c.activeAppConfirmDialog=null;});return answer.promise;}});
  for(const file of ['runtime/private-ui-transport.js','runtime/album-tops-react-bridge.js'])vm.runInContext(fs.readFileSync(path.join(F.ROOT,'music_app/static/js',file),'utf8'),c,{filename:file});
  const runtime=c.AlbumHavenAlbumTopsRuntime,scope=runtime.snapshot().scopeKey;
  assert.equal(typeof runtime.registerDraftNavigation,'function');const release=runtime.registerDraftNavigation({isCurrent:()=>sourceCurrent,
    confirmLeave:confirm=>confirm('Discard source draft?'),onDiscard(){h.calls.discard++;sourceCurrent=false;}});assert.equal(typeof release,'function');
  return{...h,root,runtime,scope,answer,release};
}
test('ordinary snapshot/sync repaint during popped Settings confirmation retains the painted source context',async()=>{
  const h=fixture();h.history.go(-1);await settle();assert.equal(h.location.pathname,'/account');assert.equal(h.calls.confirm,1);
  for(let index=0;index<3;index++){const snapshot=index%2?h.runtime.sync():h.runtime.snapshot();
    assert.equal(snapshot.visible,true);assert.equal(snapshot.inLibrary,true);assert.equal(snapshot.topRef,F.TOP);assert.equal(snapshot.scopeKey,h.scope);
    assert.equal(h.root.hidden,false);assert.equal(h.calls.discard,0);assert.equal(h.calls.fetch.length,0);}
  h.answer.resolve(false);await settle();assert.equal(h.index(),1);assert.equal(h.runtime.snapshot().visible,true);assert.equal(h.calls.discard,0);
});
for(const change of ['scope','generation','view'])test(`painted-source retention never hides live ${change} invalidation`,async()=>{
  const h=fixture();h.history.go(-1);await settle();assert.equal(h.calls.confirm,1);
  if(change==='scope')h.shell.dataset.nativeLibraryId='library:two';else if(change==='generation')h.shell.dataset.privateUiContext='b'.repeat(64);else h.context.state.view={surface:{active:'album_tops'},top_ref:F.OTHER};
  h.runtime.sync();h.answer.resolve(true);await settle();assert.equal(h.calls.fetch.length,0);assert.equal(h.calls.confirm,1);
  assert.equal(h.runtime.snapshot().visible,false);assert.equal(h.calls.discard,1);
});
