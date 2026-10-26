'use strict';
// Authored, UNRUN. Real activity renderer and retry renderer; unchanged historical fixture.
const test=require('node:test'),assert=require('node:assert/strict');
const {load,fixture}=require('./home-friends-native-app-fixture.cjs');
const own={account_ref:null,kind:'listens'};
const report=state=>({state,accepted:false,proves_not_sent:false,can_resend:false,provider_snapshot_guaranteed:false});
const row=state=>({id:'event:1',kind:'listen',title:'Song',artist:'Artist',source_readable:true,availability:'local',
 scrobble_delivery:{state:'delivery_unconfirmed',next_step:'check_delivery',show_status:true},lastfm_assessment:report(state)});
test('actual uncertain assessment labels never grant native Send or accepted acknowledgement',async t=>{
 const h=fixture(t),{activityTrackRow}=await load('activity-tracks.mjs');
 const runtime={...h.runtime,canRetryRecentScrobble:()=>true,retryRecentScrobble:()=>{}};
 for(const state of ['unbound_attempt','incomplete_observation','possible_observation','ambiguous_observation','not_observed']){
  const entry=row(state),result=activityTrackRow(runtime,entry,0,own,{}),host=h.document.createElement('div');
  host.innerHTML=result.cells.title.content;
  assert.equal(host.querySelector('[data-recent-scrobble-retry]'),null,state);
  assert.match(host.textContent,/uncertain|not a confirmed|Ambiguous|does not prove/);
  assert.equal(entry.scrobble_delivery.state,'delivery_unconfirmed');
 }
});
test('actual uncertain metadata is hidden outside own visible delivery and closed non-authorizing contract',async t=>{
 const h=fixture(t),{activityTrackRow}=await load('activity-tracks.mjs');
 for(const [context,patch] of [[{account_ref:'friend',kind:'listens'},{}],[{account_ref:null,kind:'tracks'},{}],
  [own,{scrobble_delivery:{state:'accepted',next_step:'none',show_status:true}}],
  [own,{scrobble_delivery:{state:'delivery_unconfirmed',next_step:'none',show_status:false}}],
  [own,{lastfm_assessment:{...report('possible_observation'),can_resend:true}}],
  [own,{lastfm_assessment:report('<script>bad</script>')}]] ){
  const html=activityTrackRow(h.runtime,{...row('possible_observation'),...patch},0,context,{}).cells.title.content;
  assert.doesNotMatch(html,/Possible request-tuple|<script>/);
 }
});
test('actual assessment changes only title explanation and preserves native row targets and cells',async t=>{
 const h=fixture(t),{activityTrackRow}=await load('activity-tracks.mjs'),entry=row('not_observed');
 const cells={artist:{content:'Artist'},time:{content:'retained'}};
 const before=activityTrackRow(h.runtime,{...entry,lastfm_assessment:undefined},4,own,cells);
 const after=activityTrackRow(h.runtime,entry,4,own,cells);
 for(const key of ['key','className','tabIndex','ariaDisabled','dataAttributes'])assert.deepEqual(after[key],before[key]);
 for(const key of ['artist','time','number','availability','love'])assert.deepEqual(after.cells[key],before.cells[key]);
 assert.match(after.cells.title.content,/does not prove it was unsent/);
});
// Genuine bridge/model pipeline, retaining the published native fixture unchanged.
const {setup}=require('./recent-scrobble-delivery-fixture.cjs');
const {plain}=require('./home-friends-native-app-fixture.cjs');
async function pipeline(t,input,{direct=false,query={kind:'listens',period:'week'}}={}){
 const h=setup(),ui=fixture(t),{createHomeFriendsController}=await load('model.mjs');
 const read=()=>({rows:input,next_cursor:null,total_listens:input.length});
 const provider=direct?read:h.bridge.configureActivityProvider({readActivity:read});
 const controller=createHomeFriendsController({providers:{readActivity:provider}});
 controller.setScope(h.bridge.snapshot().scopeKey);t.after(()=>controller.dispose());
 await controller.loadActivity(query);
 return {h,ui,controller,rows:controller.getSnapshot().activity.data?.rows};
}
test('genuine bridge model renderer pipeline retains every closed uncertain assessment without Send',async t=>{
 const states=['unbound_attempt','incomplete_observation','possible_observation','ambiguous_observation','not_observed'];
 const input=states.map((state,i)=>({...row(state),id:'event:'+i,last_listened_at:'2026-10-23T00:00:00Z'}));
 const w=await pipeline(t,input),{activityTrackRow}=await load('activity-tracks.mjs');
 assert.equal(w.rows.length,states.length);
 assert.deepEqual(plain(w.rows.map(item=>item.lastfm_assessment)),states.map(report));
 for(const item of w.rows){
  assert.ok(Object.isFrozen(item.lastfm_assessment));
  const host=w.ui.document.createElement('div');host.innerHTML=activityTrackRow(w.ui.runtime,item,0,own,{}).cells.title.content;
  assert.match(host.textContent,/uncertain|not a confirmed|Ambiguous|does not prove/);
  assert.equal(host.querySelector('[data-recent-scrobble-retry]'),null);
 }
 assert.deepEqual(w.h.calls.reads,[],'projection invokes no HTTP or sender');
});
test('genuine bridge rejects foreign grouped unreadable and malformed uncertain assessments',async()=>{
 const base=row('possible_observation');
 const cases=[['friend:1','listens',base],[null,'tracks',base],[null,'listens',{...base,kind:'track'}],
  [null,'listens',{...base,source_readable:false}],[null,'listens',{...base,source_readable:undefined}],
  [null,'listens',{...base,allowed_actions:{can_read:false}}],
  ...[{},[],null,{...report('possible_observation'),private:'PRIVATE'},
   {...report('possible_observation'),accepted:true},{...report('possible_observation'),proves_not_sent:true},
   {...report('possible_observation'),can_resend:true},{...report('possible_observation'),provider_snapshot_guaranteed:true},
   {...report('possible_observation'),accepted:0},report('accepted')]
   .map(lastfm_assessment=>[null,'listens',{...base,lastfm_assessment}]),
  ...[{state:'accepted',next_step:'none',show_status:true},{state:'unknown',next_step:'check_connection',show_status:false}]
   .map(scrobble_delivery=>[null,'listens',{...base,scrobble_delivery}])];
 for(const [account_ref,kind,item] of cases){
  const h=setup(),read=h.bridge.configureActivityProvider({readActivity:()=>({rows:[item],next_cursor:null})});
  const result=await read({scopeKey:h.bridge.snapshot().scopeKey,account_ref,kind,period:'week'});
  assert.equal(Object.hasOwn(result.rows[0],'lastfm_assessment'),false);
  assert.doesNotMatch(JSON.stringify(result),/PRIVATE/);
 }
});
test('genuine model independently rejects assessment injection and invalid delivery semantics',async t=>{
 const base=row('possible_observation');
 const input=[{...base,id:'valid'},
  {...base,id:'extra',lastfm_assessment:{...report('possible_observation'),private:'PRIVATE'}},
  {...base,id:'send',lastfm_assessment:{...report('possible_observation'),can_resend:true}},
  {...base,id:'semantic',scrobble_delivery:{state:'delivery_unconfirmed',next_step:'retry_check',show_status:true}},
  {...base,id:'denied',source_readable:false},
  {...base,id:'missing-readable',source_readable:undefined}];
 const w=await pipeline(t,input,{direct:true});
 assert.equal(w.rows.length,input.length);
 assert.deepEqual(plain(w.rows[0].lastfm_assessment),report('possible_observation'));
 assert.ok(w.rows.slice(1).every(item=>!Object.hasOwn(item,'lastfm_assessment')));
 assert.doesNotMatch(JSON.stringify(w.rows),/PRIVATE/);
});
