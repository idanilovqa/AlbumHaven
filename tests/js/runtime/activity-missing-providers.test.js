const test = require('node:test');
const assert = require('node:assert/strict');
const id = number => `00000000-0000-4000-8000-${String(number).padStart(12,'0')}`;
const actor_scope = {account_id: 4, library_id: 5};
const source = {kind: 'activity', ref: id(1), revision: id(2)};
const allowed_actions = {can_read: true, can_use_for_playlist: true};
const protocol = 'missing_activity_selection_v1';
const origin = {audience:'own',subject_ref:null,kind:'listens',period:'week',snapshot_ref:'s'.repeat(43)};
const options = {scopeKey:'scope:one', origin, row_refs:null};
const response = () => ({status:'ready',data:{source,actor_scope,source_protocol:protocol,mode:'missing',capture_ref:id(1),
  title:'Recent activity · Missing tracks', allowed_actions,entries_complete:true,retained_parent_albums:[],
  entries:[3,4].map(number => ({entry_ref:id(number),title:`Original ${number}`,availability:'missing',
    source_row_ref:`activity_${String(number).repeat(64)}`,inventory_track_ref:'inventory-track:5:11',
    allowed_actions:{can_read:true,can_select:true},parent_album:{state:'unknown'}}))}});
let create, normalize, prepare, draftController;
test.before(async()=>{
  ({createPlaylistBackendProviders:create}=await import('../../../music_app/static/js/playlists/backend-providers.mjs'));
  ({normalizeCreationResult:normalize,prepareMissingDraft:prepare}=await import('../../../music_app/static/js/playlists/creation.mjs'));
  ({createMissingPlaylistDraftController:draftController}=await import('../../../music_app/static/js/playlists/draft.mjs'));
});
function fixture(custom){
  const calls=[];let context='one';
  const transport={context:()=>context,query:(path,params)=>`${path}?${new URLSearchParams(params)}`,
    async request(path,opts={}){calls.push({path,...opts});if(custom){const value=await custom(path,opts);if(value!==undefined)return value;}
      if(path.endsWith('/eligibility'))return {status:'ready',data:{can_inspect_missing:true,missing_count:2,actor_scope}};
      if(path.startsWith('/playlists/creation-source/activity-missing'))return response();
      if(path==='/playlists')return {status:'ready',data:{ok:true,action:'create',request_key:opts.body.request_key,
        playlist_id:id(8),revision:'1',changed:true,actor_scope}};
      throw new Error(`Unexpected ${path}`);}};
  return {calls,providers:create({transport,runtime:{acceptsPrivateScope:key=>key==='scope:one'}}),change:()=>{context='two';}};
}
async function begin(f){
  const opened=await f.providers.beginActivityMissingSource(options);
  const context={scopeKey:options.scopeKey,mode:'missing',canCreate:true,source:opened.source};
  const normalized=normalize(opened.resource,context);
  assert.equal(normalized.status,'ready');
  const prepared=prepare({...context,sourceResource:normalized,mutation:{status:'idle'},title:'Missing activity',description:'',
    selectedKeys:normalized.data.entries.map(row=>row.row_key)});
  return draftController({prepared,providers:f.providers});
}
test('eligibility is read only and full source capture keeps Activity receipt and repeated occurrences',async()=>{
  const f=fixture();assert.equal((await f.providers.readActivityMissingEligibility(options)).missing_count,2);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].path,'/playlists/creation-source/activity-missing/eligibility');
  const draft=await begin(f);assert.equal(draft.getSnapshot().entries.length,2);assert.equal(draft.canSave(),true);
  assert.equal(f.calls.some(call=>call.path==='/playlists'),false);
  assert.deepEqual(f.calls.at(-1).body,{origin,row_refs:null});
  await draft.save();const write=f.calls.at(-1);assert.equal(write.path,'/playlists');
  assert.deepEqual(write.body.source,source);assert.equal(write.body.source_protocol,protocol);assert.equal(write.body.mode,'missing');
  assert.deepEqual(write.body.entry_refs,[id(3),id(4)]);
});
test('retained Reload never captures again and preserves removed or explicitly empty authorship',async()=>{
  let accepted=false;const f=fixture(path=>{
    if(path.includes('activity-missing?')){const value=response();if(accepted){Object.assign(value.data.entries[1],{availability:'local',match_state:'accepted'});}return value;}
  });const draft=await begin(f);draft.remove(draft.getSnapshot().entries[0].row_key);accepted=true;
  assert.equal(await draft.refresh(),true);assert.deepEqual(draft.getSnapshot().entries.map(row=>row.entry_ref),[id(4)]);
  assert.doesNotMatch(draft.exportText(),/Original 4/);
  draft.remove(draft.getSnapshot().entries[0].row_key);assert.equal(await draft.refresh(),true);assert.equal(draft.getSnapshot().entries.length,0);
  assert.equal(f.calls.filter(call=>call.method==='POST').length,1);
  assert.equal(f.calls.filter(call=>call.path.includes('activity-missing?')).length,2);
});
test('ordinary activity cannot acquire Missing draft authority',()=>{
  const context={scopeKey:'scope:one',canCreate:true,mode:'missing',source:{...source,allowed_actions,source_protocol:'complete_activity_selection_v1'}};
  assert.equal(normalize({...response(),data:{...response().data,scopeKey:'scope:one'}},context).status,'denied');
});
test('capture rejects unconfirmed or accepted-present entries before handing off',async()=>{
  for(const availability of ['unresolved','local']){
    const f=fixture(path=>{if(path.endsWith('activity-missing')){const value=response();value.data.entries[0].availability=availability;return value;}});
    await assert.rejects(f.providers.beginActivityMissingSource(options));
  }
});
test('selected capture sends occurrence identities unchanged and never substitutes full source',async()=>{
  const f=fixture(),row_refs=['activity_'+'4'.repeat(64),'activity_'+'3'.repeat(64)];
  await f.providers.beginActivityMissingSource({...options,row_refs});assert.deepEqual(f.calls[0].body.row_refs,row_refs);
  await assert.rejects(f.providers.beginActivityMissingSource({...options,row_refs:[]}));assert.equal(f.calls.length,1);
});
test('expired or revoked retained source stays failed and never opens fresh capture',async()=>{
  const f=fixture(path=>{if(path.includes('activity-missing?'))throw Object.assign(new Error('Denied'),{status:403});});
  const draft=await begin(f);assert.equal(await draft.refresh(),false);assert.equal(draft.getSnapshot().sourceResource.status,'denied');
  assert.equal(f.calls.filter(call=>call.method==='POST').length,1);
});
test('context change retires the cached capture rather than rebinding it',async()=>{
  const f=fixture(),opened=await f.providers.beginActivityMissingSource(options);f.change();
  await assert.rejects(f.providers.readPlaylistCreationSource({...options,mode:'missing',source:opened.source,retain_capture:true}));
  assert.equal(f.calls.length,1);
});

