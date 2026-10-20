'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const C=require('./artist-consumer-fixtures/consumer.cjs');
const {H,B,tick}=C,{F,N}=B;
const path=r=>new URL(r.url,'http://localhost').pathname;
const isTop=r=>new URL(r.url,'http://localhost').searchParams.get('surface')==='album_tops';
const posts=h=>h.requests.filter(r=>r.options.method==='POST'&&path(r)==='/album-tops');
function button(h,label){const node=[...h.origin.headerRoot.querySelectorAll('button')].find(n=>(n.getAttribute('aria-label')||n.textContent.trim())===label&&!n.closest('[hidden]'));assert.ok(node,label);return node;}
async function dispatch(h,from){
 for(let pass=0;pass<8;pass++){
  await tick();const pending=h.requests.slice(from).filter(r=>!r.settled),top=pending.find(isTop);if(top)return top;
  for(const request of pending){const url=new URL(request.url,'http://localhost');
   if(url.pathname==='/album-tops'&&request.options.method!=='POST')request.resolve(h.envelope({tops:[],next_cursor:null,allowed_actions:N.permissions()}));
   else if(url.pathname==='/album-tops/'+F.TOP)request.resolve(h.envelope(N.detail({top_ref:F.TOP,revision:'1',items:[]})));
   else {assert.equal(url.pathname,'/view-data','only actual directory/detail/native parent hydration is answered');assert.equal(url.searchParams.get('artist'),H.ARTIST);request.resolve(H.payload());}
  }
 }
 assert.fail('exact acknowledged native Top navigation was not dispatched');
}
async function create(t,options={}){
 const h=await C.setup(t,options);await h.grant();h.click(h.create());await tick();await h.population();
 const name=h.form().querySelector('[aria-label="Album Top name"]');name.value='Explicit selection';h.dispatch(name,'input');h.dispatch(h.form(),'submit');await tick();
 assert.equal(posts(h).length,1);const write=posts(h)[0],command=JSON.parse(write.options.body);
 assert.deepEqual(command.artist_scope,{root_artist_id:'3',mode:'artist'});assert.deepEqual(command.album_refs,[F.A]);assert.equal(command.title,'Explicit selection');
 const receipt={action:'create',request_key:command.request_key,top_ref:F.TOP,revision:'1'},from=h.requests.length;
 write.resolve(h.envelope(receipt));const navigation=await dispatch(h,from);
 assert.equal(h.owner('activeAppFormDialog'),null,'actual native dismissal precedes Top dispatch');
 assert.equal(h.document.getElementById('app-confirm-modal').hidden,true,'saved handoff never requests dirty discard');
 assert.equal(h.origin.phase(),'opening');assert.equal(h.origin.canCreate(),false);assert.equal(new URL(navigation.url,'http://localhost').searchParams.get('top_ref'),F.TOP);
 return {...h,command,receipt,navigation};
}
for(const mobile of [false,true])test('automatic consumer completes genuine scoped Create and native Open '+mobile,async t=>{
 const h=await create(t,{mobile});h.navigation.resolve(H.top(h));await tick();
 assert.equal(h.state.view.top_ref,F.TOP);assert.equal(h.origin.isOwnerCurrent(),false);assert.equal(h.namespace.snapshot(),null);assert.equal(posts(h).length,1);assert.equal(h.form(),null);
});
test('genuine failed Open retains explicit recovery and retries without remapping or another Create',async t=>{
 const h=await create(t);h.navigation.resolve({error:'unavailable'},503);await tick();
 assert.equal(h.origin.phase(),'recovery');assert.match(h.origin.headerRoot.textContent,/Top created; opening failed\./);assert.equal(h.form(),null);
 const before=h.requests.length,writeCount=posts(h).length,populations=h.requests.filter(r=>path(r)==='/album-top-catalog/search').length;
 const open=button(h,'Open');h.click(open);h.click(open);const retry=await dispatch(h,before);
 assert.equal(h.requests.slice(before).filter(isTop).length,1);assert.equal(new URL(retry.url,'http://localhost').searchParams.get('top_ref'),h.receipt.top_ref);
 assert.equal(posts(h).length,writeCount);assert.equal(h.requests.filter(r=>path(r)==='/album-top-catalog/search').length,populations);assert.equal(h.form(),null);
 retry.resolve(H.top(h));await tick();assert.equal(h.state.view.top_ref,F.TOP);assert.equal(posts(h).length,1);assert.equal(h.namespace.snapshot(),null);
});
test('recovery Dismiss retires acknowledged origin and cannot automatically recreate form or action',async t=>{
 const h=await create(t);h.navigation.resolve({error:'unavailable'},503);await tick();assert.equal(h.origin.phase(),'recovery');
 const before=h.requests.length;h.click(button(h,'Dismiss'));await tick();h.context.syncAlbumTopArtistCreationContext();await tick();
 assert.equal(h.origin.isOwnerCurrent(),false);assert.equal(h.namespace.snapshot(),null);assert.equal(h.form(),null);assert.equal(h.create(),undefined);assert.equal(h.requests.length,before);assert.equal(posts(h).length,1);
});
test('late failed Open after actual private retirement cannot install recovery or steal focus',async t=>{
 const h=await create(t);h.change('context');const external=h.document.createElement('button');h.document.body.append(external);external.focus();
 h.navigation.resolve({error:'unavailable'},503);await tick();assert.equal(h.namespace.snapshot(),null);assert.equal(h.form(),null);assert.equal(h.origin.isOwnerCurrent(),false);
 assert.equal(h.document.activeElement,external);assert.doesNotMatch(h.origin.headerRoot.textContent,/Top created; opening failed\./);assert.equal(posts(h).length,1);external.remove();
});
