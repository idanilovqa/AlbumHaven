'use strict';
const nativeTest=require('node:test'),test=(name,run)=>nativeTest(name,{timeout:10000},run),assert=require('node:assert/strict'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const {entryEnvironment,nativeShell,drain}=require('./native-entry-fixtures/actual-native-runtime.cjs');
const {attentionReadFixture}=require('./goals-attention-read-fixture.cjs');
const {installPrivateContext}=require('./private-context-harness.cjs');
const fs=require('node:fs'),vm=require('node:vm');
const G='11111111-1111-4111-8111-111111111111',A='22222222-2222-4222-8222-222222222222';let sequence=0;
function data(){return {goal_ref:G,revision:'2',allowed_actions:{can_read:true,can_add:true,can_complete:true,can_remove:true,can_reset:true},
 albums:[{catalog_ref:A,title:'Retained Goal album',artist_display:'Artist',first_release_date:null,primary_type:null}],
 periods:Object.fromEntries(['week','month','six-months','year'].map((period,index)=>[period,{period,top_ref:G,cycle:{cycle_id:`33333333-3333-4333-8333-${String(index+1).padStart(12,'0')}`,started_at:'2026-10-14T00:00:00Z',start_date:'2026-10-14',due_date:'2099-01-01',timezone_name:'UTC'},album_refs:[A],manual_completed_at:{[A]:null},total:1,completed:0}]))};}
function canonicalRestoration(env) {
 const c=env.context,host=env.add('mobile-home'),writes=[];
 // Browser history and outer shell are platform inputs. The complete bridge,
 // its sanitizer, save operation and snapshot read remain production code.
 c.location={href:'https://albumhaven.test/?mobile_page=home'};
 c.history={state:{albumHavenNavigationPosition:7},replaceState(value){this.state=JSON.parse(JSON.stringify(value));writes.push(this.state);}};
 c.state={view:null};c.shouldShowMobileHome=()=>!host.hidden;
 installPrivateContext(c);
 vm.runInContext(fs.readFileSync(path.resolve(__dirname,'../../../music_app/static/js/runtime/home-friends-bridge.js'),'utf8'),c,{filename:'home-friends-bridge.js'});
 const bridge=c.AlbumHavenHomeRuntime,initial=bridge.snapshot();assert.equal(initial.visible,true);assert.equal(initial.entryKey,7);
 assert.equal(bridge.savePresentation({homeSection:'goals',visitIntent:{explicit:true},pendingToken:{secret:true}},initial),true);
 assert.equal(writes.length,1);const saved=JSON.parse(JSON.stringify(c.history.state));
 assert.equal(saved.homeFriendsPresentation.value.homeSection,'goals');
 assert.equal(Object.hasOwn(saved.homeFriendsPresentation.value,'visitIntent'),false);
 assert.equal(Object.hasOwn(saved.homeFriendsPresentation.value,'pendingToken'),false);
 c.history.replaceState({albumHavenNavigationPosition:8});assert.equal(bridge.snapshot().presentation,null);
 c.history.replaceState(saved);const restored=bridge.snapshot();
 assert.equal(restored.entryKey,7);assert.equal(restored.presentation.homeSection,'goals');
 assert.equal(restored.scopeKey,initial.scopeKey);
 return restored.presentation;
}
async function mounted(t,{restored=false,authenticated=true,canonicalRestore=false}={}){
 const env=entryEnvironment(t),saved=canonicalRestore?canonicalRestoration(env):restored?{homeSection:'goals'}:null;
 const home=nativeShell(env,{visible:false,authenticated,presentation:saved}),value=data();
 const host=env.add('home-friends-root'),reads=attentionReadFixture(t,()=>value),listeners=new Set();let retired=false;
 t.after(()=>{retired=true;home.change({visible:false,authenticated:false,scopeKey:null});});
 env.context.AlbumHavenHomeRuntime=home.runtime;
 home.runtime.switchHtml=env.owner('buildGallerySwitchHtml');
 const wire={context:()=> 'a'.repeat(64),subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},async request(route,options={}){
  const attention=reads.dispatch(route,options);if(attention.handled)return {status:'ready',context_ref:wire.context(),data:attention.data};
  let result;if(route==='/account/goals')result=value;
  else if(route==='/account/goals/bonus-settings')result={settings_revision:'1',enabled:false,source_mode:'all_active',selected_top_refs:[],preferred_top_refs:[],album_mode:'next',unfinished_policy:'carry',selection_algorithm:'active-top-weighted-v1',normal_top_weight:1,preferred_top_weight:3};
  else if(route==='/account/goals/bonus')result={cycle_id:value.periods.week.cycle.cycle_id,bonus:null,manual_count:1};
  else throw new Error('Unexpected Goals endpoint '+route);
  return {status:'ready',context_ref:wire.context(),data:result};
 }};
 env.context.AlbumHavenPrivateUITransport=wire;
 await import(`${pathToFileURL(path.resolve(__dirname,'../../../music_app/static/js/home-friends/index-native.mjs')).href}?attention-entry=${++sequence}`);
 env.context.AlbumHavenHomeUI.configureProviders({});home.change({visible:true});await drain();await drain();
 return {...env,home,host,reads,listeners,tab:key=>host.querySelector(`[data-in-page-tab="${key}"]`),async flush(){await drain();await drain();},
  writes:()=>reads.allRequests.filter(x=>x.options.method==='POST')};
}
test('real Home off-tab entry reads only bounded attention and shows canonical blue marker',async t=>{
 const h=await mounted(t);assert.deepEqual(h.reads.allRequests.map(x=>x.route),['/account/goals/attention']);assert.deepEqual(h.writes(),[]);
 assert.equal(h.tab('goals').getAttribute('aria-label'),'Goals, new weekly goals');assert.equal(h.host.querySelector('.album-card'),null);
});
test('real Home saved Goals restoration hydrates quietly with zero POST',async t=>{
 const h=await mounted(t,{restored:true});assert.match(h.host.textContent,/Retained Goal album/);assert.deepEqual(h.writes(),[]);
 assert.equal(h.reads.allRequests.filter(x=>x.route==='/account/goals').length,2);
});
test('real Home explicit Goals tab acknowledges once and entry replacement borrows existing full owner',async t=>{
 const h=await mounted(t);h.click(h.tab('goals'));await h.flush();await h.flush();assert.equal(h.writes().length,1);
 const before=h.reads.allRequests.filter(x=>x.route==='/account/goals').length;assert.equal(before,2);
 h.home.change({entryKey:'replacement',presentation:{homeSection:'goals'}});await h.flush();
 assert.match(h.host.textContent,/Retained Goal album/);assert.equal(h.reads.allRequests.filter(x=>x.route==='/account/goals').length,before);assert.equal(h.writes().length,1);
 h.click(h.tab('recent'));await h.flush();h.click(h.tab('goals'));await h.flush();assert.equal(h.writes().length,1);assert.equal(h.reads.allRequests.filter(x=>x.route==='/account/goals').length,before);
});
test('real Home keyboard selection enters Goals through canonical tabs',async t=>{
 const h=await mounted(t),recent=h.tab('recent');recent.focus();const event=new h.context.Event('keydown',{bubbles:true,cancelable:true});event.key='End';recent.dispatchEvent(event);
 await h.flush();await h.flush();assert.equal(h.tab('goals').getAttribute('aria-selected'),'true');assert.equal(h.writes().length,1);
});

