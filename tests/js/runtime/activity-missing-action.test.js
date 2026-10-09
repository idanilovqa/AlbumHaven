const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const vm=require('node:vm');
const React=require('react');
const {buildSync}=require('esbuild');
const bundle=buildSync({entryPoints:[path.resolve(__dirname,'../../../music_app/static/js/home-friends/activity-missing.jsx')],
  bundle:true,platform:'node',format:'cjs',write:false,external:['react','react-dom']}).outputFiles[0].text;
const settle=async()=>{for(let i=0;i<15;i++)await Promise.resolve();};
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
// Hook-level ownership test, not browser or React renderer acceptance.
function harness(runtime){
  const cells=[];let cursor=0,effects=[],props={runtime,scopeKey:'home:one',kind:'listens',period:'week',
    value:{status:'ready',data:{snapshot_ref:'s'.repeat(43)}},onError:()=>{}};
  const equal=(a,b)=>a&&b&&a.length===b.length&&a.every((v,i)=>Object.is(v,b[i]));
  const hooks={...React,useState(initial){const i=cursor++;cells[i]??={value:typeof initial==='function'?initial():initial};
    return [cells[i].value,value=>{cells[i].value=typeof value==='function'?value(cells[i].value):value;}];},
    useRef(initial){const i=cursor++;cells[i]??={current:initial};return cells[i];},
    useMemo(factory,deps){const i=cursor++;if(!equal(cells[i]?.deps,deps))cells[i]={deps,value:factory()};return cells[i].value;},
    useEffect(callback,deps){const i=cursor++;if(!equal(cells[i]?.deps,deps)){const prior=cells[i];cells[i]={deps};
      effects.push(()=>{prior?.cleanup?.();cells[i].cleanup=callback();});}}};
  const loaded={exports:{}};vm.runInNewContext(bundle,{module:loaded,exports:loaded.exports,AbortController,console,
    require:name=>name==='react'?hooks:name==='react-dom'?{createPortal:value=>value}:assert.fail(name)});
  const render=patch=>{props={...props,...patch};cursor=0;effects=[];const node=loaded.exports.ActivityMissingAction(props);
    for(const effect of effects)effect();return node;};
  return {render,dispose:()=>cells.forEach(cell=>cell?.cleanup?.())};
}
test('toolbar trusts confirmed server eligibility and sends a full sealed source, not loaded rows',async()=>{
  const probes=[],captures=[];const runtime={readActivityMissingEligibility:async options=>{probes.push(options);return {can_inspect_missing:true,missing_count:99};},
    inspectActivityMissing:async options=>{captures.push(options);return true;}};
  const h=harness(runtime);assert.equal(h.render(),null);await settle();const button=h.render();
  assert.equal(button.props['children'],'Inspect missing tracks');assert.equal(button.props.disabled,false);
  assert.equal(probes[0].row_refs,null);assert.equal(probes[0].origin.snapshot_ref,'s'.repeat(43));
  await button.props.onClick();assert.equal(captures.length,1);assert.equal(captures[0].row_refs,null);h.dispose();
});
test('unknown or false eligibility exposes no Inspect action',async()=>{
  for(const result of [null,{can_inspect_missing:false,missing_count:0}]){
    const h=harness({readActivityMissingEligibility:async()=>result,inspectActivityMissing:()=>assert.fail('capture')});
    h.render();await settle();assert.equal(h.render(),null);h.dispose();
  }
});
test('new source immediately hides prior eligibility and suppresses stale probe',async()=>{
  const waiting=deferred();const h=harness({readActivityMissingEligibility:()=>waiting.promise,inspectActivityMissing:()=>assert.fail('capture')});
  h.render();await settle();assert.equal(h.render({value:{status:'loading',data:null}}),null);
  waiting.resolve({can_inspect_missing:true,missing_count:1});await settle();assert.equal(h.render(),null);h.dispose();
});
test('selected occurrence capture remains selected and repeated clicks cannot open two drafts',async()=>{
  const waiting=deferred(),calls=[];const h=harness({readActivityMissingEligibility:async()=>({can_inspect_missing:true,missing_count:2}),
    inspectActivityMissing:options=>{calls.push(options);return waiting.promise;}});
  h.render({selectedRowIds:['activity_'+'2'.repeat(64),'activity_'+'1'.repeat(64)]});await settle();
  const button=h.render(),first=button.props.onClick();button.props.onClick();assert.equal(calls.length,1);
  assert.deepEqual(Array.from(calls[0].row_refs),['activity_'+'2'.repeat(64),'activity_'+'1'.repeat(64)]);
  assert.equal(h.render().props.disabled,true);waiting.resolve(true);await first;h.dispose();
});
test('full-source size rejection is explicit and never substitutes a page',async()=>{
  const h=harness({readActivityMissingEligibility:async()=>{throw Object.assign(new Error('limit'),{status:413});},
    inspectActivityMissing:()=>assert.fail('capture')});h.render();await settle();const status=h.render();
  assert.equal(status.props.role,'status');assert.match(status.props.children,/5,000/);h.dispose();
});
