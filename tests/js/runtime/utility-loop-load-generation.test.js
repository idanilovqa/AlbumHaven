const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(path.resolve(__dirname, '../../../music_app/static/js/runtime/utility-loaders-and-cover-lookup.js'), 'utf8');
const loader = source.slice(source.indexOf('async function loadUtilityLoops('), source.indexOf('function normalizeUtilityLogHistoryRevision('));
function harness() {
  let resolve; const pending = new Promise(done => { resolve = done; });
  const events=[];
  const errors=[];
  const toasts=[];
  const storage = new Map();
  const window = {localStorage: {
    getItem: key => storage.get(String(key)) ?? null,
    setItem: (key, value) => storage.set(String(key), String(value)),
    removeItem: key => storage.delete(String(key)),
  }};
  const context=vm.createContext({window,state:{utility:{loops:[{id:'existing'}],activeTab:'loops',loopDataGeneration:4,loopMutationGeneration:2}},
    fetch:()=>pending,renderUtilityModalContent:()=>events.push('render'),
    showToast:(...args)=>{toasts.push(args);events.push('toast');},
    console:{...console,error:(...args)=>{errors.push(args);console.error(...args);}},
    groupUtilityLoops:items=>[{key:'track:1',loops:items}],collapseAllUtilityLoopGroups(){},syncLoopCreateCapability(){}});
  for (const file of ['browser-storage-helpers.js', 'playback-ownership-helpers.js']) {
    const filename = path.resolve(__dirname, '../../../music_app/static/js/runtime', file);
    vm.runInContext(fs.readFileSync(filename, 'utf8'), context, {filename});
  }
  vm.runInContext(loader,context);
  return {context,events,errors,toasts,resolve:()=>resolve({ok:true,json:async()=>({ok:true,allowed_actions:{'library.loops.create':true},loops:[{id:'stale'}]})})};
}
test('fresh authorized load advances data generation so older reorder cannot replace cache',async()=>{
  const h=harness();const pending=h.context.loadUtilityLoops(true);
  assert.equal(h.context.state.utility.loopDataGeneration,5);h.resolve();await pending;
});

test('loop projection preserves independently verified log grants and revokes omitted loop grants',async()=>{
  const h=harness();
  h.context.state.utility.allowedActions={'library.logs.read':true,'library.logs.export':true,'library.loops.delete':true};
  const pending=h.context.loadUtilityLoops(true);h.resolve();await pending;
  assert.equal(h.context.state.utility.allowedActions['library.logs.export'],true);
  assert.equal(h.context.state.utility.allowedActions['library.logs.read'],true);
  assert.equal(h.context.state.utility.allowedActions['library.loops.delete'],false);
});
test('late loop load cannot write into a replacement account utility state or render it',async()=>{
  const h=harness();const pending=h.context.loadUtilityLoops(true);
  const next={loops:[{id:'other-account'}],loopsLoading:true,loopsLoadPromise:{current:true}};
  h.context.state.utility=next;h.events.length=0;h.resolve();await pending;
  assert.deepEqual(next.loops,[{id:'other-account'}]);assert.equal(next.loopsLoading,true);
  assert.deepEqual(next.loopsLoadPromise,{current:true});assert.deepEqual(h.events,[]);
});
test('load started before reorder cannot overwrite its newer cache or render stale rows',async()=>{
  const h=harness();const pending=h.context.loadUtilityLoops(true);
  h.context.state.utility.loopMutationGeneration+=1;h.context.state.utility.loops=[{id:'committed-order'}];
  h.events.length=0;h.resolve();await pending;
  assert.deepEqual(h.context.state.utility.loops,[{id:'committed-order'}]);assert.deepEqual(h.events,[]);
  assert.equal(h.context.state.utility.loopsLoading,false);
});
test('late loops response does not rerender the unrelated active tab',async()=>{
  const h=harness();const pending=h.context.loadUtilityLoops(true);
  h.context.state.utility.activeTab='rules';h.events.length=0;h.resolve();await pending;
  assert.deepEqual(h.events,[]);
});
test('main save invalidates an older pending loop list response before replacing its cache',async()=>{
  const h=harness();const pending=h.context.loadUtilityLoops(true);
  h.context.state.player={current:{path:'owned'},loopActive:true,loopStart:0,loopEnd:1,saveBusy:false};
  Object.assign(h.context,{showLoopNameDialog:async()=> 'Saved',setLoopActive(){},updatePlayerUi(){},
    buildUtilityLoopGroupKey:()=> 'track:1',fetch:async()=>({ok:true,json:async()=>({ok:true,loop:{id:'saved'},loops:[{id:'saved'}]})})});
  const player=fs.readFileSync(path.resolve(__dirname,'../../../music_app/static/js/runtime/player-loop-playback.js'),'utf8');
  vm.runInContext(player.slice(player.indexOf('async function saveCurrentLoop('),player.indexOf('function handlePlayerLoopEditKeydown(')),h.context);
  await h.context.saveCurrentLoop();h.events.length=0;h.resolve();await pending;
  assert.equal(h.context.state.utility.loops[0].id,'saved');assert.deepEqual(h.events,[]);
});
for(const operation of ['create','delete']) test(`saved ${operation} invalidates an earlier pending collection load`,async()=>{
  const h=harness();const pending=h.context.loadUtilityLoops(true);
  h.context.state.utility.loopEditors={existing:{active:true,startSeconds:0,endSeconds:1}};
  h.context.state.utility.loops[0].duration_seconds = 2;
  const expected=operation==='delete'?[]:[{id:'new-child'}];
  Object.assign(h.context,{showLoopNameDialog:async()=> 'Child',buildUtilityLoopGroupKey:()=> 'track:1',
    loopEditSessionExpiryController:{stop(){}},cssEscape:value=>value,
    document:{querySelector:()=>null},fetch:async()=>({ok:true,json:async()=>({ok:true,loop:expected[0],loops:expected})})});
  const saved=fs.readFileSync(path.resolve(__dirname,'../../../music_app/static/js/runtime/utility-loop-playback.js'),'utf8');
  vm.runInContext(saved,h.context);
  if(operation==='create') {
    await h.context.createLoopFromSavedLoop('existing');
    assert.deepEqual(h.errors,[], 'creation must finish without a caught runtime error');
    assert.equal(h.context.state.utility.loopEditors.existing.active,false);
    assert.equal(h.context.state.utility.selectedLoopId,'new-child');
    assert.deepEqual(h.toasts,[['Loop saved.','success',2600]]);
  } else {
    assert.equal(await h.context.deleteSavedLoop('existing',{confirmed:true}),true);
    assert.deepEqual(h.errors,[], 'deletion must finish without a caught runtime error');
    assert.deepEqual(h.toasts,[['Loop removed.','success',2400]]);
  }
  assert.deepEqual(h.context.state.utility.loops,expected);
  assert.equal(h.context.state.utility.loopsLoaded,true);
  assert.equal(h.context.state.utility.loopMutationGeneration,3);
  h.events.length=0;h.resolve();await pending;
  assert.deepEqual(h.context.state.utility.loops,expected);assert.deepEqual(h.events,[]);
  assert.deepEqual(h.errors,[]);
});
