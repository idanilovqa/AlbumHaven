'use strict';
// Additive R3 tests-before-source. No production API is widened for these tests.
// Native dialog/control owners and real image modules execute unchanged when a
// later root-authorized test run composes this file into ALBUM_TOP_TEST_ROOT.
// This authored packet itself is unrun and is not browser/raster/download proof.
const test = require('node:test');
const assert = require('node:assert/strict');
const {fixture,load,settle,deferred,observe,visible,name,findControl,button,disabled,assertDisabled,click,input,toggle} = require('./album-top-image-coordinator-fixture.cjs');
const OWN = /own.*rating|rating.*own|my rating/i;
const width = env => findControl(env.content(), /^Width(?:\b|:)/i, 'input');
const height = env => findControl(env.content(), /^Height(?:\b|:)/i, 'input');
const frame = env => findControl(env.content(), /^Frame (?:thickness|width)(?:\b|:)/i, 'input');
const download = env => button(env.content());
async function ready(env) {
  await env.pump();
  assert.ok(env.preview(), 'current accepted preview is displayed');
  assert.equal(disabled(download(env)), false, 'download enables only after accepted preview');
  return env.preview();
}
function assertNoSourceWork(env, before) {
  assert.equal(env.accesses.length,before.accesses,'waiting shell creates no new source access');
  assert.equal(env.captureKeys.length,before.captures,'waiting shell captures no new source');
  assert.equal(env.fontLoads.length,before.fonts,'waiting shell starts no font load');
  assert.equal(env.preparations.length,before.preparations,'waiting shell starts no resource preparation');
  assert.equal(env.bitmaps.length,before.bitmaps,'waiting shell starts no decoder');
  assert.equal(env.imageDecodes.length,before.previews,'waiting shell starts no preview decoder');
  assert.equal(env.reads.length,before.ratings,'waiting shell starts no own-rating read');
}
const work = env => ({accesses:env.accesses.length,captures:env.captureKeys.length,fonts:env.fontLoads.length,preparations:env.preparations.length,bitmaps:env.bitmaps.length,previews:env.imageDecodes.length,ratings:env.reads.length});
function assertWaiting(env) {
  assert.equal(env.coordinator.read().phase,'waiting');
  assert.ok(/wait|clos|finish|clean/i.test(env.text()),'waiting native shell explains the barrier');
  assert.equal(env.content().querySelectorAll('input,select,img').length,0,'waiting shell has no editable/source/preview content');
  for(const node of env.content().querySelectorAll('button')) if(visible(node)) assert.match(name(node),/^(Cancel|Close)(?:\b|$)/i,'waiting shell exposes only cancellation');
  assert.equal(env.modal().hidden,false,'native shell remains open');
  assert.equal(env.document.getElementById('app-form-close').disabled,false,'native X stays usable');
}
function assertNoPrivateText(env) {assert.doesNotMatch(env.document.body.textContent,/PRIVATE_PATH|SECRET_CONTEXT|raw-response|native-inventory-secret/);}

// This suite deliberately does not reimplement runtime.imageExport.coordinator.
// The independently authored native/source suite owns singleton factory failure,
// runtime shutdown and real index/app/Share argument-threading/remount witnesses.
test('coordinator and immediate designer handle expose only the frozen R3 boundary',async t=>{
  const env=await fixture(t,{holdFontReady:true});
  assert.deepEqual(Object.keys(env.coordinator).sort(),['dispose','open','read']);
  assert.deepEqual(env.coordinator.read(),{phase:'idle'});assert.ok(Object.isFrozen(env.coordinator.read()));
  const handle=env.open();assert.deepEqual(Object.keys(handle).sort(),['close','closed','dispose','update']);
  assert.ok(handle.closed instanceof Promise);const closed=handle.closed;
  assert.equal(handle.update({state:env.state}),undefined,'update is synchronous');
  await env.pump();
  handle.close();handle.dispose();handle.close();assert.equal(handle.closed,closed);
  assert.equal(env.closeNotices.length,1,'UI closure notifies once');
  const disposition=env.coordinator.dispose();assert.ok(disposition instanceof Promise);assert.equal(env.coordinator.dispose(),disposition);
  const pending=observe(disposition);await settle();assert.equal(pending.state,'pending','font ready settlement remains owed');
  env.fontReady.resolve(env.fonts);await env.pump();await closed;await disposition;
  assert.deepEqual(env.coordinator.read(),{phase:'disposed'});assert.ok(Object.isFrozen(env.coordinator.read()));
  const before=work(env),late=env.open();late.close();await env.pump();assertNoSourceWork(env,before);
  assertNoPrivateText(env);
});

test('unabortable font readiness blocks reopening and only the latest waiting shell survives',async t=>{
  const env=await fixture(t,{holdFontReady:true});const first=env.open();await settle();
  const firstClosed=observe(first.closed);first.close();const before=work(env);
  const obsolete=env.open(),obsoleteClosed=observe(obsolete.closed),latest=env.open();
  assertWaiting(env);await env.pump();assertNoSourceWork(env,before);
  assert.equal(firstClosed.state,'pending');assert.equal(obsoleteClosed.state,'resolved','superseded waiting request owns no asynchronous work');
  assert.equal(env.closeNotices.length,2,'closed active and superseded waiting shells each notify once');
  env.fontReady.resolve(env.fonts);await ready(env);
  assert.equal(firstClosed.state,'resolved');assert.equal(env.accesses.length,before.accesses+1,'only latest desired request starts');
  assert.equal(new Set(env.captureKeys).size,env.captureKeys.length,'capture source generations never repeat across reopen');
  latest.close();await latest.closed;
});

