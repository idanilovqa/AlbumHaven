'use strict';
// Run only in the actual Home8a01/D1 successor closure. B supplies platform,
// transport response and named asset-loader boundaries, never modal source.
const test = require('node:test'), assert = require('node:assert/strict');
const B = require('./foobar-track-evidence-fixture.cjs');
async function open(t, album = B.album()) {const f = await B.platform(t), m = f.modal(); m.render(album); await f.flush(); return {f,m,album};}
test('HC01 actual Home modal lazily offers source evidence without eager requests or changing track controls', async t => {
  const {f,m} = await open(t,B.album({tracks:[B.track(11),B.track(12)]}));
  assert.equal(m.controls().length,2); assert.equal(m.list.querySelectorAll('.play-track-button').length,2);
  assert.equal(f.requests.length,0); assert.equal(f.imports.length,0);
});
test('HC02 actual Home row receipt uses current inventory identity rather than duplicate labels', async t => {
  const {f,m} = await open(t,B.album({tracks:[B.track(11)],track_rows:[B.track(77,{path:B.track(11).path})]}));
  f.click(m.controls()[0]);await f.flush();assert.equal(f.requests.length,1);
  assert.deepEqual(B.body(f.requests[0]),{version:B.VERSION,track_id:'77',family:'standard',cursor:null});
  f.reply(0,B.payload([B.item()],{track_id:'77'}));await f.flush();B.noPrivate(m.owner().host);
});
test('HC03 actual Home subject unreadable and missing albums never attach own-account evidence', async t => {
  const {f,m}=await open(t);
  for(const patch of [{read_only_subject:true},{source_readable:false},{inventory_status:'missing'},{allowed_actions:{can_read:false}}]){
    m.render(B.album(patch));await f.flush();assert.equal(m.controls().length,0);
  }
  assert.equal(f.requests.length,0);
});
test('HC04 actual Home close cleanup retires evidence panel and aborts pending read', async t => {
  const {f,m}=await open(t);f.click(m.controls()[0]);await f.flush();const host=m.owner().host;
  assert.equal(f.requests.length,1);f.c.clearTrackModalRenderedState();await f.flush();
  assert.equal(f.requests[0].options.signal.aborted,true);assert.equal(host.isConnected,false);assert.equal(m.owner(),null);
});
test('HC05 actual Home rerender keeps only current row evidence and fences prior response', async t => {
  const {f,m}=await open(t);f.click(m.controls()[0]);await f.flush();const old=m.owner().host;
  m.render(B.album({key:'next',tracks:[B.track(12)]}));await f.flush();
  assert.equal(f.requests[0].options.signal.aborted,true);assert.equal(old.isConnected,false);
  f.reply(0,B.payload());await f.flush();assert.equal(m.list.querySelectorAll('.foobar-history').length,0);
  f.click(m.controls()[0]);await f.flush();assert.equal(B.body(f.requests[1]).track_id,'12');
});
test('HC06 actual Home current account capability retirement removes evidence controls', async t => {
  const {f,m}=await open(t);f.click(m.controls()[0]);await f.flush();
  f.shell.dataset.accountFoobarHistoryAllowed='false';f.mutate(f.shell);await f.flush();
  assert.equal(m.controls().length,0);assert.equal(f.requests[0].options.signal.aborted,true);
});
test('HC07 actual Home rejects foreign malformed and denied inventory row references', async t => {
  const {f,m}=await open(t,B.album({tracks:[B.track(11,{inventory_track_ref:'inventory-track:4:11'}),B.track(12,{inventory_track_ref:null}),B.track(13,{allowed_actions:{can_read:false}})]}));
  assert.equal(m.controls().length,0);assert.equal(f.imports.length,0);assert.equal(f.requests.length,0);
});
test('HC08 actual Home delayed evidence asset cannot outlive modal cleanup', async t => {
  const {f,m}=await open(t);const gate=f.holdImport();f.click(m.controls()[0]);f.c.clearTrackModalRenderedState();gate.resolve();await f.flush();
  assert.equal(f.requests.length,0);assert.equal(m.owner(),null);assert.equal(m.list.querySelectorAll('.foobar-history').length,0);
});

