'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const B=require('./artist-scoped-builder-fixtures/builder.cjs');
const {F,N,tick}=B;
test('connected bridge exposes exact whole separator and rating owners',async t=>{
 const h=await B.setup(t);for(const [method,owner,props]of [
 ['artistSeparatorHtml','buildFamilyArtistHeaderHtml',{artist:'Canonical Artist',albumCount:2,showInfo:false}],
 ['galleryRatingHtml','buildGalleryRatingHtml',{rating:7}]]){
 assert.equal(typeof h.bridge[method],'function');assert.equal(h.bridge[method](props),h.owner(owner)(props));}
});
test('scoped builder starts expanded with actual Selected and blank metadata',async t=>{
 const h=await B.setup(t);assert.deepEqual(h.rows(),[F.A]);assert.equal(h.field('Album Top name').value,'');assert.equal(h.field('Album Top subtitle').value,'');
 assert.deepEqual(h.calls[0].artistScope,B.scope());assert.equal(h.service.count('searchAlbums'),0);assert.equal(h.button('Create Album Top').disabled,true);
});
test('real Family control recomputes initial population without altering root',async t=>{
 const h=await B.setup(t);h.click(h.button('Family'));await tick();assert.deepEqual(h.rows(),[F.A,F.B]);assert.deepEqual(h.calls.at(-1).artistScope,B.scope('family'));
 h.click(h.button('Family'));await tick();assert.deepEqual(h.rows(),[F.A]);assert.deepEqual(h.calls.at(-1).artistScope,B.scope());
});
for(const raw of ['1e2','-1',' 7','11'])test(`invalid native rating ${JSON.stringify(raw)} blocks direct form submit`,async t=>{
 const h=await B.setup(t);h.input('Album Top name','Scoped');h.input('Rating from',raw);await tick();assert.deepEqual(h.rows(),[F.A]);assert.equal(h.button('Create Album Top').disabled,true);
 h.submit();await tick();assert.equal(h.service.count('execute'),0);assert.equal(h.acknowledged.length,0);
});
test('loading population is incomplete and cannot submit even through form event',async t=>{
 const page=N.deferred(),h=await B.setup(t,{population:()=>page.promise});h.input('Album Top name','Scoped');h.submit();await tick();assert.equal(h.service.count('execute'),0);
 page.resolve({albums:[B.album(11)],next_cursor:null});await tick();assert.deepEqual(h.rows(),[F.A]);assert.equal(h.button('Create Album Top').disabled,false);
});
test('failed population exposes actual Retry population and commits only complete retry',async t=>{
 let count=0;const h=await B.setup(t,{population:async()=>{if(++count===1)throw new Error('Unavailable');return {albums:[B.album(11)],next_cursor:null};}});
 h.input('Album Top name','Scoped');h.submit();await tick();assert.equal(h.service.count('execute'),0);assert.equal(h.button('Create Album Top').disabled,true);
 h.click(h.button('Retry population'));await tick();assert.equal(count,2);assert.deepEqual(h.rows(),[F.A]);assert.equal(h.button('Create Album Top').disabled,false);
});
test('exact Create acknowledgement waits for genuine controller detail refresh without pre-close',async t=>{
 const read=N.deferred(),h=await B.setup(t,{providers:{read:()=>read.promise}});h.input('Album Top name','Scoped');h.input('Album Top subtitle','Chosen');h.submit();await tick();
 assert.equal(h.service.count('execute'),1);const command=h.controller.getSnapshot().mutation.command;
 assert.deepEqual(command.artist_scope,B.scope());assert.deepEqual(command.album_refs,[F.A]);assert.equal(command.title,'Scoped');assert.equal(command.description,'Chosen');
 assert.equal(h.controller.getSnapshot().mutation.refreshing,true);assert.equal(h.acknowledged.length,0);assert.equal(h.closed.length,0);assert.equal(h.ordinary.length,0);
 read.resolve(N.detail({top_ref:F.TOP,revision:'1',items:[]}));await tick();
 assert.equal(h.controller.getSnapshot().selectedTopRef,F.TOP);assert.equal(h.controller.getSnapshot().mutation.refreshing,false);assert.equal(h.acknowledged.length,1);
 assert.equal(h.acknowledged[0].submittedRequestKey,command.request_key);assert.deepEqual(h.acknowledged[0].receipt,h.controller.getSnapshot().mutation.data);
 assert.equal(h.closed.length,0);assert.equal(h.ordinary.length,0);assert.ok(h.form(),'callback receives acknowledgement before native dismissal');
 h.editor.update({state:h.controller.getSnapshot()});await tick();assert.equal(h.acknowledged.length,1);assert.equal(h.service.count('execute'),1);
 assert.equal(await h.forms[0].beforeDismiss(),true,'acknowledged departure does not ask to discard saved changes');
 assert.equal(h.document.getElementById('app-confirm-modal').hidden,true);
});
test('session retirement during actual refresh cannot deliver acknowledgement',async t=>{
 const read=N.deferred(),h=await B.setup(t,{providers:{read:()=>read.promise}});h.input('Album Top name','Scoped');h.submit();await tick();assert.equal(h.service.count('execute'),1);
 h.invalidate();read.resolve(N.detail({top_ref:F.TOP,revision:'1',items:[]}));await tick();assert.equal(h.acknowledged.length,0);assert.equal(h.ordinary.length,0);
});
test('scoped builder retains ordinary dirty confirmation before acknowledgement',async t=>{
 const h=await B.setup(t);h.input('Album Top name','Unsaved');const dismiss=h.forms[0].beforeDismiss();await tick();assert.equal(h.document.getElementById('app-confirm-modal').hidden,false);
 h.click(h.document.getElementById('app-confirm-cancel'));assert.equal(await dismiss,false);assert.ok(h.form());assert.equal(h.service.count('execute'),0);
});
