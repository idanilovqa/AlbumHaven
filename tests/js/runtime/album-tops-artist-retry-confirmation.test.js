'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const C=require('./artist-consumer-fixtures/consumer.cjs'),B=require('./artist-scoped-builder-fixtures/builder.cjs');
const posts=h=>h.requests.filter(r=>r.options.method==='POST'&&new URL(r.url,'http://localhost').pathname==='/album-tops');
function retry(h){const node=[...h.form().querySelectorAll('button')].find(n=>(n.getAttribute('aria-label')||n.textContent.trim())==='Retry original request'&&!n.closest('[hidden]'));assert.ok(node);return node;}
test('automatic Artist consumer retries only the exact original command through its actual child confirmation',async t=>{
 const h=await C.setup(t);await h.grant();h.click(h.create());await C.tick();await h.population();const input=h.form().querySelector('[aria-label="Album Top name"]');input.value='Owned retry';h.dispatch(input,'input');h.dispatch(h.form(),'submit');await C.tick();
 assert.equal(posts(h).length,1);const original=posts(h)[0].options.body;posts(h)[0].resolve({error:'unavailable'},503);await C.tick();h.click(retry(h));await C.tick();
 assert.equal(h.document.getElementById('app-confirm-modal').hidden,false);assert.equal(h.document.getElementById('app-confirm-title').textContent,'Retry original request');assert.equal(posts(h).length,1);assert.equal(h.origin.phase(),'child');
 h.click(h.document.getElementById('app-confirm-accept'));await C.tick();assert.equal(posts(h).length,2);assert.equal(posts(h)[1].options.body,original);posts(h)[1].resolve({error:'invalid_command'},422);await C.tick();assert.ok(h.form());
});
test('private Artist retirement during genuine original-request confirmation prevents retry',async t=>{
 const h=await B.setup(t,{execute:async()=>{throw new Error('Unknown response');}});h.input('Album Top name','Retired retry');h.submit();await B.tick();assert.equal(h.controller.getSnapshot().mutation.status,'uncertain');
 h.click(h.button('Retry original request'));await B.tick();const modal=h.document.getElementById('app-confirm-modal'),accept=h.document.getElementById('app-confirm-accept');assert.equal(modal.hidden,false);h.change('context');h.namespace.snapshot();h.click(accept);await B.tick();assert.equal(h.service.count('execute'),1);assert.equal(h.acknowledged.length,0);assert.equal(h.origin.isOwnerCurrent(),false);
});
