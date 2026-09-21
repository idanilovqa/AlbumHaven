const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const root = path.resolve(__dirname, '../../..');
function load(overrides = {}) {
  const context = { state: { utility: { integrationDrafts: {lastfm:{}}, librarySettings: {
    loaded:true, settings:{}, draft:{main_library_roots:[{id:'own',path:'/approved/music',layout_mode:'artist'}],hoarding_library_roots:[{id:'hoarding_library_roots-1',path:''}],new_arrivals_roots:[{id:'new_arrivals_roots-1',path:''}],move_policy:{}},
    allowedActions:{'library.settings.manage':true,'library.filesystem.browse':true,'library.paths.read':true}
  }, lastfmScrobbles: { summary: null, loading: false, submitting: false } } }, escapeHtml: value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),
    cloneRuntimeJson: value => JSON.parse(JSON.stringify(value)), renderUtilityModalContent(){},
    formatLogHistoryTimestamp: value => value, getDetectedBrowserTimeZone:()=> 'America/Denver',getSupportedBrowserTimeZones:()=>[],
    showRepairAlert(){}, showToast(){}, console, ...overrides };
  context.window = context; vm.createContext(context);
  for (const file of ['button-component.js','runtime/library-settings.js','runtime/utility-list-builders.js','runtime/utility-renderers-and-actions.js'])
    vm.runInContext(fs.readFileSync(path.join(root,'music_app/static/js',file),'utf8'),context);
  context.renderUtilityModalContent = overrides.renderUtilityModalContent || (() => {});
  return context;
}

function loadLastfmActions(overrides = {}) {
  const context = load(overrides);
  vm.runInContext(fs.readFileSync(path.join(root,'music_app/static/js/runtime/utility-loaders-and-cover-lookup.js'),'utf8'),context);
  return context;
}

test('connected Scrobbling shows three separate Last.fm counts and an enabled shared Submit button',()=>{
 const c=load();c.state.utility.lastfmScrobbles.summary={scrobbled:17,lastfm_total:12000,pending:3,can_submit:true};
 const html=c.buildUtilityIntegrationDetail({key:'lastfm',connected:true,api_configured:true,username:'listener',listen_history_count:9,pending_scrobble_count:8,playback_statistics:{local_playcount:4,total_listening_seconds:3661}});
 assert.match(html,/Last\.FM/); assert.match(html,/Connected/);
 assert.match(html,/data-lastfm-scrobbled[^>]*>Scrobbled: 17</);
 assert.match(html,/data-lastfm-total[^>]*>LastFM Total: 12000</);
 assert.match(html,/data-lastfm-pending[^>]*>Pending: 3</);
 assert.match(html,/data-submit-lastfm-scrobbles="1"/);
 assert.doesNotMatch(html,/data-submit-lastfm-scrobbles="1"[^>]*disabled/);
 assert.match(html,/Local playcount/);assert.match(html,/>4</);assert.match(html,/1 hour 1 minute/);
 assert.doesNotMatch(html,/Queued:|data-lastfm-field="timezone"|Save timezone|Connected as|account connected/i);
});

test('LastFM Total distinguishes loading from provider unavailability',()=>{
 const c=load();c.state.utility.lastfmScrobbles.loading=true;
 let html=c.buildUtilityIntegrationDetail({key:'lastfm',connected:true,api_configured:true,listen_history_count:4,pending_scrobble_count:0});
 assert.match(html,/data-lastfm-total[^>]*>LastFM Total: Loading\.\.\.</);
 c.state.utility.lastfmScrobbles.loading=false;
 c.state.utility.lastfmScrobbles.summary={scrobbled:4,lastfm_total:null,pending:0,can_submit:true};
 html=c.buildUtilityIntegrationDetail({key:'lastfm',connected:true,api_configured:true});
 assert.match(html,/data-lastfm-total[^>]*>LastFM Total: Unavailable</);
});