test('font load rather than just FontFaceSet.ready is a real preparation barrier',async t=>{
  const env=await fixture(t,{autoFont:false});const first=env.open();await env.pump();
  assert.ok(env.fontLoads.length>0,'exact fixed-family loads start');assert.equal(env.preparations.length,0);
  first.close();const state=observe(first.closed),before=work(env);const next=env.open();
  await env.pump();assertNoSourceWork(env,before);assert.equal(state.state,'pending');
  for(const row of env.fontLoads)row.gate.resolve([]);env.settings.autoFont=true;
  await ready(env);assert.equal(state.state,'resolved');next.close();
});

test('unsettled fresh own-rating work survives abort and stale results are released, never adopted',async t=>{
  const env=await fixture(t,{autoRatings:false});const first=env.open();await ready(env);
  toggle(env.content(),OWN,true);assertDisabled(download(env));await env.pump();
  assert.equal(env.reads.length,1);const pending=env.reads[0];const before=work(env);
  first.close();const closed=observe(first.closed);const next=env.open();await env.pump();
  assert.equal(pending.options.signal.aborted,true);assert.equal(closed.state,'pending');assertNoSourceWork(env,before);
  const stale=env.makeRatings(pending.capture);pending.gate.resolve(stale);await ready(env);
  assert.equal(closed.state,'resolved');assert.equal(env.releases.filter(value=>value===stale).length,1);
  assert.equal(env.watches.some(row=>row.ratings===stale),false,'retired rating batch is not subscribed');
  assert.equal(env.reads.length,1,'reopened default-off designer performs no taste read');next.close();
});

test('stale own-rating rejection cannot overwrite the newest designer or leak exception text',async t=>{
  const env=await fixture(t,{autoRatings:false});const first=env.open();await ready(env);toggle(env.content(),OWN,true);await env.pump();
  first.close();env.open();await env.pump();
  env.reads[0].gate.reject(new Error('PRIVATE_PATH /raw-response SECRET_CONTEXT'));await ready(env);
  assertNoPrivateText(env);assert.equal(disabled(download(env)),false);
});

test('opt-out while a taste read is pending retires it without starting parallel preparation',async t=>{
  const env=await fixture(t,{autoRatings:false});env.open();await ready(env);
  toggle(env.content(),OWN,true);await env.pump();assert.equal(env.reads.length,1);
  const before=work(env);toggle(env.content(),OWN,false);await env.pump();
  assert.equal(env.reads[0].options.signal.aborted,true);assert.equal(env.reads.length,1);
  assert.equal(env.preparations.length,before.preparations,'new pipeline waits for the underlying batch');
  const old=env.makeRatings(env.reads[0].capture);env.reads[0].gate.resolve(old);await ready(env);
  assert.ok(env.releases.includes(old));assert.equal(env.watches.some(row=>row.ratings===old),false);
});

for(const stage of ['prepare','bitmap','encode']) test(`core ${stage} settlement, not abort, gates same-runtime reopen`,async t=>{
  const config=stage==='prepare'?{autoPrepare:false}:stage==='bitmap'?{autoBitmap:false}:{autoEncode:false};
  const env=await fixture(t,config),first=env.open();await env.pump();
  const row=stage==='prepare'?env.preparations[0]:stage==='bitmap'?env.bitmaps[0]:env.encodes[0];assert.ok(row,`${stage} started`);
  first.close();const closed=observe(first.closed),before=work(env);env.open();await env.pump();
  assert.equal(closed.state,'pending');assertNoSourceWork(env,before);assertWaiting(env);
  if(stage==='prepare'){env.settings.autoPrepare=true;row.gate.resolve(row.value());}
  if(stage==='bitmap'){env.settings.autoBitmap=true;row.gate.resolve();}
  if(stage==='encode'){assert.equal(row.element.width,row.width,'encoding still owns unchanged surface');assert.equal(row.element.height,row.height);env.settings.autoEncode=true;row.finish(env.blob(row.width,row.height));}
  await ready(env);assert.equal(closed.state,'resolved');
  if(stage==='prepare')assert.equal(row.released,1);
  if(stage==='bitmap')assert.equal(row.closed,1,'stale returned bitmap is closed once');
  assert.equal(env.bitmapPeak,1,'native image bitmap operations remain serial');
});

test('candidate preview decode owns its reservation after immediate UI removal and URL revocation',async t=>{
  const env=await fixture(t,{autoImage:false}),first=env.open();await env.pump();
  assert.equal(env.imageDecodes.length,1);const pending=env.imageDecodes[0];assertDisabled(download(env));
  first.close();const closed=observe(first.closed),before=work(env);env.open();await env.pump();
  assert.equal(pending.element.getAttribute('src'),null,'retired preview removes its src');
  assert.equal(pending.element.listeners.length,0,'retired preview removes its listeners');assert.ok(env.revoked.includes(pending.url));
  assert.equal(closed.state,'pending');assertNoSourceWork(env,before);assert.equal(env.imageActive,1,'revocation does not pretend decode settled');
  env.settings.autoImage=true;pending.gate.resolve();await ready(env);
  assert.equal(closed.state,'resolved');assert.equal(env.imagePeak,1,'no replacement decode starts early');
});

test('preview Blob header reading is tracked before any image decode and gates reopen',async t=>{
  const env=await fixture(t,{autoEncode:false}),first=env.open();await env.pump();const encoded=env.encodes[0],header=deferred();
  encoded.finish(env.blob(encoded.width,encoded.height,{headerGate:header}));await env.pump();
  assert.equal(env.imageDecodes.length,0);first.close();const closed=observe(first.closed),before=work(env);env.open();await env.pump();
  assert.equal(closed.state,'pending');assertNoSourceWork(env,before);
  env.settings.autoEncode=true;header.resolve();await ready(env);assert.equal(closed.state,'resolved');
});

