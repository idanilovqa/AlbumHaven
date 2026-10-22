'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {fixture,artistView,group,album,ARTIST}=require('./artist-host-fixtures/actual-artist-runtime.cjs');
const STAMP='a'.repeat(64),clone=value=>JSON.parse(JSON.stringify(value));
const wire=(artist=ARTIST,root='3')=>({context_ref:STAMP,artist_ref:artist,artist_scope:{root_artist_id:root,mode:'artist'}});
const arrays=['artist_groups','primary_artist_groups','family_artist_groups','related_filter_base_primary_groups','related_filter_base_family_groups'];
function payload(){const main=group(ARTIST,[album(1)],{artist_listen_through_launch:wire()}),family=group('Family',[album(2)],{artist_listen_through_launch:wire('Family','4')});
  return artistView({artist_listen_through_context_ref:STAMP,artist_groups:[main,family],primary_artist_groups:[main],family_artist_groups:[family],
    related_filter_base_primary_groups:[main],related_filter_base_family_groups:[family],related_artists:['Family'],
    artist_page:{artist_ref:ARTIST,active_page_mode:'gallery',page_modes:['gallery','info'],default_page_mode:'gallery',artist_listen_through_launch:wire()}});}
function clear(view){assert.equal(view.artist_listen_through_context_ref,null);for(const key of arrays)for(const row of view[key]||[])assert.equal(row?.artist_listen_through_launch??null,null);assert.equal(view.artist_page?.artist_listen_through_launch??null,null);}
function current(c,view){assert.equal(view.artist_listen_through_context_ref,STAMP);for(const key of arrays)for(const row of view[key]||[])assert.equal(c.artistListenThroughLaunchIsCurrent(row.artist_listen_through_launch),true);assert.equal(c.artistListenThroughLaunchIsCurrent(view.artist_page.artist_listen_through_launch),true);}

test('fresh normalization preserves independent Top launch on every producing group and page boundary',t=>{
  const h=fixture(t),c=h.context,input=payload(),view=c.normalizeViewPayload(input);current(c,view);assert.equal(view.artist_loved_context_ref,null);
  assert.equal(view.artist_groups[0].artist_loved_launch,null);assert.ok(Object.isFrozen(view.artist_page.artist_listen_through_launch));
});

for(const reason of ['absent','wrong','private'])test('normalization clears all Top fields for '+reason+' response stamp',t=>{
  const h=fixture(t),c=h.context,input=payload();if(reason==='absent')delete input.artist_listen_through_context_ref;
  if(reason==='wrong')input.artist_listen_through_context_ref='b'.repeat(64);if(reason==='private')input.private_search=true;
  const view=c.normalizeViewPayload(input);for(const key of arrays)for(const row of view[key]||[])assert.equal(row?.artist_listen_through_launch??null,null);
  assert.equal(view.artist_page?.artist_listen_through_launch??null,null);
  if(reason!=='wrong')assert.equal(view.artist_listen_through_context_ref,null);
});

test('partial normalization with a stamp cannot borrow omitted fallback arrays or Artist page authority',t=>{
  const h=fixture(t),c=h.context,base=c.normalizeViewPayload(payload());current(c,base);
  const next=c.normalizeViewPayload({artist_listen_through_context_ref:STAMP,album_count:2},base);
  for(const key of arrays)for(const row of next[key]||[])assert.equal(row?.artist_listen_through_launch??null,null);assert.equal(next.artist_page?.artist_listen_through_launch??null,null);
});

test('local normalization carries registered receipts but cannot register copied fallback launch fields',t=>{
  const h=fixture(t),c=h.context,base=c.normalizeViewPayload(payload());current(c,base);
  current(c,c.normalizeViewPayload({gallery_scale_percent:90},base));const copied=clone(base),next=c.normalizeViewPayload({gallery_scale_percent:90},copied);
  for(const key of arrays)for(const row of next[key]||[])assert.equal(row?.artist_listen_through_launch??null,null);assert.equal(next.artist_page?.artist_listen_through_launch??null,null);
});

