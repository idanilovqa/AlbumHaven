const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {fixture,load,settle,deferred} = require('./home-friends-native-app-fixture.cjs');
const stamp='a'.repeat(64),goal='11111111-1111-4111-8111-111111111111',album='22222222-2222-4222-8222-222222222222',cycle='33333333-3333-4333-8333-333333333333';
function value(full=false) {
  return {goal_ref:full?goal:null,revision:full?'2':'1',periods:Object.fromEntries(['week','month','six-months','year'].map(period=>[period,{period,top_ref:full?goal:null,
    cycle:full?{cycle_id:cycle,started_at:'2026-12-01T00:00:00Z',start_date:'2026-12-01',due_date:'2027-01-01',timezone_name:'UTC'}:null,
    album_refs:full?[album]:[],manual_completed_at:full?{[album]:null}:{},total:full?1:0,completed:0,percent:0}])),
    albums:full?[{catalog_ref:album,title:'Private album',artist_display:'Private artist',first_release_date:null,primary_type:null}]:[],
    allowed_actions:{can_read:true,can_add:true,can_reset:true,can_complete:true,can_remove:true}};
}
async function mounted(t,{full=false}={}) {
  const h=fixture(t),entry=await load('account-entry.mjs');let owner,restores=0;
  const calls=[],script=[];let data=value(full);
  h.c.URLSearchParams=URLSearchParams;
  h.c.fetch=async(route,options)=>{calls.push({route,options});const next=script.length?script.shift():data;
    const result=await(typeof next==='function'?next(route,options):next);if(result instanceof Error)throw result;
    return result?.response||{ok:true,status:200,json:async()=>({status:'ready',context_ref:stamp,context_scope:'account-goals-v1',data:result})};};
  vm.runInContext(fs.readFileSync(path.resolve(__dirname,'../../../music_app/static/js/runtime/private-ui-transport.js'),'utf8'),h.c);
  h.host.id='account-home';h.host.dataset.accountGoalsContext=stamp;h.host.dataset.accountName='member.one';
  Object.defineProperty(h.document,'visibilityState',{value:'visible',writable:true,configurable:true});
  t.after(()=>owner?.dispose());
  owner=h.own(entry.mountAccountGoalsEntry(h.host,entry.accountGoalsRuntime(h.c),h.c.createAlbumHavenPrivateUITransport,{onRestore:()=>restores++}));
  await settle();h.drain();
  return {...h,owner,calls,script,setData:next=>{data=next;},restores:()=>restores,
    visibility(value){h.document.visibilityState=value;h.document.dispatchEvent(new h.c.Event('visibilitychange'));},
    page(name,persisted=false){const event=new h.c.Event(name);event.persisted=persisted;h.document.dispatchEvent(event);}};
}
function gate(t,h){const wait=deferred();t.after(async()=>{try{h.owner.dispose();}finally{wait.resolve(value());}await wait.promise;await settle();});return wait;}