test('same-binding settings replace only one desired candidate while prior preview decode is uninterruptible',async t=>{
  const env=await fixture(t);env.open();const old=await ready(env),oldUrl=old.src;
  env.settings.autoImage=false;input(width(env),5);await env.pump();assert.equal(env.imageActive,1);
  const candidate=env.imageDecodes.at(-1);input(width(env),6);input(width(env),7);input(width(env),8);await env.pump();
  assert.equal(env.imageActive,1);assert.equal(env.imageDecodes.at(-1),candidate,'no second preview decoder before stale settlement');
  assert.equal(env.preview(),old,'previous accepted preview stays visible');assert.equal(old.src,oldUrl);assert.match(env.text(),/previous/i);assertDisabled(download(env));
  env.settings.autoImage=true;candidate.gate.resolve();await ready(env);
  assert.equal(env.imagePeak,1);assert.equal(env.imageDecodes.at(-1).blob,env.encodes.at(-1).blob,'only newest exact Blob becomes preview');
  assert.equal(env.liveUrls().length,1,'stale candidate and old preview URLs released after newest acceptance');
});

for(const cleanup of ['prepareReleaseThrow','ratingReleaseThrow']) test(`${cleanup} quarantines close rather than treating unknown release as settlement`,async t=>{
  const env=await fixture(t,cleanup==='prepareReleaseThrow'?{prepareReleaseThrow:true}:{}),first=env.open();
  if(cleanup==='prepareReleaseThrow'){
    await env.pump();assert.ok(env.preparations.length>0);assert.ok(env.preparations.some(row=>row.released===1),'the fault actually occurred');
  }else{
    await ready(env);toggle(env.content(),OWN,true);await ready(env);env.settings.ratingReleaseThrow=true;
  }
  first.close();const closed=observe(first.closed),before=work(env);env.open();await env.pump();env.advance(60000);await env.pump();
  assert.equal(closed.state,'pending');assertNoSourceWork(env,before);assert.equal(env.preview(),null);
  assert.ok(env.bitmaps.every(row=>row.closed===1),'remaining bitmap cleanup is still attempted');
  assert.equal(env.liveUrls().length,0,'remaining preview URL cleanup is still attempted');
  assertNoPrivateText(env);
});

test('throwing onClose cannot skip lease cleanup or grant a waiting designer early admission',async t=>{
  const env=await fixture(t,{holdFontReady:true}),first=env.open({onClose(){throw new Error('PRIVATE_PATH observer');}});await settle();
  assert.doesNotThrow(()=>first.close());const closed=observe(first.closed),before=work(env);env.open();await env.pump();
  assert.equal(closed.state,'pending');assertNoSourceWork(env,before);
  env.fontReady.resolve(env.fonts);await ready(env);assert.equal(closed.state,'resolved');assertNoPrivateText(env);
});

for(const closeKind of ['Cancel','X','Escape']) test(`native ${closeKind} remains usable while preparation is pending`,async t=>{
  const env=await fixture(t,{holdFontReady:true}),handle=env.open();await settle();
  if(closeKind==='Cancel')click(button(env.content(),/^Cancel$/i));
  if(closeKind==='X')click(env.document.getElementById('app-form-close'));
  if(closeKind==='Escape'){const target=env.modal().contains(env.document.activeElement)?env.document.activeElement:env.modal();target.dispatchEvent(new env.context.Event('keydown',{key:'Escape',bubbles:true}));}
  // The actual guarded native X/Escape dismissal invokes beforeDismiss on its
  // queued Promise turn. Await that bounded turn, not preparation or a timer.
  const status=observe(handle.closed);await settle();assert.equal(env.closeNotices.length,1);assert.equal(status.state,'pending');
  assert.equal(env.modal().hidden,true,'native dialog closes immediately rather than locking cancellation');
  env.fontReady.resolve(env.fonts);await env.pump();assert.equal(status.state,'resolved');
});

test('Width Height and frame sliders stay native, stable, keyboard-editable and source-derived',async t=>{
  const env=await fixture(t,{count:37});env.open();await ready(env);
  const w=width(env),h=height(env),f=frame(env),downloadNode=download(env);
  for(const node of [w,h,f])assert.equal(node.type,'range');
  assert.equal(w.getAttribute('min'),'1');assert.equal(w.getAttribute('max'),'10');assert.equal(w.getAttribute('step'),'1');
  assert.equal(f.getAttribute('min'),'1');assert.equal(f.getAttribute('max'),'12');
  const {albumTopImageRowSteps,albumTopImageGrid}=await load('image-export-layout.mjs');const steps=albumTopImageRowSteps(37);
  assert.equal(h.getAttribute('min'),'0');assert.equal(Number(h.getAttribute('max')),steps.length-1);
  const reads=env.reads.length,captures=env.captureKeys.length,preparations=env.preparations.length;
  w.focus();input(w,10);assertDisabled(downloadNode);assert.equal(env.document.activeElement,w);
  assert.equal(width(env),w);assert.equal(height(env),h);assert.equal(frame(env),f);assert.equal(download(env),downloadNode);
  assert.equal(Number(h.value),albumTopImageGrid(37,{columns:10}).rowIndex);assert.match(h.getAttribute('aria-valuetext')||'',/\b4\b/,'height reports actual occupied rows');
  input(h,steps.length-1);assert.equal(Number(w.value),albumTopImageGrid(37,{rowIndex:steps.length-1}).columns);
  input(f,12);input(w,4);input(w,7);await ready(env);
  assert.equal(width(env),w);assert.equal(height(env),h);assert.equal(frame(env),f);assert.equal(env.reads.length,reads,'opt-out performs zero rating reads');
  assert.equal(env.captureKeys.length,captures,'same-source settings keep source capture');
  assert.equal(env.preparations.length,preparations,'same-source edits reuse core resource cache');
  assert.equal(env.content().querySelector('input[type="number"]'),null,'deliberate range controls are not replaced by numeric correction');
});