test('disconnected Scrobbling hides Last.fm counts and Submit',()=>{
 const c=load();c.state.utility.lastfmScrobbles.summary={scrobbled:17,lastfm_total:12000,pending:3,can_submit:true};
 const html=c.buildUtilityIntegrationDetail({key:'lastfm',connected:false,api_configured:true});
 assert.doesNotMatch(html,/data-lastfm-(?:scrobbled|total|pending)|data-submit-lastfm-scrobbles/);
});

test('Submit is disabled when no pending scrobbles exist',()=>{
 const c=load();c.state.utility.lastfmScrobbles.summary={scrobbled:17,lastfm_total:12000,pending:0,can_submit:true};
 const html=c.buildUtilityIntegrationDetail({key:'lastfm',connected:true,api_configured:true});
 assert.match(html,/data-submit-lastfm-scrobbles="1"[^>]*disabled/);
 assert.match(html,/>\s*<span class="ui-button__content">Submit<\/span>/);
});

test('Submit shows disabled in-flight copy while scrobbles are being sent',()=>{
 const c=load();c.state.utility.lastfmScrobbles={summary:{scrobbled:17,lastfm_total:12000,pending:3,can_submit:true},loading:false,submitting:true};
 const html=c.buildUtilityIntegrationDetail({key:'lastfm',connected:true,api_configured:true});
 assert.match(html,/data-submit-lastfm-scrobbles="1"[^>]*disabled/);
 assert.match(html,/Submitting\.\.\./);
});

test('loading Integrations renders local data before the Last.fm provider summary resolves',async()=>{
 let resolveProvider;const requests=[];const c=loadLastfmActions({fetch:async(url)=>{
  requests.push(url);
  if(url==='/utilities/integrations')return {ok:true,json:async()=>({ok:true,integrations:[{key:'lastfm',connected:true,api_configured:true,username:'listener',user_timezone:'America/Denver'}]})};
  assert.equal(url,'/utilities/integrations/lastfm/scrobbles');
  return new Promise(resolve=>{resolveProvider=resolve;});
 }});
 await c.loadUtilityIntegrations(true);
 assert.deepEqual(requests,['/utilities/integrations','/utilities/integrations/lastfm/scrobbles']);
 assert.equal(c.state.utility.integrationsLoading,false);
 assert.equal(c.state.utility.lastfmScrobbles.loading,true);
 assert.match(c.buildUtilityIntegrationDetail(c.state.utility.integrations[0]),/LastFM Total: Loading\.\.\./);
 const providerLoad=c.state.utility.lastfmScrobbles.loadPromise;
 resolveProvider({ok:true,json:async()=>({ok:true,scrobbled:17,lastfm_total:12000,pending:3,can_submit:true})});
 await providerLoad;
 assert.equal(c.state.utility.lastfmScrobbles.summary.scrobbled,17);
});

test('an older Last.fm summary cannot repopulate after disconnect and reconnect',async()=>{
 let resolveOld,resolveNew,getCount=0;const c=loadLastfmActions({fetch:async()=>{
  getCount++;
  return new Promise(resolve=>{if(getCount===1)resolveOld=resolve;else resolveNew=resolve;});
 }});
 const oldLoad=c.loadLastfmScrobbleSummary({connected:true,listen_history_count:1,pending_scrobble_count:1});
 await c.loadLastfmScrobbleSummary({connected:false});
 const newLoad=c.loadLastfmScrobbleSummary({connected:true,listen_history_count:2,pending_scrobble_count:2});
 resolveNew({ok:true,json:async()=>({ok:true,scrobbled:22,lastfm_total:220,pending:0,can_submit:true})});
 await newLoad;
 resolveOld({ok:true,json:async()=>({ok:true,scrobbled:11,lastfm_total:110,pending:1,can_submit:true})});
 await oldLoad;
 assert.equal(getCount,2);
 assert.equal(JSON.stringify(c.state.utility.lastfmScrobbles.summary),JSON.stringify({scrobbled:22,lastfm_total:220,pending:0,can_submit:true}));
 assert.equal(c.state.utility.lastfmScrobbles.loading,false);
});

