'use strict';
// Exact accepted correction-addendum capability contract. Real registry and
// coordinator; only the approved begin lease/browser boundaries are controlled.
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,load,observe,settle}=require('./album-top-image-regression-fixture.cjs');
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const code=error=>typeof error==='string'?error:error?.code;
const bounded=kind=>error=>code(error)===kind;
const keys=(value,expected)=>assert.deepEqual(Object.keys(value).sort(),[...expected].sort());
const noWork=env=>assert.deepEqual([env.accesses.length,env.captureKeys.length,env.fontLoads.length,env.preparations.length,env.encodes.length,env.imageDecodes.length],[0,0,0,0,0,0]);
async function setup(t){const env=await fixture(t),module=await load('image-export-share-transition.mjs');keys(module,['registerAlbumTopImageShareTransition','requestAlbumTopImageShareTransition']);return {env,...module};}

test('exact host capability preserves standalone null, one issued lease, retired tombstone and no premature cancellation settlement',async t=>{
  const {env,registerAlbumTopImageShareTransition:register,requestAlbumTopImageShareTransition:request}=await setup(t);
  const never=env.document.createElement('div');env.host.append(never);assert.equal(request(never),null);
  const gate=deferred();let begins=0,cancels=0;
  const lease=Object.freeze({settled:gate.promise,cancel(){cancels++;}}),unregister=register(env.host,()=>{begins++;return lease;});env.trackCleanup(unregister);
  assert.equal(typeof unregister,'function');assert.equal(request(env.host),lease);assert.equal(begins,1);keys(lease,['settled','cancel']);
  assert.throws(()=>request(env.host),bounded('share_transition_unavailable'));assert.equal(begins,1,'duplicate request cannot invoke begin twice');
  assert.throws(()=>register(env.host,()=>lease),bounded('share_transition_unavailable'));
  const settled=observe(lease.settled);unregister();unregister();await settle();assert.equal(cancels,1);assert.equal(settled.state,'pending','unregister does not manufacture native closure');
  assert.throws(()=>request(env.host),bounded('share_transition_unavailable'));assert.equal(begins,1);
  gate.resolve(false);await settle();assert.equal(settled.state,'resolved');assert.equal(settled.value,false);
  const fresh=Object.freeze({settled:Promise.resolve(true),cancel(){}}),unregisterFresh=register(env.host,()=>fresh);env.trackCleanup(unregisterFresh);
  assert.equal(request(env.host),fresh,'current logical owner can replace an explicitly retired tombstone');
});

test('unregister before issuance never invokes stale begin or turns retired host into standalone',async t=>{
  const {env,registerAlbumTopImageShareTransition:register,requestAlbumTopImageShareTransition:request}=await setup(t);
  let calls=0;const unregister=register(env.host,()=>{calls++;assert.fail('retired begin invoked');});unregister();
  assert.throws(()=>request(env.host),bounded('share_transition_unavailable'));assert.equal(calls,0);
  env.host.remove();assert.throws(()=>request(env.host),bounded('share_transition_unavailable'));
});

for(const invalid of ['extra-key','unfrozen','not-promise','cancel-missing','throw'])test(`begin ${invalid} is unconfirmed, not a safe standalone or confirmed-close result`,async t=>{
  const {env,registerAlbumTopImageShareTransition:register,requestAlbumTopImageShareTransition:request}=await setup(t);let called=0;
  const unregister=register(env.host,()=>{called++;
    if(invalid==='throw')throw new Error('PRIVATE_TRANSITION_DETAIL');
    const lease={settled:Promise.resolve(true),cancel(){}};
    if(invalid==='extra-key')lease.authority='forbidden';if(invalid==='not-promise')lease.settled=true;if(invalid==='cancel-missing')delete lease.cancel;
    return invalid==='unfrozen'?lease:Object.freeze(lease);
  });env.trackCleanup(unregister);
  assert.throws(()=>request(env.host),bounded('share_transition_unconfirmed'));assert.equal(called,1);
  assert.throws(()=>request(env.host),bounded('share_transition_unavailable'));assert.equal(called,1,'ambiguous begin is not retried');
});

test('real coordinator acquires native-transition barrier before synchronous begin can reenter terminal dispose',async t=>{
  const {env,registerAlbumTopImageShareTransition:register}=await setup(t),gate=deferred();let terminal,cancels=0;
  const unregister=register(env.host,()=>{
    terminal=observe(env.coordinator.dispose());
    return Object.freeze({settled:gate.promise,cancel(){cancels++;}});
  });env.trackCleanup(unregister);
  const handle=env.open();await env.pump();assert.ok(terminal);assert.equal(terminal.state,'pending');noWork(env);
  const closed=observe(handle.closed);await settle();assert.equal(closed.state,'pending');
  gate.resolve(false);await env.pump();assert.equal(closed.state,'resolved');assert.equal(terminal.state,'resolved');assert.ok(cancels<=1);noWork(env);
});

test('closing a waiting transition cancels continuation without substituting for physical close settlement',async t=>{
  const {env,registerAlbumTopImageShareTransition:register}=await setup(t),gate=deferred();let cancels=0;
  const unregister=register(env.host,()=>Object.freeze({settled:gate.promise,cancel(){cancels++;}}));env.trackCleanup(unregister);
  const handle=env.open();noWork(env);handle.close();handle.close();const closed=observe(handle.closed);await env.pump();
  assert.equal(closed.state,'pending');assert.equal(cancels,1);noWork(env);
  gate.resolve(true);await env.pump();assert.equal(closed.state,'resolved');noWork(env);assert.equal(env.modal().hidden,true,'cancelled true settlement cannot open designer');
});

for(const failure of ['throw','rejection'])test(`ambiguous transition ${failure} retains coordinator quarantine rather than granting a lane`,async t=>{
  const {env,registerAlbumTopImageShareTransition:register}=await setup(t),gate=deferred();
  const unregister=register(env.host,()=>{if(failure==='throw')throw new Error('PRIVATE_CLOSE_DETAIL');return Object.freeze({settled:gate.promise,cancel(){}});});env.trackCleanup(unregister);
  const first=env.open();if(failure==='rejection')gate.reject(new Error('PRIVATE_CLOSE_DETAIL'));await env.pump();noWork(env);
  first.close();const closed=observe(first.closed);env.open();await env.pump();noWork(env);assert.equal(closed.state,'pending');
  const terminal=observe(env.coordinator.dispose());await env.pump();assert.equal(terminal.state,'pending');
  assert.equal(env.text().includes('PRIVATE_CLOSE_DETAIL'),false);
});

for(const bad of ['disconnected-host','null-host','nonfunction-begin'])test(`invalid ${bad} fails before any physical Share begin`,async t=>{
  const {env,registerAlbumTopImageShareTransition:register,requestAlbumTopImageShareTransition:request}=await setup(t);
  const host=bad==='disconnected-host'?env.document.createElement('div'):bad==='null-host'?null:env.host;
  let called=0;const begin=bad==='nonfunction-begin'?null:()=>{called++;assert.fail('invalid registration invoked begin');};
  assert.throws(()=>register(host,begin),bounded('share_transition_unavailable'));assert.equal(called,0);
  if(bad!=='nonfunction-begin')assert.throws(()=>request(host),bounded('share_transition_unavailable'));
});
