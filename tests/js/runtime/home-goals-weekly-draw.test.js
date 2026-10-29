'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {load,settle,deferred}=require('./home-friends-native-app-fixture.cjs');
const id=n=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const periods=['week','month','six-months','year'];
function data(refs=[],revision='1') {return {goal_ref:refs.length?id(1):null,revision,allowed_actions:{can_read:true,can_add:true},albums:refs.map(catalog_ref=>({catalog_ref})),
  periods:Object.fromEntries(periods.map((period,index)=>[period,{period,total:refs.length,completed:0,album_refs:refs,
    manual_completed_at:Object.fromEntries(refs.map(ref=>[ref,null])),cycle:refs.length?{cycle_id:id(10+index)}:null}]))};}
async function setup(t,{ambiguous=false,malformed=false}={}) {
  const {createGoalsController}=await load('goals-model.mjs');let state=data(),receipt,notify,key=50,writes=0,reads=0;
  const provider={subscribe(fn){notify=fn;return()=>{};},async read(){reads++;return state;},async weekly_draw(command){
    writes++;state=data([id(20),id(21)],'2');
    receipt={ok:true,action:'weekly_draw',request_key:command.request_key,changed:true,reason:'',goal_ref:id(1),revision:'2',period:'week',cycle_id:id(10),catalog_refs:[id(20),id(21)]};
    if(ambiguous)throw new Error('Response lost');
    return malformed?{...receipt,catalog_refs:[id(20),id(20)]}:receipt;
  },async operation(){return {status:'committed',receipt};}};
  const controller=createGoalsController({provider,timezone:'UTC',requestKey:()=>id(key++)});t.after(()=>controller.dispose());await controller.load();
  return {controller,provider,writes:()=>writes,reads:()=>reads,retire:()=>notify(),capture:()=>({data:controller.getSnapshot().data,period:controller.getSnapshot().period})};
}
test('multi-suggestion confirmation refreshes authorized Goals without opt-in bonus gate',async t=>{
  const h=await setup(t);await h.controller.drawWeekly('1',h.capture());
  assert.equal(h.writes(),1);assert.equal(h.controller.getSnapshot().status,'ready');
  assert.deepEqual(h.controller.getSnapshot().data.periods.week.album_refs,[id(20),id(21)]);
  assert.equal(h.controller.getSnapshot().outcome.action,'weekly_draw');
});
test('ambiguous multi-suggestion write recovers committed operation without rerolling',async t=>{
  const h=await setup(t,{ambiguous:true});await h.controller.drawWeekly('1',h.capture());assert.equal(h.controller.getSnapshot().mutation,'uncertain');
  await h.controller.retry();assert.equal(h.writes(),1);assert.equal(h.controller.getSnapshot().status,'ready');assert.equal(h.controller.getSnapshot().mutation,'idle');
});
test('duplicate suggestion receipt cannot acknowledge a write',async t=>{
  const h=await setup(t,{malformed:true});await h.controller.drawWeekly('1',h.capture());assert.equal(h.controller.getSnapshot().mutation,'uncertain');
});
test('retired captured confirmation cannot write',async t=>{
  const h=await setup(t),expected=h.capture();h.retire();await h.controller.drawWeekly('1',expected);assert.equal(h.writes(),0);
});
test('legacy bonus projection permits new seven-total readback but rejects eight',async()=>{
  const {normalizeCurrentBonus}=await load('goals-provider.mjs');
  assert.equal(normalizeCurrentBonus({cycle_id:id(10),bonus:null,manual_count:7}).manual_count,7);
  assert.throws(()=>normalizeCurrentBonus({cycle_id:id(10),bonus:null,manual_count:8}));
});
test('controller rejects manual completion command for rating-only Goals entry',async t=>{
  const h=await setup(t),value=data([id(20)],'2');value.allowed_actions.can_complete=true;value.albums[0].completion_mode='rating';
  h.provider.read=async()=>value;await h.controller.load();let called=false;h.provider.completion=async()=>{called=true;};
  const expected={data:h.controller.getSnapshot().data,period:'week',revision:'2',cycle_id:id(10)};
  await h.controller.setCompletion(id(20),true,expected);assert.equal(called,false);assert.equal(h.controller.getSnapshot().mutation,'idle');
});
for(const duplicate of [false,true]) test(`completion propagation receipt ${duplicate?'rejects duplicate Tops':'accepts validated Top evidence'}`,async t=>{
  const h=await setup(t);let value=data([id(20)],'2');value.allowed_actions.can_complete=true;
  h.provider.read=async()=>value;await h.controller.load();
  h.provider.completion=async command=>{
    value=data([id(20)],'3');value.allowed_actions.can_complete=true;
    for(const period of Object.values(value.periods)){period.manual_completed_at[id(20)]='2026-10-26T00:00:00Z';period.completed=1;}
    const top={top_ref:id(30),album_ref:id(20),action:'set_manual_completion',request_key:command.request_key,progress_revision:'1',manual_completed_at:'2026-10-26T00:00:00Z',changed:true};
    return {ok:true,action:'completion',request_key:command.request_key,changed:true,reason:'',goal_ref:id(1),revision:'3',period:'week',cycle_id:id(10),catalog_ref:id(20),top_completions:duplicate?[top,top]:[top]};
  };
  const expected={data:h.controller.getSnapshot().data,period:'week',revision:'2',cycle_id:id(10)};
  await h.controller.setCompletion(id(20),true,expected);
  assert.equal(h.controller.getSnapshot().mutation,duplicate?'uncertain':'idle');
  if(!duplicate)assert.equal(h.controller.getSnapshot().data.periods.week.completed,1);
});