test('successful Submit refreshes all counts and shows the success notification',async()=>{
 const requests=[],toasts=[];const c=loadLastfmActions({
  fetch:async(url,options={})=>{requests.push([url,options.method||'GET']);if(options.method==='POST')return {ok:true,json:async()=>({ok:true,attempted:1,succeeded:1,failed:0,pending_before:1,pending_after:0})};return {ok:true,json:async()=>({ok:true,scrobbled:18,lastfm_total:12001,pending:0,can_submit:true})};},
  showToast:(...args)=>toasts.push(args),
 });
 c.state.utility.integrations=[{key:'lastfm',connected:true,api_configured:true}];
 c.state.utility.lastfmScrobbles.summary={scrobbled:17,lastfm_total:12000,pending:1,can_submit:true};
 await c.submitPendingLastfmScrobbles();
 assert.deepEqual(requests,[['/utilities/integrations/lastfm/scrobbles/submit','POST'],['/utilities/integrations/lastfm/scrobbles','GET']]);
 assert.equal(JSON.stringify(c.state.utility.lastfmScrobbles.summary),JSON.stringify({scrobbled:18,lastfm_total:12001,pending:0,can_submit:true}));
 assert.equal(c.state.utility.lastfmScrobbles.submitting,false);
 assert.deepEqual(toasts,[['Pending Last.fm scrobbles submitted.','success',2600]]);
});

test('Submit replaces an in-flight pre-Submit Last.fm summary refresh',async()=>{
 let resolveOld,getCount=0;const requests=[];const c=loadLastfmActions({fetch:async(url,options={})=>{
  requests.push([url,options.method||'GET']);
  if(options.method==='POST')return {ok:true,json:async()=>({ok:true,attempted:1,succeeded:1,failed:0,pending_before:1,pending_after:0})};
  getCount++;
  if(getCount===1)return new Promise(resolve=>{resolveOld=resolve;});
  return {ok:true,json:async()=>({ok:true,scrobbled:18,lastfm_total:12001,pending:0,can_submit:true})};
 }});
 const lastfm={key:'lastfm',connected:true,api_configured:true};
 c.state.utility.integrations=[lastfm];
 c.state.utility.lastfmScrobbles.summary={scrobbled:17,lastfm_total:12000,pending:1,can_submit:true};
 const oldLoad=c.loadLastfmScrobbleSummary(lastfm);
 await c.submitPendingLastfmScrobbles();
 resolveOld({ok:true,json:async()=>({ok:true,scrobbled:17,lastfm_total:12000,pending:1,can_submit:true})});
 await oldLoad;
 assert.equal(getCount,2);
 assert.deepEqual(requests,[
  ['/utilities/integrations/lastfm/scrobbles','GET'],
  ['/utilities/integrations/lastfm/scrobbles/submit','POST'],
  ['/utilities/integrations/lastfm/scrobbles','GET'],
 ]);
 assert.equal(JSON.stringify(c.state.utility.lastfmScrobbles.summary),JSON.stringify({scrobbled:18,lastfm_total:12001,pending:0,can_submit:true}));
});

test('failed Submit refreshes counts and uses the regular bottom-right Error alert',async()=>{
 const alerts=[];let renders=0;const c=loadLastfmActions({
  fetch:async(url,options={})=>options.method==='POST'
   ? {ok:false,json:async()=>({ok:false,error:'Last.fm is temporarily unavailable.',attempted:1,succeeded:0,failed:1,pending_before:1,pending_after:1})}
   : {ok:true,json:async()=>({ok:true,scrobbled:17,lastfm_total:12000,pending:1,can_submit:true})},
  renderUtilityModalContent:()=>{renders++;},showRepairAlert:(...args)=>alerts.push(args),
 });
 c.state.utility.integrations=[{key:'lastfm',connected:true,api_configured:true}];
 c.state.utility.lastfmScrobbles.summary={scrobbled:17,lastfm_total:12000,pending:1,can_submit:true};
 await c.submitPendingLastfmScrobbles();
 assert.equal(c.state.utility.lastfmScrobbles.summary.pending,1);
 assert.equal(c.state.utility.lastfmScrobbles.submitting,false);
 assert.equal(c.state.utility.logHistoryLoaded,false);
 assert.deepEqual(alerts,[['Last.fm is temporarily unavailable.','error',null]]);
 assert.ok(renders>=2);
});