test('native input disables download synchronously before renderer scheduling or preview acceptance',async t=>{
  const env=await fixture(t);env.open();await ready(env);const control=width(env),nativeDownload=download(env);
  env.settings.autoEncode=false;input(control,6);assertDisabled(nativeDownload);
  const before=env.downloads.length;nativeDownload.dispatchEvent(new env.context.Event('click'));assert.equal(env.downloads.length,before,'synthetic forced click cannot bypass disabled behavior');
  await env.pump();const encoding=env.encodes.at(-1);encoding.finish(env.blob(encoding.width,encoding.height));
  await ready(env);assert.equal(download(env),nativeDownload,'native Download node stays stable');
});

test('preview and download share the exact admitted Blob without copying or a second encode',async t=>{
  const env=await fixture(t);env.open();const preview=await ready(env),accepted=env.encodes.at(-1).blob,encodedCount=env.encodes.length;
  assert.equal(env.imageDecodes.at(-1).blob,accepted);assert.equal(env.urls.get(preview.src).blob,accepted);
  click(download(env));await settle();assert.equal(env.downloads.length,1);assert.equal(env.downloads[0].blob,accepted);
  assert.notEqual(env.downloads[0].url,preview.src,'delivery lease does not reuse preview URL');assert.equal(env.encodes.length,encodedCount);
  assert.equal(env.reads.length,0,'default-off Download performs no own-rating request');
});

test('same-binding pending and failed generation preserve an undimmed previous preview',async t=>{
  const env=await fixture(t);env.open();const old=await ready(env),url=old.src;
  env.settings.autoEncode=false;input(width(env),6);assertDisabled(download(env));
  assert.equal(env.preview(),old);assert.ok(['','1'].includes(old.style.opacity));assert.match(env.text(),/previous/i);
  await env.pump();env.encodes.at(-1).finish(null);await env.pump();assert.equal(env.preview(),old);assert.equal(old.src,url);assert.ok(['','1'].includes(old.style.opacity));
  assert.match(env.text(),/previous/i);assertDisabled(download(env));
});

test('source retirement clears preview synchronously and cannot be revived by same-value state return',async t=>{
  const env=await fixture(t);const handle=env.open();const old=await ready(env),url=old.src,nativeDownload=download(env),state=env.state;
  env.accesses[0].retire();assertDisabled(nativeDownload);assert.equal(env.preview(),null);assert.ok(env.revoked.includes(url));
  handle.update({state});nativeDownload.dispatchEvent(new env.context.Event('click'));assert.equal(env.downloads.length,0);
  assert.equal(old.getAttribute('src'),null);assert.equal(old.listeners.length,0);
});

test('controller state identity changes are checked synchronously by handle.update',async t=>{
  const env=await fixture(t);const handle=env.open();await ready(env);const old=env.state,nativeDownload=download(env);
  const state=env.changeState({detail:{...old.detail,data:{...old.detail.data,revision:'8'}}});handle.update({state});
  assertDisabled(nativeDownload);assert.equal(env.preview(),null);nativeDownload.dispatchEvent(new env.context.Event('click'));assert.equal(env.downloads.length,0);
});

test('reentry during download URL creation rechecks generation and retires the unused URL',async t=>{
  const env=await fixture(t);const handle=env.open();await ready(env);let created;
  env.settings.onCreateURL=(_blob,url)=>{created=url;env.settings.onCreateURL=null;const current=env.state;const state=env.changeState({detail:{...current.detail,data:{...current.detail.data,revision:'8'}}});handle.update({state});};
  click(download(env));await env.pump();assert.equal(env.downloads.length,0);assert.ok(env.revoked.includes(created));assert.equal(env.preview(),null);
});

for(const errorKind of ['header_dimensions','natural_dimensions','invalid_png','too_many_pixels']) test(`preview ${errorKind} fails closed before enabling Download`,async t=>{
  const env=await fixture(t,{autoEncode:false,autoImage:false});env.open();await env.pump();const record=env.encodes[0];
  if(errorKind==='header_dimensions')record.finish(env.blob(record.width+1,record.height));
  if(errorKind==='too_many_pixels')record.finish(env.blob(16384,16384));
  if(errorKind==='invalid_png')record.finish(new Blob(['not PNG PRIVATE_PATH'],{type:'image/png'}));
  if(errorKind==='natural_dimensions') {record.finish(env.blob(record.width,record.height));await env.pump();const candidate=env.imageDecodes[0];assert.ok(candidate);candidate.width++;candidate.gate.resolve();}
  await env.pump();assert.equal(env.preview(),null);assertDisabled(download(env));
  if(errorKind!=='natural_dimensions')assert.equal(env.imageDecodes.length,0,'header/budget admission precedes pixel decoder');
  assert.equal(env.liveUrls().length,0);assertNoPrivateText(env);
});

for(const capability of ['failMetrics','missingRoundRect','failEvenOdd','fontCheck']) test(`unsupported ${capability} has explicit unavailable output, not a fallback raster`,async t=>{
  const env=await fixture(t,{[capability]:capability==='fontCheck'?false:true});env.open();await env.pump();
  assert.equal(env.preview(),null);assertDisabled(download(env));assert.equal(env.encodes.length,0);
  assert.ok(/unavailable|could not|cannot|failed|supported/i.test(env.text()),'bounded UI failure is visible');assertNoPrivateText(env);
});

test('font readiness changes synchronously invalidate accepted output and wait for the new generation',async t=>{
  const env=await fixture(t);env.open();await ready(env);const next=deferred(),before=env.encodes.length;
  env.fonts.status='loading';env.fonts.ready=next.promise;env.fonts.dispatchEvent(new env.context.Event('loading'));
  assertDisabled(download(env));await env.pump();assert.equal(env.encodes.length,before,'no old-font re-encode while readiness is unsettled');
  env.fonts.status='loaded';next.resolve(env.fonts);env.fonts.dispatchEvent(new env.context.Event('loadingdone'));await ready(env);
  assert.ok(env.encodes.length>before);assert.ok(env.fontLoads.every(row=>/system-ui/.test(row.font)),'only fixed native font family loads');
});

