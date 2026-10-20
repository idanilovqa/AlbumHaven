'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const A=require('./artist-host-fixtures/actual-artist-runtime.cjs'),H=require('./artist-creation-fixtures/facade.cjs');
for(const change of ['request','context'])test('new origin notification '+change+' reentry fences the older actual native terminal observer',async t=>{
 const h=A.fixture(t);await h.entry();const namespace=h.context.AlbumHavenAlbumTopsRuntime.artistCreation,oldSettled=[],newSettled=[];let entered=false,origin=null,newWork=null,newIndex=-1;
 const off=namespace.subscribe(()=>{const value=namespace.snapshot();if(entered||!value||!value.canCreate())return;entered=true;origin=value;
  if(change==='request'){newIndex=h.requests.length;newWork=h.read('/view-data?surface=album_tops&top_ref='+H.F.TOP,{onSettled:value=>newSettled.push(value)},true);}
  else h.change('context');
 });t.after(off);t.after(()=>origin?.dispose());
 const index=h.requests.length,work=h.read(h.context.buildApiUrl(H.payload()),{onSettled:value=>oldSettled.push(value)},true);assert.equal(h.requests.length,index+1);h.reply(index,H.payload());await work;await H.drain();
 assert.equal(entered,true);assert.deepEqual(oldSettled,[],'older observer cannot run after the callback changed request/private scope');
 if(change==='request'){assert.equal(h.requests.length,newIndex+1);assert.equal(h.requests[newIndex].settled,false);h.reply(newIndex,H.top(h));const result=await newWork;assert.equal(result.error,undefined);assert.equal(result.value,true);assert.equal(newSettled.length,1);assert.equal(h.state.view.top_ref,H.F.TOP);H.terminal(h);}
 else {assert.equal(origin.isOwnerCurrent(),false);assert.equal(namespace.snapshot(),null);}
});
