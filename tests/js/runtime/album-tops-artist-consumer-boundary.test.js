'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const A=require('./artist-host-fixtures/actual-artist-runtime.cjs');
const H=require('./artist-creation-fixtures/facade.cjs');
const C=require('./artist-consumer-fixtures/consumer.cjs');
const {tick}=C;
const createButton=header=>[...header.querySelectorAll('button')].find(n=>(n.getAttribute('aria-label')||n.textContent.trim())==='Create Listen-through');
test('actual origin subscriber can retire admission before automatic consumer mounts authority or actions',async t=>{
 const h=A.fixture(t),root=h.document.createElement('section');root.id='album-tops-root';h.main.append(root);
 const namespace=h.context.AlbumHavenAlbumTopsRuntime.artistCreation;let retired=0;
 const unsubscribe=namespace.subscribe(()=>{const origin=namespace.snapshot();if(!retired&&origin?.canCreate()){retired++;h.change('context');}});
 t.after(unsubscribe);await h.entry();const payload=H.payload(),index=h.requests.length,work=h.read(h.context.buildApiUrl(payload),{},true);h.reply(index,payload);await work;await tick();assert.equal(retired,1);assert.equal(namespace.snapshot(),null);
 assert.equal(createButton(h.header),undefined);assert.equal(h.document.querySelector('form[aria-label="Create Album Top"]'),null);
 for(const request of h.requests.filter(r=>!r.settled&&new URL(r.url,'http://localhost').pathname==='/album-tops')){
  assert.equal(request.options.signal.aborted,true);request.resolve({status:'ready',context_ref:H.STAMP,data:{tops:[],next_cursor:null,allowed_actions:{'library.browse.read':true,'library.album_tops.create':true,can_create:true}}});
 }
 await tick();assert.equal(createButton(h.header),undefined);
});
for(const method of ['listScopedAlbums','admitAlbum','execute'])test('single explicit actual consumer rejects changed provider identity '+method,async t=>{
 // Deliberately targeted public-constructor test. The real entry has no Top
 // mount host, so exactly one explicit consumer is mounted with real providers.
 const h=await H.fixture(t,{withDestinationHost:false});assert.equal(h.document.getElementById('album-tops-root'),null);
 const {createAlbumTopBackendProviders}=await H.F.load('album-tops/backend-providers.mjs');
 const {mountArtistListenThroughCreation}=await H.F.load('album-tops/artist-creation.mjs');
 const providers=createAlbumTopBackendProviders({transport:h.context.AlbumHavenPrivateUITransport,acceptsScope:h.bridge.acceptsPrivateScope});
 let disposed=0;const realDispose=providers.dispose;providers.dispose=()=>{disposed++;return realDispose();};
 const originalNodes=[...h.origin.headerRoot.childNodes];
 const consumer=mountArtistListenThroughCreation({runtime:h.bridge,providers});t.after(()=>{consumer.dispose();realDispose();});await tick();
 const directories=h.requests.filter(r=>!r.settled&&new URL(r.url,'http://localhost').pathname==='/album-tops');assert.equal(directories.length,1);
 directories[0].resolve({status:'ready',context_ref:H.STAMP,data:{tops:[],next_cursor:null,allowed_actions:{'library.browse.read':true,'library.album_tops.create':true,can_create:true}}});await tick();
 const button=createButton(h.origin.headerRoot);assert.ok(button);const before=h.requests.length,actual=providers[method];let replacements=0;
 providers[method]=function(...args){replacements++;return Reflect.apply(actual,this,args);};h.click(button);await tick();
 assert.equal(h.document.querySelector('form[aria-label="Create Album Top"]'),null);assert.equal(h.requests.length,before);assert.equal(replacements,0);assert.equal(disposed,0,'consumer never owns shared provider disposal');
 assert.equal(createButton(h.origin.headerRoot),undefined,'observed provider retirement removes its action immediately');
 assert.deepEqual([...h.origin.headerRoot.childNodes],originalNodes,'retired session restores the exact original native children');
 consumer.dispose();assert.equal(disposed,0);
});
test('duplicate old actual native close callback cannot tear down newer admitted child',async t=>{
 const h=await C.setup(t);await h.grant();const real=h.context.openReactFormDialog;let first=null;
 h.context.openReactFormDialog=function(options,...rest){const opened=Reflect.apply(real,this,[options,...rest]);if(!first)first={options,opened};return opened;};
 t.after(()=>{h.context.openReactFormDialog=real;});h.click(h.create());await tick();await h.population();assert.ok(first);
 const oldOrigin=h.origin;const close=first.opened.close(null,{force:true,restoreFocus:false});
 for(let pass=0;pass<4;pass++){await tick();for(const request of h.requests.filter(r=>!r.settled&&new URL(r.url,'http://localhost').pathname==='/view-data'))request.resolve(H.payload());}
 await close;await tick();const successor=h.namespace.snapshot();assert.ok(successor);assert.notEqual(successor,oldOrigin);assert.equal(oldOrigin.isOwnerCurrent(),false);
 const directory=h.directories();assert.equal(directory.length,1);directory[0].resolve(h.envelope({tops:[],next_cursor:null,allowed_actions:{'library.browse.read':true,'library.album_tops.create':true,can_create:true}}));await tick();
 const button=createButton(successor.headerRoot);assert.ok(button);h.click(button);await tick();const form=h.form();assert.ok(form);
 const currentHeader=successor.headerRoot,name=form.querySelector('[aria-label="Album Top name"]');name.focus();first.options.onClose(null,{current:true,restoreFocusRequested:true});await tick();
 assert.equal(h.form(),form);assert.equal(h.namespace.snapshot(),successor);assert.equal(successor.phase(),'child');assert.equal(h.document.activeElement,name);assert.equal(successor.headerRoot,currentHeader);
});