test('failed Submit keeps its fresher complete counts and permission when refresh fails',async()=>{
 const alerts=[];const c=loadLastfmActions({
  fetch:async(_url,options={})=>options.method==='POST'
   ? {ok:false,json:async()=>({ok:false,error:'Last.fm is temporarily unavailable.',scrobbled:18,lastfm_total:12001,pending:2,attempted:1,succeeded:0,failed:1,pending_before:2,pending_after:2})}
   : {ok:false,json:async()=>({ok:false,error:'status unavailable'})},
  showRepairAlert:(...args)=>alerts.push(args),
 });
 c.state.utility.integrations=[{key:'lastfm',connected:true,api_configured:true}];
 c.state.utility.lastfmScrobbles.summary={scrobbled:17,lastfm_total:12000,pending:2,can_submit:true};
 await c.submitPendingLastfmScrobbles();
 assert.equal(JSON.stringify(c.state.utility.lastfmScrobbles.summary),JSON.stringify({scrobbled:18,lastfm_total:12001,pending:2,can_submit:true}));
 assert.deepEqual(alerts,[['Last.fm is temporarily unavailable.','error',null]]);
});

test('partial failed Submit keeps updated pending count actionable when refresh fails',async()=>{
 const alerts=[];const c=loadLastfmActions({
  fetch:async(_url,options={})=>options.method==='POST'
   ? {ok:false,json:async()=>({ok:false,error:'One scrobble failed.',attempted:2,succeeded:1,failed:1,pending_before:2,pending_after:1})}
   : {ok:false,json:async()=>({ok:false,error:'status unavailable'})},
  showRepairAlert:(...args)=>alerts.push(args),
 });
 const lastfm={key:'lastfm',connected:true,api_configured:true};
 c.state.utility.integrations=[lastfm];
 c.state.utility.lastfmScrobbles.summary={scrobbled:17,lastfm_total:12000,pending:2,can_submit:true};
 await c.submitPendingLastfmScrobbles();
 assert.equal(JSON.stringify(c.state.utility.lastfmScrobbles.summary),JSON.stringify({scrobbled:17,lastfm_total:12000,pending:1,can_submit:true}));
 assert.doesNotMatch(c.buildUtilityIntegrationDetail(lastfm),/data-submit-lastfm-scrobbles="1"[^>]*disabled/);
 assert.deepEqual(alerts,[['One scrobble failed.','error',null]]);
});

test('successful Submit keeps its fresher complete counts and permission when refresh fails',async()=>{
 const toasts=[];const c=loadLastfmActions({
  fetch:async(_url,options={})=>options.method==='POST'
   ? {ok:true,json:async()=>({ok:true,scrobbled:18,lastfm_total:12001,pending:0,attempted:1,succeeded:1,failed:0,pending_before:1,pending_after:0})}
   : {ok:false,json:async()=>({ok:false,error:'status unavailable'})},
  showToast:(...args)=>toasts.push(args),
 });
 c.state.utility.integrations=[{key:'lastfm',connected:true,api_configured:true}];
 c.state.utility.lastfmScrobbles.summary={scrobbled:17,lastfm_total:12000,pending:1,can_submit:true};
 await c.submitPendingLastfmScrobbles();
 assert.equal(JSON.stringify(c.state.utility.lastfmScrobbles.summary),JSON.stringify({scrobbled:18,lastfm_total:12001,pending:0,can_submit:true}));
 assert.deepEqual(toasts,[['Pending Last.fm scrobbles submitted.','success',2600]]);
});

