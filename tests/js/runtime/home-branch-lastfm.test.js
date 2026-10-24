'use strict';
// Authored, UNRUN. Uses this branch's genuine React source compilation convention.
// Hook probes disclose lifecycle doubles; they are not browser/React reconciliation proof.
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),vm=require('node:vm');
const {pathToFileURL}=require('node:url');
const React=require('react'),{buildSync}=require('esbuild');
const {setup}=require('./recent-scrobble-delivery-fixture.cjs');
const {createNativeHomeRuntime}=require('./native-home-harness.cjs');
const root=path.resolve(__dirname,'../../..');
function compile(name,react=React){
 const code=buildSync({entryPoints:[path.join(root,'music_app/static/js/home-friends',name)],bundle:true,
  platform:'node',format:'cjs',write:false,external:['react','react-dom']}).outputFiles[0].text;
 const module={exports:{}};vm.runInNewContext(code,{module,exports:module.exports,
  require:name=>name==='react'?react:require(name),console,AbortController,Date});return module.exports;
}
const report=state=>({state,accepted:false,proves_not_sent:false,can_resend:false,provider_snapshot_guaranteed:false});
const own={account_ref:null,kind:'listens',period:'all'};
const row=(id,state='delivery_unconfirmed')=>({id,kind:'listen',title:'Song',artist:'Artist',source_readable:true,
 availability:'local',scrobble_delivery:{state,next_step:state==='not_sent'?'retry_check':'check_delivery',show_status:true},
 lastfm_assessment:report('possible_observation')});
