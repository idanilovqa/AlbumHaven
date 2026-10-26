'use strict';
// Authored, UNRUN. Actual provider/bridge/model/panel; declared transport and DOM doubles.
// Existing historical fixtures are reused unchanged, never edited.
const test=require('node:test'),assert=require('node:assert/strict');
const {load,fixture,deferred,settle}=require('./home-friends-native-app-fixture.cjs');
const {setup}=require('./recent-scrobble-delivery-fixture.cjs');
const ID='12345678-1234-1234-1234-123456789abc',SNAP='b'.repeat(43),REF='a'.repeat(64);
const context={scopeKey:'own:1',account_ref:null,kind:'listens',period:'all'};
const state=(patch={})=>({generation:ID,state:'reading',next_page:1,...patch});
async function provider(t) {
 const {createHomeBackendProviders}=await load('backend-providers.mjs');let listener,stamp=REF;
 const h={calls:[],wait:deferred()};
 const transport={context:()=>stamp,subscribe(fn){listener=fn;return()=>{};},query:(p,q)=>p+'?'+new URLSearchParams(q),
  request(path,options){h.calls.push({path,options});return h.wait.promise;}};
 h.value=createHomeBackendProviders(transport,{runtime:{snapshot:()=>({scopeKey:context.scopeKey})}});
 h.change=()=>{stamp='c'.repeat(64);listener();};t.after(()=>h.value.dispose());return h;
}
test('closed begin command uses actual import endpoint, never scrobble endpoint',async t=>{
 const h=await provider(t),pending=h.value.lastfmHistoryCommand({...context,command:'begin',range_start:100,range_end:200,username:'discard',session_key:'discard',force:true});
 assert.equal(h.calls[0].path,'/home/activity/lastfm/import');assert.equal(h.calls[0].options.expected,REF);
 assert.deepEqual(h.calls[0].options.body,{command:'begin',range_start:100,range_end:200});
 h.wait.resolve({status:'ready',data:{...state(),raw_xml:'private',provider_username:'private'}});
 assert.deepEqual(await pending,state());
});
test('invalid ranges, foreign history, unknown commands and page cursors never dispatch',async t=>{
 const h=await provider(t);
 for(const patch of [{account_ref:'friend'},{kind:'tracks'},{command:'send'},{range_start:-1},{range_end:100+32*86400},{range_end:Math.floor(Date.now()/1000)},
 {command:'advance',generation:ID,page:0},{command:'advance',generation:ID,page:101},{command:'advance',generation:ID+'x',page:1}])
  await assert.rejects(h.value.lastfmHistoryCommand({...context,command:'begin',range_start:100,range_end:200,...patch}));
 assert.equal(h.calls.length,0);
});
test('duplicate command is blocked and transport failure never retries automatically',async t=>{
 const h=await provider(t),first=h.value.lastfmHistoryCommand({...context,command:'pending'});
 const rejected=assert.rejects(first);await assert.rejects(h.value.lastfmHistoryCommand({...context,command:'pending'}));
 h.wait.reject(new Error('connection lost'));await rejected;assert.equal(h.calls.length,1);
});
test('scope change retires late command response',async t=>{
 const h=await provider(t),first=h.value.lastfmHistoryCommand({...context,command:'pending'}),rejected=assert.rejects(first);
 h.change();assert.equal(h.calls[0].options.isCurrent(),false);h.wait.resolve({status:'ready',data:{generations:[]}});await rejected;
});
test('closed pending result rejects oversized list and malformed cursor',async t=>{
 for(const generations of [Array.from({length:5},()=>state()),[state({next_page:0})],[state({state:'accepted'})]]){
  const h=await provider(t),first=h.value.lastfmHistoryCommand({...context,command:'pending'}),rejected=assert.rejects(first);
  h.wait.resolve({status:'ready',data:{generations}});await rejected;
 }
});
test('UTC inclusive date range is bounded and rejects normalized impossible dates',async()=>{
 const {historyRange}=await load('lastfm-history-controls.mjs'),now=Date.parse('2026-10-23T12:00:00Z');
 assert.deepEqual(historyRange('2026-10-23','2026-10-23',now),{range_start:Date.parse('2026-10-23T00:00:00Z')/1000,range_end:now/1000-60});
 for(const pair of [['2026-02-30','2026-03-01'],['2026-10-23','2026-10-22'],['2026-09-01','2026-10-23'],['2026-10-24','2026-10-25'],['','2026-10-23']])assert.equal(historyRange(...pair,now),null);
});
async function wired(t,{rows=[],enabled=true,account_ref=null}={}){
 const native=setup(),ui=fixture(t),{createHomeBackendProviders}=await load('backend-providers.mjs');
 const {createHomeFriendsController}=await load('model.mjs'),{mountActivityPanel}=await load('activity.mjs');
 const h={native,ui,calls:[],wait:deferred()};
 native.context.fetch=async(path,options)=>{
  h.calls.push({path,options});
  if(options.method==='POST')return h.wait.promise;
  return {ok:true,status:200,json:async()=>({status:rows.length?'ready':'empty',account_ref,data:{rows,snapshot_ref:SNAP,next_cursor:null,
   coverage:{lastfm_observations:{enabled,connected:true,observation_state:'not_imported',complete_history:true,secret:'discard'}}}})};
 };
 const providers=createHomeBackendProviders(native.window.AlbumHavenPrivateUITransport,{runtime:native.bridge});
 const read=native.bridge.configureActivityProvider(providers),controller=createHomeFriendsController({providers:{readActivity:read}});
 controller.setScope(native.bridge.snapshot().scopeKey);await controller.loadActivity({kind:'listens',period:'all',account_ref});
 const ctx={scopeKey:controller.getSnapshot().scopeKey,account_ref,kind:'listens',period:'all'};
 const runtime={...ui.runtime,canImportLastfmHistory:native.bridge.canImportLastfmHistory,importLastfmHistory:native.bridge.importLastfmHistory,
  refreshLastfmHistory:native.bridge.refreshLastfmHistory,lastfmImportProgress:native.bridge.lastfmImportProgress};
 const panel=ui.own(mountActivityPanel(ui.host,runtime,{...ctx,value:controller.getSnapshot().activity}));
 t.after(()=>{controller.dispose();providers.dispose();});return Object.assign(h,{providers,controller,panel,ctx,runtime});
}
test('empty own history retains truthful coverage and offers explicit first import',async t=>{
 const h=await wired(t);assert.equal(h.controller.getSnapshot().activity.status,'empty');
 const coverage=h.controller.getSnapshot().activity.data.lastfm_observations;
 assert.equal(coverage.complete_history,false);assert.equal(coverage.secret,undefined);
 assert.equal(h.ui.host.querySelector('.home-activity__lastfm-history').hidden,false);
 assert.match(h.ui.host.textContent,/No range has been imported/);
 const begin=[...h.ui.host.querySelectorAll('button')].find(x=>x.textContent==='Import selected dates');assert.equal(begin.disabled,false);
 begin.dispatchEvent(new h.ui.c.Event('click',{bubbles:true}));begin.dispatchEvent(new h.ui.c.Event('click',{bubbles:true}));
 assert.equal(h.calls.filter(x=>x.options.method==='POST').length,1);
 assert.equal(JSON.parse(h.calls.at(-1).options.body).command,'begin');
 h.wait.resolve({ok:true,status:200,json:async()=>({status:'ready',data:state()})});await settle();
 assert.equal(h.calls.filter(x=>x.options.method==='POST').length,1,'no automatic page advance');
});
test('feature off has no import controls and no command authority',async t=>{
 const h=await wired(t,{enabled:false});assert.equal(h.ui.host.querySelector('.home-activity__lastfm-history').hidden,true);
 assert.equal(h.native.bridge.canImportLastfmHistory(h.ctx),false);
 await assert.rejects(h.native.bridge.importLastfmHistory({command:'pending'},h.ctx));assert.equal(h.calls.filter(x=>x.options.method==='POST').length,0);
});
test('remote observation remains metadata-only without accepted delivery badge',async t=>{
 const h=await wired(t,{rows:[{id:'activity_'+'c'.repeat(64),kind:'listen',title:'Remote',artist:'Artist',availability:'unresolved',source_readable:true,
  lastfm_observation:{source:'remote_only',correlation:'unmatched',uncertain:true,provider_username:'private'}}]});
 const row=h.controller.getSnapshot().activity.data.rows[0];assert.equal(row.scrobble_delivery,undefined);assert.equal(row.lastfm_observation.provider_username,undefined);
 assert.match(h.ui.host.textContent,/Last.fm history · metadata only/);assert.match(h.ui.host.textContent,/uncertain observation/);
 assert.equal(h.ui.host.querySelector('[data-home-activity-play]').disabled,true);
 assert.equal(h.ui.host.querySelector('[data-recent-scrobble-retry]'),null);
});
test('old own view cannot command or refresh newly selected foreign/scope history',async t=>{
 const h=await wired(t);assert.equal(h.native.bridge.canImportLastfmHistory({...h.ctx,account_ref:'friend'}),false);
 h.native.shell.dataset.nativeLibraryId='library:other';h.native.bridge.sync();
 assert.equal(h.native.bridge.canImportLastfmHistory(h.ctx),false);await assert.rejects(h.native.bridge.importLastfmHistory({command:'pending'},h.ctx));
 assert.equal(h.calls.filter(x=>x.options.method==='POST').length,0);
});

