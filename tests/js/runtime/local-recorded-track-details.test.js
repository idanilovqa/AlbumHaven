'use strict';
// Whole actual modules. HTTP envelope/DOM are declared platform fixtures.
const test=require('node:test'),assert=require('node:assert/strict');
const N=require('./album-tops-native-fixtures/actual-native-runtime.cjs');
const F=require('./album-tops-native-gallery-fixture.cjs');
const {STAMP}=require('./private-context-harness.cjs');
const details=()=>({policy:'local-recorded-track-depth-v1',target:5,
  scope:'processed-compatible-recorded-evidence',history_complete:false,cutoff_checkpoint_id:'19',
  recorded_frames:2880000,partial_stretches:12,partial_incomplete:true,coverage_pruned:false,
  uneven_track_coverage:true,unsupported_runs:0,target_coverage:{numerator:2,denominator:5},tracks_at_target:0,
  tracks:[{track_id:'11',recorded_frames:2880000,extent_frames:1440000,
    position_coverage:{numerator:1440000,denominator:1440000},minimum_position_depth:2,
    tracks_target_reached:false,coverage_pruned:false}]});

test('recorded details distinguish replay time depth and nonmonotonic partial stretches',async()=>{
  const {recordedTrackDetails:parse}=await N.load('album-tops/recorded-track-details.mjs');
  const result=parse(details(),5);assert.ok(result);
  assert.match(result.explanation,/Replays add time, not unheard positions/);
  assert.match(result.explanation,/not lifetime sessions or a monotonic lower bound/);
  assert.match(result.explanation,/at least 40%/);assert.match(result.explanation,/minimum depth 2/);
});
for(const [label,patch] of [
  ['time sum',{recorded_frames:7}],['target receipt',{target:7}],
  ['invalid ratio',{target_coverage:{numerator:6,denominator:5}}],
  ['lifetime claim',{history_complete:true}],['exact partial claim',{partial_incomplete:false}],
])test(`recorded details reject ${label}`,async()=>{
  const {recordedTrackDetails:parse}=await N.load('album-tops/recorded-track-details.mjs');
  assert.equal(parse({...details(),...patch},5),null);
});

test('recorded details without a target show time and position without inventing saved settings',async()=>{
  const {recordedTrackDetails:parse}=await N.load('album-tops/recorded-track-details.mjs');
  const value=details();value.target=null;value.target_coverage=null;value.tracks_at_target=null;
  value.tracks[0].tracks_target_reached=null;
  assert.match(parse(value,null).explanation,/Duration-weighted target coverage unavailable/);
});

test('actual Top provider and presenter expose derived stretches target and uneven caveat separately',async()=>{
  const source=F.detail({items:[F.row(11)]}),row=source.items[0];
  const {createCurrentTopListeningProvider}=await N.load('album-tops/current-listening-provider.mjs');
  const provider=createCurrentTopListeningProvider({acceptsScope:s=>s===N.SCOPE,isDisposed:()=>false,
    transport:{context:()=>STAMP,request:async()=>({version:'current-top-listening-v1',context_ref:STAMP,
      top_ref:source.top_ref,top_revision:source.revision,account_id:'1',library_id:'2',
      scope:'requested-current-items',whole_top_complete:false,
      settings:{completed_target:5,settings_revision:'1',preference_status:'default'},items:[{
        item_ref:row.item_ref,album_ref:row.album_ref,local_album_ref:row.native_album.inventory_album_ref,
        membership_revision:'b'.repeat(64),status:'ready',manual_completed:false,automatic_completed:false,
        fresh_rating:null,fresh_play:null,baseline_status:'ready',
        predicates:{has_plays:true,listened:true,completed:null,rated:false},
        reported_evidence:{status:'not_requested',has_plays:null,incomplete:true,count_family:'standard',provenance:'own_account_foobar_reported_evidence'},
        full_progress:{available:true,state_revision:'9',continuation:false,status:'complete_at_cutoff',
          policy_version:'local-edition-overlap-total-margin-v1',basis:'healthy-local-inventory-version-v1',
          history_complete:false,full:2,uninterrupted_full:1,partial:null,recorded_details:details()},
      }]})}});
  const result=await provider.readTopListening({detail:source,itemRefs:[row.item_ref],accountId:'1',libraryId:'2',scopeKey:N.SCOPE,isCurrent:()=>true});
  const {albumTopStatusPresentation:present}=await N.load('album-tops/status-presentation.mjs');
  source.top_viewer_overlay.completed_target_preference=result.settings;
  source.top_viewer_overlay.item_listening_presentation={[row.album_ref]:result.items.get(row.item_ref).presentation};
  const view=present(source,row);
  assert.equal(view.summary,'≥2 full · 12 partial stretches · ≥0 tracks at target');
  assert.match(view.explanation,/Track coverage is uneven/);assert.match(view.explanation,/1 min/);
  assert.equal(view.flags.listened,true);assert.equal(view.flags.completed,null);
});


