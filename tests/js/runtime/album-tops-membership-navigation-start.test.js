const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {harness,deferred,settle,F}=require('./album-tops-membership-fixtures/navigation-owner-fixture.cjs');
function fixture(mode='success'){
  const h=harness(),c=h.context,events=[];let count=0;
  Object.assign(h.shell.dataset,{nativeAccountId:'account:one',nativeLibraryId:'library:one',privateUiContext:'a'.repeat(64)});
  const host=h.document.createElement('div');host.id='album-tops-root';h.shell.appendChild(host);
  Object.assign(c,{crypto:{randomUUID:()=>F.id(900+count++)},getLibrarySidebarMode:()=> 'album_tops',selectLibrarySidebarMode:()=>true,AlbumHavenHomeRuntime:{},activeAppConfirmDialog:null,activeAppFormDialog:null,
    closeArtistsDrawer(){events.push('drawer');},async fetchAndRender(url,push,request){
      const requestId=c.state.ui.activeViewRequestId=Number(c.state.ui.activeViewRequestId||0)+1;
      // Synthetic admitted-dispatch seam; the actual owner is independently covered.
      if(request.onStart?.({requestId})===false||c.state.ui.activeViewRequestId!==requestId)return false;
      let applied=false,error=null;
      try{
        events.push('request');h.calls.navigation.push(url);await Promise.resolve();
        if(mode==='error')throw Object.assign(new Error('Destination failed'),{status:503});if(mode==='false')return false;
        const payload={surface:{active:'album_tops'},top_ref:mode==='wrong-resource'?F.TOP:F.OTHER,context_ref:'a'.repeat(64)};
        if(request.shouldApplyResponse(payload)!==true)return false;c.state.view=payload;applied=true;return true;
      }catch(caught){error=caught;throw caught;}
      finally{
        // Only this admitted synthetic request owns a terminal observation.
        try{request.onSettled?.({applied,error,requestId});}catch(_error){/* Observer cannot alter its result. */}
      }
    }});
  for(const file of ['runtime/private-ui-transport.js','runtime/album-tops-react-bridge.js'])vm.runInContext(fs.readFileSync(path.join(F.ROOT,'music_app/static/js',file),'utf8'),c,{filename:file});
  return{...h,events,runtime:c.AlbumHavenAlbumTopsRuntime};
}
for(const reason of ['invalid-ref','stale-currentness','stale-request','declined-guard','busy-guard'])test(`${reason} never announces or starts a native Top destination`,async()=>{
  const h=fixture();let started=0;const options={top_ref:F.OTHER,onStart:()=>{started++;}};
  if(reason==='invalid-ref')options.top_ref='invalid';if(reason==='stale-currentness')options.isCurrent=()=>false;
  if(reason==='stale-request')options.expectedViewRequestId=99;
  if(reason.endsWith('guard'))assert.equal(typeof h.runtime.registerDraftNavigation({isCurrent:()=>true,confirmLeave:()=>false,onDiscard(){assert.fail('Blocked owner discarded');}}),'function');
  assert.equal(await h.runtime.navigate(options),false);assert.equal(started,0);assert.deepEqual(h.calls.navigation,[]);
});
for(const decision of [false,true])test(`pending discard delays onStart until the one ${decision?'accepted':'declined'} native intent is resolved`,async()=>{
  const h=fixture(),answer=deferred();let started=0;
  h.runtime.registerDraftNavigation({isCurrent:()=>true,confirmLeave:()=>answer.promise,onDiscard(){h.calls.discard++;}});
  const pending=h.runtime.navigate({top_ref:F.OTHER,onStart:()=>{started++;h.events.push('start');}});await settle();assert.equal(started,0);assert.deepEqual(h.calls.navigation,[]);
  answer.resolve(decision);assert.equal(await pending,decision);assert.equal(started,decision?1:0);assert.equal(h.calls.navigation.length,decision?1:0);
  if(decision)assert.deepEqual(h.events,['start','request','drawer']);
});
for(const mode of ['success','false','wrong-resource','error'])test(`started ${mode} destination preserves legacy return/error semantics and calls onStart once before fetch`,async()=>{
  const h=fixture(mode);let started=0;const pending=h.runtime.navigate({top_ref:F.OTHER,onStart:()=>{started++;h.events.push('start');}});
  if(mode==='error')await assert.rejects(pending,error=>error.status===503);else assert.equal(await pending,mode==='success');
  assert.equal(started,1);assert.equal(h.calls.navigation.length,1);assert.deepEqual(h.events.slice(0,2),['start','request']);
});
for(const change of ['scope','generation','view','currentness'])test(`onStart re-entrancy changing ${change} cannot launch the stale destination`,async()=>{
  const h=fixture();let started=0,current=true;
  const result=await h.runtime.navigate({top_ref:F.OTHER,isCurrent:()=>current,onStart(){started++;
    if(change==='scope')h.shell.dataset.nativeAccountId='account:two';else if(change==='generation')h.shell.dataset.privateUiContext='b'.repeat(64);
    else if(change==='view')h.context.state.view={surface:{active:'album_tops'},top_ref:F.TOP};else current=false;
  }}).catch(error=>{assert.equal(error.name,'AbortError');return false;});
  assert.equal(result,false);assert.equal(started,1);assert.deepEqual(h.calls.navigation,[]);
});
