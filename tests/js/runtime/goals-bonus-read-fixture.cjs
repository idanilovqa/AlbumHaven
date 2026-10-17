'use strict';
const assert = require('node:assert/strict');
const sequence = ['/account/goals','/account/goals/bonus-settings','/account/goals/bonus','/account/goals'];
function bonusReadFixture(t, getData) {
  const allRequests=[], cycles=[], waiters=[]; let phase=0, cycle=null, entered;
  const ready=new Promise(resolve=>{entered=resolve;});t.after(()=>{entered();for(const resolve of waiters.splice(0))resolve();});
  const settings=()=>({settings_revision:'1',enabled:false,source_mode:'all_active',selected_top_refs:[],preferred_top_refs:[],
    album_mode:'next',unfinished_policy:'carry',selection_algorithm:'active-top-weighted-v1',normal_top_weight:1,preferred_top_weight:3});
  function dispatch(path,options={}) {
    allRequests.push({path,options});
    const get=!options.method||options.method==='GET';
    if(phase===2||phase===3){assert.equal(get,true);assert.equal(path,sequence[phase],'coherent bonus read endpoint order');}
    if(get&&path==='/account/goals/bonus-settings'){
      assert.equal(phase,1,'settings follows actual Goals read');cycle.push(path);phase=2;return {handled:true,data:settings()};
    }
    if(get&&path==='/account/goals/bonus'){
      cycle.push(path);phase=3;const data=getData();return {handled:true,data:{cycle_id:data.periods.week.cycle?.cycle_id??null,bonus:null,manual_count:data.periods.week.total}};
    }
    if(get&&path==='/account/goals'&&phase===3){
      cycle.push(path);assert.deepEqual(cycle,sequence);cycles.push([...cycle]);phase=0;entered();for(const resolve of waiters.splice(0))resolve();return {handled:true,data:getData()};
    }
    if(get&&path==='/account/goals'){cycle=[path];phase=1;} else if(phase===1){phase=0;cycle=null;}
    return {handled:false};
  }
  function assertInitial(){assert.deepEqual(allRequests.map(row=>row.path),sequence);assert.equal(cycles.length,1);}
  return {allRequests,cycles,ready,dispatch,assertInitial,nextCycle:()=>new Promise(resolve=>waiters.push(resolve))};
}
module.exports={bonusReadFixture,bonusReadSequence:sequence};