test('unauthenticated Home never starts private Goals attention or exposes its tab',async t=>{
 const h=await mounted(t,{authenticated:false});assert.deepEqual(h.reads.allRequests,[]);assert.equal(h.tab('goals'),null);
});

test('canonical bridge history save/read roundtrip restores Goals quietly through the native entry',async t=>{
 const h=await mounted(t,{canonicalRestore:true});
 assert.equal(h.tab('goals').getAttribute('aria-selected'),'true');assert.match(h.host.textContent,/Retained Goal album/);
 assert.equal(h.context.history.state.homeFriendsPresentation.value.homeSection,'goals');
 assert.deepEqual(h.writes(),[]);assert.equal(h.reads.allRequests.filter(x=>x.route==='/account/goals').length,2);
 const prior=h.reads.allRequests.length;await h.flush();await h.flush();assert.deepEqual(h.writes(),[]);assert.equal(h.reads.allRequests.length,prior);
});

test('Home and account Goals adapters request canonical top-center placement and preserve disposal ownership',async t=>{
 const env=entryEnvironment(t);canonicalRestoration(env);
 // Observe only the shared toast API boundary. Both adapter functions are
 // production code; canonical positioning/disposal has its own real-owner suite.
 const calls=[],handle=Object.freeze({dispose(){}});
 env.context.showToast=(...args)=>{calls.push(args);return handle;};
 const account=await import(pathToFileURL(path.resolve(__dirname,'../../../music_app/static/js/home-friends/account-entry.mjs')).href);
 const adapters=[env.context.AlbumHavenHomeRuntime,account.accountGoalsRuntime(env.context)];
 for(const adapter of adapters) {
  assert.equal(adapter.showOwnedToast('Weekly Goals period has ended.','info'),handle);
  assert.equal(adapter.showOwnedToast('Weekly Goals achieved.','success'),handle);
 }
 assert.equal(calls.length,4);
 for(const [index,args] of calls.entries()) {
  assert.equal(args[0],index%2?'Weekly Goals achieved.':'Weekly Goals period has ended.');
  assert.equal(args[1],index%2?'success':'info');assert.equal(args[2],undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(args[3])),{placement:'top-center'});assert.equal(args.length,4);
 }
});
