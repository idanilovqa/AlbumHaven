'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const H=require('./artist-creation-fixtures/facade.cjs');
test('actual request advance retains reserved origin without Create before its exact private offer',async t=>{
  const h=await H.fixture(t),ack=await H.acknowledgement(t,h);assert.ok(H.form(h));const fetch=h.context.fetchAndRender,observed=[],before=h.state.ui.activeViewRequestId;
  h.context.fetchAndRender=function(url,push,options){return fetch.call(this,url,push,{...options,onStart(value){
    observed.push({stage:'before-offer',requestId:value.requestId,actual:h.state.ui.activeViewRequestId,origin:h.namespace.snapshot(),phase:h.origin.phase(),canCreate:h.origin.canCreate()});
    const accepted=options.onStart(value);
    observed.push({stage:'after-offer',accepted,requestId:value.requestId,actual:h.state.ui.activeViewRequestId,origin:h.namespace.snapshot(),phase:h.origin.phase(),canCreate:h.origin.canCreate(),owned:h.origin.isOwnerCurrent()});return accepted;
  }});};let work;
  try{work=h.origin.openCreatedTop(ack.receipt,{isCurrent:ack.isCurrent});await H.drain();assert.equal(observed.length,2);assert.ok(observed[0].requestId>before);for(const row of observed){assert.equal(row.requestId,row.actual);assert.equal(row.origin,h.origin);assert.equal(row.phase,'opening');assert.equal(row.canCreate,false);}assert.equal(observed[1].accepted,true);assert.equal(observed[1].owned,true);
    const request=h.requests.find(row=>!row.settled&&new URL(row.url,h.location.href).searchParams.get('surface')==='album_tops');assert.ok(request);request.resolve(H.top(h));assert.equal(await work,true);
  }finally{h.context.fetchAndRender=fetch;}
});