test('removed coverage hides controls and retires rendered cached progress',async t=>{
 const h=await wired(t);
 h.panel.update({...h.ctx,value:{status:'empty',data:{rows:[],snapshot_ref:SNAP,next_cursor:null}}});
 assert.equal(h.ui.host.querySelector('.home-activity__lastfm-history').hidden,true);
 for(const button of h.ui.host.querySelector('.home-activity__lastfm-history').querySelectorAll('button'))assert.equal(button.disabled,true);
});

test('read-only pending recovery preserves the current pagination receipt',async t=>{
 const {createHomeBackendProviders}=await load('backend-providers.mjs');const calls=[];
 const transport={context:()=>REF,query:(p,q)=>p+'?'+new URLSearchParams(q),request:async(path,options)=>{
  calls.push({path,options});return options.method==='POST'?{status:'ready',data:{generations:[]}}:{status:'empty',data:{snapshot_ref:SNAP,rows:[],next_cursor:null}};}};
 const value=createHomeBackendProviders(transport,{runtime:{snapshot:()=>({scopeKey:context.scopeKey})}});t.after(()=>value.dispose());
 await value.readActivity(context);await value.lastfmHistoryCommand({...context,command:'pending'});
 await value.readActivity({...context,pagination:{page:1,page_size:50}});
 assert.match(calls.at(-1).path,/snapshot_ref=/);assert.equal(calls.length,3);
});
test('coverage revocation aborts local command ownership and cannot repopulate hidden jobs',async t=>{
 const ui=fixture(t),{mountLastfmHistoryControls}=await load('lastfm-history-controls.mjs'),wait=deferred();let signal;
 const runtime={...ui.runtime,canImportLastfmHistory:()=>true,lastfmImportProgress:()=>[state()],
  importLastfmHistory:(_command,_context,value)=>{signal=value;return wait.promise;}};
 const controls=ui.own(mountLastfmHistoryControls(ui.host,runtime));
 controls.update({context,coverage:{enabled:true,connected:true,observation_state:'partial'}});
 const recover=[...ui.host.querySelectorAll('button')].find(x=>x.textContent==='Find unfinished imports');
 recover.dispatchEvent(new ui.c.Event('click',{bubbles:true}));assert.equal(signal.aborted,false);
 controls.update({context,coverage:null});assert.equal(signal.aborted,true);assert.equal(ui.host.hidden,true);
 wait.resolve({generations:[state()]});await settle();assert.doesNotMatch(ui.host.textContent,/Import 12345678/);
});
