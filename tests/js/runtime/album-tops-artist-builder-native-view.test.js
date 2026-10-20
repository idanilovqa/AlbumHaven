'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const B=require('./artist-native-view-fixtures/builder.cjs');
const chooser=h=>{const n=h.form().querySelector('[role="group"][aria-label="View"]');assert.ok(n,'real native ViewChooser');return n;};
const choose=(h,value)=>{const n=chooser(h);h.click(n.querySelector('button.is-active'));h.click(n.querySelector(`[data-action-value="${value}"]`));};
const selected=h=>h.form().querySelector('[role="tab"][data-value="selected"]')||[...h.form().querySelectorAll('button')].find(n=>(n.getAttribute('aria-label')||n.textContent).startsWith('Selected ('));
const observe=h=>{const cards=[],actual=h.runtime.galleryCardHtml;h.runtime.galleryCardHtml=function(...args){cards.push(args[0]);return Reflect.apply(actual,this,args);};return cards;};
test('actual View starts compact and explicit initially-selected Cards enables known native full info',async t=>{
 const h=await B.setup(t,{population:async()=>({albums:[B.album(11,{artist:'Known Artist',creation_metadata:{rating:7,rating_state:'available',release_type:'studio',artwork_url:null}})],next_cursor:null})});
 assert.equal(chooser(h).querySelector('button.is-active').dataset.actionValue,'cards');assert.doesNotMatch(h.form().querySelector('[data-album-draft-key]').textContent,/Known Artist/);
 const storage=h.storageCalls.slice(),calls=observe(h);choose(h,'cards');await B.tick();assert.equal(calls.at(-1).displayMode,'cards');assert.equal(calls.at(-1).artist,'Known Artist');assert.ok(calls.at(-1).ratingHtml);assert.deepEqual(h.rows(),[B.F.A]);assert.deepEqual(h.storageCalls,storage);
});
for(const [value,mode]of [['list','list'],['covers','covers']])test(`actual View ${value} preserves selected command order and real reorder`,async t=>{
 const h=await B.setup(t,{population:async()=>({albums:[B.album(11),B.album(12)],next_cursor:null})}),calls=observe(h),storage=h.storageCalls.slice();
 choose(h,value);await B.tick();assert.ok(calls.length);assert.ok(calls.every(x=>x.displayMode===mode));assert.equal(h.form().querySelectorAll('.gallery-card-info').length,mode==='covers'?0:2);
 const first=h.form().querySelector('[data-album-draft-key]'),move=first.querySelector('[data-album-draft-move]');move.focus();move.dispatchEvent(new h.context.Event('keydown',{key:'End'}));await B.tick();assert.deepEqual(h.rows(),[B.F.B,B.F.A]);assert.equal(h.document.activeElement,move);
 assert.deepEqual(h.storageCalls,storage);h.input('Album Top name','Ordered');h.submit();await B.tick();assert.deepEqual(h.service.calls.find(x=>x.method==='execute').args[1].album_refs,[B.F.B,B.F.A]);
});
test('local View survives All/Selected, filter reset and Family population without becoming global',async t=>{
 const h=await B.setup(t);choose(h,'list');await B.tick();h.click(h.button('All'));await B.tick();assert.equal(h.form().querySelector('[role="group"][aria-label="View"]'),null);
 h.click(selected(h));await B.tick();assert.equal(chooser(h).querySelector('button.is-active').dataset.actionValue,'list');
 h.input('Year from','1900');h.click(h.button('Reset'));h.click(h.button('Family'));await B.tick();assert.equal(chooser(h).querySelector('button.is-active').dataset.actionValue,'list');assert.deepEqual(h.rows(),[B.F.A,B.F.B]);
});
for(const retire of ['denied','disposed','tab'])test(`captured real View owner callback is inert after ${retire}`,async t=>{
 const h=await B.setup(t);h.click(h.button('All'));await B.tick();let callback;const actual=h.runtime.mountViewChooser;
 h.runtime.mountViewChooser=function(root,options){callback=options.onSelect;return Reflect.apply(actual,this,[root,options]);};h.click(selected(h));await B.tick();assert.equal(typeof callback,'function');
 const calls=observe(h);if(retire==='denied')h.controller.observeDenial(h.controller.getSnapshot().scopeKey,Object.assign(new Error('Denied'),{status:403}));else if(retire==='disposed')h.editor.dispose();else h.click(h.button('All'));
 await B.tick();const count=calls.length;callback('covers');await B.tick();assert.equal(calls.length,count);assert.equal(h.service.count('execute'),0);
});
test('busy Create leaves a captured View callback unable to repaint',async t=>{
 const gate=B.N.deferred(),h=await B.setup(t,{execute:()=>gate.promise});h.click(h.button('All'));await B.tick();let callback;const actual=h.runtime.mountViewChooser;h.runtime.mountViewChooser=function(root,options){callback=options.onSelect;return Reflect.apply(actual,this,[root,options]);};h.click(selected(h));await B.tick();assert.equal(typeof callback,'function');h.input('Album Top name','Busy');h.submit();await B.tick();const calls=observe(h);callback('list');await B.tick();assert.equal(calls.length,0);assert.equal(h.service.count('execute'),1);
 const command=h.controller.getSnapshot().mutation.command;gate.resolve({action:'create',request_key:command.request_key,top_ref:B.F.TOP,revision:'1'});await B.tick();
});
test('actual origin currentness callback retires View action before captured choice can paint',async t=>{
 let armed=false;const h=await B.setup(t,{observeCurrent({controller}){if(armed){armed=false;controller.observeDenial(controller.getSnapshot().scopeKey,Object.assign(new Error('Denied'),{status:403}));}}});h.click(h.button('All'));await B.tick();let callback;const mount=h.runtime.mountViewChooser;h.runtime.mountViewChooser=function(root,options){callback=options.onSelect;return Reflect.apply(mount,this,[root,options]);};h.click(selected(h));await B.tick();assert.equal(typeof callback,'function');
 armed=true;
 const calls=observe(h);callback('covers');await B.tick();assert.equal(calls.length,0);assert.equal(h.service.count('execute'),0);
});