const elements=node=>React.isValidElement(node)?[node,...React.Children.toArray(node.props.children).flatMap(elements)]:[];
function controls(runtime,context={scopeKey:'own',...own},coverage={enabled:true,connected:true,observation_state:'partial'}){
 const slots=[];let cursor=0,effects=[],tree;
 const changed=(old,deps)=>!old||deps.some((v,i)=>!Object.is(v,old.deps[i]));
 const hooks={...React,useRef(value){return slots[cursor++]||=( {current:value});},
  useState(value){const i=cursor++;slots[i]||={value:typeof value==='function'?value():value};
   return [slots[i].value,next=>{slots[i].value=typeof next==='function'?next(slots[i].value):next;}];},
  useLayoutEffect(effect,deps){const i=cursor++,old=slots[i];if(changed(old,deps))effects.push(()=>{old?.cleanup?.();slots[i]={deps,cleanup:effect()};});}};
 const module=compile('lastfm-history-controls.jsx',hooks);
 function render(){cursor=0;effects=[];const wrapper=module.LastfmHistoryControls({runtime,context,coverage});
  tree=wrapper?wrapper.type(wrapper.props):null;for(const effect of effects)effect();return tree;}
 render();render();
 return {render,buttons:()=>elements(tree).filter(e=>e.type?.name==='Button'),
  click(label){const button=this.buttons().find(e=>e.props.children===label);assert.ok(button,label);button.props.onClick();},
  dispose(){for(const slot of slots)slot?.cleanup?.();},module};
}
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
test('Home React branch actual bridge model JSX row retains uncertain report without Send',async t=>{
 const bridge=setup(),{createHomeFriendsController}=await import(pathToFileURL(path.join(root,'music_app/static/js/home-friends/model.mjs')));
 const provider=bridge.bridge.configureActivityProvider({readActivity:()=>({rows:[row('event:1')],next_cursor:null,coverage:{lastfm_observations:{enabled:true,connected:true,observation_state:'partial'}}})});
 const model=createHomeFriendsController({providers:{readActivity:provider}});t.after(()=>model.dispose());
 model.setScope(bridge.bridge.snapshot().scopeKey);await model.loadActivity(own);
 const actual=model.getSnapshot().activity.data.rows[0];assert.equal(actual.lastfm_assessment.state,'possible_observation');
 const native=createNativeHomeRuntime(),{activityTrackRow}=compile('activity-tracks.jsx');
 bridge.context.ButtonComponent=native.context.ButtonComponent;
 const runtime={iconHtml:bridge.bridge.iconHtml,escapeHtml:native.context.escapeHtml,artboxHtml:()=>'',actionHtml:()=>'',albumTrackRow:()=>null};
 const html=activityTrackRow(runtime,actual,0,own,{}).cells.title.content;
 assert.match(html,/not a confirmed acknowledgement/);assert.doesNotMatch(html,/data-recent-scrobble-retry/);
 const panel=activityLifecycle();t.after(()=>panel.dispose());
 const tree=panel.render({kind:'listens',account_ref:null,period:'all',value:model.getSnapshot().activity});
 const controls=elements(tree).find(e=>e.type?.name==='LastfmHistoryControls');
 assert.equal(controls.props.coverage.enabled,true);assert.equal(controls.props.coverage.observation_state,'partial');
});
test('Home React import controls stay absent for friend grouped or revoked coverage',()=>{
 const {LastfmHistoryControls}=compile('lastfm-history-controls.jsx');
 for(const [context,coverage] of [[{...own,account_ref:'friend'}, {enabled:true}],
  [{...own,kind:'tracks'},{enabled:true}],[own,{enabled:false}]])assert.equal(LastfmHistoryControls({runtime:{},context,coverage}),null);
});
test('Home React AllTime start is one explicit command and never auto advances',async t=>{
 const calls=[],refresh=[];const h=controls({canImportLastfmHistory:()=>true,lastfmImportProgress:()=>[],
  importLastfmHistory:async payload=>{calls.push(payload);return {plan:'plan:1',revision:1,state:'active',upper_cut:100,cursor_end:99,completed_windows:0,next_allowed_at:'later'};},
  refreshLastfmHistory:context=>refresh.push(context)});t.after(()=>h.dispose());
 assert.equal(calls.length,0);h.click('Start or recover All Time import');await flush();h.render();
 assert.deepEqual(JSON.parse(JSON.stringify(calls)),[{command:'backfill_begin'}]);assert.equal(refresh.length,1);
 assert.ok(h.buttons().some(e=>e.props.children==='Read next All Time page'));
});
test('Home React AllTime advance retains exact plan revision and suppresses duplicate click',async t=>{
 let settle;const wait=new Promise(resolve=>{settle=resolve;}),calls=[];
 const plan={plan:'plan:1',revision:8,state:'active',upper_cut:100,cursor_end:99,completed_windows:2,next_allowed_at:'later'};
 const h=controls({canImportLastfmHistory:()=>true,lastfmImportProgress:()=>[plan],importLastfmHistory:payload=>{calls.push(payload);return wait;}});t.after(()=>h.dispose());
 h.click('Read next All Time page');h.click('Read next All Time page');h.render();
 assert.deepEqual(JSON.parse(JSON.stringify(calls)),[{command:'backfill_advance',plan:'plan:1',revision:8}]);assert.ok(h.buttons().every(e=>e.props.disabled));
 settle({...plan,revision:9});await flush();h.render();assert.equal(calls.length,1);
});
test('Home React pending recovery does not retire current Home pagination',async t=>{
 let refresh=0;const h=controls({canImportLastfmHistory:()=>true,lastfmImportProgress:()=>[],
  importLastfmHistory:async()=>({generations:[]}),refreshLastfmHistory:()=>{refresh++;}});t.after(()=>h.dispose());
 h.click('Find unfinished imports');await flush();h.render();assert.equal(refresh,0);
});
test('Home React disposed import aborts local request and suppresses stale result refresh',async()=>{
 let settle,signal,refresh=0;const wait=new Promise(resolve=>{settle=resolve;});
 const h=controls({canImportLastfmHistory:()=>true,lastfmImportProgress:()=>[],
  importLastfmHistory:(_payload,_context,s)=>{signal=s;return wait;},refreshLastfmHistory:()=>{refresh++;}});
 h.click('Start or recover All Time import');h.dispose();assert.equal(signal.aborted,true);
 settle({plan:'plan:1',revision:1,state:'active'});await flush();assert.equal(refresh,0);
});
test('Home React import controls fail closed when current capability or connection is absent',()=>{
 for(const [capability,connected] of [[false,true],[true,false]]){
  let calls=0;const h=controls({canImportLastfmHistory:()=>capability,lastfmImportProgress:()=>[],importLastfmHistory:()=>{calls++;}},
   {scopeKey:'own',...own},{enabled:true,connected});
  assert.ok(h.buttons().every(e=>e.props.disabled));h.click('Start or recover All Time import');assert.equal(calls,0);h.dispose();
 }
});
test('Home React finite date range rejects invalid dates future-only and oversized ranges',()=>{
 const {historyRange}=compile('lastfm-history-controls.jsx');const now=Date.parse('2026-10-23T12:00:00Z');
 assert.equal(historyRange('2026-02-30','2026-03-01',now),null);
 assert.equal(historyRange('2026-01-01','2026-10-01',now),null);
 assert.equal(historyRange('2026-10-24','2026-10-24',now),null);
 assert.equal(historyRange('2026-10-23','2026-10-23',now).range_end,now/1000-60);
});