test('reopening loaded Integrations explicitly retries the Last.fm summary without erasing existing counts',async()=>{
 let resolveRefresh;const c=loadLastfmActions({fetch:async()=>new Promise(resolve=>{resolveRefresh=resolve;})});
 c.state.utility.integrationsLoaded=true;
 c.state.utility.integrations=[{key:'lastfm',connected:true,api_configured:true}];
 c.state.utility.lastfmScrobbles.summary={scrobbled:17,lastfm_total:12000,pending:1,can_submit:true};
 await c.loadUtilityIntegrations();
 assert.equal(c.state.utility.lastfmScrobbles.loading,true);
 const refresh=c.state.utility.lastfmScrobbles.loadPromise;
 resolveRefresh({ok:false,json:async()=>({ok:false,error:'status unavailable'})});
 await refresh;
 assert.equal(JSON.stringify(c.state.utility.lastfmScrobbles.summary),JSON.stringify({scrobbled:17,lastfm_total:12000,pending:1,can_submit:true}));
});

test('missing measured statistics are unavailable rather than invented zero or sample values',()=>{
 const html=load().buildUtilityIntegrationDetail({key:'lastfm',connected:false,api_configured:false});
 assert.match(html,/Playback statistics/);assert.match(html,/Unavailable/);assert.doesNotMatch(html,/1,248|86 hours/);
});

test('playlist integration exposes only one disabled Import control',()=>{
 const html=load().buildUtilityIntegrationDetail({key:'local_playlist_import',target_options:[{title:'Album Top'}]});
 assert.equal((html.match(/<button\b/g)||[]).length,1);assert.match(html,/<button[^>]*disabled[^>]*>[\s\S]*Import/);
 assert.doesNotMatch(html,/data-analyze-local-playlist|textarea|target_recommendation|Album Top/);
});

test('Foobar uses shared format trigger and truthful unavailable import with left guide action',()=>{
 const html=load().buildUtilityIntegrationDetail({key:'foobar',help_route:'/utilities/integrations/foobar/help'});
 assert.match(html,/SQLite database/);assert.match(html,/data-foobar-format-trigger/);assert.match(html,/Playback Statistics XML/);
 assert.match(html,/data-foobar-import[^>]*disabled|disabled[^>]*data-foobar-import/);
 assert.match(html,/Read setup instructions/);assert.match(html,/unavailable in this build/i);assert.doesNotMatch(html,/<select|<iframe/);
});

test('root path rows keep browse and destructive remove inside one accessible input shell',()=>{
 const html=load().buildLibrarySettingsRootSection('main_library_roots','Main Library','');
 assert.match(html,/library-settings-path-control/);assert.match(html,/aria-label="Main Library path 1"/);
 assert.match(html,/data-browse-library-root="main_library_roots"/);assert.match(html,/aria-label="Choose Main Library folder 1"/);
 assert.match(html,/action-button--destructive/);assert.doesNotMatch(html,/C:\\Music|>Browse<|>Remove</);
});

test('picker cancellation leaves the draft and persistence untouched',async()=>{
 let fetched=[];const c=load({fetch:async(url,options)=>{fetched.push([url,options]);return {ok:true,json:async()=>({ok:true,path:'',parent_path:null,entries:[{name:'Music',path:'/approved/music'}]})};},showAppFormDialog:async()=>null});
 const before=JSON.stringify(c.state.utility.librarySettings.draft);
 assert.equal(await c.browseLibraryRootDraft('main_library_roots',0),false);
 assert.equal(JSON.stringify(c.state.utility.librarySettings.draft),before);
 assert.equal(fetched.length,1);assert.match(fetched[0][0],/^\/library-settings\/browse/);assert.notEqual(fetched[0][1]?.method,'POST');
});