test('every opted-in Download fresh-reads and releases an equal revision-bearing result before using the exact Blob',async t=>{
  const env=await fixture(t);env.open();await ready(env);toggle(env.content(),OWN,true);await ready(env);
  const accepted=env.encodes.at(-1).blob,baseline=env.watches.at(-1).ratings,encodedCount=env.encodes.length;
  env.settings.autoRatings=false;
  for(let n=0;n<2;n++) {
    const previous=env.reads.length;click(download(env));assertDisabled(download(env));await env.pump();assert.equal(env.reads.length,previous+1);
    const read=env.reads.at(-1),fresh=env.makeRatings(read.capture);read.gate.resolve(fresh);await env.pump();
    assert.equal(env.comparisons.at(-1).previous,baseline);assert.equal(env.comparisons.at(-1).next,fresh);assert.ok(env.releases.includes(fresh));
    assert.equal(env.downloads.length,n+1);assert.equal(env.downloads[n].blob,accepted);assert.equal(env.encodes.length,encodedCount,'equal fresh read causes no redundant encoding');
  }
  assert.equal(env.releases.includes(baseline),false,'adopted baseline retained while live');
});

test('equal public ratings with changed private preference revision never download the previous Blob',async t=>{
  const env=await fixture(t);env.open();await ready(env);toggle(env.content(),OWN,true);await ready(env);
  const oldBlob=env.encodes.at(-1).blob;env.settings.autoRatings=false;click(download(env));await env.pump();
  const row=env.reads.at(-1),changed=env.makeRatings(row.capture,{revision:'preference-2'});row.gate.resolve(changed);await env.pump();
  assert.equal(env.downloads.length,0);assert.ok(env.comparisons.some(value=>value.next===changed),'private receipt comparison is used');
  assertDisabled(download(env));assert.equal(env.preview(),null,'changed own preference retires old image immediately');
  // A new complete capture may now be pending; it is not evidence of a download.
  for(const pending of env.reads.filter(value=>value!==row&&value!==env.reads[0]))pending.gate.resolve(env.makeRatings(pending.capture,{revision:'preference-2'}));
  env.settings.autoRatings=true;await env.pump();
  assert.equal(env.downloads.some(value=>value.blob===oldBlob),false);
});

test('failed opted-in Download stays unavailable with a bounded retry path and does not silently omit taste',async t=>{
  const env=await fixture(t);env.open();await ready(env);toggle(env.content(),OWN,true);await ready(env);env.settings.autoRatings=false;
  click(download(env));await env.pump();env.reads.at(-1).gate.reject(new Error('SECRET_CONTEXT raw-response PRIVATE_PATH'));await env.pump();
  assert.equal(env.downloads.length,0);assertDisabled(download(env));assert.ok(/retry|try again/i.test(env.text()),'fresh read failure has a visible retry path');assertNoPrivateText(env);
});

test('close during opted-in Download consumes a late equal result without initiating delivery',async t=>{
  const env=await fixture(t),handle=env.open();await ready(env);toggle(env.content(),OWN,true);await ready(env);env.settings.autoRatings=false;
  click(download(env));await env.pump();const row=env.reads.at(-1);handle.close();const closed=observe(handle.closed),before=work(env);env.open();await env.pump();
  assert.equal(closed.state,'pending');assertNoSourceWork(env,before);const fresh=env.makeRatings(row.capture);row.gate.resolve(fresh);await ready(env);
  assert.equal(env.downloads.length,0);assert.ok(env.releases.includes(fresh));assert.equal(closed.state,'resolved');
});

test('watch callback invalidates synchronously, unsubscribes on opt-out, and cannot download after retirement',async t=>{
  const env=await fixture(t);env.open();await ready(env);toggle(env.content(),OWN,true);await ready(env);const watch=env.watches.at(-1),nativeDownload=download(env);
  watch.change();assertDisabled(nativeDownload);assert.equal(env.preview(),null);
  nativeDownload.dispatchEvent(new env.context.Event('click'));assert.equal(env.downloads.length,0);
  toggle(env.content(),OWN,false);await env.pump();assert.ok(env.releases.includes(watch.ratings),'baseline released rather than retaining observation history');
});

test('two delivery leases use independent URLs, reject a third click without queuing, and expire within 60 seconds',async t=>{
  const env=await fixture(t);env.open();await ready(env);const nativeDownload=download(env);
  click(nativeDownload);click(nativeDownload);await env.pump();assert.equal(env.downloads.length,2);assert.notEqual(env.downloads[0].url,env.downloads[1].url);
  const count=env.urlEvents.filter(row=>row.type==='create').length;nativeDownload.dispatchEvent(new env.context.Event('click'));await env.pump();
  assert.equal(env.downloads.length,2);assert.equal(env.urlEvents.filter(row=>row.type==='create').length,count,'full lease ledger does not create a third URL');
  assert.ok(/unavailable|wait|limit|download/i.test(env.text()));
  assert.ok([...env.timers.values()].every(row=>row.delay>0&&row.delay<=60000),'delivery lifetime is bounded');
  env.advance(60000);await env.pump();for(const row of env.downloads)assert.ok(env.revoked.includes(row.url));
  assert.equal(env.downloads.length,2,'expired capacity does not run a queued click');
});

test('designer.closed excludes initiated delivery leases, but terminal coordinator.dispose includes their expiry',async t=>{
  const env=await fixture(t),handle=env.open();await ready(env);click(download(env));await settle();const lease=env.downloads[0];
  handle.close();const closed=observe(handle.closed),disposed=env.coordinator.dispose(),terminal=observe(disposed);assert.equal(env.coordinator.dispose(),disposed);await env.pump();
  assert.equal(closed.state,'resolved');assert.equal(terminal.state,'pending');assert.equal(env.preview(),null);assert.equal(env.urls.get(lease.url).revoked,false,'delivery survives modal disposal');
  assert.equal(env.liveUrls().length,1,'no preview/model URL survives alongside delivery');env.advance(60000);await env.pump();
  assert.equal(terminal.state,'resolved');assert.ok(env.revoked.includes(lease.url));assert.equal(env.timers.size,0);
});

