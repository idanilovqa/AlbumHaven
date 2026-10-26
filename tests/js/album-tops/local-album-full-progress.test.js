'use strict';
// Authored only: native import of the whole actual presenter, no extraction.
const test=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const load=()=>import(pathToFileURL(path.resolve(__dirname,'../../../music_app/static/js/album-tops/listening-presentation.mjs')).href);
const scope={albumKey:'album',accountId:'7',libraryId:'3',context:'a'.repeat(64)};
const dto=()=>({ok:true,version:'local-album-full-progress-v1',album_key:'album',account_id:'7',library_id:'3',
  context_ref:scope.context,membership_revision:'b'.repeat(64),full_progress:{available:true,
    policy_version:'local-edition-overlap-total-margin-v1',basis:'healthy-local-inventory-version-v1',
    state_revision:'8',full:5,uninterrupted_full:2,listened:true,partial:null,history_complete:false,
    derived_pruned:false,status:'complete_at_cutoff',continuation:false,cutoff_checkpoint_id:'99',completed_cutoff_checkpoint_id:'99'}});

test('local Full result is a supported lower bound with uninterrupted included once',async()=>{
  const {projectLocalAlbumFullProgress:show}=await load();const value=dto();
  const result=show(scope,value);assert.equal(result.available,true);
  assert.equal(result.text,'Full: at least 5 (2 uninterrupted)');
  assert.match(result.detail,/included, not added again/);assert.equal(result.continuation,false);
});

test('zero Full evidence remains unknown rather than declaring unlistened',async()=>{
  const {projectLocalAlbumFullProgress:show}=await load();const value=dto();
  Object.assign(value.full_progress,{full:0,uninterrupted_full:0,listened:'unknown'});
  assert.equal(show(scope,value).text,'Full listens: not yet established');
});

test('initial zero state revision schedules bounded continuation',async()=>{
  const {projectLocalAlbumFullProgress:show}=await load();const value=dto();
  value.full_progress={available:true,status:'not_started',state_revision:'0',continuation:true};
  const result=show(scope,value);assert.equal(result.available,true);assert.equal(result.revision,'0');assert.equal(result.continuation,true);
});

test('derived pruning remains visibly incomplete without claiming raw deletion',async()=>{
  const {projectLocalAlbumFullProgress:show}=await load();const value=dto();
  Object.assign(value.full_progress,{status:'lower_bound_at_cutoff',derived_pruned:true});
  assert.match(show(scope,value).detail,/conservatively omitted; original listening remains retained/);
});

for(const [name,change] of [
  ['other account',v=>v.account_id='8'],['other library',v=>v.library_id='4'],
  ['other context',v=>v.context_ref='c'.repeat(64)],['other album',v=>v.album_key='other'],
  ['catalog relabel',v=>v.full_progress.basis='authoritative-catalog'],
  ['wrong policy',v=>v.full_progress.policy_version='old-candidate'],
  ['exact lifetime',v=>v.full_progress.history_complete=true],
  ['invented partial count',v=>v.full_progress.partial=12],
  ['negative full',v=>v.full_progress.full=-1],
  ['double count',v=>v.full_progress.uninterrupted_full=6],
  ['false zero listened',v=>Object.assign(v.full_progress,{full:0,uninterrupted_full:0,listened:true})],
  ['unsafe revision',v=>v.full_progress.state_revision='9007199254740992'],
  ['bad cutoff',v=>v.full_progress.cutoff_checkpoint_id='None']
])test(`local Full presenter rejects ${name}`,async()=>{
  const {projectLocalAlbumFullProgress:show}=await load();const value=dto();change(value);
  assert.equal(show(scope,value).available,false);assert.equal(show(scope,value).continuation,false);
});
