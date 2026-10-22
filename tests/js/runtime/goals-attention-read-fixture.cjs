'use strict';
const assert=require('node:assert/strict');
// Explicit server boundary beside the existing bonus fixture. Every request is
// retained unfiltered; domain suites retain their original domain-call ledger.
function attentionReadFixture(t,getData) {
 const allRequests=[],acknowledged=new Set();let reads=0,complete;
 let deadline,failed,done=false;const ready=new Promise((resolve,reject)=>{failed=reject;complete=()=>{done=true;clearTimeout(deadline);resolve();};});t.after(()=>complete());
 function projection() {
  const data=getData(),periods=Object.fromEntries(Object.entries(data.periods).map(([key,row])=>[key,{
   cycle_id:row.cycle?.cycle_id??null,due_date:row.cycle?.due_date??null,timezone_name:row.cycle?.timezone_name??null,
   total:row.total,completed:row.completed,due:false,achieved:row.total>0&&row.completed===row.total}]));
  const event=periods.week.total?{kind:'weekly_cycle_started',goal_ref:data.goal_ref,cycle_id:periods.week.cycle_id}:null;
  const seen=Boolean(event&&acknowledged.has(event.cycle_id));
  return {goal_ref:data.goal_ref,revision:data.revision,evaluated_at:'2026-10-15T18:00:00Z',periods,
   weekly_event:event,weekly_acknowledged:seen,indicator:event&&!seen?'blue':'none'};
 }
 function dispatch(route,options={}) {
  allRequests.push({route,options});
  if(route==='/account/goals/attention'){
   assert.equal(options.method||'GET','GET');const data=projection();reads++;
   if(!data.weekly_event||data.weekly_acknowledged)complete();
   return {handled:true,data};
  }
  if(route==='/account/goals/attention/ack'){
   assert.equal(options.method,'POST');const command=typeof options.body==='string'?JSON.parse(options.body):options.body;
   assert.deepEqual(Object.keys(command).sort(),['action','event','request_key']);assert.equal(command.action,'attention_ack');
   assert.match(command.request_key,/^[0-9a-f-]{36}$/);assert.deepEqual(command.event,projection().weekly_event);
   const changed=!acknowledged.has(command.event.cycle_id);acknowledged.add(command.event.cycle_id);
   return {handled:true,data:{ok:true,action:'attention_ack',request_key:command.request_key,event:command.event,changed}};
  }
  return {handled:false};
 }
 function assertInitial(){
  const full=getData().periods.week.total>0;
  assert.deepEqual(allRequests.map(x=>x.route),['/account/goals','/account/goals/bonus-settings','/account/goals/bonus','/account/goals','/account/goals/attention',...(full?['/account/goals/attention/ack','/account/goals/attention']:[])]);
  assert.equal(reads,full?2:1);assert.equal(allRequests.filter(x=>x.options.method==='POST').length,full?1:0);
 }
 return {dispatch,get ready(){if(!done&&!deadline)deadline=setTimeout(()=>failed(new Error('Initial attention response did not settle.')),10000);return ready;},allRequests,assertInitial};
}
module.exports={attentionReadFixture};
