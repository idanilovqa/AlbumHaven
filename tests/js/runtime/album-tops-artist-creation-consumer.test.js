'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const C=require('./artist-consumer-fixtures/consumer.cjs');
const {tick}=C;
test('actual automatic consumer waits for its genuine directory request before adding action',async t=>{
 const h=await C.setup(t);assert.equal(h.directories().length,1);assert.equal(h.create(),undefined);assert.equal(h.form(),null);
 assert.deepEqual([...h.origin.headerRoot.childNodes],h.original);await h.grant();assert.ok(h.create());assert.equal(h.create().disabled,false);assert.equal(h.form(),null);
});
test('Create denial leaves original Artist header unadopted and no dead action',async t=>{
 const h=await C.setup(t);await h.grant(false);assert.equal(h.create(),undefined);assert.deepEqual([...h.origin.headerRoot.childNodes],h.original);assert.equal(h.form(),null);
});
test('late directory reply cannot mount into an origin whose private context retired',async t=>{
 const h=await C.setup(t),request=h.directories()[0];h.change('context');await tick();assert.equal(request.options.signal.aborted,true);
 request.resolve(h.envelope({tops:[],next_cursor:null,allowed_actions:{'library.browse.read':true,'library.album_tops.create':true,can_create:true}}));await tick();
 assert.equal(h.create(),undefined);assert.equal(h.form(),null);assert.equal(h.origin.isOwnerCurrent(),false);
});
test('adoption rehosts exact native header children and chrome still reaches them',async t=>{
 const h=await C.setup(t),header=h.origin.headerRoot;await h.grant();assert.equal(h.origin.headerRoot,header);
 for(const node of h.original)assert.equal(header.contains(node),true,'original node is rehosted, not cloned');
 h.context.syncAlbumTopArtistCreationContext();await tick();for(const node of h.original)assert.equal(header.contains(node),true);
 assert.equal([...header.querySelectorAll('button')].filter(n=>(n.getAttribute('aria-label')||n.textContent.trim())==='Create Listen-through').length,1);
});
test('repeated actual Create clicks open one native child and one scoped population',async t=>{
 const h=await C.setup(t);await h.grant();const button=h.create();h.click(button);h.click(button);await tick();
 assert.ok(h.form());assert.equal(h.document.querySelectorAll('form[aria-label="Create Album Top"]').length,1);
 assert.equal(h.pending('/album-top-catalog/search').length,1);assert.equal(h.namespace.snapshot().phase(),'child');
 await h.population();assert.equal(h.form().querySelector('[aria-label="Album Top name"]').value,'');
 assert.equal(h.requests.filter(r=>r.options.method==='POST').length,0);
});
test('owned child suspension preserves the editor while native parent is nonactionable',async t=>{
 const h=await C.setup(t);await h.grant();h.click(h.create());await tick();const form=h.form();await h.population();
 const suspended=h.namespace.snapshot();assert.equal(suspended,h.origin);assert.equal(suspended.canCreate(),false);
 h.context.syncAlbumTopArtistCreationContext();await tick();assert.equal(h.form(),form);assert.equal(h.namespace.snapshot(),h.origin);
});
test('private context retirement tears down only owned child and header action',async t=>{
 const h=await C.setup(t);await h.grant();h.click(h.create());await tick();const request=h.pending('/album-top-catalog/search')[0];assert.ok(request);
 h.change('context');await tick();assert.equal(request.options.signal.aborted,true);assert.equal(h.form(),null);assert.equal(h.create(),undefined);
 request.resolve(h.envelope({albums:[C.B.album(11)],next_cursor:null}));await tick();assert.equal(h.form(),null);assert.equal(h.create(),undefined);
});
test('retirement never steals an original node externally moved out of its adopted slot',async t=>{
 const h=await C.setup(t);await h.grant();const external=h.document.createElement('aside');h.document.body.append(external);
 const node=h.original.find(n=>n.nodeType===1);assert.ok(node);external.append(node);h.change('context');await tick();
 assert.equal(node.parentNode,external);assert.equal(h.create(),undefined);external.remove();
});
