'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,artistView,group,album,ARTIST}=require('./artist-host-fixtures/actual-artist-runtime.cjs');
const STAMP='a'.repeat(64),clone=value=>JSON.parse(JSON.stringify(value));
const wire=()=>({context_ref:STAMP,artist_ref:ARTIST,artist_scope:{root_artist_id:'9223372036854775807',mode:'artist'}});
const normalize=(c,value=wire(),stamp=STAMP,anchor=ARTIST)=>c.normalizeRuntimeArtistListenThroughLaunch(value,stamp,anchor);

test('current actual Gallery scope admits a detached immutable launch independently of Loved',t=>{
  const h=fixture(t),c=h.context,input=wire(),launch=normalize(c,input);assert.ok(launch);assert.deepEqual(clone(launch),input);
  assert.notEqual(launch,input);assert.notEqual(launch.artist_scope,input.artist_scope);assert.ok(Object.isFrozen(launch));assert.ok(Object.isFrozen(launch.artist_scope));
  assert.equal(c.artistListenThroughLaunchIsCurrent(input),true);assert.equal(c.artistListenThroughLaunchIsCurrent(launch),true);
  assert.equal(c.artistListenThroughLaunchIsCurrent(clone(launch)),false);assert.equal(h.requests.length,0);
});

for(const [name,change] of [
  ['null',()=>null],['array',()=>[]],['extra',v=>({...v,authority:true})],['missing-scope',v=>{delete v.artist_scope;return v;}],
  ['scope-extra',v=>({...v,artist_scope:{...v.artist_scope,library_id:'9'}})],['scope-null',v=>({...v,artist_scope:null})],
  ['scope-array',v=>({...v,artist_scope:[]})],['family',v=>({...v,artist_scope:{...v.artist_scope,mode:'family'}})],
  ['zero',v=>({...v,artist_scope:{...v.artist_scope,root_artist_id:'0'}})],['leading-zero',v=>({...v,artist_scope:{...v.artist_scope,root_artist_id:'01'}})],
  ['numeric-root',v=>({...v,artist_scope:{...v.artist_scope,root_artist_id:1}})],['overflow',v=>({...v,artist_scope:{...v.artist_scope,root_artist_id:'9223372036854775808'}})],
  ['root-LF',v=>({...v,artist_scope:{...v.artist_scope,root_artist_id:'1\n'}})],['root-CR',v=>({...v,artist_scope:{...v.artist_scope,root_artist_id:'1\r'}})],
  ['root-space',v=>({...v,artist_scope:{...v.artist_scope,root_artist_id:' 1'}})],['stamp-LF',v=>({...v,context_ref:STAMP+'\n'})],
  ['stamp-upper',v=>({...v,context_ref:'A'.repeat(64)})],['wrong-stamp',v=>({...v,context_ref:'b'.repeat(64)})],
  ['wrong-anchor',v=>({...v,artist_ref:'Different Artist'})]
])test('malformed exact launch is absent: '+name,t=>{const h=fixture(t),value=change(wire());assert.equal(normalize(h.context,value),null);assert.equal(h.context.artistListenThroughLaunchIsCurrent(value),false);});

for(const stamp of [STAMP+'\n',STAMP+'\r','A'.repeat(64),null])test('response stamp is exact '+JSON.stringify(stamp),t=>{const h=fixture(t),value=wire();value.context_ref=stamp;assert.equal(normalize(h.context,value,stamp),null);});

for(const field of ['context','artist','root','mode'])test('first receipt binds immutable descriptor despite same-epoch wire mutation '+field,t=>{
  const h=fixture(t),c=h.context,input=wire(),launch=normalize(c,input),original=clone(launch);assert.ok(launch);
  if(field==='context')input.context_ref='b'.repeat(64);if(field==='artist')input.artist_ref='New Artist';if(field==='root')input.artist_scope.root_artist_id='2';if(field==='mode')input.artist_scope.mode='family';
  assert.equal(c.artistListenThroughLaunchIsCurrent(input),false);assert.equal(normalize(c,input,input.context_ref,input.artist_ref),null);
  assert.deepEqual(clone(launch),original);assert.equal(c.artistListenThroughLaunchIsCurrent(launch),true);
});

for(const missing of ['captureGalleryReadScope','galleryReadScopeIsCurrent'])test('Top requires actual Gallery support at first admission and later currentness '+missing,t=>{
  const h=fixture(t),c=h.context,launch=normalize(c);assert.ok(launch);const original=c[missing];c[missing]=undefined;
  try{assert.equal(normalize(c),null);assert.equal(c.artistListenThroughLaunchIsCurrent(launch),false);}finally{c[missing]=original;}
});

test('null transport generation cannot admit or validate Top receipts',t=>{
  const h=fixture(t),c=h.context,launch=normalize(c);assert.ok(launch);const original=c.artistLovedTransportGeneration;
  // Explicit absent-integration boundary only; all positive cases use the real transport.
  c.artistLovedTransportGeneration=()=>null;try{assert.equal(normalize(c),null);assert.equal(c.artistListenThroughLaunchIsCurrent(launch),false);}finally{c.artistLovedTransportGeneration=original;}
});

for(const kind of ['actor','library','context'])test('actual shell/transport '+kind+' change permanently retires the captured receipt',t=>{
  const h=fixture(t),c=h.context,input=wire(),launch=normalize(c,input);assert.ok(launch);h.change(kind);assert.equal(c.artistListenThroughLaunchIsCurrent(launch),false);assert.equal(normalize(c,input),null);
});

test('a new root response retires the old wire object without granting it a fresh epoch',t=>{
  const h=fixture(t),c=h.context,input=wire(),launch=normalize(c,input);assert.ok(launch);
  c.applyViewPayload(artistView(),{trackSidebarReveal:false});assert.equal(c.artistListenThroughLaunchIsCurrent(launch),false);assert.equal(normalize(c,input),null);assert.ok(normalize(c,wire()));
});

test('descriptor mutation during the actual currentness observer is rejected after that observer',t=>{
  const h=fixture(t),c=h.context,input=wire(),launch=normalize(c,input);assert.ok(launch);const owner=c.galleryReadScopeIsCurrent;let once=true;
  c.galleryReadScopeIsCurrent=function(...args){const current=owner.apply(this,args);if(once){once=false;input.artist_scope.root_artist_id='2';}return current;};
  try{assert.equal(c.artistListenThroughLaunchIsCurrent(input),false);assert.deepEqual(clone(launch),wire());assert.equal(c.artistListenThroughLaunchIsCurrent(launch),true);}finally{c.galleryReadScopeIsCurrent=owner;}
});

test('descriptor mutation during real scope capture cannot mint the changed descriptor',t=>{
  const h=fixture(t),c=h.context,input=wire(),owner=c.captureGalleryReadScope;let once=true;
  c.captureGalleryReadScope=function(...args){const captured=owner.apply(this,args);if(once){once=false;input.artist_scope.root_artist_id='2';}return captured;};
  try{assert.equal(normalize(c,input),null);}finally{c.captureGalleryReadScope=owner;}
});
