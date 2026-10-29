'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {fixture,load,settle,deferred}=require('./home-friends-native-app-fixture.cjs');
const G='11111111-1111-4111-8111-111111111111',A='22222222-2222-4222-8222-222222222222',C='33333333-3333-4333-8333-333333333333',T='44444444-4444-4444-8444-444444444444';
const SEQUENCE=['/account/goals','/account/goals/bonus-settings','/account/goals/bonus','/account/goals'];
const INCLUDE='Weekly Goals settings';
function goalData({empty=false,due=false}={}){
 return {goal_ref:G,revision:'2',periods:Object.fromEntries(['week','month','six-months','year'].map(period=>[period,{period,top_ref:G,
  cycle:{cycle_id:C,started_at:'2020-01-01T00:00:00Z',start_date:'2020-01-01',due_date:due?'2020-01-08':'2099-01-01',timezone_name:'UTC'},
  album_refs:empty?[]:[A],manual_completed_at:empty?{}:{[A]:null},total:empty?0:1,completed:0,percent:0}])),
  albums:empty?[]:[{catalog_ref:A,title:'Personal Goal album',artist_display:'Artist',first_release_date:null,primary_type:null}],
  allowed_actions:{can_read:true,can_add:true,can_reset:true,can_complete:true,can_remove:true}};
}
function settings(enabled=false){return {settings_revision:'1',enabled,source_mode:'all_active',selected_top_refs:[],preferred_top_refs:[],album_mode:'next',unfinished_policy:'carry',selection_algorithm:'active-top-weighted-v1',normal_top_weight:1,preferred_top_weight:3};}
async function mounted(t,{enabled=false,empty=false,due=false,source=false,blockedSource=false,removed=false,retained=false}={}){
 const h=fixture(t),{mountGoalsPanel}=await load('goals.mjs'),{defaultWeeklySettings}=await load('goals-weekly-settings-model.mjs');
 h.c.crypto={randomUUID:()=>T}; const weekly={settings_revision:'1',settings:defaultWeeklySettings(),genres:[],playthroughs:source&&!blockedSource?[{top_ref:T,title:'Private Top title'}]:[]};let owner,sourceWire=null,sourceRoot,readPhase=0;
 let data=goalData({empty,due}),prefs=settings(enabled),bonus={cycle_id:C,bonus:removed?{catalog_ref:'55555555-5555-4555-8555-555555555555',present:false}:null,manual_count:empty?0:1};
 if(retained){weekly.settings.preferred_playthrough_refs=[T];prefs.source_mode='selected';prefs.selected_top_refs=[T];prefs.preferred_top_refs=[T];}
 const calls=[],sourceCalls=[],listeners=new Set(),gates=[],readWaiters=[];const first=deferred();readWaiters.push(first);
 t.after(async()=>{try{owner?.dispose();}finally{try{sourceWire?.dispose();h.c.AlbumHavenPrivateUITransport?.dispose();}finally{for(const gate of gates)gate.resolve(new Error('retired'));for(const wait of readWaiters)wait.resolve();}}await Promise.allSettled(gates.map(x=>x.promise));});
 let respondWrite=null;
 const wire={context:()=> 'a'.repeat(64),subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},async request(route,options={}){
  calls.push({route,options});let answer;
  if(route==='/account/goals/weekly-preview'){answer={albums:[],summary:[]};}
  else if(route==='/account/goals/weekly-settings'&&options.method!=='POST'){answer=weekly;}
  else if(options.method==='POST'){
   if(respondWrite)answer=await respondWrite(route,options.body);
   else{const gate=deferred();gates.push(gate);answer=await gate.promise;}
  }else if(route==='/account/goals'){answer=data;if(readPhase===3){readPhase=0;for(const wait of readWaiters.splice(0))wait.resolve();}else readPhase=1;}
  else if(route==='/account/goals/bonus-settings'){assert.equal(readPhase,1);readPhase=2;answer=prefs;}
  else if(route==='/account/goals/bonus'){assert.equal(readPhase,2);readPhase=3;answer=bonus;}
  else throw new Error(`Unexpected request ${route}`);
  if(answer instanceof Error)throw answer;
  return {status:'ready',context_ref:wire.context(),data:answer};
 }};
 if(source){
  h.c.URLSearchParams=URLSearchParams;
  h.c.fetch=async(route,options)=>{sourceCalls.push({route,options});return {ok:true,status:200,json:async()=>({status:'ready',context_ref:'b'.repeat(64),data:{tops:[{top_ref:T,title:'Private Top title',description:'',revision:'1',visibility:'private',allowed_actions:{can_read:true},top_viewer_overlay:{activity:{active:true,activity_revision:'1'}}}],allowed_actions:{},next_cursor:null}})};};
  vm.runInContext(fs.readFileSync(path.resolve(__dirname,'../../../music_app/static/js/runtime/private-ui-transport.js'),'utf8'),h.c);
  sourceRoot=h.add('bonus-source-context');sourceRoot.dataset.privateUiContext='b'.repeat(64);sourceWire=h.c.createAlbumHavenPrivateUITransport({root:sourceRoot});if(blockedSource)sourceWire.invalidate();
 }
 const header={actions:h.add('bonus-header-actions'),content:h.add('bonus-header-content')};
 owner=h.own(mountGoalsPanel(h.host,h.runtime,{transport:wire,sourceTransport:sourceWire,header,isCurrent:()=>true}));
 await first.promise;await settle();h.drain();assert.deepEqual(calls.map(x=>x.route),SEQUENCE);
 return {...h,owner,header,calls,sourceCalls,sourceWire,wire,get data(){return data;},get settings(){return prefs;},
  respond(fn){respondWrite=fn;},savePrefs(next){prefs=next;},setData(next){data=next;},
  nextRead(){const wait=deferred();readWaiters.push(wait);return wait.promise;},
  async flush(){await settle();h.drain();await settle();},
  async open(){h.click(h.named(INCLUDE));await settle();h.drain();await settle();},writes:()=>calls.filter(x=>x.options.method==='POST'&&x.route!=='/account/goals/weekly-preview')};
}
function choose(h,label,item){h.click(h.named(label));h.click(h.named(item));h.drain();}
// Superseded opt-in presentation is replaced by default5+1 settings; legacy draw/replay
// contracts remain in home-goals-actions / bonus-model / bonus-settings coverage.
test('settings action is icon-only in header, defaults5+1 and Cancel never persists',async t=>{
 const h=await mounted(t);const control=h.named(INCLUDE);assert.ok(h.header.actions.contains(control));assert.notEqual(control.getAttribute('role'),'switch');
 await h.open();assert.equal(h.form.querySelector('input[aria-label="Your picks"]').value,'5');assert.equal(h.form.querySelector('input[aria-label="Suggestions"]').value,'1');
 h.click(h.named('Cancel',h.form));await h.flush();assert.equal(h.form.hidden,true);assert.deepEqual(h.writes(),[]);
});
test('account-only settings Save explicitly persists settings without drawing',async t=>{
 const h=await mounted(t,{retained:true});await h.open();assert.equal(h.sourceCalls.length,0);
 h.respond((route,body)=>{assert.equal(route,'/account/goals/weekly-settings');assert.equal(body.settings_revision,'1');assert.equal(body.settings.manual_count,5);assert.deepEqual(body.settings.preferred_playthrough_refs,[T]);return {ok:true};});
 h.click(h.named('Save',h.form));await h.flush();assert.equal(h.form.hidden,true);assert.equal(h.writes().length,1);assert.equal(h.calls.some(x=>x.route==='/account/goals/weekly-draw'),false);
});
test('initial source context failure leaves account Goals and settings usable',async t=>{
 const h=await mounted(t,{source:true,blockedSource:true});assert.throws(()=>h.sourceWire.context(),/Reload/);assert.match(h.host.textContent,/Personal Goal album/);await h.open();assert.equal(h.sourceCalls.length,0);assert.equal(h.named('Save',h.form).disabled,false);assert.deepEqual(h.writes(),[]);
});
test('source invalidation immediately removes private settings titles without erasing account Goals',async t=>{
 const h=await mounted(t,{source:true});await h.open();assert.match(h.form.textContent,/Private Top title/);
 h.sourceWire.invalidate();assert.throws(()=>h.sourceWire.context(),/Reload/);assert.doesNotMatch(h.form.textContent,/Private Top title/);assert.match(h.host.textContent,/Personal Goal album/);await h.flush();assert.equal(h.form.hidden,true);assert.deepEqual(h.writes(),[]);
});
test('dirty settings cannot admit suggestions from another selected period',async t=>{
 const h=await mounted(t,{source:true,removed:true});choose(h,'Period: 1 week','1 month');await h.open();
 const input=h.form.querySelector('input[aria-label="Suggestions"]');input.value='2';input.dispatchEvent(new h.c.Event('change',{bubbles:true}));await h.flush();
 assert.equal(h.named('Add suggestions',h.form).disabled,true);assert.deepEqual(h.writes(),[]);
});
test('explicit weekly draw acknowledges empty pool without another random request',async t=>{
 const h=await mounted(t,{source:true});choose(h,'Period: 1 week','1 month');await h.open();const draw=h.named('Add suggestions',h.form);assert.equal(draw.disabled,false);
 const read=h.nextRead();h.respond((route,body)=>{assert.equal(route,'/account/goals/weekly-draw');assert.equal(body.expected_cycle_id,C);assert.equal(body.revision,'2');return {ok:true,action:'weekly_draw',request_key:body.request_key,changed:false,reason:'no_eligible_source',goal_ref:G,revision:'2',period:'week',cycle_id:C,catalog_refs:[]};});
 h.click(draw);await read;await h.flush();assert.match(h.host.textContent,/No eligible unfinished album/);assert.equal(h.writes().length,1);assert.equal(h.named('Retry'),undefined);assert.deepEqual(h.calls.slice(-4).map(x=>x.route),SEQUENCE);
});
test('due Reset Choice displays selected next-period operation before explicit transition',async t=>{
 const h=await mounted(t,{due:true});h.click(h.named('Reset'));assert.ok(h.named('Period action: Restart these albums'));choose(h,'Period action: Restart these albums','Start next period');assert.ok(h.named('Period action: Start next period'));const submit=h.named('Start next period',h.form);assert.ok(submit);assert.deepEqual(h.writes(),[]);h.click(submit);await h.flush();const writes=h.writes();assert.equal(writes.length,1);assert.equal(writes[0].route,'/account/goals/transition');assert.equal(writes[0].options.body.period,'week');assert.equal(writes[0].options.body.expected_cycle_id,C);assert.equal(writes[0].options.body.settings_revision,'1');
});
test('switching due Reset choice back preserves exact restart endpoint',async t=>{
 const h=await mounted(t,{due:true});h.click(h.named('Reset'));choose(h,'Period action: Restart these albums','Start next period');choose(h,'Period action: Start next period','Restart these albums');assert.ok(h.named('Period action: Restart these albums'));h.click(h.named('Restart these albums',h.form));await h.flush();assert.equal(h.writes().length,1);assert.equal(h.writes()[0].route,'/account/goals/reset');assert.equal(h.writes()[0].options.body.period,'week');
});
test('empty due cycle reuses Reset without adding a new header action',async t=>{
 const h=await mounted(t,{due:true,empty:true});assert.ok(h.named('Reset'));assert.equal(h.header.actions.querySelectorAll('button').filter(x=>!x.closest('[hidden]')).length,3);h.click(h.named('Reset'));assert.ok(h.named('Period action: Restart these albums'));h.click(h.named('Cancel',h.form));assert.deepEqual(h.writes(),[]);
});
test('period change retires retained settings Save without a write',async t=>{
 const h=await mounted(t);await h.open();const saved=h.named('Save',h.form);choose(h,'Period: 1 week','1 month');h.click(saved);assert.equal(h.form.hidden,true);assert.deepEqual(h.writes(),[]);
});
test('due-date advice uses captured timezone and year boundary without implicit transition',async()=>{
 const {isGoalCycleDue}=await load('goals.mjs');const cycle={due_date:'2027-01-01',timezone_name:'America/Los_Angeles'};
 assert.equal(isGoalCycleDue(cycle,new Date('2027-01-01T07:59:59Z')),false);assert.equal(isGoalCycleDue(cycle,new Date('2027-01-01T08:00:00Z')),true);assert.equal(isGoalCycleDue({...cycle,timezone_name:'invalid'},new Date()),false);
});