test('revocation failure attempts remaining cleanup and does not claim a confirmed terminal barrier',async t=>{
  const env=await fixture(t),handle=env.open();await ready(env);click(download(env));click(download(env));await settle();
  const before=env.liveUrls().map(row=>row.url);env.settings.revokeThrow=true;handle.close();const disposed=observe(env.coordinator.dispose());
  env.advance(60000);await env.pump();for(const url of before)assert.ok(env.revoked.includes(url),'a prior throwing revoke cannot skip another lease');
  assert.equal(disposed.state,'pending','unknown physical URL release remains quarantined');
});

for(const [title,filename]of [
  ['A/B\\C:*?"<>|.  ','A-B-C-------.png'],
  ['CON','Album Top.png'],['lpt9','Album Top.png'],['','Album Top.png'],
  ['🎵'.repeat(101),'🎵'.repeat(100)+'.png'],
]) test(`download sanitizes a synthetic title (${JSON.stringify(title.slice(0,16))})`,async t=>{
  const env=await fixture(t,{title,count:1});env.open();await ready(env);click(download(env));await settle();
  assert.equal(env.downloads[0].filename,filename);assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(env.downloads[0].filename),'filename never splits a surrogate pair');
});

test('all settled visibility flags affect the real projected paint while keeping their controls stable',async t=>{
  const env=await fixture(t,{count:1});env.open();await ready(env);
  const patterns=[/^(?:Show )?(?:Top )?Title(?:\b|:)/i,/^(?:Show )?(?:Info|Description)(?:\b|:)/i,
    /^(?:Show )?Artist(?:\b|:)/i,/^(?:Show )?Album(?: name| title)?(?:\b|:)/i,/^(?:Show )?Year(?:\b|:)/i,/^(?:Show )?Numbers?(?:$|:)/i];
  const controls=patterns.map(pattern=>findControl(env.content(),pattern));
  for(const pattern of patterns)toggle(env.content(),pattern,false);
  await ready(env);
  const painted=env.canvases.at(-1).paint.filter(row=>row.method==='fillText').map(row=>row.args[0]);
  for(const text of ['Synthetic Album Top','Synthetic complete collection','Artist 1','Album 1','2001','1'])assert.equal(painted.includes(text),false,`hidden ${text} is not projected to paint`);
  assert.ok(painted.includes('AlbumHaven'));assert.ok(painted.includes('Synthetic curator'),'approved attribution/branding are not accidental visibility settings');
  patterns.forEach((pattern,index)=>assert.equal(findControl(env.content(),pattern),controls[index]));
  assert.equal(env.reads.length,0);
  assert.equal([...env.content().querySelectorAll('input,select,button')].filter(visible).some(node=>/^(?:Font(?: family| size)?|Raster(?: size)?|Resolution|DPI|Cover size)(?:\b|:)/i.test(name(node))),false,'no unrequested raster/font settings');
});

function selectChoice(env,pattern,value) {
  const candidates=[...env.content().querySelectorAll('button')].filter(node=>visible(node)&&pattern.test(name(node)));
  for(const trigger of candidates){
    click(trigger);const menu=[...env.document.querySelectorAll('[role="menu"]')].filter(visible).at(-1);
    if(!menu)continue;
    const rows=menu.querySelectorAll('[data-foobar-format]'),values=rows.map(row=>row.getAttribute('data-foobar-format'));
    if(values.includes('on')&&values.includes('below')){const row=rows.find(row=>row.getAttribute('data-foobar-format')===value);assert.ok(row);click(row);return trigger;}
    menu.dispatchEvent(new env.context.Event('keydown',{key:'Tab'}));
  }
  assert.fail('canonical number-placement Choice exposes exactly the on/below alternatives');
}
test('number on/below placement and rounded corners reach the real renderer without new settings',async t=>{
  const env=await fixture(t,{count:1});env.open();await ready(env);
  const trigger=selectChoice(env,/number/i,'below');await ready(env);
  const coverSquare=paint=>{
    const coverIndex=paint.findIndex(row=>row.method==='drawImage');assert.ok(coverIndex>=0);
    const beforeCover=paint.slice(0,coverIndex),clipIndex=beforeCover.map(row=>row.method).lastIndexOf('clip');
    assert.ok(clipIndex>0,'cover pixels are clipped by the recorded layout path');
    const square=beforeCover[clipIndex-1],cover=paint[coverIndex];
    assert.ok(square&&['rect','roundRect'].includes(square.method),'clip path records the exact cover square');
    const [x,y,width,height]=square.args;assert.ok(width>0);assert.equal(width,height);
    assert.ok(cover.args[2]>y&&cover.args[2]+cover.args[4]<y+height,'nonsquare cover remains vertically letterboxed inside the square');
    assert.equal(cover.args[1],x);assert.equal(cover.args[3],width);
    return {top:y,bottom:y+height};
  };
  let paint=env.canvases.at(-1).paint,square=coverSquare(paint),number=paint.find(row=>row.method==='fillText'&&row.args[0]==='1');
  assert.ok(number);assert.ok(number.args[2]>square.bottom,'below-number baseline is below the layout cover square');
  assert.equal(selectChoice(env,/number/i,'on'),trigger);await ready(env);
  paint=env.canvases.at(-1).paint;square=coverSquare(paint);number=paint.find(row=>row.method==='fillText'&&row.args[0]==='1');
  assert.ok(number);assert.ok(number.args[2]>square.top&&number.args[2]<square.bottom,'on-number baseline is inside the layout cover square');
  const rounded=toggle(env.content(),/^Rounded(?: corners)?(?:\b|:)/i,true);await ready(env);
  assert.ok(env.canvases.at(-1).trace.some(row=>row[0]==='roundRect'&&Number(row.at(-1))>0),'rounded option reaches canonical rounded geometry');
  assert.equal(toggle(env.content(),/^Rounded(?: corners)?(?:\b|:)/i,false),rounded);await ready(env);
});

