'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,ARTIST}=require('./artist-host-fixtures/actual-artist-runtime.cjs');
const A='a'.repeat(64),B='b'.repeat(64);
const wire=(stamp=A)=>({context_ref:stamp,artist_ref:ARTIST,artist_scope:{root_artist_id:'3',mode:'artist'}});

test('matching wire and response foreign stamps cannot bind to another actual Gallery session',t=>{
  const h=fixture(t),c=h.context,actual=c.captureGalleryReadScope();assert.equal(actual.context,A);assert.equal(actual.stamp,A);
  const foreign=wire(B);assert.equal(c.normalizeRuntimeArtistListenThroughLaunch(foreign,B,ARTIST),null);assert.equal(c.artistListenThroughLaunchIsCurrent(foreign),false);
  const current=c.normalizeRuntimeArtistListenThroughLaunch(wire(),A,ARTIST);assert.ok(current);assert.equal(c.artistListenThroughLaunchIsCurrent(current),true);
});

test('actual private context change from captured-scope observer cannot admit the old response',t=>{
  const h=fixture(t),c=h.context,owner=c.captureGalleryReadScope;let once=true;
  c.captureGalleryReadScope=function(...args){const scope=owner.apply(this,args);if(once){once=false;h.change('context',B);}return scope;};
  const input=wire();try{assert.equal(c.normalizeRuntimeArtistListenThroughLaunch(input,A,ARTIST),null);assert.equal(c.artistListenThroughLaunchIsCurrent(input),false);}finally{c.captureGalleryReadScope=owner;}
});

test('actual private context change after the real currentness observer retires the receipt before return',t=>{
  const h=fixture(t),c=h.context,launch=c.normalizeRuntimeArtistListenThroughLaunch(wire(),A,ARTIST);assert.ok(launch);
  const owner=c.galleryReadScopeIsCurrent;let once=true;
  c.galleryReadScopeIsCurrent=function(...args){const current=owner.apply(this,args);if(once){once=false;h.change('context',B);}return current;};
  try{assert.equal(c.artistListenThroughLaunchIsCurrent(launch),false);}finally{c.galleryReadScopeIsCurrent=owner;}
  assert.equal(c.artistListenThroughLaunchIsCurrent(launch),false);
});

test('retained query-clearing transition strips newly registered related base arrays with all other launches',t=>{
  const h=fixture(t),c=h.context;
  const group=()=>({artist:ARTIST,albums:[{key:'retained-release',name:'Release',artist:ARTIST}],artist_listen_through_launch:wire()});
  const initial={surface:{active:'albums'},selected_artist:ARTIST,query:'Canonical',artist_listen_through_context_ref:A,
    artist_groups:[group()],primary_artist_groups:[group()],family_artist_groups:[],related_artists:[],related_filter_artists:[]};
  c.applyViewPayload(initial,{trackSidebarReveal:false});const old=h.state.view.primary_artist_groups[0],oldLaunch=old.artist_listen_through_launch;assert.ok(oldLaunch);
  const primary=group(),family=group(),beforePrimary=JSON.parse(JSON.stringify(primary)),beforeFamily=JSON.parse(JSON.stringify(family));
  c.applyViewPayload({surface:{active:'albums'},selected_artist:ARTIST,query:'',artist_listen_through_context_ref:A,
    artist_groups:[],primary_artist_groups:[],family_artist_groups:[],related_filter_base_primary_groups:[primary],related_filter_base_family_groups:[family],
    artist_page:{artist_ref:ARTIST,active_page_mode:'gallery',page_modes:['gallery','info'],default_page_mode:'gallery',artist_listen_through_launch:wire()}},
    {preserveMountedGalleryChildren:true,trackSidebarReveal:false});
  const next=h.state.view;assert.equal(next.artist_listen_through_context_ref,null);
  for(const key of ['artist_groups','primary_artist_groups','family_artist_groups','related_filter_base_primary_groups','related_filter_base_family_groups'])
    for(const row of next[key]||[])assert.equal(row.artist_listen_through_launch??null,null,key);
  assert.equal(next.artist_page?.artist_listen_through_launch??null,null);assert.equal(old.artist_listen_through_launch,oldLaunch);
  assert.deepEqual(primary,beforePrimary);assert.deepEqual(family,beforeFamily);
});