test('aggregate time overflow stays unknown without dropping finite per-track evidence',async()=>{
  const {recordedTrackDetails:parse}=await N.load('album-tops/recorded-track-details.mjs');
  const value=details();value.recorded_frames=null;
  value.tracks=[{...value.tracks[0],recorded_frames:Number.MAX_SAFE_INTEGER},
    {...value.tracks[0],track_id:'12',recorded_frames:1}];
  const result=parse(value,5);assert.ok(result);assert.equal(result.recorded_frames,null);
  assert.equal(result.tracks[0].recorded_frames,Number.MAX_SAFE_INTEGER);
  assert.equal(parse({...value,recorded_frames:Number.MAX_SAFE_INTEGER},5),null);
});

const modalScope={albumKey:'album',accountId:'7',libraryId:'3',context:'a'.repeat(64)};
function modalResponse(){return {ok:true,version:'local-album-recorded-metrics-v1',album_key:'album',
  account_id:'7',library_id:'3',context_ref:modalScope.context,membership_revision:'b'.repeat(64),
  history_complete:false,window_truncated:true,compatibility_policy:'healthy-local-inventory-version-v1',
  metrics:{status:'partial',basis:'local-edition-recorded-v1',history_status:'partial',full:null,listened:'unknown',
    recorded_frames:48000,tracks_with_supported_coverage:0,unsupported_run_count:1,
    tracks:[{track_id:'11',recorded_frames:48000,coverage_status:'unknown',covered_frames:null,extent_frames48:null}]},
  full_progress:{available:true,policy_version:'local-edition-overlap-total-margin-v1',basis:'healthy-local-inventory-version-v1',
    state_revision:'8',full:2,uninterrupted_full:1,listened:true,partial:null,history_complete:false,
    derived_pruned:false,status:'complete_at_cutoff',continuation:false,cutoff_checkpoint_id:'19',completed_cutoff_checkpoint_id:'19',
    recorded_details:details()}};}

test('actual Album Details presenter prefers admitted completed detail time over recent-window time',async()=>{
  const {projectLocalAlbumRecordedPresentation:show}=await N.load('album-tops/listening-presentation.mjs');
  const value=modalResponse(),result=show(modalScope,value);
  assert.equal(result.available,true);assert.equal(result.text,'Recorded: at least 1 min');
  assert.match(result.detail,/processed cutoff/);assert.match(result.detail,/minimum depth 2/);
});

test('actual Album Details presenter keeps old completed snapshot during current-cut processing',async()=>{
  const {projectLocalAlbumRecordedPresentation:show,projectLocalAlbumFullProgress:full}=await N.load('album-tops/listening-presentation.mjs');
  const value=modalResponse();Object.assign(value.full_progress,{status:'processing',continuation:true,cutoff_checkpoint_id:'29'});
  assert.equal(show(modalScope,value).text,'Recorded: at least 1 min');
  assert.equal(full(modalScope,value).continuation,true);
  assert.match(full(modalScope,value).text,/12 partial stretches.*calculating/);
  assert.equal(value.full_progress.recorded_details.cutoff_checkpoint_id,'19');
});

test('actual Album Details null aggregate detail time falls back to explicitly bounded window',async()=>{
  const {projectLocalAlbumRecordedPresentation:show}=await N.load('album-tops/listening-presentation.mjs');
  const value=modalResponse();value.full_progress.recorded_details.recorded_frames=null;
  value.full_progress.recorded_details.tracks[0].recorded_frames=null;
  assert.equal(show(modalScope,value).text,'Recorded: at least 1 sec · Coverage known: 0/1 tracks');
  assert.match(show(modalScope,value).detail,/Only the latest bounded window/);
});

for(const [label,change] of [
  ['malformed details',v=>v.full_progress.recorded_details.recorded_frames=1],
  ['wrong Full policy',v=>v.full_progress.policy_version='untrusted'],
  ['unavailable Full envelope',v=>v.full_progress.available=false],
  ['unstarted snapshot',v=>v.full_progress.status='not_started'],
])test(`actual Album Details does not admit ${label}`,async()=>{
  const {projectLocalAlbumRecordedPresentation:show}=await N.load('album-tops/listening-presentation.mjs');
  const value=modalResponse();change(value);assert.equal(show(modalScope,value).available,false);
});


for (const kind of ['absent','null','malformed','unknown','disabled']) test(`actual Top details presenter keeps ${kind} evidence unknown without throwing`,async()=>{
  const {albumTopStatusPresentation:present}=await N.load('album-tops/status-presentation.mjs');
  const source=F.detail({items:[F.row(11)]}),row=source.items[0];
  const unadmitted={recorded_details:{explanation:'UNADMITTED DETAIL'},metrics:{partial:{status:'processed_window',value:7}}};
  const input=kind==='absent'?undefined:kind==='null'?null:kind==='malformed'?unadmitted:
    {...unadmitted,protocol:'album-top-status-presentation-v1',policy_status:kind==='disabled'?'disabled':'admitted',
      status:kind==='disabled'?'ready':'unknown',top_ref:source.top_ref,top_revision:source.revision,album_ref:row.album_ref,target:5,predicates:{}};
  source.top_viewer_overlay.item_listening_presentation={[row.album_ref]:input};
  const value=present(source,row);
  assert.equal(value.admitted,false);assert.equal(value.flags.listened,null);assert.equal(value.flags.completed,null);
  assert.equal(value.counts.full,null);assert.equal(value.counts.partial,null);
  assert.equal(value.summary,'');
  assert.doesNotMatch(value.explanation,/partial stretches|UNADMITTED DETAIL/);
});
