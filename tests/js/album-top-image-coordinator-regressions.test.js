'use strict';
// Additive, independently frozen before source correction. The accepted R2 suite
// remains unchanged. Only browser primitives/approved access ports are doubles.
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,settle,deferred,observe,visible,name,findControl,button,disabled,assertDisabled,click,input,toggle}=require('./album-top-image-regression-fixture.cjs');
const OWN=/own.*rating|rating.*own|my rating/i;
const download=env=>button(env.content());
const width=env=>findControl(env.content(),/^Width(?:\b|:)/i,'input');
const work=env=>({accesses:env.accesses.length,captures:env.captureKeys.length,fonts:env.fontLoads.length,
  ratings:env.reads.length,preparations:env.preparations.length,bitmaps:env.bitmaps.length,
  surfaces:env.canvases.length,encodes:env.encodes.length,previews:env.imageDecodes.length,urls:env.urlEvents.filter(row=>row.type==='create').length});
const unchanged=(env,before)=>assert.deepEqual(work(env),before,'unknown ownership blocks all new source/font/resource/raster/preview work');
async function ready(env){await env.pump();assert.ok(env.preview(),'accepted preview exists');assert.equal(disabled(download(env)),false);return env.encodes.at(-1).blob;}
function retryIfPresent(env){const retry=[...env.content().querySelectorAll('button')].find(node=>visible(node)&&/retry|try again/i.test(name(node)));if(retry)retry.dispatchEvent(new env.context.Event('click'));}
function setColor(env){
  const trigger=findControl(env.content(),/^Background(?: colou?r)?(?:\b|:)/i,'button');click(trigger);
  const popup=[...env.document.querySelectorAll('.trigger-anchor-surface')].filter(visible).at(-1);assert.ok(popup);
  const hex=popup.querySelector('input[type="text"],input:not([type])');assert.ok(hex);input(hex,'#13579b');
  hex.dispatchEvent(new env.context.Event('change'));click(trigger);
}
const changes=[
  ['columns',env=>input(width(env),6)],
  ['frame',env=>input(findControl(env.content(),/^Frame (?:thickness|width)(?:\b|:)/i,'input'),7)],
  ['visibility',env=>toggle(env.content(),/^(?:Show )?Artist(?:\b|:)/i,false)],
  ['background color',setColor],
];
for(const [label,change]of changes)test(`pending equal own-rating Download cannot deliver old Blob after ${label} input`,async t=>{
  const env=await fixture(t);env.open();await ready(env);toggle(env.content(),OWN,true);const oldBlob=await ready(env),oldPreview=env.preview();
  env.settings.autoRatings=false;click(download(env));await env.pump();const freshRead=env.reads.at(-1);
  assertDisabled(download(env));const encodedBefore=env.encodes.length;env.settings.autoEncode=false;
  change(env);assertDisabled(download(env));assert.equal(env.preview(),oldPreview,'previous preview may remain but is ineligible');
  const fresh=env.makeRatings(freshRead.capture);env.settings.autoRatings=true;freshRead.gate.resolve(fresh);await env.pump();
  assert.ok(env.releases.includes(fresh),'stale revalidation result is released');assert.equal(env.downloads.length,0,'old equal result is not a queued click');
  assertDisabled(download(env));download(env).dispatchEvent(new env.context.Event('click'));await settle();assert.equal(env.downloads.length,0);
  assert.ok(env.encodes.length>encodedBefore,'new requested display generation actually renders');const pending=env.encodes.at(-1);assert.equal(pending.settled,false);
  pending.finish(env.blob(pending.width,pending.height));const nextBlob=await ready(env);assert.notEqual(nextBlob,oldBlob);
  assert.equal(env.downloads.length,0,'accepting the new preview never replays the old click');
  click(download(env));await env.pump();assert.equal(env.downloads.length,1);assert.equal(env.downloads[0].blob,nextBlob);
  assert.equal(env.urls.get(env.preview().src).blob,nextBlob,'later explicit click uses the exact newly accepted preview Blob');
});

test('non-rating settings reentry during delivery URL creation rechecks dirty display eligibility before anchor click',async t=>{
  const env=await fixture(t);env.open();await ready(env);let created;
  env.settings.autoEncode=false;env.settings.onCreateURL=(_blob,url)=>{created=url;env.settings.onCreateURL=null;input(width(env),6);};
  click(download(env));await env.pump();assert.equal(env.downloads.length,0);assertDisabled(download(env));
  assert.ok(created&&env.revoked.includes(created),'unused delivery URL is cleaned after settings reentry');
  const pending=env.encodes.at(-1);assert.equal(pending.settled,false);pending.finish(env.blob(pending.width,pending.height));await ready(env);
  assert.equal(env.downloads.length,0,'no deferred delivery after replacement preview');
});

