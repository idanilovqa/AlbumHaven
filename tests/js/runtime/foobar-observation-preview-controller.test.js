'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const O=require('./foobar-observation-preview-fixture.cjs'),{F}=O;
const state=f=>f.owner.getState();
const noReview=f=>{assert.equal(state(f).review,null);assert.notEqual(state(f).phase,'review_ready');};
test('OC01 genuine inspection reuploads identical File under unchanged identity and explicit presentation fields',async t=>{
 const f=await O.ready(t),before=state(f).review;await O.inspect(f);const call=O.starts(f).at(-1);
 assert.equal(call.init.body,f.selected);assert.equal(call.init.method,'POST');assert.equal(call.init.credentials,'same-origin');assert.equal(call.init.cache,'no-store');assert.equal(call.init.redirect,'error');assert.equal(call.init.headers['X-AlbumHaven-Foobar-Context'],F.STAMP);
 assert.deepEqual(O.header(call),{version:F.REVIEW,source_ref:F.SOURCE,job_ref:F.JOBREF,mapping_name:F.MAPPING,matching_library_id:null,resume:false,conflict_after:0,problem_after:0,previous_review_sha256:before.review_sha256,observation_after:0,observation_raw:null});
 assert.equal(state(f).review.review_sha256,before.review_sha256);assert.deepEqual(state(f).review.command,before.command);assert.equal(call.init.signal.aborted,true);
});
test('OC02 fortyone rows require three explicit twenty-row genuine review continuations without accumulation',async t=>{
 const f=await O.ready(t,{value:O.base({total:41})}),seen=[];
 for(const after of [0,20,40]){const review=await O.inspect(f,O.proposal(O.page({total:41,after})),after);assert.equal(review.observations.items.length,after===40?1:20);seen.push(...review.observations.items.map(r=>r.row));assert.equal(O.header(O.starts(f).at(-1)).observation_after,after);assert.equal(O.starts(f).at(-1).init.body,f.selected);assert.equal(review.checked_rows,41);}
 assert.deepEqual(seen,Array.from({length:41},(_,i)=>i+1));assert.equal(O.starts(f).length,4);assert.equal(state(f).review.observations.next,null);await F.settle();assert.equal(O.starts(f).length,4);
});
test('OC03 genuine controller makes every original raw Unicode character reachable in512-codepoint chunks',async t=>{
 const raw=('😀a\n\u202e').repeat(325)+'END',view=O.page();Object.assign(O.fieldAt(view),O.rawField('play_count',1,raw,{state:'invalid',count:null,code:'invalid_count'}));
 const f=await O.ready(t);await O.inspect(f,O.proposal(view));let combined='',offset=0;
 do{const c=O.chunk(raw,{offset}),next={...view,raw_chunk:c};const p=await O.inspect(f,O.proposal(next),0,{ordinal:1,side:'incoming',field:'play_count',offset});assert.equal(p.observations.raw_chunk.text,c.text);assert.ok(Array.from(c.text).length<=512);assert.equal(O.header(O.starts(f).at(-1)).observation_raw.offset,offset);combined+=p.observations.raw_chunk.text;offset=c.next_offset;}while(offset!==null);
 assert.equal(combined,raw);assert.equal(Array.from(combined).length,1303);assert.equal(state(f).review.observations.raw_chunk.next_offset,null);assert.equal(O.starts(f).length,5);
});
test('OC04 effective raw inspection keeps old provenance separate from current unavailable incoming field',async t=>{
 const view=O.page(),raw='previous count evidence';Object.assign(O.fieldAt(view),{state:'unavailable',count:null,raw_prefix:'N/A',raw_characters:3});Object.assign(O.fieldAt(view,'effective'),O.rawField('play_count',1,raw,{state:'invalid',count:null,code:'invalid_count',origin:[O.OLDER,88,11]}));
 const f=await O.ready(t);await O.inspect(f,O.proposal(view));view.raw_chunk=O.chunk(raw,{side:'effective'});await O.inspect(f,O.proposal(view),0,{ordinal:1,side:'effective',field:'play_count',offset:0});
 assert.equal(state(f).review.observations.raw_chunk.text,raw);assert.deepEqual(state(f).review.observations.items[0].effective[0].origin,[O.OLDER,88,11]);assert.equal(state(f).review.observations.items[0].incoming[0].state,'unavailable');
});
test('OC05 controller rejects skipped backward and noninteger page requests without transport',async t=>{
 const f=await O.ready(t,{value:O.base({total:41})});await O.inspect(f,O.proposal(O.page({total:41})));const before=O.starts(f).length;
 for(const after of [1,19,21,40,-1,0.5,'20'])await f.owner.inspectObservations(after,null);assert.equal(O.starts(f).length,before);assert.equal(state(f).phase,'review_ready');
});
test('OC06 controller rejects unseen raw fields skipped continuation and raw requests before inspection',async t=>{
 const f=await O.ready(t);await f.owner.inspectObservations(0,{ordinal:1,side:'incoming',field:'play_count',offset:0});assert.equal(O.starts(f).length,1);await O.inspect(f);
 for(const raw of [{ordinal:5,side:'incoming',field:'play_count',offset:0},{ordinal:1,side:'incoming',field:'rating',offset:0},{ordinal:1,side:'incoming',field:'play_count',offset:512}])await f.owner.inspectObservations(0,raw);assert.equal(O.starts(f).length,2);
});
test('OC07 observation continuation rejects changed inventory semantic digest and immutable command',async t=>{
 const f=await O.ready(t);
 for(const patch of [{inventory_sha256:'f'.repeat(64)},{review_sha256:'f'.repeat(64)},{command:F.command({original_generation:2})},{command:F.command({upload_sha256:'f'.repeat(64)})}]){
 const p=O.proposal(O.page(),patch);if(p.command.upload_sha256!=='b'.repeat(64))for(const row of p.observations.items)for(const field of row.incoming)field.origin[0]=p.command.upload_sha256;
 O.enqueue(f,p);await f.owner.inspectObservations();await f.time.tick();noReview(f);assert.match(state(f).error,/saved state changed/);O.enqueue(f,O.base());await f.owner.preview();await f.time.tick();assert.equal(state(f).phase,'review_ready');}
});
test('OC08 controller rejects unrequested observation page and missing requested presentation',async t=>{
 const f=await O.ready(t);O.enqueue(f,O.base());await f.owner.inspectObservations();await f.time.tick();noReview(f);
 O.enqueue(f,O.proposal());await f.owner.preview();await f.time.tick();noReview(f);assert.match(state(f).error,/saved state changed/);
});
test('OC09 controller binds exact requested raw ordinal side field and offset before publication',async t=>{
 const f=await O.ready(t);await O.inspect(f);const view=O.page();view.raw_chunk=O.chunk('9',{side:'effective',field:'play_count_enhanced'});O.enqueue(f,O.proposal(view));await f.owner.inspectObservations(0,{ordinal:1,side:'incoming',field:'play_count',offset:0});await f.time.tick();noReview(f);assert.match(state(f).error,/saved state changed/);
});
test('OC10 changing current source invalidates page and prevents stale inspection dispatch',async t=>{
 const f=await O.ready(t);await O.inspect(f);const replacement=F.source();replacement.result.source_ref=F.OTHER;f.wire.enqueue('/ui/source',replacement);await f.owner.selectSource(F.OTHER);const before=f.wire.calls.length;await f.owner.inspectObservations();assert.equal(f.wire.calls.length,before);assert.equal(state(f).source.source_ref,F.OTHER);assert.equal(state(f).review,null);
});
test('OC11 choosing a different File object invalidates observation and fresh review has no continuation',async t=>{
 const f=await O.ready(t);await O.inspect(f);const replacement=F.file('same-name.tsv');f.owner.choose(replacement);await f.owner.inspectObservations();assert.equal(O.starts(f).length,2);O.enqueue(f,O.base());await f.owner.preview();await f.time.tick();const last=O.starts(f).at(-1);assert.equal(last.init.body,replacement);assert.equal(O.header(last).previous_review_sha256,null);assert.equal(Object.hasOwn(O.header(last),'observation_after'),false);
});
test('OC12 mapping change discards TSV observation and never launches inspection for Enhanced SQLite',async t=>{
 const f=await O.ready(t);await O.inspect(f);f.owner.setMapping(O.E.IMPORT_MAPPING);assert.equal(state(f).review,null);assert.equal(state(f).filename,'');await f.owner.inspectObservations();assert.equal(O.starts(f).length,2);assert.equal(state(f).mapping,O.E.IMPORT_MAPPING);
});
test('OC13 matching change requires new ordinary review and never reuses old observation approval',async t=>{
 const f=await O.ready(t,{library:'23'});await O.inspect(f);f.owner.setMatching(true);await f.owner.inspectObservations();assert.equal(O.starts(f).length,2);assert.equal(state(f).review,null);O.enqueue(f,O.base({matching:23}));await f.owner.preview();await f.time.tick();assert.equal(O.header(O.starts(f).at(-1)).matching_library_id,23);assert.equal(O.header(O.starts(f).at(-1)).previous_review_sha256,null);
});
test('OC14 account context change retires original File review and blocks observation activation',async t=>{
 const f=await O.ready(t);await O.inspect(f);f.root.dataset.accountFoobarContext='f'.repeat(64);await f.owner.inspectObservations();assert.equal(state(f).phase,'retired');assert.equal(state(f).filename,'');assert.equal(state(f).review,null);assert.equal(O.starts(f).length,2);
});
test('OC15 library context change retires observation even when matching was not selected',async t=>{
 const f=await O.ready(t,{library:'23'});await O.inspect(f);f.root.dataset.accountFoobarMatchingLibraryId='24';await f.owner.inspectObservations();assert.equal(state(f).phase,'retired');assert.equal(O.starts(f).length,2);
});
test('OC16 capability loss cannot publish a pending observation status response',async t=>{
 const f=await O.ready(t),pending=F.deferred();f.wire.enqueue('/review/start',F.accepted(F.REVIEW,'start')).enqueue('/review/status',()=>pending.promise);await f.owner.inspectObservations();await f.time.tick();f.allow(false);pending.resolve(F.response(F.review({review:O.proposal()})));await F.settle();assert.equal(state(f).phase,'retired');assert.equal(state(f).review,null);
});
test('OC17 caller retirement fences delayed observation start and creates no poll or display',async t=>{
 const f=await O.ready(t),pending=F.deferred();f.wire.enqueue('/review/start',()=>pending.promise);const work=f.owner.inspectObservations();f.current(false);pending.resolve(F.response(F.accepted(F.REVIEW,'start')));await work;assert.equal(state(f).phase,'retired');assert.equal(f.time.tasks.size,0);assert.equal(state(f).review,null);
});
test('OC18 detached context root fences pending raw response without retaining original text',async t=>{
 const f=await O.ready(t);await O.inspect(f);const pending=F.deferred();f.wire.enqueue('/review/start',F.accepted(F.REVIEW,'start')).enqueue('/review/status',()=>pending.promise);await f.owner.inspectObservations(0,{ordinal:1,side:'incoming',field:'play_count',offset:0});await f.time.tick();f.root.isConnected=false;const v=O.page();v.raw_chunk=O.chunk('2');pending.resolve(F.response(F.review({review:O.proposal(v)})));await F.settle();assert.equal(state(f).phase,'retired');assert.equal(state(f).review,null);
});
test('OC19 disposal aborts in-flight inspection and fences late response without another request',async t=>{
 const f=await O.ready(t),pending=F.deferred();f.wire.enqueue('/review/start',()=>pending.promise);const work=f.owner.inspectObservations();const call=O.starts(f).at(-1);f.owner.dispose();assert.equal(call.init.signal.aborted,true);pending.resolve(F.response(F.accepted(F.REVIEW,'start')));await work;assert.equal(state(f).phase,'retired');assert.equal(state(f).review,null);assert.equal(f.time.tasks.size,0);assert.equal(O.starts(f).length,2);
});
test('OC20 lost inspection acknowledgment removes current review and never automatically retries',async t=>{
 const f=await O.ready(t);f.wire.enqueue('/review/start',()=>Promise.reject(new TypeError('Synthetic lost acknowledgment')));await f.owner.inspectObservations();noReview(f);assert.equal(state(f).jobRef,F.JOBREF);assert.equal(state(f).submitted,false);assert.match(state(f).error,/could not be confirmed/);await F.settle();assert.equal(O.starts(f).length,2);assert.equal(f.time.tasks.size,0);
 O.enqueue(f,O.base());await f.owner.preview();await f.time.tick();assert.equal(O.header(O.starts(f).at(-1)).job_ref,F.JOBREF);assert.equal(O.header(O.starts(f).at(-1)).previous_review_sha256,null);
});
test('OC21 malformed and oversized observation status cannot become a successful empty review',async t=>{
 const f=await O.ready(t);f.wire.enqueue('/review/start',F.accepted(F.REVIEW,'start')).enqueue('/review/status',()=>Promise.resolve(new Response(' '.repeat(131073),{headers:{'Content-Type':'application/json'}})));await f.owner.inspectObservations();await f.time.tick();noReview(f);assert.match(state(f).error,/could not be confirmed/);assert.equal(f.time.tasks.size,0);assert.equal(O.starts(f).length,2);
});
test('OC22 cancellation discards even a subsequently ready inspection and preserves no import claim',async t=>{
 const f=await O.ready(t);O.enqueue(f,O.proposal());await f.owner.inspectObservations();f.wire.enqueue('/review/cancel',F.review({phase:'reviewing',review:null},'cancel'));await f.owner.cancel();assert.equal(state(f).phase,'reviewing');await f.time.tick();assert.equal(state(f).phase,'selected');assert.equal(state(f).review,null);assert.match(state(f).notice,/Review cancelled. No import was applied/);assert.equal(f.wire.calls.filter(x=>x.route.startsWith('/job/')&&x.route!=='/job/list').length,0);
});
test('OC23 observation confirmation uses original import command without presentation preference or raw fields',async t=>{
 const f=await O.ready(t);await O.inspect(f);f.owner.setCountFamily('enhanced');f.wire.enqueue('/job/start',F.accepted(F.JOB,'start'));await f.owner.confirm();const call=f.wire.calls.find(x=>x.route==='/job/start');assert.equal(call.init.body,f.selected);assert.deepEqual(O.header(call),{version:F.JOB,...F.command(),inventory_sha256:'c'.repeat(64),review_sha256:'d'.repeat(64)});assert.equal(state(f).countFamily,'enhanced');assert.equal(state(f).phase,'importing');assert.equal(state(f).review,null);
});
test('OC24 uncertain import after inspection keeps identity counters and selected display without replay',async t=>{
 const f=await O.ready(t);await O.inspect(f);f.owner.setCountFamily('enhanced');f.wire.enqueue('/job/start',()=>Promise.reject(new TypeError('Lost start')));await f.owner.confirm();assert.equal(state(f).phase,'paused');assert.equal(state(f).jobRef,F.JOBREF);assert.equal(state(f).submitted,true);assert.equal(state(f).countFamily,'enhanced');assert.match(state(f).notice,/Committed batches are not undone/);const count=f.wire.calls.length;await f.owner.inspectObservations();f.owner.setCountFamily('standard');assert.equal(state(f).countFamily,'enhanced');assert.equal(f.wire.calls.length,count);
});
test('OC25 family changes replace confirmation identity but retain exact page evidence without a request',async t=>{
 const f=await O.ready(t);await O.inspect(f);const previous=state(f).review,view=previous.observations,count=f.wire.calls.length;f.owner.setCountFamily('enhanced');assert.notEqual(state(f).review,previous);assert.equal(state(f).review.observations,view);assert.equal(state(f).review.review_sha256,previous.review_sha256);assert.equal(state(f).countFamily,'enhanced');assert.equal(f.wire.calls.length,count);f.owner.setCountFamily('standard');assert.equal(state(f).countFamily,'standard');assert.equal(state(f).review.observations,view);
});
test('OC26 invalid family and busy-family updates cannot alter current inspection intent',async t=>{
 const f=await O.ready(t);for(const value of ['lastfm','sum',null,1])f.owner.setCountFamily(value);assert.equal(state(f).countFamily,'standard');O.enqueue(f,O.proposal());await f.owner.inspectObservations();f.owner.setCountFamily('enhanced');assert.equal(state(f).countFamily,'standard');await f.time.tick();assert.equal(state(f).phase,'review_ready');
});
test('OC27 explicit return restores original problem and personal-conflict workflow with a fresh review',async t=>{
 const value=O.P.proposal(),f=await O.ready(t,{value,library:'23',matching:true});await O.inspect(f,O.proposal(O.page(),{matching:23,review_counts:value.review_counts,proposed_counts:value.proposed_counts,problems:value.problems}));O.enqueue(f,value);await f.owner.preview();await f.time.tick();const last=O.header(O.starts(f).at(-1));assert.equal(last.previous_review_sha256,null);assert.equal(Object.hasOwn(last,'observation_after'),false);assert.equal(state(f).review.conflicts.length,3);assert.equal(state(f).review.problem_items.length,1);assert.equal(Object.hasOwn(state(f).review,'observations'),false);
});
test('OC28 Enhanced SQLite review still uses genuine separate mapping and never dispatches TSV observations',async t=>{
 const f=await F.controller(t),selected=await O.E.importReady(f);const before=f.wire.calls.length;await f.owner.inspectObservations();f.owner.setCountFamily('enhanced');assert.equal(f.wire.calls.length,before);assert.equal(state(f).countFamily,'standard');assert.equal(state(f).review.command.mapping_name,O.E.IMPORT_MAPPING);assert.equal(O.starts(f)[0].init.body,selected);assert.equal(O.starts(f)[0].init.headers['Content-Type'],'application/vnd.sqlite3');
});
test('OC29 ordinary conflict and problem page continuations remain exact after adding observation mode',async t=>{
 const f=await O.ready(t,{value:O.D.page(),library:'23',matching:true});O.enqueue(f,O.D.page(false,true));await f.owner.nextConflictPage();await f.time.tick();assert.equal(state(f).review.conflict_after,64);assert.equal(state(f).review.problem_after,0);O.enqueue(f,O.D.page(true,true));await f.owner.nextProblemPage();await f.time.tick();assert.equal(state(f).review.problem_after,63);assert.equal(state(f).review.conflict_after,64);assert.equal(Object.hasOwn(O.header(O.starts(f).at(-1)),'observation_after'),false);
});
test('OC30 observation start duplicate activations remain bounded to one pending request',async t=>{
 const f=await O.ready(t),pending=F.deferred();f.wire.enqueue('/review/start',()=>pending.promise);const work=f.owner.inspectObservations();await f.owner.inspectObservations();await f.owner.preview();assert.equal(O.starts(f).length,2);pending.resolve(F.response(F.accepted(F.REVIEW,'start')));await work;assert.equal([...f.time.tasks.values()].filter(x=>x.delay===1000).length,1);
});
test('OC31 resumed observation starts at confirmed prefix and conserves only remaining rows under same job',async t=>{
 const f=await F.controller(t);f.wire.enqueue('/ui/source',F.source());await f.owner.initialize();const command=F.command({total_rows:43});f.wire.enqueue('/job/status',F.job({command,confirmed_rows:20,remaining_rows:23,confirmed_counts:[20,0,0,0,0,0,0]}));await f.owner.recoverJob(F.JOBREF,F.SOURCE);assert.equal(state(f).phase,'paused');
 const selected=F.file();f.owner.choose(selected);O.enqueue(f,O.base({total:43,start:20,resume:true}));await f.owner.resume();await f.time.tick();assert.equal(state(f).review.start_offset,20);assert.equal(state(f).review.checked_rows,23);
 await O.inspect(f,O.proposal(O.page({total:43,after:20}),{start:20,resume:true}));assert.equal(O.header(O.starts(f).at(-1)).observation_after,20);assert.equal(O.header(O.starts(f).at(-1)).resume,true);assert.equal(state(f).review.observations.items[0].row,21);assert.equal(state(f).review.observations.remaining,3);assert.equal(state(f).review.observations.items.length+state(f).review.observations.remaining,43-20);
 await O.inspect(f,O.proposal(O.page({total:43,after:40}),{start:20,resume:true}),40);assert.equal(state(f).review.observations.items[0].row,41);assert.equal(state(f).review.observations.items.length,3);assert.equal(state(f).review.observations.remaining,0);assert.equal(state(f).review.start_offset,20);assert.equal(state(f).job.confirmed_rows,20);assert.equal(state(f).job.remaining_rows,23);
 f.wire.enqueue('/job/resume',F.accepted(F.JOB,'resume'));await f.owner.confirm();const call=f.wire.calls.find(c=>c.route==='/job/resume');assert.equal(call.init.body,selected);assert.equal(O.header(call).job_ref,F.JOBREF);assert.equal(O.header(call).total_rows,43);assert.equal(f.wire.calls.filter(c=>c.route==='/job/start').length,0);
});