for (const failed of [false, true]) test(`picker never submits the previous folder during ${failed ? 'failed' : 'pending'} child navigation`, async () => {
  let finishChild, observations;
  const response = path => ({ ok: true, json: async () => ({ ok: true, path, entries: [] }) });
  const c = load({ fetch: async url => {
    const target = new URL(url, 'https://fixture.invalid').searchParams.get('path');
    return target.endsWith('/child') ? new Promise(resolve => { finishChild = resolve; }) : response(target);
  } });
  const before = JSON.stringify(c.state.utility.librarySettings.draft);
  c.showAppFormDialog = async options => {
    let click; const enabled = [];
    const content = { innerHTML: '', addEventListener(_name, callback) { click = callback; }, removeEventListener() {}, setAttribute() {} };
    options.onMount(content, { setSubmitEnabled(value) { enabled.push(value); } });
    const navigate = path => click({ preventDefault() {}, target: { closest: () => ({ getAttribute: () => path }) } });
    await navigate('/approved/music');
    const child = navigate('/approved/music/child');
    const submit = () => { try { return options.onSubmit(); } catch (error) { return { error: error.message }; } };
    observations = { initialEnabled: options.submitEnabled, during: submit(), disabled: enabled.at(-1) };
    finishChild(failed ? { ok: false, json: async () => ({ ok: false, error: 'Directory unavailable' }) } : response('/approved/music/child'));
    await child;
    observations.after = submit(); observations.afterEnabled = enabled.at(-1);
    options.onClose(); return null;
  };
  await c.browseLibraryRootDraft('main_library_roots', 0);
  assert.equal(observations.initialEnabled, false);
  assert.match(observations.during.error || '', /loading|wait|folder first/i);
  assert.equal(observations.disabled, false);
  if (failed) { assert.match(observations.after.error || '', /folder first/i); assert.equal(observations.afterEnabled, false); }
  else { assert.equal(observations.after, '/approved/music/child'); assert.equal(observations.afterEnabled, true); }
  assert.equal(JSON.stringify(c.state.utility.librarySettings.draft), before);
});

test('absent picker grant fails closed before a filesystem request',async()=>{
 const c=load({fetch:()=>assert.fail('unauthorized filesystem request')});c.state.utility.librarySettings.allowedActions={};
 assert.equal(await c.browseLibraryRootDraft('main_library_roots',0),false);
});


test('Foobar guide fetches approved live copy into the wide reading owner and escapes content',async()=>{
 let dialog;const c=load({fetch:async url=>{assert.equal(url,'/utilities/integrations/foobar/help');return {ok:true,json:async()=>({ok:true,sections:[{title:'Portable profiles',body_markdown:'Keep backups. <script>bad</script>'}]})};},showAppFormDialog:async options=>{dialog=options;return null;}});
 await c.openUtilityFoobarGuide();assert.equal(dialog.mode,'reading');assert.match(dialog.contentHtml,/Portable profiles/);
 assert.match(dialog.contentHtml,/&lt;script>/);assert.doesNotMatch(dialog.contentHtml,/<iframe|<script>/);
});


test('late guide and folder responses cannot reopen a different Settings section',async()=>{
 for (const kind of ['guide','folder']) {
  let finish, dialogs=0;const c=load({fetch:()=>new Promise(resolve=>{finish=resolve;}),showAppFormDialog:async()=>{dialogs++;return null;}});
  c.state.utility.activeTab='integrations';c.state.utility.selectedIntegrationKey=kind==='guide'?'foobar':'library';
  const pending=kind==='guide'?c.openUtilityFoobarGuide():c.browseLibraryRootDraft('main_library_roots',0);
  c.state.utility.activeTab='rules';
  finish({ok:true,json:async()=>({ok:true,sections:[],entries:[],path:''})});await pending;assert.equal(dialogs,0);
 }
});


