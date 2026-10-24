'use strict';
// Additive actual-module focus regressions. The unchanged accepted native DOM,
// controller and HTTP/scheduler fixtures remain the only synthetic boundaries.
const test=require('node:test'),assert=require('node:assert/strict');
const O=require('./foobar-observation-preview-fixture.cjs'),{F}=O;
const status=f=>{const node=f.host.querySelector('.foobar-import__status');assert.ok(node);return node;};
const heading=f=>{const node=f.host.querySelectorAll('h4').find(n=>n.textContent==='3. Review the proposed import');assert.ok(node);return node;};
const visible=node=>{if(!node?.isConnected)return false;for(let n=node;n;n=n.parentElement)if(n.hidden===true||n.getAttribute?.('hidden')!==null&&n.getAttribute?.('hidden')!==undefined||n.getAttribute?.('inert')!==null&&n.getAttribute?.('inert')!==undefined)return false;return true;};
const external=f=>{const node=f.document.createElement('button');node.textContent='Unrelated settings control';f.document.body.append(node);return node;};
function pending(f,button){
 const start=F.deferred(),reply=F.deferred(),before=O.starts(f).length;
 f.wire.enqueue('/review/start',()=>start.promise).enqueue('/review/status',()=>reply.promise);f.click(button);assert.equal(O.starts(f).length,before+1);
 return {start,reply,async reachStatus(){start.resolve(F.response(F.accepted(F.REVIEW,'start')));await F.settle();await f.time.tick();},async finish(value){reply.resolve(F.response(F.review({review:value})));await F.settle();}};
}
const atStatus=f=>{assert.equal(f.document.activeElement,status(f),'Focused initiating control hands off synchronously to visible status');assert.equal(visible(status(f)),true);assert.equal(status(f).tabIndex,-1);assert.equal(status(f).getAttribute('aria-live'),'polite');assert.equal(heading(f).parentElement.hidden,true);};
const atHeading=f=>{assert.equal(f.document.activeElement,heading(f));assert.equal(visible(heading(f)),true);assert.equal(heading(f).tabIndex,-1);};
test('OF01 focused inspection stays on visible status through delayed start and status then reaches review heading',async t=>{
 const f=await O.native(t),button=O.nodes(f).open;button.focus();assert.equal(f.document.activeElement,button);const work=pending(f,button);atStatus(f);await F.settle();atStatus(f);await work.reachStatus();atStatus(f);await work.finish(O.proposal());atHeading(f);assert.ok(O.table(f));assert.equal(f.action('confirm').disabled,true);
});
test('OF02 inspection dispatched with existing external focus never steals it while pending or completed',async t=>{
 const f=await O.native(t),outside=external(f);outside.focus();const work=pending(f,O.nodes(f).open);assert.equal(f.document.activeElement,outside);await work.reachStatus();assert.equal(f.document.activeElement,outside);await work.finish(O.proposal());assert.equal(f.document.activeElement,outside);assert.equal(visible(outside),true);assert.ok(O.table(f));
});
test('OF03 external focus chosen during delayed inspection start is not stolen by later completion',async t=>{
 const f=await O.native(t),outside=external(f),button=O.nodes(f).open;button.focus();const work=pending(f,button);atStatus(f);outside.focus();await work.reachStatus();assert.equal(f.document.activeElement,outside);await work.finish(O.proposal());assert.equal(f.document.activeElement,outside);assert.equal(visible(outside),true);
});
test('OF04 external focus chosen while status response is pending survives successful observation publication',async t=>{
 const f=await O.native(t),outside=external(f),button=O.nodes(f).open;button.focus();const work=pending(f,button);atStatus(f);await work.reachStatus();atStatus(f);outside.focus();await work.finish(O.proposal());assert.equal(f.document.activeElement,outside);assert.equal(visible(outside),true);
});
test('OF05 focused next observation page hands off before old rows hide and restores only the completed review',async t=>{
 const f=await O.native(t,{value:O.base({total:43})});await O.nativeInspect(f,O.proposal(O.page({total:43})));const button=O.nodes(f).next,oldRows=O.cells(f,'song');button.focus();const work=pending(f,button);atStatus(f);assert.ok(oldRows.every(n=>!n.isConnected));assert.equal(O.header(O.starts(f).at(-1)).observation_after,20);await work.reachStatus();atStatus(f);await work.finish(O.proposal(O.page({total:43,after:20})));atHeading(f);assert.equal(O.cells(f,'song').length,20);assert.match(O.cells(f,'song')[0].textContent,/row 21$/);
});
test('OF06 focused raw beginning keeps visible focus while preserving exact captured row side and field',async t=>{
 const f=await O.native(t);await O.nativeInspect(f);const n=O.selectRaw(f,{ordinal:2,side:'effective',field:'play_count_enhanced'});n.rawStart.focus();const work=pending(f,n.rawStart);atStatus(f);assert.deepEqual(O.header(O.starts(f).at(-1)).observation_raw,{ordinal:2,side:'effective',field:'play_count_enhanced',offset:0});await work.reachStatus();atStatus(f);const view=O.page();view.raw_chunk=O.chunk('9',{ordinal:2,side:'effective',field:'play_count_enhanced'});await work.finish(O.proposal(view));atHeading(f);assert.equal(O.nodes(f).raw.textContent,'9');
});
test('OF07 focused raw continuation retains visible status and restores heading after exact512 offset completes',async t=>{
 const f=await O.native(t),raw='😀'.repeat(600),view=O.page();Object.assign(O.fieldAt(view),O.rawField('play_count',1,raw,{state:'invalid',count:null,code:'invalid_count'}));await O.nativeInspect(f,O.proposal(view));O.selectRaw(f);view.raw_chunk=O.chunk(raw);await O.nativeInspect(f,O.proposal(view),O.nodes(f).rawStart);const button=O.nodes(f).rawNext;button.focus();const work=pending(f,button);atStatus(f);assert.equal(O.header(O.starts(f).at(-1)).observation_raw.offset,512);await work.reachStatus();atStatus(f);const last={...view,raw_chunk:O.chunk(raw,{offset:512})};await work.finish(O.proposal(last));atHeading(f);assert.equal(O.nodes(f).raw.textContent,'😀'.repeat(88));assert.equal(O.nodes(f).rawNext.disabled,true);
});
test('OF08 focused return to normal review hands off to status then restores heading and diagnostic controls',async t=>{
 const value=O.P.proposal(),f=await O.native(t,{value,library:'23',matching:true});await O.nativeInspect(f,O.proposal(O.page(),{matching:23,review_counts:value.review_counts,proposed_counts:value.proposed_counts,problems:value.problems}));const button=O.nodes(f).back;button.focus();const work=pending(f,button);atStatus(f);assert.equal(O.header(O.starts(f).at(-1)).previous_review_sha256,null);assert.equal(Object.hasOwn(O.header(O.starts(f).at(-1)),'observation_after'),false);await work.reachStatus();atStatus(f);await work.finish(value);atHeading(f);assert.equal(O.table(f),null);assert.equal(O.P.fields(f).length,3);assert.ok(f.host.querySelector('[aria-label="Foobar dry-run row problems"]'));
});
test('OF09 return to normal review respects external focus present at dispatch and after completion',async t=>{
 const f=await O.native(t);await O.nativeInspect(f);const outside=external(f);outside.focus();const work=pending(f,O.nodes(f).back);assert.equal(f.document.activeElement,outside);await work.reachStatus();assert.equal(f.document.activeElement,outside);await work.finish(O.base());assert.equal(f.document.activeElement,outside);assert.equal(O.table(f),null);assert.equal(visible(outside),true);
});
test('OF10 raw inspection completion never steals focus moved outside during its pending status',async t=>{
 const f=await O.native(t);await O.nativeInspect(f);const n=O.selectRaw(f),outside=external(f);n.rawStart.focus();const work=pending(f,n.rawStart);atStatus(f);await work.reachStatus();atStatus(f);outside.focus();const view=O.page();view.raw_chunk=O.chunk('2');await work.finish(O.proposal(view));assert.equal(f.document.activeElement,outside);assert.equal(O.nodes(f).raw.textContent,'2');assert.equal(visible(outside),true);
});
test('OF11 failed focused inspection keeps visible status and never focuses a hidden result heading',async t=>{
 const f=await O.native(t),button=O.nodes(f).open,start=F.deferred();f.wire.enqueue('/review/start',()=>start.promise);button.focus();f.click(button);atStatus(f);start.reject(new TypeError('Synthetic lost observation start'));await F.settle();assert.equal(f.document.activeElement,status(f));assert.equal(visible(status(f)),true);assert.equal(heading(f).parentElement.hidden,true);assert.equal(O.table(f),null);assert.equal(f.action('confirm').disabled,true);assert.equal(O.starts(f).length,2);
});
test('OF12 focused inspection retired by account change cannot pull focus from unrelated settings on late reply',async t=>{
 const f=await O.native(t),button=O.nodes(f).open,outside=external(f),start=F.deferred();f.wire.enqueue('/review/start',()=>start.promise);button.focus();f.click(button);atStatus(f);outside.focus();f.root.dataset.accountFoobarContext='f'.repeat(64);f.mutation(f.root,'data-account-foobar-context');start.resolve(F.response(F.accepted(F.REVIEW,'start')));await F.settle();assert.equal(f.document.activeElement,outside);assert.equal(visible(outside),true);assert.equal(f.host.querySelector('.foobar-import__review'),null);assert.equal(f.time.tasks.size,0);assert.equal(O.starts(f).length,2);
});