test('three independent native color popups preserve editable hex, dismissal priority and focus',async t=>{
  const env=await fixture(t,{count:1});env.open();await ready(env);
  const controls=[[/^Background(?: colou?r)?(?:\b|:)/i,'#123456'],[/^Text(?: colou?r)?(?:\b|:)/i,'#456789'],[/^Frame(?: colou?r)?(?:$|:)/i,'#789abc']];
  for(const [pattern,value]of controls) {
    const trigger=findControl(env.content(),pattern,'button');trigger.focus();click(trigger);
    const popup=[...env.document.querySelectorAll('.trigger-anchor-surface')].filter(visible).at(-1);
    assert.ok(popup,'color uses the canonical registered trigger surface');
    assert.equal(env.owner('isTriggerSurfaceAnchorCurrent')(popup,trigger),true,'native registration, not a lookalike popup class');
    const hex=popup.querySelector('input[type="text"],input:not([type])');assert.ok(hex,'hex field remains explicit editable text');
    assert.ok(popup.querySelector('input[type="color"],input[type="range"],[role="slider"]'),'spectrum/custom color control remains available');
    hex.focus();input(hex,value);hex.dispatchEvent(new env.context.Event('change'));assertDisabled(download(env));
    assert.equal(hex.value.toLowerCase(),value);assert.equal(env.document.activeElement,hex,'state sync does not steal focus from text editing');
    click(trigger);assert.equal(hex.isConnected,false,'closing removes popup controls');assert.equal(env.document.activeElement,trigger,'repeated activation returns focus');
    assert.equal(findControl(env.content(),pattern,'button'),trigger,'trigger identity survives color updates');
  }
  await ready(env);
  const paint=env.canvases.at(-1).paint;
  assert.ok(paint.some(row=>row.method==='fillRect'&&row.fillStyle==='#123456'),'background color is independent');
  assert.ok(paint.some(row=>row.method==='fillText'&&row.fillStyle==='#456789'),'text color is independent');
  assert.ok(paint.some(row=>row.method==='fill'&&row.fillStyle==='#789abc'),'frame color is independent');
  const trigger=findControl(env.content(),controls[0][0],'button');click(trigger);
  const popup=[...env.document.querySelectorAll('.trigger-anchor-surface')].filter(visible).at(-1),hex=popup.querySelector('input[type="text"],input:not([type])');
  hex.focus();hex.dispatchEvent(new env.context.Event('keydown',{key:'Escape'}));await settle();
  assert.equal(hex.isConnected,false);assert.equal(env.modal().hidden,false,'first Escape dismisses child color, not designer');assert.equal(env.document.activeElement,trigger);
  // First Escape restored the real trigger; the second bubbles from that
  // descendant to the actual form listener, never downward from document.
  trigger.dispatchEvent(new env.context.Event('keydown',{key:'Escape',bubbles:true}));await settle();assert.equal(env.closeNotices.length,1,'next Escape closes native designer');
});

for(const count of [20,37]) test(`Height incremental range stepping traverses every reachable occupied-row gap for ${count} members`,async t=>{
  const env=await fixture(t,{count});env.open();await ready(env);const h=height(env),w=width(env);
  const {albumTopImageRowSteps,albumTopImageGrid}=await load('image-export-layout.mjs'),steps=albumTopImageRowSteps(count);
  h.focus();input(h,0);
  for(let index=1;index<steps.length;index++) {
    h.stepUp();h.dispatchEvent(new env.context.Event('input'));
    assert.equal(Number(h.value),index,'increment never snaps back across an unreachable row count');
    assert.equal(Number(w.value),albumTopImageGrid(count,{rowIndex:index}).columns);
    assert.match(h.getAttribute('aria-valuetext')||'',new RegExp(`\\b${steps[index]}\\b`));assert.equal(env.document.activeElement,h);
  }
  for(let index=steps.length-2;index>=0;index--){h.stepDown();h.dispatchEvent(new env.context.Event('input'));assert.equal(Number(h.value),index);}
  await ready(env);assert.equal(height(env),h);assert.equal(env.captureKeys.length,1,'stepping is settings, not a new source');
});

test('one private 1x1 measurement canvas is resized once and held until real encoder callback settlement',async t=>{
  const env=await fixture(t,{autoEncode:false});const handle=env.open();await env.pump();
  assert.equal(env.canvases.length,1,'no second hidden rendering canvas');const canvas=env.canvases[0],encoding=env.encodes[0];assert.ok(encoding);
  const widths=canvas.trace.filter(row=>row[0]==='width').map(row=>row[1]),heights=canvas.trace.filter(row=>row[0]==='height').map(row=>row[1]);
  assert.deepEqual(widths,[1,encoding.width]);assert.deepEqual(heights,[1,encoding.height]);
  assert.equal(canvas.element.isConnected,false,'rendering surface is private rather than a screenshot DOM pipeline');
  handle.close();await env.pump();assert.equal(canvas.element.width,encoding.width);assert.equal(canvas.element.height,encoding.height);
  encoding.finish(env.blob(encoding.width,encoding.height));await env.pump();await handle.closed;
  assert.ok(canvas.element.width<=1&&canvas.element.height<=1,'released surface dimensions are cleared after encoder relinquishes ownership');
});

