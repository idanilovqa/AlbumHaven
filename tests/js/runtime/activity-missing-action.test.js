const test=require('node:test');
const assert=require('node:assert/strict');
const {createNativeHomeRuntime}=require('./native-home-harness.cjs');
let mountActivityMissingAction;
test.before(async()=>{({mountActivityMissingAction}=await import('../../../music_app/static/js/home-friends/activity-missing.mjs'));});
const settle=async()=>{for(let i=0;i<15;i++)await Promise.resolve();};
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
// Actual native owner and canonical Button events; no hook or renderer emulator.
function harness(t,providers){
  const native=createNativeHomeRuntime(),host=native.document.createElement('div');native.document.body.append(host);
  const runtime={...providers,buttonHtml:options=>native.context.ButtonComponent.renderButton(options),
    actionHtml:options=>native.context.ButtonComponent.renderActionButton(options)};
  let props={scopeKey:'home:one',kind:'listens',period:'week',
    value:{status:'ready',data:{snapshot_ref:'s'.repeat(43)}},onError:()=>{}},owner,disposed=false;
  const render=patch=>{assert.equal(disposed,false);props={...props,...patch};
    if(owner)owner.update(props);else owner=mountActivityMissingAction(host,runtime,props);
    return host.querySelector('button,[role="status"]');};
  const click=button=>{const event=new native.context.Event('click');event.detail=1;button.dispatchEvent(event);return event;};
  const dispose=()=>{if(disposed)return;disposed=true;
    try {owner?.dispose();assert.equal(host.childNodes.length,0);assert.equal(host.listeners.length,0);}
    finally {host.remove();}};
  t.after(dispose);return {render,click,dispose,host};
}
test('toolbar trusts confirmed server eligibility and sends a full sealed source, not loaded rows',async t=>{
  const probes=[],captures=[];const runtime={readActivityMissingEligibility:async options=>{probes.push(options);return {can_inspect_missing:true,missing_count:99};},
    inspectActivityMissing:async options=>{captures.push(options);return true;}};
  const h=harness(t,runtime);assert.equal(h.render(),null);await settle();const button=h.render();
  assert.equal(button.getAttribute('aria-label'),'Inspect missing tracks');assert.equal(button.disabled,false);
  assert.equal(probes[0].row_refs,null);assert.equal(probes[0].origin.snapshot_ref,'s'.repeat(43));
  h.click(button);await settle();assert.equal(captures.length,1);assert.equal(captures[0].row_refs,null);h.dispose();
});
test('unknown or false eligibility exposes no Inspect action',async t=>{
  for(const result of [null,{can_inspect_missing:false,missing_count:0}]){
    const h=harness(t,{readActivityMissingEligibility:async()=>result,inspectActivityMissing:()=>assert.fail('capture')});
    h.render();await settle();assert.equal(h.render(),null);h.dispose();
  }
});
test('new source immediately hides prior eligibility and suppresses stale probe',async t=>{
  const waiting=deferred();const h=harness(t,{readActivityMissingEligibility:()=>waiting.promise,inspectActivityMissing:()=>assert.fail('capture')});
  h.render();await settle();assert.equal(h.render({value:{status:'loading',data:null}}),null);
  waiting.resolve({can_inspect_missing:true,missing_count:1});await settle();assert.equal(h.render(),null);h.dispose();
});
test('selected occurrence capture remains selected and repeated clicks cannot open two drafts',async t=>{
  const waiting=deferred(),calls=[];const h=harness(t,{readActivityMissingEligibility:async()=>({can_inspect_missing:true,missing_count:2}),
    inspectActivityMissing:options=>{calls.push(options);return waiting.promise;}});
  h.render({selectedRowIds:['activity_'+'2'.repeat(64),'activity_'+'1'.repeat(64)]});await settle();
  const button=h.render();h.click(button);h.click(button);assert.equal(calls.length,1);
  assert.deepEqual(Array.from(calls[0].row_refs),['activity_'+'2'.repeat(64),'activity_'+'1'.repeat(64)]);
  assert.equal(h.render().disabled,true);waiting.resolve(true);await settle();h.dispose();
});
test('full-source size rejection is explicit and never substitutes a page',async t=>{
  const h=harness(t,{readActivityMissingEligibility:async()=>{throw Object.assign(new Error('limit'),{status:413});},
    inspectActivityMissing:()=>assert.fail('capture')});h.render();await settle();const status=h.render();
  assert.equal(status.getAttribute('role'),'status');assert.match(status.textContent,/5,000/);h.dispose();
});