test('remove then add preserves unique root IDs for saved move policy',()=>{
 const c=load();c.state.utility.librarySettings.draft.main_library_roots=[{id:'main_library_roots-2',path:'/approved/second'}];
 c.addLibraryRootDraftEntry('main_library_roots');const roots=c.state.utility.librarySettings.draft.main_library_roots;
 assert.notEqual(roots[0].id,roots[1].id);
});


test('integration navigation uses the four approved section names',()=>{
 const c=load();c.state.utility.integrations=[{key:'lastfm',title:'Last.FM'},{key:'foobar',title:'Foobar2000'},{key:'local_playlist_import',title:'Import Local Playlist'}];
 assert.deepEqual(Array.from(c.buildUtilityIntegrationItems(),item=>item.title),['Library','Scrobbling','Foobar2000','Import Local Playlist']);
});

test('guide markdown renders safe paragraphs lists and code instead of raw syntax',()=>{
 const c=load();const html=c.formatUtilityGuideMarkdown('Read `portable_mode_enabled`.\n\n1. Open preferences.\n2. Copy the preset.\n\n```\nheader\nbody\n```\n\n<script>bad</script>');
 assert.match(html,/<p>Read <code>portable_mode_enabled<\/code>\.<\/p>/);assert.match(html,/<ol><li>Open preferences\.<\/li><li>Copy the preset\.<\/li><\/ol>/);
 assert.match(html,/<pre><code>header\nbody<\/code><\/pre>/);assert.doesNotMatch(html,/<script>|```/);
});

test('picker selects only server-returned paths and changes draft only after Choose',async()=>{
 const requests=[];const c=load({fetch:async url=>{requests.push(url);return {ok:true,json:async()=>({ok:true,path:requests.length===1?'':'/approved/album',parent_path:null,entries:[{name:'Album',path:'/approved/album'}]})};}});
 const before=c.state.utility.librarySettings.draft.main_library_roots[0].path;
 c.showAppFormDialog=async options=>{
  const listeners={};const content={innerHTML:'',addEventListener:(name,fn)=>{listeners[name]=fn;},removeEventListener:(name)=>{delete listeners[name];}};
  options.onMount(content);await listeners.click({preventDefault(){},target:{closest:()=>({getAttribute:()=>'/approved/album'})}});
  assert.equal(c.state.utility.librarySettings.draft.main_library_roots[0].path,before);
  const result=options.onSubmit();options.onClose();return result;
 };
 assert.equal(await c.browseLibraryRootDraft('main_library_roots',0),true);
 assert.equal(c.state.utility.librarySettings.draft.main_library_roots[0].path,'/approved/album');
 assert.equal(requests.length,2);assert.match(requests[1],/path=%2Fapproved%2Falbum/);
});


test('integration selection retains mounted tree buttons and scroll instead of rebuilding',()=>{
 const c=load();const keys=['library','lastfm','foobar','local_playlist_import'];
 const nodes=keys.map(key=>({getAttribute:()=>key,remove:()=>assert.fail('existing row removed')}));
 nodes.forEach((node,index)=>Object.defineProperty(node,'nextElementSibling',{get:()=>nodes[index+1]||null}));
 const list={dataset:{utilityNavigationOwner:'integrations'},scrollTop:123,querySelectorAll:()=>nodes,get firstElementChild(){return nodes[0];},insertBefore:()=>assert.fail('existing row moved'),set innerHTML(value){assert.fail('tree rebuilt');}};
 c.getUtilityModalElements=()=>({overlay:{},list,detail:{innerHTML:''},count:{}});
 c.window.NavigationTree={setItemSelected:(node,selected)=>{node.selected=selected;}};
 c.state.utility.integrations=keys.slice(1).map(key=>({key,title:key}));c.state.utility.selectedIntegrationKey='lastfm';
 c.buildUtilityIntegrationDetail=()=>'<div>Detail</div>';
 c.renderUtilityIntegrations();assert.equal(nodes[1].selected,true);
 c.state.utility.selectedIntegrationKey='foobar';c.renderUtilityIntegrations();
 assert.equal(nodes[1].selected,false);assert.equal(nodes[2].selected,true);assert.equal(list.scrollTop,123);
});

test('integration tree rows use the registered NavigationTree component',()=>{
 const c=load();let options;c.window.NavigationTree={renderItem:value=>{options=value;return 'shared-tree';}};
 assert.equal(c.buildUtilityIntegrationListItem({key:'foobar',title:'Foobar2000'},true),'shared-tree');
 assert.equal(options.label,'Foobar2000');assert.equal(options.attributes['data-utility-integration-key'],'foobar');
});


test('clicking the selected integration does not reload or replace its detail',async()=>{
 const c=load({document:{querySelectorAll:()=>[]}});c.state.coverLookup={};c.state.utility.selectedIntegrationKey='foobar';
 vm.runInContext(fs.readFileSync(path.join(root,'music_app/static/js/runtime/bootstrap-utility-event-handlers.js'),'utf8'),c);
 let selections=0,renders=0;c.handleLibrarySettingsIntegrationSelection=()=>{selections++;return false;};c.renderUtilityModalContent=()=>{renders++;};
 await c.handleUtilityBootstrapClick({preventDefault(){},target:{closest:selector=>selector==='[data-utility-integration-key]'?{getAttribute:()=> 'foobar'}:null}});
 assert.equal(selections,0);assert.equal(renders,0);
});

test('clicking Submit dispatches the pending Last.fm scrobble action',async()=>{
 const c=load({document:{querySelectorAll:()=>[]}});c.state.coverLookup={};
 vm.runInContext(fs.readFileSync(path.join(root,'music_app/static/js/runtime/bootstrap-utility-event-handlers.js'),'utf8'),c);
 let submissions=0,prevented=false;c.submitPendingLastfmScrobbles=async()=>{submissions++;};
 await c.handleUtilityBootstrapClick({preventDefault(){prevented=true;},target:{closest:selector=>selector==='[data-submit-lastfm-scrobbles="1"]'?{}:null}});
 assert.equal(prevented,true);assert.equal(submissions,1);
});


for (const stage of ['initial', 'navigation']) for (const transition of ['section', 'tab', 'settings-owner', 'utility-owner']) {
  test(`late picker ${stage} error stays with its ${transition} owner`, async () => {
    const toasts = []; let rejectRead;
    const c = load({ showToast: message => toasts.push(message) });
    c.state.utility.activeTab = 'integrations'; c.state.utility.selectedIntegrationKey = 'library';
    const leave = () => {
      if (transition === 'section') c.state.utility.selectedIntegrationKey = 'foobar';
      if (transition === 'tab') c.state.utility.activeTab = 'rules';
      if (transition === 'settings-owner') c.state.utility.librarySettings = { ...c.state.utility.librarySettings };
      if (transition === 'utility-owner') c.state.utility = { ...c.state.utility };
    };
    c.fetch = url => {
      if (stage === 'navigation' && url.endsWith('path=')) return Promise.resolve({ ok: true, json: async () => ({ok:true,path:'',entries:[]}) });
      return new Promise((_resolve, reject) => { rejectRead = reject; });
    };
    c.showAppFormDialog = async options => {
      assert.equal(stage, 'navigation');
      let click;
      const content = { addEventListener(_event, callback) {click=callback;}, removeEventListener() {}, setAttribute() {} };
      options.onMount(content, {setSubmitEnabled() {}});
      const navigation = click({preventDefault() {}, target:{closest:()=>({getAttribute:()=>'/approved/child'})}});
      leave(); rejectRead(new Error('Directory unavailable'));
      await navigation; options.onClose(); return null;
    };
    const pending = c.browseLibraryRootDraft('main_library_roots', 0);
    if (stage === 'initial') { leave(); rejectRead(new Error('Directory unavailable')); }
    assert.equal(await pending, false);
    assert.deepEqual(toasts, []);
  });
}
