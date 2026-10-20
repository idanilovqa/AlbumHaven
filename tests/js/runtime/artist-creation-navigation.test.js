'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const H=require('./artist-creation-fixtures/facade.cjs');
const topRequests=h=>h.requests.filter(row=>new URL(row.url,h.location.href).searchParams.get('surface')==='album_tops');
async function dispatched(h,before){
  // Native return may hydrate its real parent; answer only that genuine request.
  for(let i=0;i<4;i++){await H.drain();const pending=h.requests.slice(before).filter(row=>!row.settled),top=pending.find(row=>new URL(row.url,h.location.href).searchParams.get('surface')==='album_tops');if(top)return top;
    for(const row of pending){const url=new URL(row.url,h.location.href);assert.equal(url.pathname,'/view-data');assert.equal(url.searchParams.get('artist'),H.ARTIST);row.resolve(H.payload());}}
  assert.fail('native acknowledged Open did not dispatch its exact Top');
}
async function ready(t,options={}){const h=await H.fixture(t,options),ack=await H.acknowledgement(t,h);const form=H.form(h);assert.ok(form);return {...h,ack,form};}
function open(h,options={}){const settled=[];const work=h.origin.openCreatedTop(h.ack.receipt,{isCurrent:h.ack.isCurrent,onSettled:result=>settled.push(result),...options});return {work,settled};}

for(const mobile of [false,true])test('actual acknowledged Create opens once through native dismissal and transferred request '+mobile,async t=>{
  const h=await ready(t,{mobile}),before=h.requests.length,originalRequest=h.state.ui.activeViewRequestId,session=h.runtime().snapshot().sessionId;
  const pending=open(h),request=await dispatched(h,before);assert.equal(h.owner('activeAppFormDialog'),null);assert.ok(h.state.ui.activeViewRequestId>originalRequest);assert.equal(h.namespace.snapshot(),h.origin);assert.equal(h.origin.phase(),'opening');assert.equal(h.origin.canCreate(),false);assert.equal(h.origin.isOwnerCurrent(),true);assert.equal(new URL(request.url,h.location.href).searchParams.get('top_ref'),H.F.TOP);assert.equal(h.ack.calls.length,1);
  request.resolve(H.top(h));assert.equal(await pending.work,true);await H.drain();assert.equal(pending.settled.length,1);assert.equal(pending.settled[0].opened,true);assert.equal(h.namespace.snapshot(),null);assert.equal(h.origin.isOwnerCurrent(),false);assert.equal(h.state.view.top_ref,H.F.TOP);assert.equal(h.ack.calls.length,1);assert.ok(session);
});
for(const mobile of [false,true])test('declined actual native dismissal prevents any Open dispatch '+mobile,async t=>{
  const h=await H.fixture(t,{mobile}),ack=await H.acknowledgement(t,h);h.ack=ack;const form=H.form(h,{beforeDismiss:()=>false});assert.ok(form);const before=topRequests(h).length,pending=open(h);assert.equal(await pending.work,false);assert.equal(topRequests(h).length,before);assert.equal(h.origin.canCreate(),false);assert.ok(h.owner('activeAppFormDialog'));assert.equal(ack.calls.length,1);
});
test('initial live acknowledgement guard rejection cannot dispatch or seal a fabricated receipt',async t=>{
  const h=await ready(t),before=h.requests.length;assert.equal(await h.origin.openCreatedTop(h.ack.receipt,{isCurrent:()=>false}),false);assert.equal(h.requests.length,before);assert.ok(h.owner('activeAppFormDialog'));
});
test('genuine failed fetch restores same Artist parent before recoverable settlement and exact retry',async t=>{
  const h=await ready(t),session=h.runtime().snapshot().sessionId,before=h.requests.length,events=[];
  const pending=open(h,{onSettled(value){events.push({value,busy:h.state.busy,controller:h.state.ui.activeViewRequestController,pending:h.state.ui.pendingViewRequest,artist:h.runtime().snapshot()});}});const request=await dispatched(h,before);request.resolve({error:'unavailable'},503);assert.equal(await pending.work,false);await H.drain();assert.equal(events.length,1);assert.equal(events[0].value.opened,false);assert.equal(events[0].value.recoverable,true);assert.ok(events[0].value.error);assert.equal(events[0].busy,false);assert.equal(events[0].controller??null,null);assert.equal(events[0].pending??null,null);assert.equal(events[0].artist.sessionId,session);assert.equal(events[0].artist.actionable,true);H.terminal(h);
  assert.equal(h.namespace.snapshot(),h.origin);assert.equal(h.origin.phase(),'recovery');assert.equal(h.origin.canCreate(),false);assert.equal(h.origin.isOwnerCurrent(),true);h.ack.controller.dispose();
  const nextBefore=h.requests.length,retry=h.origin.openCreatedTop({...h.ack.receipt},{isCurrent:()=>true});const next=await dispatched(h,nextBefore);assert.notEqual(next,request);assert.equal(new URL(next.url,h.location.href).searchParams.get('top_ref'),H.F.TOP);next.resolve(H.top(h));assert.equal(await retry,true);assert.equal(h.ack.calls.length,1);assert.equal(h.namespace.snapshot(),null);
});
for(const field of ['request_key','top_ref','revision','action'])test('recovery cannot substitute acknowledged receipt '+field,async t=>{
  const h=await ready(t),before=h.requests.length,pending=open(h),request=await dispatched(h,before);request.resolve({error:'unavailable'},503);assert.equal(await pending.work,false);assert.equal(h.origin.phase(),'recovery');const count=h.requests.length;
  const changed={...h.ack.receipt,[field]:field==='revision'?'2':field==='action'?'copy':H.F.OTHER};assert.equal(await h.origin.openCreatedTop(changed,{isCurrent:()=>true}),false);assert.equal(h.requests.length,count);assert.equal(h.ack.calls.length,1);
});
test('second Open during the actual pending request is rejected without a second dispatch',async t=>{
  const h=await ready(t),before=h.requests.length,first=open(h),request=await dispatched(h,before),count=h.requests.length;assert.equal(await h.origin.openCreatedTop(h.ack.receipt,{isCurrent:h.ack.isCurrent}),false);assert.equal(h.requests.length,count);request.resolve(H.top(h));assert.equal(await first.work,true);assert.equal(h.ack.calls.length,1);
});
for(const change of ['context','dispose'])test('late Open response cannot restore '+change+' retired recovery or focus',async t=>{
  const h=await ready(t),before=h.requests.length,pending=open(h),request=await dispatched(h,before);if(change==='context')h.change('context');else h.origin.dispose();const external=h.document.createElement('button');h.document.body.append(external);external.focus();request.resolve(H.top(h));assert.equal(await pending.work,false);await H.drain();assert.equal(h.namespace.snapshot(),null);assert.equal(h.origin.isOwnerCurrent(),false);assert.equal(h.document.activeElement,external);assert.equal(pending.settled.some(row=>row.recoverable),false);
});
test('disposed actual Artist owner prevents recovery even when failed view and header objects remain',async t=>{
  const h=await ready(t),before=h.requests.length,pending=open(h),request=await dispatched(h,before);h.runtime().dispose();request.resolve({error:'unavailable'},503);assert.equal(await pending.work,false);await H.drain();assert.equal(pending.settled.some(row=>row.recoverable),false);assert.equal(h.namespace.snapshot(),null);
});
test('actual onStart scope mutation rejects private transfer without a stale request application',async t=>{
  const h=await ready(t),fetch=h.context.fetchAndRender;let observed=0;
  h.context.fetchAndRender=function(url,push,options){return fetch.call(this,url,push,{...options,onStart(value){observed++;assert.equal(value.requestId,h.state.ui.activeViewRequestId);h.change('context');return options.onStart(value);}});};const before=h.requests.length;
  try{assert.equal(await h.origin.openCreatedTop(h.ack.receipt,{isCurrent:h.ack.isCurrent}),false);assert.equal(observed,1);assert.equal(h.requests.length,before);assert.equal(h.namespace.snapshot(),null);}finally{h.context.fetchAndRender=fetch;}
});
test('duplicate actual onStart delivery cannot offer another request or admit a response',async t=>{
  const h=await ready(t),fetch=h.context.fetchAndRender,offers=[];
  h.context.fetchAndRender=function(url,push,options){return fetch.call(this,url,push,{...options,onStart(value){assert.equal(value.requestId,h.state.ui.activeViewRequestId);offers.push(options.onStart(value));offers.push(options.onStart(value));return offers.at(-1);}});};const before=h.requests.length;
  try{assert.equal(await h.origin.openCreatedTop(h.ack.receipt,{isCurrent:h.ack.isCurrent}),false);assert.deepEqual(offers,[true,false]);assert.equal(h.requests.length,before);assert.equal(h.origin.canCreate(),false);}finally{h.context.fetchAndRender=fetch;}
});
test('settlement callback errors cannot redirect a successfully applied Top',async t=>{
  const h=await ready(t),before=h.requests.length,pending=open(h,{onSettled(){throw new Error('observer failed');}}),request=await dispatched(h,before);request.resolve(H.top(h));assert.equal(await pending.work,true);assert.equal(h.state.view.top_ref,H.F.TOP);assert.equal(h.namespace.snapshot(),null);
});