test('missing native createImageBitmap fails explicitly with no alternate Image cover decoder',async t=>{
  const env=await fixture(t);globalThis.createImageBitmap=undefined;env.context.createImageBitmap=undefined;
  env.open();await env.pump();assert.equal(env.bitmaps.length,0);assert.equal(env.imageDecodes.length,0);assert.equal(env.encodes.length,0);
  assert.equal(env.preview(),null);assertDisabled(download(env));assert.match(env.text(),/unavailable|supported|could not|cannot/i);
});

test('resource_unavailable remains explicit unavailable UI with no raw diagnostics, preview or download',async t=>{
  const env=await fixture(t,{autoPrepare:false});env.open();await env.pump();assert.equal(env.preparations.length,1);
  env.preparations[0].gate.reject(Object.assign(new Error('PRIVATE_PATH SECRET_CONTEXT raw-response'),{code:'resource_unavailable'}));await env.pump();
  assert.equal(env.preview(),null);assertDisabled(download(env));assert.equal(env.downloads.length,0);
  assert.match(env.text(),/unavailable|could not|cannot|failed/i);assertNoPrivateText(env);
  // Exact access/transport error category and coordinator mapping are separately
  // source-reviewed; R3 deliberately exposes no test-only error DOM attribute.
});

test('distinct-Blob accounting admits exactly 192 MiB and rejects one byte over before URL/decode',async t=>{
  const CAP=192*1024*1024,MAX=64*1024*1024;
  const env=await fixture(t,{count:1,outputBytes:MAX});env.open();await ready(env);click(download(env));await settle();
  input(frame(env),2);await ready(env);click(download(env));await settle();assert.equal(env.downloads.length,2);
  env.settings.outputBytes=33;input(frame(env),3);await env.pump();assert.ok(env.preview(),'preview generation remains possible while two delivery slots are occupied');
  // A and B delivery leases retain 128 MiB. C is the old 33-byte preview.
  // Candidate D at 64 MiB-33 reaches exactly 192 MiB during old+candidate overlap.
  env.settings.outputBytes=MAX-33;env.settings.autoImage=false;input(frame(env),4);await env.pump();
  const distinct=new Set(env.liveUrls().map(row=>row.blob));assert.equal([...distinct].reduce((sum,value)=>sum+value.size,0),CAP);
  assert.equal(env.imageActive,1);const candidate=env.imageDecodes.at(-1);env.settings.autoImage=true;candidate.gate.resolve();await env.pump();
  const retained=env.preview(),urlCount=env.urlEvents.filter(row=>row.type==='create').length,decodeCount=env.imageDecodes.length;
  assert.equal(env.urls.get(retained.src).blob.size,MAX-33);
  // D remains the old preview; candidate E at 34 bytes would be exactly one over.
  env.settings.outputBytes=34;input(frame(env),5);await env.pump();
  assert.equal(env.urlEvents.filter(row=>row.type==='create').length,urlCount,'reserve ledger refuses over-budget candidate before URL');
  assert.equal(env.imageDecodes.length,decodeCount,'no over-budget preview decode');assert.equal(env.preview(),retained);assertDisabled(download(env));
  assert.match(env.text(),/unavailable|budget|limit|could not|cannot/i);
  // Sized Blob subclasses are synthetic accounting witnesses, not physical
  // allocation, decoder working-space, browser memory or PNG-raster evidence.
});

for(const fault of ['createAccessThrow','fontLoadThrow','readRatingsThrow']) test(`synchronous ${fault} is controlled unavailable, not a raw exception or phantom pending lease`,async t=>{
  const env=await fixture(t,fault==='readRatingsThrow'?{}:{[fault]:true});let handle,previous=null;
  assert.doesNotThrow(()=>{handle=env.open();});
  if(fault==='readRatingsThrow'){
    previous=await ready(env);env.settings.readRatingsThrow=true;
    assert.doesNotThrow(()=>toggle(env.content(),OWN,true));
  }
  await env.pump();if(fault!=='readRatingsThrow')assert.equal(env.preview(),null);
  else if(env.preview()){assert.equal(env.preview(),previous);assert.ok(['','1'].includes(previous.style.opacity));assert.match(env.text(),/previous/i);}
  assert.equal(env.downloads.length,0);assertNoPrivateText(env);
  const control=[...env.content().querySelectorAll('button')].find(node=>visible(node)&&/^Download(?: PNG| image)?$/i.test(name(node)));
  if(control)assertDisabled(control);
  assert.ok(/unavailable|could not|cannot|failed/i.test(env.document.body.textContent),'failure is explicitly unavailable');
  assert.doesNotThrow(()=>handle.close());const closed=observe(handle.closed);await env.pump();
  assert.equal(closed.state,'resolved','a synchronous throw creates no unsettled underlying Promise');
  const terminal=observe(env.coordinator.dispose());await env.pump();assert.equal(terminal.state,'resolved');
});

test('font readiness loads every actually painted fixed-family size and weight, not one generic font',async t=>{
  const env=await fixture(t);env.open();await ready(env);toggle(env.content(),OWN,true);await ready(env);
  const key=font=>{
    assert.equal(typeof font,'string');assert.match(font,/system-ui/,'font family remains the fixed native family');
    const size=font.match(/(?:^|\s)(\d+(?:\.\d+)?)px(?:\/[\w.]+)?(?:\s|$)/);assert.ok(size,'font load specifies a used pixel size');
    const prefix=font.slice(0,size.index).trim().split(/\s+/),weight=prefix.find(value=>/^[1-9]00$/.test(value))||(prefix.includes('bold')?'700':'400');
    const family=font.slice(size.index+size[0].length).replace(/\s+/g,' ').trim();return `${weight}|${Number(size[1])}|${family}`;
  };
  const prepared=new Set(env.fontLoads.map(row=>key(row.font)));
  const painted=new Set(env.canvases.flatMap(canvas=>canvas.paint.filter(row=>row.method==='fillText').map(row=>key(row.font))));
  assert.ok(painted.size>0);for(const value of painted)assert.ok(prepared.has(value),`painted font has exact readiness/load evidence: ${value}`);
});
