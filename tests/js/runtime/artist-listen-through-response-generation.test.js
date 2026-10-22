'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,ARTIST}=require('./artist-host-fixtures/actual-artist-runtime.cjs');
const STAMP='a'.repeat(64);
const wire=()=>({context_ref:STAMP,artist_ref:ARTIST,artist_scope:{root_artist_id:'3',mode:'artist'}});
for(const boundary of ['normalization','currentness'])test('actual transport invalidation after Gallery scope callback rejects '+boundary,t=>{
  const h=fixture(t),c=h.context,transport=c.AlbumHavenPrivateUITransport,input=wire();
  const launch=boundary==='currentness'?c.normalizeRuntimeArtistListenThroughLaunch(input,STAMP,ARTIST):null;
  if(boundary==='currentness')assert.ok(launch);
  const generation=transport.generation(),shellStamp=h.shell.dataset.privateUiContext,owner=c.galleryReadScopeIsCurrent;let once=true;
  c.galleryReadScopeIsCurrent=function(...args){const current=owner.apply(this,args);if(once){once=false;assert.equal(current,true);transport.invalidate();}return current;};
  try{
    if(boundary==='normalization')assert.equal(c.normalizeRuntimeArtistListenThroughLaunch(input,STAMP,ARTIST),null);
    else assert.equal(c.artistListenThroughLaunchIsCurrent(launch),false);
    assert.equal(once,false);assert.notEqual(transport.generation(),generation);assert.equal(h.shell.dataset.privateUiContext,shellStamp);
  }finally{c.galleryReadScopeIsCurrent=owner;}
  if(launch)assert.equal(c.artistListenThroughLaunchIsCurrent(launch),false);
});
