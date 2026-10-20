'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const B=require('./artist-scoped-builder-fixtures/builder.cjs');
const ROOT=path.resolve(process.env.ALBUM_TOP_TEST_ROOT||path.join(__dirname,'../../..'));
const fragment=(file,key)=>{const text=fs.readFileSync(path.join(ROOT,file),'utf8'),escaped=key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');const match=text.match(new RegExp("(?:'"+escaped+"'|"+escaped+"): '([^']*)'"));assert.ok(match,key+' fixed registry entry');return match[1];};
const js='music_app/static/js/button-component.js',jinja='music_app/templates/partials/button.html';
const FRIENDS='<circle cx="8" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3 19c.5-3.5 2.2-5.2 5-5.2s4.5 1.7 5 5.2M14 14.5c3.5-.8 5.8.8 6.5 4.5"/>';
test('Artist Family fixed registries have byte-identical trusted fragments and preserve Friends',()=>{
 assert.equal(fragment(js,'artist-family'),fragment(jinja,'artist-family'));assert.equal(fragment(js,'friends'),FRIENDS);assert.equal(fragment(jinja,'friends'),FRIENDS);assert.notEqual(fragment(js,'artist-family'),FRIENDS);
});
test('actual registry renders decorative currentColor pick, headstock and exactly three people',async t=>{
 const h=await B.setup(t),markup=h.context.ButtonComponent.renderIconSvg('artist-family'),holder=h.document.createElement('div');holder.innerHTML=markup;const svg=holder.querySelector('svg');assert.ok(svg);
 assert.match(markup,/viewBox="0 0 24 24"/);assert.equal(svg.getAttribute('aria-hidden'),'true');assert.equal(svg.getAttribute('focusable'),'false');
 assert.equal(svg.querySelectorAll('[data-artist-family-pick]').length,1);assert.equal(svg.querySelectorAll('[data-artist-family-headstock]').length,1);assert.equal(svg.querySelectorAll('g[data-artist-family-person]').length,3);
 for(const n of svg.querySelectorAll('[fill],[stroke]'))for(const attr of ['fill','stroke'])if(n.hasAttribute(attr))assert.ok(['none','currentColor'].includes(n.getAttribute(attr)));
 assert.doesNotMatch(markup,/<(?:image|rect|foreignObject)|(?:href|url\()|#(?:fff|[0-9a-f]{6})|white|navy/i);assert.match(markup,/currentColor/);
 assert.ok(markup.includes(fragment(js,'artist-family')),'exact registry fragment reaches actual renderer');
});
test('actual accessible Family icon remains one native toggle with exact population intent',async t=>{
 const h=await B.setup(t),button=h.button('Family');assert.equal(button.getAttribute('aria-label'),'Family');assert.equal(button.getAttribute('title'),'Family');assert.equal(button.getAttribute('aria-pressed'),'false');assert.ok(button.querySelector('.ui-icon--artist-family'));
 assert.equal(button.querySelectorAll('[data-artist-family-person]').length,3);h.click(button);await B.tick();const active=h.button('Family');assert.equal(active,button);assert.equal(active.getAttribute('aria-pressed'),'true');assert.ok(active.querySelector('.ui-icon--artist-family'));assert.deepEqual(h.calls.at(-1).artistScope,B.scope('family'));assert.deepEqual(h.rows(),[B.F.A,B.F.B]);
 h.click(active);await B.tick();assert.equal(h.button('Family').getAttribute('aria-pressed'),'false');assert.deepEqual(h.rows(),[B.F.A]);h.input('Album Top name','Scoped');h.submit();await B.tick();const command=h.service.calls.find(x=>x.method==='execute').args[1];assert.deepEqual(command.artist_scope,B.scope());assert.deepEqual(command.album_refs,[B.F.A]);
});
test('busy Create disables the actual icon action without another population request',async t=>{
 const pending=B.N.deferred(),h=await B.setup(t,{execute:()=>pending.promise});h.input('Album Top name','Pending');h.submit();await B.tick();const button=h.button('Family'),count=h.calls.length;assert.equal(button.disabled,true);assert.ok(button.querySelector('.ui-icon--artist-family'));h.click(button);await B.tick();assert.equal(h.calls.length,count);assert.equal(h.service.count('execute'),1);
 const command=h.controller.getSnapshot().mutation.command;pending.resolve({action:'create',request_key:command.request_key,top_ref:B.F.TOP,revision:'1'});await B.tick();
});
test('denial retires or disables Family and captured native action cannot request new scope',async t=>{
 const h=await B.setup(t),button=h.button('Family'),count=h.calls.length;h.controller.observeDenial(h.controller.getSnapshot().scopeKey,Object.assign(new Error('Denied'),{status:403}));await B.tick();assert.ok(!button.isConnected||button.disabled);h.click(button);await B.tick();assert.equal(h.calls.length,count);assert.equal(h.service.count('execute'),0);
});