test('Activity TXT validates current source rights before releasing any bytes',async()=>{
  let denied=false;const f=fixture(path=>{if(denied&&path.includes('activity-missing?'))throw Object.assign(new Error('Revoked'),{status:403});});
  const draft=await begin(f);draft.remove(draft.getSnapshot().entries[0].row_key);
  const text=await draft.prepareExportText();assert.match(text,/Original 4/);assert.doesNotMatch(text,/Original 3/);
  assert.equal(f.calls.filter(call=>call.path.includes('activity-missing?')).length,1);
  denied=true;assert.equal(await draft.prepareExportText(),null);assert.equal(draft.getSnapshot().entries.length,0);
  assert.equal(f.calls.filter(call=>call.method==='POST').length,1);
});

test('only the exact Activity Missing transport rejection proves source denial', async()=>{
  for(const method of ['readActivityMissingEligibility','beginActivityMissingSource']) {
    const failure=Object.assign(new Error('Source denied'),{status:403,code:'source_unavailable',responseRejected:true});
    const f=fixture(()=>{throw failure;}), proof=[];
    await assert.rejects(f.providers[method]({...options,onSourceDenied:error=>proof.push(error)}),error=>error===failure);
    assert.deepEqual(proof,[failure]);assert.equal(f.calls.length,1);
  }
});
test('Missing source proof excludes generic denial, expiry, network and malformed success',async()=>{
  for(const failure of [Object.assign(new Error('Create denied'),{status:403,code:'forbidden',responseRejected:true}),
    Object.assign(new Error('Expired'),{status:410,code:'source_expired',responseRejected:true}),new TypeError('Network'),null]) {
    const f=fixture(()=>{if(failure)throw failure;return {status:'ready',data:{}};}),proof=[];
    await assert.rejects(f.providers.beginActivityMissingSource({...options,onSourceDenied:error=>proof.push(error)}));
    assert.deepEqual(proof,[]);
  }
});
test('typed denial from uncertain Create recovery never proves current Missing source denial',async()=>{
  let recoveryDenied=false;
  const failure=Object.assign(new Error('Prior source denied'),{status:403,code:'source_unavailable',responseRejected:true});
  const f=fixture((path,request)=>{
    if(path==='/playlists'&&request.method==='POST')throw TypeError('Lost write');
    if(path.startsWith('/playlists/operations/')){if(recoveryDenied)throw failure;return {status:'unknown'};}
  });
  await f.providers.beginActivityMissingSource(options);
  await assert.rejects(f.providers.createPlaylistFromSelection({...options,source,source_protocol:protocol,mode:'missing',
    title:'Prior',description:'',entry_refs:[id(3)],request_key:id(77)}));
  recoveryDenied=true;const before=f.calls.length,proof=[];
  await assert.rejects(f.providers.beginActivityMissingSource({...options,onSourceDenied:error=>proof.push(error)}),error=>error===failure);
  assert.deepEqual(proof,[]);
  assert.equal(f.calls.slice(before).some(call=>call.path==='/playlists/creation-source/activity-missing'),false);
});