// Narrow synthetic platform additions for the real Home dialog relocation API.
// No selection, grant, provenance, renderer or evidence implementation is replaced.
async function embedded(t) {
  const {f,m,album}=await open(t), {document,c}=f;
  const proto=Object.getPrototypeOf(c.Element.prototype);
  proto.before=function(node){this.parentNode?.insertBefore(node,this);};
  proto.replaceWith=function(node){const parent=this.parentNode;if(parent){parent.insertBefore(node,this);parent.removeChild(this);}};
  document.createComment=text=>{const node=document.createTextNode(text);node.nodeType=8;return node;};
  const events=[], originalAdd=c.addEventListener, originalRemove=c.removeEventListener;
  c.addEventListener=(type,callback,...options)=>{if(type==='resize')events.push({type,callback});return originalAdd?.call(c,type,callback,...options);};
  c.removeEventListener=(type,callback,...options)=>{const n=events.findIndex(row=>row.type===type&&row.callback===callback);if(n>=0)events.splice(n,1);return originalRemove?.call(c,type,callback,...options);};
  const dialog=document.createElement('div');dialog.className='track-modal-dialog';
  dialog.append(m.header,m.list,m.cover);m.overlay.append(dialog);m.overlay.hidden=true;
  const host=document.createElement('section');document.body.append(host);
  let current=true,allowed=true;
  const lease=c.acquireTrackModalSelection(host,album,{isCurrent:()=>current,canOpen:()=>allowed,canPlay:()=>false,canArtwork:()=>false});
  assert.ok(lease);assert.equal(dialog.parentNode,host);
  t.after(()=>{try{lease.release('test teardown');assert.equal(events.length,0);}finally{c.addEventListener=originalAdd;c.removeEventListener=originalRemove;}});
  return {f,m,album,lease,dialog,host,current:value=>{current=value;},allow:value=>{allowed=value;}};
}
test('HC09 actual Home embedded selection release aborts evidence and returns existing dialog to dock', async t=>{
  const {f,m,lease,dialog}=await embedded(t);f.click(m.controls()[0]);await f.flush();assert.equal(f.requests.length,1);
  lease.release('React effect cleanup');await f.flush();
  assert.equal(dialog.parentNode,m.overlay);assert.equal(f.requests[0].options.signal.aborted,true);assert.equal(m.owner(),null);
});
test('HC10 actual Home embedded selection revocation blocks evidence before observer or rerender', async t=>{
  const {f,m,current}=await embedded(t);const button=m.controls()[0];current(false);f.click(button);await f.flush();
  assert.equal(f.imports.length,0);assert.equal(f.requests.length,0);
});
test('HC11 actual Home embedded selection open-grant loss blocks evidence without granting playback', async t=>{
  const {f,m,allow}=await embedded(t);allow(false);f.click(m.controls()[0]);await f.flush();
  assert.equal(f.requests.length,0);assert.equal(f.imports.length,0);
  for(const button of m.list.querySelectorAll('.play-track-button'))assert.equal(button.disabled,true);
});
test('HC12 actual Home source-page provenance revocation fences existing evidence action', async t=>{
  const {f,m,album}=await open(t);let current=true;
  f.c.openTrackModal(album,{sourcePageOwner:{isCurrent:()=>current},
    presentationRestrictions:{can_view_artwork:false},releaseSet:{releases:[album],selectedIndex:0}});
  await f.flush();assert.equal(m.controls().length,1);current=false;
  f.click(m.controls()[0]);await f.flush();assert.equal(f.imports.length,0);assert.equal(f.requests.length,0);
});
test('HC13 actual Home embedded lease invalidation fences a delayed source evidence response', async t=>{
  const {f,m,current,lease}=await embedded(t);f.click(m.controls()[0]);await f.flush();
  assert.equal(f.requests.length,1);const host=m.owner().host;current(false);
  f.reply(0,B.payload());await f.flush();assert.equal(host.querySelectorAll('section').length,0);
  assert.equal(host.textContent.includes(B.item().source_ref),false);lease.release('revoked');
  assert.equal(host.isConnected,false);assert.equal(m.owner(),null);
});

test('HC14 actual Home transport API is used without fabricated native lifecycle methods',async t=>{
  const {f,m}=await open(t);assert.equal(typeof f.transport.generation,'function');
  assert.equal(f.transport.peekGeneration,undefined);assert.equal(f.transport.dispose,undefined);
  const generation=f.transport.generation();f.click(m.controls()[0]);await f.flush();assert.equal(f.requests.length,1);
  assert.equal(f.transport.generation(),generation);f.reply(0,B.payload());await f.flush();
  assert.equal(m.owner().host.querySelectorAll('section').length,1);
});

test('HC15 actual Home synchronous transport context retirement fences click before observer delivery',async t=>{
  const {f,m}=await open(t);const button=m.controls()[0];const generation=f.transport.generation();
  f.shell.dataset.privateUiContext='d'.repeat(64);f.click(button);await f.flush();
  assert.equal(f.transport.generation(),generation+1);assert.equal(m.owner(),null);
  assert.equal(f.requests.length,0);assert.equal(f.imports.length,0);
});