test('ordinary public navigate ignores forged private handoff fields and keeps actual native observer behavior',async t=>{
  const h=await H.fixture(t),before=h.requests.length;let starts=0,offers=0;const fake={offerRequest(){offers++;return true;},isCurrent:()=>true,retire(){offers++;}};
  const pending=h.bridge.navigate({top_ref:H.F.TOP,isCurrent:()=>true,onStart(){starts++;},artistHandoff:fake,handoff:fake});const request=await dispatched(h,before);assert.equal(starts,1);assert.equal(offers,0);request.resolve(H.top(h));assert.equal(await pending,true);assert.equal(offers,0);
});
test('a real newer foreground request suppresses old failed Open recovery',async t=>{
  const h=await ready(t),before=h.requests.length,old=open(h),request=await dispatched(h,before);const value=H.payload({query:'newer Artist intent'}),next=h.read(h.context.buildApiUrl(value),{},true);await H.drain();request.resolve({error:'old failure'},503);assert.equal(await old.work,false);await H.drain();
  for(const pending of h.requests)if(!pending.settled)pending.resolve(value);await next;await H.drain();assert.equal(old.settled.some(row=>row.recoverable),false);assert.equal(h.origin.isOwnerCurrent(),false);const current=h.namespace.snapshot();h.origin.dispose();assert.equal(h.namespace.snapshot(),current);
});