test('local sparse group slots cannot borrow launch authority from a prior fallback row',t=>{
  const h=fixture(t),c=h.context,base=c.normalizeViewPayload(payload()),input={artist_listen_through_context_ref:STAMP,artist_groups:new Array(1)};
  const next=c.normalizeViewPayload(input,base);assert.equal(next.artist_groups[0]?.artist_listen_through_launch??null,null);
  assert.equal(next.primary_artist_groups[0]?.artist_listen_through_launch??null,null);
});

test('merge presentation transition preserves current receipts and nonlocal merge strips omitted evidence',t=>{
  const h=fixture(t),c=h.context;c.applyViewPayload(payload(),{trackSidebarReveal:false});const first=h.state.view.artist_groups[0].artist_listen_through_launch;assert.equal(c.artistListenThroughLaunchIsCurrent(first),true);
  c.mergeViewPayload({gallery_scale_percent:90},{trackSidebarReveal:false});assert.equal(c.artistListenThroughLaunchIsCurrent(h.state.view.artist_groups[0].artist_listen_through_launch),true);
  c.mergeViewPayload({album_count:99},{trackSidebarReveal:false});clear(h.state.view);assert.equal(c.artistListenThroughLaunchIsCurrent(first),false);
});

test('real related filter transition retains only registered current group receipts',t=>{
  const h=fixture(t),c=h.context;c.applyViewPayload(payload(),{trackSidebarReveal:false});const main=h.state.view.primary_artist_groups[0].artist_listen_through_launch;
  const next=c.applyLocalRelatedFilterState(['Family'],{primary_filter_active:true});assert.ok(next);assert.equal(c.artistListenThroughLaunchIsCurrent(main),true);
  assert.equal(next.artist_listen_through_context_ref,STAMP);for(const row of next.artist_groups)assert.equal(c.artistListenThroughLaunchIsCurrent(row.artist_listen_through_launch),true);
});

test('root continuation shares its existing epoch but a new root response retires cached wire launches',t=>{
  const h=fixture(t),c=h.context,input=payload();c.applyViewPayload(input,{trackSidebarReveal:false});const first=h.state.view.artist_groups[0].artist_listen_through_launch;
  c.applyViewPayload(input,{rootGalleryContinuation:true,trackSidebarReveal:false});assert.equal(c.artistListenThroughLaunchIsCurrent(first),true);
  c.applyViewPayload(input,{trackSidebarReveal:false});assert.equal(c.artistListenThroughLaunchIsCurrent(first),false);
  for(const row of h.state.view.artist_groups)assert.equal(row.artist_listen_through_launch,null);
});

test('retained mounted selected view strips Top fields without mutating old group or album objects',t=>{
  const h=fixture(t),c=h.context,input=payload();input.query='Canonical';c.applyViewPayload(input,{trackSidebarReveal:false});
  const prior=h.state.view,old=prior.primary_artist_groups[0],launch=old.artist_listen_through_launch;assert.ok(launch);
  c.applyViewPayload({query:'',selected_artist:ARTIST,artist_groups:[],primary_artist_groups:[],family_artist_groups:[]},
    {preserveMountedGalleryChildren:true,trackSidebarReveal:false});const next=h.state.view;clear(next);
  assert.notEqual(next.primary_artist_groups[0],old);assert.equal(next.primary_artist_groups[0].albums,old.albums);assert.equal(old.artist_listen_through_launch,launch);
});

test('missing optional Top evidence never changes ordinary album content or grants it from Loved fields',t=>{
  const h=fixture(t),c=h.context,input=payload();delete input.artist_listen_through_context_ref;
  input.artist_loved_context_ref=STAMP;input.primary_artist_groups[0].artist_loved_launch={context_ref:STAMP,artist_ref:ARTIST,descriptor:{version:1,root_artist_id:'3',scope_mode:'artist'}};
  const next=c.normalizeViewPayload(input);clear(next);assert.equal(next.primary_artist_groups[0].albums[0].key,input.primary_artist_groups[0].albums[0].key);
});