test('account fallback reuses actual Home profile, selected Goals tab and central Start without library providers',async t=>{
  const h=await mounted(t);assert.equal(h.host.querySelector('.home-profile__name h1').textContent,'member.one');
  assert.ok(h.host.querySelector('[role="img"]'));assert.equal(h.host.querySelector('img'),null);
  const tab=h.host.querySelector('[role="tab"]');assert.equal(tab.textContent,'Goals');assert.equal(tab.getAttribute('aria-selected'),'true');
  assert.equal(h.host.querySelector('[aria-label="Goals"]').getAttribute('aria-label'),'Goals');assert.ok(h.named('Start'));
  assert.deepEqual(h.calls.map(row=>row.route),['/account/goals']);assert.equal(h.host.querySelector('.home-profile__handle'),null);
  assert.equal(h.calls[0].options.headers['X-AlbumHaven-Account-Context'],stamp);
});
test('populated fallback places Reset and Add beside username using existing header slots',async t=>{
  const h=await mounted(t,{full:true}),header=h.host.querySelector('.home-friends__page-header');
  assert.ok(header.contains(h.named('Reset')));assert.ok(header.contains(h.named('Add')));assert.ok(header.contains(h.named('Period: 1 week')));
  assert.match(h.host.textContent,/Private album/);assert.equal(h.named('Start'),undefined);
});
test('pagehide retires private state and persisted pageshow requests fresh server entry',async t=>{
  const h=await mounted(t,{full:true}),saved=h.named('Add');h.page('pagehide');
  assert.doesNotMatch(h.host.textContent,/member.one|Private album|Private artist/);assert.equal(h.host.hasAttribute('data-account-goals-context'),false);
  h.click(saved);assert.equal(h.form.hidden,true);assert.equal(h.calls.length,1);
  h.page('pageshow',true);assert.equal(h.restores(),1);h.owner.dispose();h.page('pageshow',true);assert.equal(h.restores(),1);
});
test('hidden tab conceals the same owner and return waits for marker validation',async t=>{
  const h=await mounted(t,{full:true}),before=h.host.querySelector('.album-card'),wait=gate(t,h);
  h.visibility('hidden');assert.equal(h.host.hidden,true);assert.equal(h.form.hidden,true);
  h.script.push(()=>wait.promise);h.visibility('visible');await settle();assert.equal(h.host.hidden,true);
  assert.equal(h.calls.length,2);wait.resolve(value(true));await settle();
  assert.equal(h.host.hidden,false);assert.equal(h.host.querySelector('.album-card'),before);assert.equal(h.calls.length,2);
});
for(const status of [401,403,409])test(`return validation ${status} clears the prior account instead of exposing it`,async t=>{
  const h=await mounted(t,{full:true});h.visibility('hidden');
  h.script.push({response:{ok:false,status,json:async()=>({error:'stale_context'})}});h.visibility('visible');await settle();
  assert.doesNotMatch(h.host.textContent,/member.one|Private album|Private artist/);assert.equal(h.named('Add'),undefined);
  assert.match(h.host.textContent,/Reload Home/);
});
test('transient validation failure keeps retained private owner concealed and allows later read revalidation',async t=>{
  const h=await mounted(t,{full:true}),card=h.host.querySelector('.album-card');h.visibility('hidden');
  h.script.push({response:{ok:false,status:503,json:async()=>({error:'temporary'})}});h.visibility('visible');await settle();
  assert.equal(h.host.hidden,true);assert.equal(h.host.querySelector('.album-card'),card);
  h.visibility('hidden');h.visibility('visible');await settle();assert.equal(h.host.hidden,false);assert.equal(h.host.querySelector('.album-card'),card);
  assert.equal(h.calls.filter(row=>row.options.method==='POST').length,0);
});
test('newer visibility epoch rejects late validation and cannot reveal hidden account data',async t=>{
  const h=await mounted(t,{full:true}),wait=gate(t,h);h.visibility('hidden');h.script.push(()=>wait.promise);h.visibility('visible');await settle();
  const pending=h.calls.at(-1);h.visibility('hidden');assert.equal(pending.options.signal.aborted,true);
  wait.resolve(value(true));await settle();assert.equal(h.host.hidden,true);
});
test('visibility validation preserves an uncertain Reset intent and never issues a replacement mutation',async t=>{
  const h=await mounted(t,{full:true}),wait=gate(t,h);h.script.push(()=>wait.promise);
  h.click(h.named('Reset'));h.click(h.named('Reset',h.form));await settle();const original=h.calls.find(row=>row.route==='/account/goals/reset');assert.ok(original);
  h.visibility('hidden');wait.resolve(new TypeError('disconnected'));await settle();
  h.visibility('visible');await settle();assert.equal(h.host.hidden,false);assert.ok(h.named('Retry'));
  assert.equal(h.calls.filter(row=>row.route==='/account/goals/reset').length,1);
  const retryWrite=deferred(),refreshDecoded=deferred();
  t.after(()=>{retryWrite.resolve();refreshDecoded.resolve();});
  // Observe the actual operation-lookup -> exact retry -> authoritative read
  // phases. A guessed microtask count can stop before the retry write begins.
  const updated=value(true);updated.revision='3';updated.periods.week.cycle.cycle_id='44444444-4444-4444-8444-444444444444';h.setData(updated);
  h.script.push({status:'unknown'},(_route,options)=>{
    retryWrite.resolve();
    return {ok:true,action:'reset',request_key:JSON.parse(options.body).request_key,changed:true,reason:'',goal_ref:goal,revision:'3',period:'week',cycle_id:'44444444-4444-4444-8444-444444444444'};
  },{response:{ok:true,status:200,json:async()=>{
    refreshDecoded.resolve();
    return {status:'ready',context_ref:stamp,context_scope:'account-goals-v1',data:updated};
  }}});
  h.click(h.named('Retry'));await retryWrite.promise;await refreshDecoded.promise;await settle();
  const writes=h.calls.filter(row=>row.route==='/account/goals/reset');assert.equal(writes.length,2);assert.equal(writes[1].options.body,original.options.body);
  assert.ok(h.calls.some(row=>row.route.startsWith('/account/goals/operations/')));assert.equal(h.named('Retry'),undefined);
});

test('account privacy CSS explicitly overrides shared Home display while hidden',()=>{
  const css=fs.readFileSync(path.resolve(__dirname,'../../../music_app/static/css/account-home.css'),'utf8');
  const template=fs.readFileSync(path.resolve(__dirname,'../../../music_app/templates/account-goals.html'),'utf8');
  assert.match(css,/#account-home\[hidden\]\s*\{\s*display:\s*none\s*!important;/);
  assert.ok(template.includes('/static/css/account-home.css?v={{ runtime_asset_version }}'));
});

test('returning to a still-visible window conceals before focus validation and retains its card owner',async t=>{
  const h=await mounted(t,{full:true}),card=h.host.querySelector('.album-card'),wait=gate(t,h);
  h.page('blur');assert.equal(h.document.visibilityState,'visible');assert.equal(h.host.hidden,true);
  h.script.push(()=>wait.promise);h.page('focus');await settle();assert.equal(h.host.hidden,true);
  wait.resolve(value(true));await settle();assert.equal(h.host.hidden,false);assert.equal(h.host.querySelector('.album-card'),card);
});
test('focus validation from an older window epoch cannot reveal the panel after another blur',async t=>{
  const h=await mounted(t,{full:true}),wait=gate(t,h);h.page('blur');h.script.push(()=>wait.promise);h.page('focus');await settle();
  const request=h.calls.at(-1);h.page('blur');assert.equal(request.options.signal.aborted,true);
  wait.resolve(value(true));await settle();assert.equal(h.host.hidden,true);
});
