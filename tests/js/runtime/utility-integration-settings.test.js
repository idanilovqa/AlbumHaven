const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const root = path.resolve(__dirname, '../../..');
function load(overrides = {}) {
  const context = { state: { utility: { integrationDrafts: {lastfm:{}}, librarySettings: {
    loaded:true, settings:{}, draft:{main_library_roots:[{id:'own',path:'/approved/music',layout_mode:'artist'}],hoarding_library_roots:[],new_arrivals_roots:[],move_policy:{}},
    allowedActions:{'library.settings.manage':true,'library.filesystem.browse':true,'library.paths.read':true}
  } } }, escapeHtml: value => String(value ?? '').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),
    cloneRuntimeJson: value => JSON.parse(JSON.stringify(value)), renderUtilityModalContent(){},
    formatLogHistoryTimestamp: value => value, getDetectedBrowserTimeZone:()=> 'America/Denver',getSupportedBrowserTimeZones:()=>[],
    showToast(){}, console, ...overrides };
  context.window = context; vm.createContext(context);
  for (const file of ['button-component.js','runtime/library-settings.js','runtime/utility-list-builders.js','runtime/utility-renderers-and-actions.js'])
    vm.runInContext(fs.readFileSync(path.join(root,'music_app/static/js',file),'utf8'),context);
  context.renderUtilityModalContent = overrides.renderUtilityModalContent || (() => {});
  return context;
}

test('Scrobbling shows real measured statistics and separate connected status without timezone',()=>{
 const c=load();const html=c.buildUtilityIntegrationDetail({key:'lastfm',connected:true,api_configured:true,username:'listener',listen_history_count:17,pending_scrobble_count:3,playback_statistics:{local_playcount:4,total_listening_seconds:3661}});
 assert.match(html,/Last\.FM/); assert.match(html,/Connected/);assert.match(html,/Scrobbled: 17/);assert.match(html,/Queued: 3/);
 assert.match(html,/Local playcount/);assert.match(html,/>4</);assert.match(html,/1 hour 1 minute/);
 assert.doesNotMatch(html,/data-lastfm-field="timezone"|Save timezone|Connected as|account connected/i);
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