for(const failure of ['ratingReleaseThrow','watchUnsubscribeThrow'])test(`opt-out ${failure} commits quarantine before settings, retry, or reopen can start work`,async t=>{
  const env=await fixture(t),first=env.open();await ready(env);toggle(env.content(),OWN,true);await ready(env);
  const baseline=env.watches.at(-1),before=work(env),oldDownload=download(env),oldWidth=width(env);env.settings[failure]=true;
  toggle(env.content(),OWN,false);assert.ok(!visible(oldDownload)||disabled(oldDownload),'quarantine invalidates publication synchronously');await env.pump();unchanged(env,before);
  assert.ok(env.unsubscriptions.includes(baseline),'observation cleanup attempted');assert.ok(env.releases.includes(baseline.ratings),'rating cleanup still attempted after prior unsubscribe throw');
  input(oldWidth,6);retryIfPresent(env);oldDownload.dispatchEvent(new env.context.Event('click'));await env.pump();unchanged(env,before);
  assert.equal(env.downloads.length,0);first.close();const closed=observe(first.closed);env.open();await env.pump();unchanged(env,before);
  assert.equal(closed.state,'pending','unknown baseline release cannot settle designer closure');
  assert.ok(env.accesses.every(row=>row.disposed),'remaining access cleanup attempted');assert.ok(env.bitmaps.every(row=>row.closed===1),'remaining bitmap cleanup attempted');
  assert.equal(env.liveUrls().length,0,'remaining known preview URL cleanup attempted');
  const terminal=observe(env.coordinator.dispose());await env.pump();env.advance(60000);await env.pump();assert.equal(terminal.state,'pending');unchanged(env,before);
});

test('delivery revocation failure after successful designer close quarantines subsequent opens, not only terminal dispose',async t=>{
  const env=await fixture(t),first=env.open();await ready(env);click(download(env));click(download(env));await env.pump();assert.equal(env.downloads.length,2);
  const deliveries=env.downloads.map(row=>row.url);first.close();const closed=observe(first.closed);await env.pump();assert.equal(closed.state,'resolved');
  assert.equal(env.preview(),null);for(const url of deliveries)assert.equal(env.urls.get(url).revoked,false,'delivery outlives designer');
  const before=work(env);env.settings.revokeThrow=true;env.advance(60000);await env.pump();
  for(const url of deliveries)assert.ok(env.revoked.includes(url),'throwing one expiry does not skip another cleanup');
  env.open();await env.pump();unchanged(env,before);assert.equal(env.preview(),null);assert.equal(env.downloads.length,2);
  for(const node of env.content().querySelectorAll('button'))if(visible(node)&&/retry|download/i.test(name(node)))node.dispatchEvent(new env.context.Event('click'));
  await env.pump();unchanged(env,before);
  const promise=env.coordinator.dispose(),terminal=observe(promise);assert.equal(env.coordinator.dispose(),promise);await env.pump();
  assert.equal(terminal.state,'pending','unknown delivery release permanently prevents a confirmed terminal barrier');
});

// These are public reentry/barrier controls. They do not claim that the old
// implementation prematurely closed solely because leased(rec, task()) invoked
// task first. Exact acquire-before-invoke ordering remains a mandatory source
// review invariant, not a fabricated externally observed failure.
test('synchronous font-load callback reentry cannot admit replacement work before its returned Promise settles',async t=>{
  const env=await fixture(t,{autoFont:false});let first,waiting,closed,row;
  env.settings.onFontLoad=value=>{row=value;env.settings.onFontLoad=null;first.close();closed=observe(first.closed);waiting=env.open();};
  first=env.open();await env.pump();assert.ok(row&&waiting);const before=work(env);assert.equal(closed.state,'pending');
  await env.pump();unchanged(env,before);env.settings.autoFont=true;row.gate.resolve([]);await ready(env);assert.equal(closed.state,'resolved');
});

test('synchronous own-rating call reentry retains the returned operation across close and consumes late result',async t=>{
  const env=await fixture(t),first=env.open();await ready(env);let row,closed;
  env.settings.autoRatings=false;env.settings.onReadRatings=value=>{row=value;env.settings.onReadRatings=null;first.close();closed=observe(first.closed);env.open();};
  toggle(env.content(),OWN,true);await env.pump();assert.ok(row);const before=work(env);assert.equal(closed.state,'pending');unchanged(env,before);
  const late=env.makeRatings(row.capture);row.gate.resolve(late);await ready(env);assert.ok(env.releases.includes(late));assert.equal(closed.state,'resolved');assert.equal(env.downloads.length,0);
});

test('synchronous preview-header invocation reentry retains actual header Promise before replacement preview work',async t=>{
  const env=await fixture(t,{autoEncode:false}),first=env.open();await env.pump();const encoded=env.encodes[0],gate=deferred();
  const blob=env.blob(encoded.width,encoded.height,{headerGate:gate}),slice=blob.slice.bind(blob);let closed,entered=0;
  blob.slice=(...args)=>{const part=slice(...args),read=part.arrayBuffer.bind(part);part.arrayBuffer=()=>{entered++;first.close();closed=observe(first.closed);env.open();return read();};return part;};
  encoded.finish(blob);await env.pump();assert.equal(entered,1);assert.equal(closed.state,'pending');const before=work(env);await env.pump();unchanged(env,before);
  env.settings.autoEncode=true;gate.resolve();await ready(env);assert.equal(closed.state,'resolved');assert.equal(env.imageDecodes.some(row=>row.blob===blob),false,'stale header never becomes preview');
});
