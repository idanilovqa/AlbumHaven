'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const B=require('./artist-scoped-builder-fixtures/builder.cjs');
const group=h=>h.form()?.querySelector('[role="group"][aria-label="View"]');
const mode=root=>root?.querySelector('button.is-active')?.dataset.actionValue;
const clickChoice=(h,root,value)=>{assert.ok(root);const active=root.querySelector('button.is-active'),target=root.querySelector(`[data-action-value="${value}"]`);assert.ok(active&&target);if(!root.classList.contains('is-open'))h.click(active);h.click(target);};
function observe(h){const calls=[],actual=h.runtime.galleryCardHtml;h.runtime.galleryCardHtml=function(...args){calls.push(args[0]);return Reflect.apply(actual,this,args);};return calls;}
function capture(root){return {root,host:root.parentNode,buttons:[...root.querySelectorAll('button')],direction:root.dataset.unfoldDirection,expanded:root.classList.contains('is-open'),count:root.style.getPropertyValue('--unfolding-action-count')};}
async function assertBlockedClicks(h,old,calls,layout){
 const before=calls.length,rows=h.rows();assert.equal(group(h),old);assert.equal(old.parentNode,layout.host);assert.equal(old.isConnected,true);assert.equal(old.closest('[hidden]'),null);assert.deepEqual([...old.querySelectorAll('button')],layout.buttons);assert.equal(old.dataset.unfoldDirection,layout.direction);assert.equal(old.style.getPropertyValue('--unfolding-action-count'),layout.count);for(const button of layout.buttons){assert.equal(button.disabled,true);assert.equal(button.getAttribute('aria-disabled'),'true');assert.equal(button.tabIndex,-1);}
 // Exercise actual native event handling: disabled owned buttons must reject
 // before the unfolding owner's selection-before-onSelect transition.
 clickChoice(h,old,'list');await B.tick();
 const current=group(h);assert.equal(current,old);assert.equal(mode(current),'cards','visible control cannot disagree with unchanged preview');assert.equal(old.classList.contains('is-open'),layout.expanded);assert.deepEqual([...old.querySelectorAll('button')],layout.buttons);
 assert.equal(calls.length,before,'blocked click does not render another mode');assert.deepEqual(h.rows(),rows);assert.equal(h.service.count('execute'),1);
}
async function assertRecovered(h,old,calls,layout){
 assert.equal(h.controller.getSnapshot().mutation.status,'error');const current=group(h);assert.ok(current?.isConnected);assert.equal(mode(current),'cards','same local presentation returns after definitive rejection');
 assert.equal(current,old,'same occupied native lease resumes');assert.equal(current.parentNode,layout.host);assert.deepEqual([...current.querySelectorAll('button')],layout.buttons);for(const button of layout.buttons){assert.equal(button.disabled,false);assert.notEqual(button.getAttribute('aria-disabled'),'true');assert.equal(button.tabIndex,(!button.hidden&&(current.classList.contains('is-open')||button.classList.contains('is-active')))?0:-1);}const start=calls.length;clickChoice(h,current,'list');await B.tick();assert.equal(mode(group(h)),'list');assert.ok(calls.length>start);assert.ok(calls.slice(start).every(x=>x.displayMode==='list'));assert.deepEqual(h.rows(),[B.F.A]);
}
test('genuine pending Create cannot change native selected View and definitive rejection restores usable ownership',async t=>{
 const gate=B.N.deferred(),h=await B.setup(t,{execute:()=>gate.promise}),old=group(h);assert.ok(old);assert.equal(mode(old),'cards');const layout=capture(old);
 h.input('Album Top name','Pending');h.submit();await B.tick();assert.equal(h.controller.getSnapshot().mutation.status,'loading');const calls=observe(h);await assertBlockedClicks(h,old,calls,layout);
 gate.reject(Object.assign(new Error('Invalid command'),{status:422,code:'invalid_command'}));await B.tick();await assertRecovered(h,old,calls,layout);assert.equal(h.service.count('execute'),1);
});
test('genuine uncertain Create prevents native View divergence until actual original-request recovery settles',async t=>{
 let attempts=0;const h=await B.setup(t,{execute:async()=>{if(++attempts===1)throw new Error('Unknown response');throw Object.assign(new Error('Invalid command'),{status:422,code:'invalid_command'});}}),old=group(h);assert.ok(old);h.click(old.querySelector('button.is-active'));assert.equal(old.classList.contains('is-open'),true);const layout=capture(old);
 h.input('Album Top name','Uncertain');h.submit();await B.tick();assert.equal(h.controller.getSnapshot().mutation.status,'uncertain');const command=structuredClone(h.controller.getSnapshot().mutation.command),calls=observe(h);await assertBlockedClicks(h,old,calls,layout);
 h.click(h.button('Retry original request'));await B.tick();assert.equal(h.document.getElementById('app-confirm-modal').hidden,false);h.click(h.document.getElementById('app-confirm-accept'));await B.tick();
 assert.equal(h.service.count('execute'),2);assert.deepEqual(h.service.calls.filter(x=>x.method==='execute')[1].args[1],command);await assertRecovered(h,old,calls,layout);
});
