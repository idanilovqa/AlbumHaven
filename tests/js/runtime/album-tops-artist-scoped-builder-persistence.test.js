'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const B=require('./artist-scoped-builder-fixtures/builder.cjs');
const {F,N,tick}=B;
test('existing keyboard reorder owns Selected preview order and submitted membership',async t=>{
 const h=await B.setup(t,{population:async()=>({albums:[B.album(11),B.album(12)],next_cursor:null})});
 const first=h.form().querySelector('[data-album-draft-key]'),move=first.querySelector('[data-album-draft-move]');assert.ok(move);move.focus();
 move.dispatchEvent(new h.context.Event('keydown',{key:'End'}));await tick();assert.deepEqual(h.rows(),[F.B,F.A]);
 assert.equal(h.form().querySelectorAll('[data-album-draft-key]')[1],first);assert.equal(h.document.activeElement,move);
 h.input('Album Top name','Ordered');h.submit();await tick();assert.equal(h.service.count('execute'),1);
 assert.deepEqual(h.service.calls.find(row=>row.method==='execute').args[1].album_refs,[F.B,F.A]);
});
test('unbound local admissions finish before Create and stable-deduplicate canonical refs',async t=>{
 const gate=N.deferred(),h=await B.setup(t,{population:async()=>({albums:[B.album(11,{album_ref:null}),B.album(12,{album_ref:null})],next_cursor:null}),
 providers:{admitAlbum:async id=>id===11?{album_ref:F.A}:gate.promise}});
 h.input('Album Top name','Mapped');h.submit();await tick();assert.equal(h.service.count('admitAlbum'),2);assert.equal(h.service.count('execute'),0);
 gate.resolve({album_ref:F.A});await tick();assert.equal(h.service.count('execute'),1);assert.deepEqual(h.service.calls.find(row=>row.method==='execute').args[1].album_refs,[F.A]);
 for(const row of h.service.calls.filter(row=>row.method==='admitAlbum'))assert.deepEqual(row.args[1].artistScope,B.scope());
});
test('partial local admission failure cannot Create or acknowledge and preserves visible membership',async t=>{
 const h=await B.setup(t,{population:async()=>({albums:[B.album(11,{album_ref:null}),B.album(12,{album_ref:null})],next_cursor:null}),
 providers:{admitAlbum:async id=>{if(id===12)throw Object.assign(new Error('Binding changed'),{status:409,code:'native_binding_changed'});return {album_ref:F.A};}}});
 h.input('Album Top name','Preserved');const before=h.rows();h.submit();await tick();assert.equal(h.service.count('admitAlbum'),2);
 assert.equal(h.service.count('execute'),0);assert.equal(h.acknowledged.length,0);assert.deepEqual(h.rows(),before);assert.equal(h.field('Album Top name').value,'Preserved');
});
test('uncertain scoped Create uses actual confirmation and exactly the original command',async t=>{
 let attempt=0;const h=await B.setup(t,{execute:async(action,command)=>{if(++attempt===1)throw new Error('Unknown response');return {action,request_key:command.request_key,top_ref:F.TOP,revision:'1'};}});
 h.input('Album Top name','One command');h.submit();await tick();assert.equal(h.controller.getSnapshot().mutation.status,'uncertain');
 const original=structuredClone(h.service.calls.find(row=>row.method==='execute').args[1]);assert.equal(h.acknowledged.length,0);
 assert.equal(await h.forms[0].beforeDismiss(),false);h.submit();await tick();assert.equal(h.service.count('execute'),1);
 h.click(h.button('Retry original request'));await tick();assert.equal(h.document.getElementById('app-confirm-modal').hidden,false);assert.equal(h.service.count('execute'),1);
 h.click(h.document.getElementById('app-confirm-accept'));await tick();assert.equal(h.service.count('execute'),2);
 assert.deepEqual(h.service.calls.filter(row=>row.method==='execute')[1].args[1],original);assert.equal(h.acknowledged.length,1);assert.equal(h.acknowledged[0].submittedRequestKey,original.request_key);
});
test('busy actual Create vetoes dismissal and duplicate direct submit',async t=>{
 const gate=N.deferred(),h=await B.setup(t,{execute:()=>gate.promise});h.input('Album Top name','Pending');h.submit();await tick();
 assert.equal(h.controller.getSnapshot().mutation.status,'loading');assert.equal(await h.forms[0].beforeDismiss(),false);h.submit();await tick();assert.equal(h.service.count('execute'),1);
 const command=h.controller.getSnapshot().mutation.command;gate.resolve({action:'create',request_key:command.request_key,top_ref:F.TOP,revision:'1'});await tick();assert.equal(h.acknowledged.length,1);
});
test('actual controller denial prevents stale keyboard and direct Create actions',async t=>{
 const h=await B.setup(t,{population:async()=>({albums:[B.album(11),B.album(12)],next_cursor:null})});h.input('Album Top name','Denied');
 const move=h.form().querySelector('[data-album-draft-move]');assert.ok(move);const before=h.rows();
 h.controller.observeDenial(h.controller.getSnapshot().scopeKey,Object.assign(new Error('Denied'),{status:403}));
 move.dispatchEvent(new h.context.Event('keydown',{key:'End'}));h.submit();await tick();assert.equal(h.service.count('execute'),0);assert.equal(h.controller.getSnapshot().mutation.command??null,null);assert.equal(h.acknowledged.length,0);
});