const {activityLifecycle,ready}=require('./home-lastfm-react-fixture.cjs');
test('Home React ActivityPanel genuine retry click submits only known-not-sent once',async t=>{
 let calls=0,pending=false;
 const fixture=activityLifecycle({canRetryRecentScrobble:()=>!pending,retryRecentScrobble:()=>{pending=true;calls++;return Promise.resolve();}});
 t.after(()=>fixture.dispose());const item=row('retry','not_sent');
 fixture.render({kind:'listens',account_ref:null,period:'all',value:ready([item])});
 const button=fixture.host.querySelector('[data-recent-scrobble-retry]');assert.ok(button);
 fixture.emit('onClick',button);fixture.emit('onClick',button);await flush();assert.equal(calls,1);
 assert.equal(button.disabled,true);
});
test('Home React ActivityPanel uncertain assessment never creates retry interaction',t=>{
 let calls=0;const fixture=activityLifecycle({canRetryRecentScrobble:()=>true,retryRecentScrobble:()=>{calls++;}});
 t.after(()=>fixture.dispose());fixture.render({kind:'listens',account_ref:null,period:'all',value:ready([row('uncertain')])});
 assert.equal(fixture.host.querySelector('[data-recent-scrobble-retry]'),null);
 assert.match(fixture.host.textContent,/not a confirmed acknowledgement/);assert.equal(calls,0);
});

test('Home genuine runtime exposes the shared icon renderer for delivery status',()=>{
 const f=setup(),native=createNativeHomeRuntime();f.context.ButtonComponent=native.context.ButtonComponent;
 assert.equal(typeof f.bridge.iconHtml,'function');
 assert.equal(f.bridge.iconHtml('more'),native.context.ButtonComponent.renderIconSvg('more'));
 assert.match(f.bridge.iconHtml('more'),/<svg/);
});

test('Home delivery statuses and retry use only genuine shared registry icons',async()=>{
 const f=setup(),native=createNativeHomeRuntime();f.context.ButtonComponent=native.context.ButtonComponent;
 const runtime={iconHtml:f.bridge.iconHtml,actionHtml:f.bridge.actionHtml,escapeHtml:native.context.escapeHtml,
  canRetryRecentScrobble:()=>true,retryRecentScrobble:()=>{}};
 const {recentScrobbleDeliveryHtml,recentScrobbleRetryHtml}=await import(pathToFileURL(path.join(root,'music_app/static/js/home-friends/recent-scrobble-delivery.mjs')));
 for(const state of ['not_eligible','unknown','accepted','delivery_unconfirmed','not_sent','reauthentication_required','rejected','retry_exhausted']){
  const item={...row(state),scrobble_delivery:{state,next_step:state==='not_sent'?'retry_check':'none',show_status:true}};
  const html=recentScrobbleDeliveryHtml(runtime,item,own);assert.match(html,/<svg/);assert.ok(html.includes(`data-recent-scrobble-delivery="${state}"`));
  const retry=recentScrobbleRetryHtml(runtime,item,own);
  if(state==='not_sent'){assert.match(retry,/<svg/);assert.match(retry,/Send this play to Last.fm/);}else assert.equal(retry,'');
 }
});
