'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const F=require('./foobar-account-import-fixture.cjs');
const PROTOCOL='foobar_temporary_source_v1';
const retained=(patch={})=>({protocol:PROTOCOL,context_ref:F.STAMP,context_scope:F.SCOPE,
 source:{source_ref:F.SOURCE,job_ref:F.JOBREF,mapping_name:F.MAPPING,upload_sha256:'b'.repeat(64),byte_length:32,expires_at:'2026-10-25T17:00:00+00:00',...patch}});

test('temporary source is opt-in and original upload remains default',async t=>{
 const f=await F.controller(t);await F.ready(f);
 assert.equal(f.owner.getState().retainSource,false);
 assert.equal(f.wire.calls.find(x=>x.route==='/review/start').init.headers['X-AlbumHaven-Retain-Source'],undefined);
});

test('explicit opt-in only adds retention header to actual upload',async t=>{
 const f=await F.controller(t);f.wire.enqueue('/ui/source',F.source());await f.owner.initialize();
 f.owner.setRetainSource(true);f.owner.choose(F.file());
 f.wire.enqueue('/review/start',F.accepted(F.REVIEW,'start')).enqueue('/review/status',F.review());
 await f.owner.preview();await f.time.tick();
 assert.equal(f.wire.calls.find(x=>x.route==='/review/start').init.headers['X-AlbumHaven-Retain-Source'],'1');
});

test('private copy lookup never resumes or imports, and requires fresh review',async t=>{
 const f=await F.controller(t);await F.ready(f);
 f.wire.enqueue('/temporary-source/status',retained());
 assert.equal(await f.owner.useTemporarySource(),true);
 assert.equal(f.owner.getState().review,null);assert.equal(f.owner.getState().phase,'selected');
 const before=f.wire.calls.length;await f.owner.confirm();assert.equal(f.wire.calls.length,before);
 assert.equal(f.wire.calls.filter(c=>c.route.startsWith('/job/start')).length,0);
});

test('retained source review sends no raw body and still uses fresh review command',async t=>{
 const f=await F.controller(t);await F.ready(f);
 f.wire.enqueue('/temporary-source/status',retained());await f.owner.useTemporarySource();
 f.wire.enqueue('/review/start',F.accepted(F.REVIEW,'start')).enqueue('/review/status',F.review());
 await f.owner.preview();await f.time.tick();
 const call=f.wire.calls.filter(x=>x.route==='/review/start').at(-1).init;
 assert.equal(call.body,'');assert.equal(call.headers['Content-Type'],'application/octet-stream');
 assert.equal(call.headers['X-AlbumHaven-Retained-Source'],'b'.repeat(64));
 assert.equal(call.headers['X-Album-Haven-Foobar-Bytes'],'32');
 assert.equal(f.owner.getState().phase,'review_ready');
});

test('retained confirmation submits original reviewed digest without renewing storage',async t=>{
 const f=await F.controller(t);await F.ready(f);
 f.wire.enqueue('/temporary-source/status',retained());await f.owner.useTemporarySource();
 f.wire.enqueue('/review/start',F.accepted(F.REVIEW,'start')).enqueue('/review/status',F.review());
 await f.owner.preview();await f.time.tick();f.wire.enqueue('/job/start',F.accepted(F.JOB,'start'));
 await f.owner.confirm();const call=f.wire.calls.at(-1).init;
 assert.equal(call.body,'');assert.equal(call.headers['X-AlbumHaven-Retain-Source'],undefined);
 assert.equal(JSON.parse(call.headers['X-AlbumHaven-Foobar-Command']).upload_sha256,'b'.repeat(64));
});

test('expired/missing copy preserves original-file fallback without importing',async t=>{
 const f=await F.controller(t);await F.ready(f);
 f.wire.enqueue('/temporary-source/status',{...retained(),source:null});
 assert.equal(await f.owner.useTemporarySource(),false);assert.match(f.owner.getState().notice,/original file/);
 f.owner.choose(F.file('replacement.tsv'));assert.equal(f.owner.getState().filename,'replacement.tsv');
});

test('real file reselection cannot carry a previous retained identity',async t=>{
 const f=await F.controller(t);await F.ready(f);
 f.wire.enqueue('/temporary-source/status',retained());await f.owner.useTemporarySource();
 const real=F.file('again.tsv');f.owner.choose(real);
 f.wire.enqueue('/review/start',F.accepted(F.REVIEW,'start')).enqueue('/review/status',F.review());
 await f.owner.preview();await f.time.tick();const call=f.wire.calls.filter(x=>x.route==='/review/start').at(-1).init;
 assert.equal(call.body,real);assert.equal(call.headers['X-AlbumHaven-Retained-Source'],undefined);
});

for(const patch of [{source_ref:F.OTHER},{job_ref:F.OTHER},{mapping_name:'other'},{upload_sha256:'x'},{byte_length:0},{byte_length:67108865},{expires_at:'invalid'}])
 test('malformed/foreign temporary metadata never creates a usable source '+JSON.stringify(patch),async t=>{
  const f=await F.controller(t);await F.ready(f);f.wire.enqueue('/temporary-source/status',retained(patch));
  assert.equal(await f.owner.useTemporarySource(),false);assert.equal(f.owner.getState().usingTemporarySource,false);
 });

test('account replacement during temporary lookup retires without retaining identity',async t=>{
 const f=await F.controller(t);await F.ready(f);const late=F.deferred();
 f.wire.enqueue('/temporary-source/status',()=>late.promise);const pending=f.owner.useTemporarySource();
 f.root.dataset.accountFoobarContext='e'.repeat(64);late.resolve(F.response(retained()));
 assert.equal(await pending,false);assert.equal(f.owner.getState().phase,'retired');assert.equal(f.owner.getState().filename,'');
});
