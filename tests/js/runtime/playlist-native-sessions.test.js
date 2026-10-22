const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {createNativeHomeRuntime,readRepo}=require('./native-home-harness.cjs');
const {withPlaylistDomPlatform:withDomPlatform}=require('./playlist-dom-platform.cjs');
const {installNativeSearch}=require('./native-search-harness.cjs');
const settle=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
function fixture(){
 const env=withDomPlatform(createNativeHomeRuntime()),{document,context}=env,frames=new Map();let frame=0;
 for(const file of ['compact-data-table.js','gallery-main-components.js','album-track-table.js','in-page-tabs.js'])vm.runInContext(readRepo(`music_app/static/js/runtime/${file}`),context);
 const search=installNativeSearch(env),buttons=context.ButtonComponent,host=document.createElement('div');document.body.append(host);
 context.Element.prototype.focus=function(){document.activeElement=this;this.dispatchEvent(new context.Event('focusin'));};
 const win={innerWidth:1200,innerHeight:900,getComputedStyle:()=>({display:'block',columnGap:'8'}),requestAnimationFrame(callback){frames.set(++frame,callback);return frame;},cancelAnimationFrame:id=>frames.delete(id),addEventListener(){},removeEventListener(){},MutationObserver:class{observe(){}disconnect(){}},ResizeObserver:class{observe(){}disconnect(){}}};document.defaultView=win;env.installWindow(win);document.documentElement.clientWidth=1200;
 const choices=[],closed=[],forms=[];
 const runtime={escapeHtml:context.escapeHtml,buttonHtml:buttons.renderButton,actionHtml:buttons.renderActionButton,iconHtml:buttons.renderIconSvg,alertHtml:env.owner('buildOnPageAlertHtml'),searchHtml:search.render,tableHtml:env.owner('buildCompactDataTable'),artboxHtml:env.owner('buildAlbumArtboxHtml'),albumTrackRow:(row,index)=>env.owner('buildAlbumTrackTableRow')({...row,duration:row.duration_display},index,{readOnly:true}),tabsHtml:env.owner('buildInPageTabsHtml'),mountTabs:env.owner('mountInPageTabs'),detailHeaderHtml:({title})=>`<h2>${context.escapeHtml(title)}</h2>`,openChoice(trigger,config){const menu={trigger,config,closed:false};choices.push(menu);return {isOpen:true,close(options){menu.closed=true;closed.push(options);}};},openForm(options){const body=document.createElement('div');document.body.append(body);forms.push({options,body});options.onMount(body);return {updatePresentation(){},setDismissDisabled(){},async close(_node,value){if(!value?.force&&options.beforeDismiss&&await options.beforeDismiss()!==true)return false;options.onClose(body,value);body.remove();return true;}};}};
 const flush=()=>{for(const [id,callback]of [...frames]){frames.delete(id);callback();}};
 return {...env,host,runtime,choices,closed,forms,flush,frames};
}
function store(initial){let state=initial;const listeners=new Set();return {getSnapshot:()=>state,subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},getLifecycleVersion:()=>0,replace(next){state=next;for(const listener of [...listeners])listener();},edit(patch){this.replace({...state,...patch});},review(key){this.replace({...state,reviewKey:key});},toggle(){},selectVisible(){},setQuery(){},setFilters(){},canSave:()=>false,canReconcile:()=>false,canRetryOriginal:()=>false,available:()=>true,remove(key){this.replace({...state,entries:state.entries.filter(row=>row.row_key!==key)});},reorder:()=>false};}
const source={kind:'playlist',ref:'source',revision:'r1',allowed_actions:{can_read:true,can_use_for_playlist:true}};
const row=key=>({row_key:key,entry_ref:`entry-${key}`,canonical_track_ref:null,source_readable:true,title:`Track ${key}`,artist:'Artist',album_title:'Album',duration_seconds:60,track_number:1,disc_number:1,metadata_state:'current',availability:'missing',artwork_url:null,allowed_actions:{can_read:true,can_select:true},parent_album:{state:'unknown',allowed_actions:{can_read:false,can_view_details:false}}});
function editorState(entries=[row('a')]){return {scopeKey:'scope',draftToken:'draft',mode:'missing',source,canCreate:true,canCreateAlbumTop:false,title:'Missing',description:'',query:'',tab:'all',entries,retained_parent_albums:[],selectedKeys:[],pinnedEntries:[],sourceResource:{status:'ready',data:{scopeKey:'scope',mode:'missing',source,allowed_actions:source.allowed_actions,entries_complete:true,entries}},mutation:{status:'idle',request_key:null},filters:{availability:'all'},reviewKey:null};}

test('sharing keeps keyed member buttons and open visibility choice through unchanged and reordered updates',async()=>{
 const {mountSharingFields}=await import('../../../music_app/static/js/playlists/native-sharing.mjs'),env=fixture(),calls=[],people=['a','b'].map(key=>({account_ref:key,display_name:key,can_edit:true,selected:false}));let value={visibility:'private',can_manage:true,people};const owner=mountSharingFields(env.host,env.runtime,{value,busy:false,onEditor:change=>calls.push(change)}),a=env.host.querySelector('[data-sharing-account="a"] button'),visibility=env.host.querySelector('.ui-choice button');a.focus();env.click(visibility);const menu=env.choices.at(-1);
 owner.update({value:{...value,people:people.map(person=>({...person}))},busy:false,onEditor:change=>calls.push(change)});assert.equal(env.host.querySelector('[data-sharing-account="a"] button'),a);assert.equal(menu.closed,false);assert.equal(env.document.activeElement,a);
 value={...value,people:[people[1],people[0]]};owner.update({value,busy:false,onEditor:change=>calls.push(change)});assert.equal(env.host.querySelector('[data-sharing-account="a"] button'),a);assert.equal(menu.closed,false);assert.equal(env.document.activeElement,a);env.click(a);assert.deepEqual(calls,[{account_ref:'a',selected:true}]);owner.dispose();env.click(a);assert.equal(calls.length,1);
});

test('sharing request role retains actual native choice and focused trigger on unrelated updates and role selection',async()=>{
 const {mountSharePlaylist}=await import('../../../music_app/static/js/playlists/native-sharing.mjs'),env=fixture(),detail={playlist_id:'p',revision:'r1',title:'P',description:'',track_rows:[]},state={scopeKey:'scope',selectedPlaylistId:'p',resource:{status:'ready',data:{detail}},mutation:{status:'idle'},drafts:{}},controller=store(state),writes=[];
 controller.readSharing=async()=>({status:'ready',data:{revision:'r1',can_manage:true,visibility:'private',people:[],pending_requests:[{request_ref:'req',display_name:'A'}]}});controller.mutate=(action,value)=>writes.push({action,value});let props={controller,state};const owner=mountSharePlaylist(env.host,env.runtime,props);await settle();const body=env.forms[0].body,trigger=body.querySelector('[data-sharing-request="req"] .ui-choice button');assert.ok(trigger);trigger.focus();env.click(trigger);const menu=env.choices.at(-1);owner.update({...props});assert.equal(body.querySelector('[data-sharing-request="req"] .ui-choice button'),trigger);assert.equal(menu.closed,false);assert.equal(env.document.activeElement,trigger);menu.config.onSelect('editor');assert.equal(body.querySelector('[data-sharing-request="req"] .ui-choice button'),trigger);assert.equal(env.document.activeElement,trigger);env.click(body.querySelectorAll('[data-sharing-request="req"] button').find(button=>button.textContent==='Apply'));assert.equal(writes[0].action,'decideEditRequest');owner.dispose();
});

test('creation review close restores its original trigger but leaves a valid alternate focus alone',async()=>{
 const {mountCreationForm}=await import('../../../music_app/static/js/playlists/native-creation-form.mjs'),env=fixture(),controller=store(editorState());let owner;const props=()=>({controller,state:controller.getSnapshot()});owner=mountCreationForm(env.host,env.runtime,props());const unsubscribe=controller.subscribe(()=>owner.update(props()));env.click(env.host.querySelector('[data-creation-review]'));let close=env.host.querySelector('.playlists__selection-header button');assert.ok(close);close.focus();env.click(close);assert.equal(env.document.activeElement,env.host.querySelector('[data-creation-review]'));
 env.click(env.host.querySelector('[data-creation-review]'));const input=env.host.querySelector('input[aria-label="Playlist name"]');input.focus();controller.review(null);assert.equal(env.document.activeElement,input);unsubscribe();owner.dispose();
});

test('removing final draft row returns focus to Filters and blocking source/save failures remain alerts',async()=>{
 const {mountMissingPlaylistDraftPage}=await import('../../../music_app/static/js/playlists/native-draft.mjs'),env=fixture(),controller=store(editorState());let owner;const props=()=>({controller,state:controller.getSnapshot(),onClose(){}});owner=mountMissingPlaylistDraftPage(env.host,env.runtime,props());const unsubscribe=controller.subscribe(()=>owner.update(props()));const remove=env.host.querySelector('[data-draft-remove]');remove.focus();env.click(remove);assert.equal(env.document.activeElement,env.host.querySelector('[data-playlists-draft-action="filters"]'));
 for(const status of ['error','conflict','incomplete','refresh_required']){controller.replace({...controller.getSnapshot(),sourceResource:{status,data:null}});assert.ok(env.host.querySelector('[role="alert"]'));}
 controller.replace({...editorState([]),mutation:{status:'denied',request_key:null}});assert.ok(env.host.querySelector('[role="alert"]'));unsubscribe();owner.dispose();
});

test('draft page uses shared measured header, keeps Close last and moves focus before narrow concealment',async()=>{
 const {mountMissingPlaylistDraftPage}=await import('../../../music_app/static/js/playlists/native-draft.mjs'),env=fixture(),controller=store(editorState([])),props={controller,state:controller.getSnapshot(),onClose(){}},owner=mountMissingPlaylistDraftPage(env.host,env.runtime,props),header=env.host.querySelector('[data-shared-header]'),filters=header.querySelector('[data-playlists-draft-action="filters"]'),tools=header.querySelector('[data-header-tools]');assert.ok(header);assert.equal(header.querySelector('.home-header__final-action [data-playlists-draft-action]').dataset.playlistsDraftAction,'close');assert.match(header.querySelector('[data-playlists-draft-action="top"]').getAttribute('title'),/unavailable for these source albums/);
 const geometry=width=>{for(const node of [header,...header.querySelectorAll('*')]){node.scrollWidth=0;node.scrollHeight=0;node.offsetHeight=0;node.clientHeight=0;env.setRect(node,{width:0,height:0});}env.setRect(header,{width,height:40});env.setRect(header.querySelector('.home-header__identity'),{width:100,height:20});for(const slot of header.querySelectorAll('.home-header__primary-actions span, .home-header__final-action span'))env.setRect(slot,{width:80,height:34});for(const button of header.querySelectorAll('button'))env.setRect(button,{width:80,height:34});env.setRect(header.querySelector('.home-header__tools'),{width:34,height:34});owner.update(props);env.flush();};
 geometry(1000);filters.focus();let concealed;tools.addEventListener('focusin',()=>{concealed=Boolean(filters.closest('[inert]'));});geometry(150);assert.equal(header.getAttribute('data-header-compact'),'true');assert.equal(env.document.activeElement,tools);assert.equal(concealed,false);env.click(tools);assert.equal(header.getAttribute('data-header-open'),'true');tools.dispatchEvent(new env.context.Event('keydown',{key:'Escape'}));assert.equal(header.getAttribute('data-header-open'),'false');geometry(1000);assert.equal(env.host.querySelector('[data-playlists-draft-action="filters"]'),filters);owner.dispose();
});

test('selected-track action explains unsupported originals and missing providers without enabling writes',async()=>{
 const {mountPlaylistActionSession}=await import('../../../music_app/static/js/playlists/native-selection-actions.mjs');
 for(const unresolved of [true,false]){const env=fixture(),instance={},snapshot={scopeKey:'scope',instance,revision:'r1',rows:[{rowKey:'a',readable:true,selectable:true}]},sourceAdapter={snapshot:()=>snapshot,resolveRows:()=>[{rowKey:'a',entry_ref:'entry-a',...(unresolved?{}:{track_ref:'track-a'})}],subscribe:()=>()=>{}},lifetime={isCurrent:()=>true},providers={readPlaylistDestinations:async()=>({status:'ready',data:{scopeKey:'scope',destinations:[{playlist_id:'p',title:'P',revision:'r1',allowed_actions:{can_add:true}}],allowed_actions:{can_create:false}}})};const owner=mountPlaylistActionSession(env.host,{runtime:env.runtime,packet:{scopeKey:'scope',origin:{tableKey:'tracks',target:'selection'},row_keys:['a']},sourceAdapter,lifetime,providers});await settle();const body=env.forms[0].body;assert.match(body.textContent,unresolved?/Create can retain their source entries/:/Adding these tracks is not available from this provider/);assert.match(body.textContent,/Creating a playlist from these tracks is not available from this source/);assert.equal(body.querySelectorAll('button').find(button=>button.textContent==='Add to playlist').disabled,true);owner.dispose();}
});

test('sharing stale revision is an alert and cannot dispatch editor writes',async()=>{
 const {mountSharePlaylist}=await import('../../../music_app/static/js/playlists/native-sharing.mjs'),env=fixture(),detail={playlist_id:'p',revision:'new',title:'P',description:'',track_rows:[]},state={scopeKey:'scope',selectedPlaylistId:'p',resource:{status:'ready',data:{detail}},mutation:{status:'idle'},drafts:{}},controller=store(state);let writes=0;controller.mutate=()=>writes++;controller.readSharing=async()=>({status:'ready',data:{revision:'old',can_manage:true,visibility:'private',people:[{account_ref:'a',display_name:'A',can_edit:true}],pending_requests:[]}});const owner=mountSharePlaylist(env.host,env.runtime,{controller,state});await settle();const body=env.forms[0].body,alert=body.querySelector('[role="alert"]');assert.match(alert.textContent,/playlist changed/);env.click(body.querySelector('[data-sharing-account="a"] button'));assert.equal(writes,0);owner.dispose();
});

test('selected-track write denial, conflict and unconfirmed error are actual alerts',async()=>{
 const {mountPlaylistActionSession}=await import('../../../music_app/static/js/playlists/native-selection-actions.mjs');for(const status of ['denied','conflict','error']){const env=fixture(),instance={},snapshot={scopeKey:'scope',instance,revision:'r1',rows:[{rowKey:'a',readable:true,selectable:true}]},sourceAdapter={snapshot:()=>snapshot,resolveRows:()=>[{rowKey:'a',track_ref:'track-a'}],subscribe:()=>()=>{}},lifetime={isCurrent:()=>true};let writes=0;const providers={readPlaylistDestinations:async()=>({status:'ready',data:{scopeKey:'scope',destinations:[{playlist_id:'p',title:'P',revision:'r1',allowed_actions:{can_add:true}}],allowed_actions:{can_create:false}}}),addTracks:async()=>{writes++;return {status};}};const owner=mountPlaylistActionSession(env.host,{runtime:env.runtime,packet:{scopeKey:'scope',origin:{tableKey:'tracks',target:'selection'},row_keys:['a']},sourceAdapter,lifetime,providers});await settle();const body=env.forms[0].body;env.click(body.querySelector('.ui-choice button'));env.choices.at(-1).config.onSelect('p');body.querySelector('form[aria-label="Add selected tracks to playlist"]').dispatchEvent(new env.context.Event('submit',{bubbles:true,cancelable:true}));await settle();assert.equal(writes,1);assert.ok(body.querySelector('[role="alert"]'));assert.equal(body.querySelectorAll('button').find(button=>button.textContent==='Add to playlist').disabled,true);owner.dispose();}
});

// The production helper is evaluated unchanged. Only completion of the mobile
// history boundary is deferred so late native cleanup can be observed directly.
function actualDialogFixture({delayed=false,nullOpen=false}={}){
 const env=fixture(),{document,context}=env,modal=document.createElement('div');modal.id='app-form-modal';modal.hidden=true;const panel=document.createElement('div');panel.className='confirm-modal-dialog';modal.append(panel);
 for(const name of ['title','content','error','close']){const node=document.createElement(name==='close'?'button':'div');node.id=`app-form-${name}`;panel.append(node);}const footer=document.createElement('div');footer.className='confirm-modal-actions';panel.append(footer);for(const name of ['cancel','submit']){const node=document.createElement('button');node.id=`app-form-${name}`;footer.append(node);}document.body.append(modal);
 let resolve;const navigation=new Promise(done=>{resolve=done;});if(delayed){context.presentMobileAppFormPage=()=>{};context.retireMobileAppFormPage=()=>navigation;}
 vm.runInContext(readRepo('music_app/static/js/runtime/browser-dialog-helpers.js'),context);const open=env.owner('openReactFormDialog');env.runtime.openForm=nullOpen?()=>null:options=>open(options);
 return {...env,modal,async settleNative(){resolve(true);await navigation;await settle();}};
}
function failureInputs(kind,onClose){
 let reads=0,resolutions=0;const subscriptions=new Set(),detail={playlist_id:'p',revision:'r1',title:'P',description:'',track_rows:[]},creationSource={...source,kind:'library'},state={scopeKey:'scope',selectedPlaylistId:'p',resource:{status:'ready',data:{detail,allowed_actions:{can_create:true},playlist_creation_source:creationSource}},mutation:{status:'idle'},drafts:{}},controller=store(state);
 const subscribe=controller.subscribe;controller.subscribe=listener=>{subscriptions.add(listener);const release=subscribe(listener);return()=>{subscriptions.delete(listener);release();};};controller.readSharing=async()=>{reads++;return {status:'ready',data:{revision:'r1',can_manage:true,visibility:'private',people:[],pending_requests:[]}};};controller.load=async()=>{reads++;return true;};
 const providers={readPlaylistPreferences:async()=>{reads++;return {scopeKey:'scope',preferences:{revision:'r1',remember_order_mode:false}};},readPlaylistCreationSource:async()=>{reads++;return {status:'empty'};},readPlaylistDestinations:async()=>{reads++;return {status:'empty',data:{scopeKey:'scope',destinations:[],allowed_actions:{can_create:false}}};}},instance={},sourceAdapter={snapshot:()=>({scopeKey:'scope',instance,revision:'r1',rows:[{rowKey:'a',readable:true,selectable:true}]}),resolveRows:()=>{resolutions++;return [{rowKey:'a',track_ref:'track-a'}];},subscribe(listener){subscriptions.add(listener);return()=>subscriptions.delete(listener);}},lifetime={isCurrent:()=>true,subscribeInvalidation(listener){subscriptions.add(listener);return()=>subscriptions.delete(listener);}};
 return {props:{controller,state,providers,onClose,mode:'ordinary',packet:{scopeKey:'scope',origin:{tableKey:'tracks',target:'selection'},row_keys:['a']},sourceAdapter,lifetime},get reads(){return reads;},get resolutions(){return resolutions;},subscriptions};
}
for(const kind of ['settings','sharing','selection-actions','creation-session'])for(const mode of ['desktop','deferred-mobile','null-open'])test(`${kind} failed ${mode} mount retires operational owners until explicit fallback Close`,async()=>{
 const env=actualDialogFixture({delayed:mode==='deferred-mobile',nullOpen:mode==='null-open'}),module=await import(`../../../music_app/static/js/playlists/native-${kind}.mjs`),mount=module[{settings:'mountPlaylistSettings',sharing:'mountSharePlaylist','selection-actions':'mountPlaylistActionSession','creation-session':'mountPlaylistCreationSession'}[kind]];let closes=0,renders=0,failed=false;const inputs=failureInputs(kind,()=>closes++),nativeButton=env.runtime.buttonHtml,before=new Set(env.listeners());env.runtime.buttonHtml=config=>{renders++;if(mode!=='null-open'&&!failed&&renders===2){failed=true;throw new Error('second native renderer failed');}return nativeButton(config);};
 const props={...inputs.props,runtime:env.runtime},owner=kind==='selection-actions'?mount(env.host,props):mount(env.host,env.runtime,props);await settle();assert.equal(inputs.reads,0);assert.equal(inputs.subscriptions.size,0);assert.equal(closes,0);assert.match(env.host.textContent,/not available/);if(mode!=='null-open')assert.ok(failed&&renders>=3,'one successful native acquisition, injected failure, then fallback button');const resolutions=inputs.resolutions;owner.update(props);await settle();assert.equal(inputs.reads,0);assert.equal(inputs.resolutions,resolutions);
 const leaked=()=>env.listeners().filter(listener=>!before.has(listener)&&!env.host.contains(listener.target)&&!env.modal.contains(listener.target));assert.deepEqual(leaked(),[]);assert.ok(env.choices.every(menu=>menu.closed));await env.settleNative();assert.equal(closes,0);assert.match(env.host.textContent,/not available/);assert.deepEqual(leaked(),[]);const close=env.host.querySelector('button');env.click(close);env.click(close);assert.equal(closes,1);assert.equal(env.host.childNodes.length,0);owner.dispose();owner.dispose();assert.equal(closes,1);assert.equal(inputs.subscriptions.size,0);assert.deepEqual(leaked(),[]);
});

test('settings paint failure closes an already-open native menu without reporting fallback close early',async()=>{
 const {mountPlaylistSettings}=await import('../../../music_app/static/js/playlists/native-settings.mjs'),env=actualDialogFixture(),inputs=failureInputs('settings',()=>closes++);let closes=0,failed=false;const render=env.runtime.buttonHtml;env.runtime.buttonHtml=config=>{if(!failed&&config.label==='Save default sort'){failed=true;const trigger=env.document.getElementById('app-form-content').querySelector('.ui-choice button');env.click(trigger);assert.equal(env.choices.length,1);throw new Error('paint failed with active menu');}return render(config);};const owner=mountPlaylistSettings(env.host,env.runtime,inputs.props);await settle();assert.equal(inputs.reads,0);assert.equal(env.choices[0].closed,true);assert.equal(closes,0);env.click(env.host.querySelector('button'));assert.equal(closes,1);owner.dispose();
});

for(const leaf of ['mountCreationResults','mountCreationForm'])test(`${leaf} unwinds partial listeners and child owners when table rendering throws`,async()=>{
 const module=await import('../../../music_app/static/js/playlists/native-creation-form.mjs'),{projectCreationState}=await import('../../../music_app/static/js/playlists/creation.mjs'),env=fixture(),controller=store(editorState()),state=controller.getSnapshot(),before=new Set(env.listeners());env.runtime.tableHtml=()=>{throw new Error('table rendering failed');};assert.throws(()=>module[leaf](env.host,env.runtime,{controller,state,id:'failed-table',projection:projectCreationState(state),disabled:false}),/table rendering failed/);assert.equal(env.host.childNodes.length,0);assert.deepEqual(env.listeners().filter(listener=>!before.has(listener)),[]);assert.ok(env.choices.every(menu=>menu.closed));
});

for(const mode of ['desktop','deferred-mobile','null-open'])test(`draft local-match failed ${mode} open retires its subscription before the trigger can load`,async()=>{
 const {mountMissingPlaylistLocalMatch}=await import('../../../music_app/static/js/playlists/native-draft-local-match.mjs');
 const {createDraftLocalMatchController}=await import('../../../music_app/static/js/playlists/draft-local-match.mjs');
 const env=actualDialogFixture({delayed:mode==='deferred-mobile',nullOpen:mode==='null-open'}),draft=store(editorState());
 let reads=0,closes=0,renders=0,failed=false;
 const model=createDraftLocalMatchController({draft,providers:()=>({readPlaylistMatchCandidates:async()=>{reads++;return {status:'unavailable'};},acceptPlaylistMatch:async()=>({status:'unavailable'})}),apply:()=>false,deny(){}}),subscriptions=new Set();
 const localMatch={...model,subscribe(listener){subscriptions.add(listener);const off=model.subscribe(listener);return()=>{subscriptions.delete(listener);off();};},close(){closes++;model.close();}};
 const props={controller:{localMatch},row:draft.getSnapshot().entries[0],disabled:false};
 const owner=mountMissingPlaylistLocalMatch(env.host,env.runtime,props),trigger=env.host.querySelector('button');
 const before=new Set(env.listeners()),buttonHtml=env.runtime.buttonHtml;
 env.runtime.buttonHtml=value=>{renders++;if(mode!=='null-open'&&!failed&&renders===3){failed=true;throw new Error('local-match content renderer failed');}return buttonHtml(value);};
 env.click(trigger);await settle();assert.equal(reads,0);assert.equal(subscriptions.size,0);assert.equal(closes,0);assert.match(env.host.textContent,/not available/);if(mode!=='null-open')assert.ok(failed,'content fails after native choice was acquired');owner.update({...props});env.click(trigger);assert.equal(reads,0);
 const leaked=()=>env.listeners().filter(listener=>!before.has(listener)&&!env.host.contains(listener.target)&&!env.modal.contains(listener.target));assert.deepEqual(leaked(),[]);assert.ok(env.choices.every(menu=>menu.closed));await env.settleNative();assert.equal(closes,0);assert.match(env.host.textContent,/not available/);const close=env.host.querySelector('button');env.click(close);env.click(close);assert.equal(closes,1);assert.equal(model.getSnapshot().status,'closed');assert.equal(env.host.querySelector('button').textContent,'Review local match again');owner.dispose();owner.dispose();assert.equal(closes,1);assert.equal(subscriptions.size,0);assert.deepEqual(leaked(),[]);model.dispose();
});

test('draft local-match initial active-state mount failure unwinds acquired subscription and preserves fallback',async()=>{
 const {mountMissingPlaylistLocalMatch}=await import('../../../music_app/static/js/playlists/native-draft-local-match.mjs');
 const {createDraftLocalMatchController}=await import('../../../music_app/static/js/playlists/draft-local-match.mjs');
 const env=actualDialogFixture(),draft=store(editorState());let reads=0,closes=0,failed=false;
 const model=createDraftLocalMatchController({draft,providers:()=>({readPlaylistMatchCandidates:async()=>{reads++;return {status:'unavailable'};},acceptPlaylistMatch:async()=>({status:'unavailable'})}),apply:()=>false,deny(){}});assert.equal(model.open('a'),true);const listeners=new Set(),localMatch={...model,subscribe(listener){listeners.add(listener);const release=model.subscribe(listener);listener();return()=>{listeners.delete(listener);release();};},close(){closes++;model.close();}};
 const render=env.runtime.buttonHtml;env.runtime.buttonHtml=value=>{if(!failed&&value.label==='Accept match'){failed=true;throw new Error('later content allocation failed');}return render(value);};const owner=mountMissingPlaylistLocalMatch(env.host,env.runtime,{controller:{localMatch},row:draft.getSnapshot().entries[0]});await settle();assert.ok(failed);assert.equal(listeners.size,0);assert.equal(reads,0);assert.equal(closes,0);assert.match(env.host.textContent,/not available/);env.click(env.host.querySelector('button'));assert.equal(closes,1);owner.dispose();model.dispose();
});

for(const phase of ['second-control','initial-paint'])test(`draft local-match content ${phase} failure releases every previously acquired owner`,async()=>{
 const {mountDraftLocalMatchContent}=await import('../../../music_app/static/js/playlists/native-draft-local-match.mjs');
 const env=fixture(),state={status:'ready',candidates:[{key:'one',title:'One',artist:'A',album_title:'B',duration_seconds:60}],selectedKey:'one',suggestionsComplete:true},controller={getSnapshot:()=>state,blocking:()=>false,select(){},load(){},accept:async()=>false},before=new Set(env.listeners());let calls=0;const render=env.runtime.buttonHtml;
 env.runtime.buttonHtml=value=>{calls++;if(phase==='second-control'&&calls===2)throw new Error('partial local content');if(phase==='initial-paint'&&value.label==='Accept match'&&calls>4){const choice=env.host.querySelector('.ui-choice button');env.click(choice);throw new Error('partial local content');}return render(value);};
 assert.throws(()=>mountDraftLocalMatchContent(env.host,env.runtime,{controller,state,row:row('a'),close(){}}),/partial local content/);assert.equal(env.host.childNodes.length,0);assert.deepEqual(env.listeners().filter(listener=>!before.has(listener)),[]);assert.ok(env.choices.every(menu=>menu.closed));
});

test('draft local-match outer constructor releases its trigger when subscription acquisition throws',async()=>{
 const {mountMissingPlaylistLocalMatch}=await import('../../../music_app/static/js/playlists/native-draft-local-match.mjs'),env=fixture(),before=new Set(env.listeners()),localMatch={getSnapshot:()=>({status:'closed',rowKey:null}),subscribe(){throw new Error('subscribe failed');},close(){assert.fail('unowned model must not be closed');}};
 assert.throws(()=>mountMissingPlaylistLocalMatch(env.host,env.runtime,{controller:{localMatch},row:row('a')}),/subscribe failed/);assert.equal(env.host.childNodes.length,0);assert.deepEqual(env.listeners().filter(listener=>!before.has(listener)),[]);
});

for (const phase of ['loading', 'accepting', 'uncertain']) {
 test(`local-match ${phase} failure preserves operation authority and explicit same-row recovery`, async () => {
  const {mountMissingPlaylistLocalMatch} = await import('../../../music_app/static/js/playlists/native-draft-local-match.mjs');
  const {createDraftLocalMatchController} = await import('../../../music_app/static/js/playlists/draft-local-match.mjs');
  const env = actualDialogFixture(), draft = store(editorState());
  const entry = draft.getSnapshot().entries[0], requests = [], reads = [];
  let resolveRead, rejectAccept, transientFailure = true, opens = 0;
  const ready = {status: 'ready', data: {scopeKey: 'scope', source, entry_ref: entry.entry_ref,
   suggestions_complete: true, candidates: [{key: 'chosen', title: 'Chosen', artist: 'Artist', album_title: 'Album'}]}};
  const providers = {
   readPlaylistMatchCandidates(options) {
    reads.push(options);
    if (phase === 'loading' && reads.length === 1) return new Promise(resolve => {resolveRead = resolve;});
    return Promise.resolve(ready);
   },
   acceptPlaylistMatch(options) {
    requests.push(options);
    return new Promise((_resolve, reject) => {rejectAccept = reject;});
   },
  };
  const model = createDraftLocalMatchController({draft, providers: () => providers, apply: () => false, deny() {}});
  const localMatch = {...model, open(key) {opens++; return model.open(key);}};
  assert.equal(localMatch.open('a'), true);
  const loading = model.load();
  let accepting;
  if (phase !== 'loading') {
   await loading;
   assert.equal(model.select('chosen'), true);
   accepting = model.accept();
   if (phase === 'uncertain') {
    rejectAccept(new Error('response unknown'));
    await accepting;
    assert.equal(model.getSnapshot().status, 'uncertain');
   }
  }
  const before = model.getSnapshot(), buttonHtml = env.runtime.buttonHtml;
  env.runtime.buttonHtml = value => {
   if (transientFailure && value.label === 'Accept match') {
    transientFailure = false;
    throw new Error('transient local-match renderer failure');
   }
   return buttonHtml(value);
  };
  const props = {controller: {localMatch}, row: entry, disabled: false};
  const owner = mountMissingPlaylistLocalMatch(env.host, env.runtime, props);
  assert.match(env.host.textContent, /not available/);
  if (phase === 'loading') {
   assert.equal(reads[0].signal.aborted, true);
   assert.equal(model.getSnapshot().status, 'closed');
   resolveRead(ready);
   await loading;
   assert.equal(model.getSnapshot().status, 'closed', 'late read cannot restore its retired opening');
  } else {
   assert.equal(requests[0].signal.aborted, false);
   assert.equal(model.getSnapshot(), before);
  }
  owner.update({...props});
  assert.match(env.host.textContent, /not available/);
  env.click(env.host.querySelector('button'));
  const recovery = env.host.querySelector('button');
  assert.equal(recovery.textContent, 'Review local match again');
  owner.update({...props});
  assert.equal(env.host.querySelector('button'), recovery, 'parent update does not reopen automatically');
  if (phase !== 'loading') {
   assert.equal(requests[0].signal.aborted, false);
   assert.equal(model.getSnapshot(), before, 'fallback Close must not erase write ambiguity or candidate');
  }
  env.click(recovery);
  await settle();
  assert.equal(opens, phase === 'loading' ? 2 : 1, 'existing opening is reused');
  const body = env.document.getElementById('app-form-content');
  if (phase === 'loading') {
   assert.equal(reads.length, 2);
   assert.equal(model.getSnapshot().status, 'ready');
  } else {
   assert.equal(model.getSnapshot().selectedKey, 'chosen');
   if (phase === 'accepting') {
    assert.equal(requests.length, 1, 'reopen does not duplicate an in-flight write');
    rejectAccept(new Error('response unknown'));
    await accepting;
   }
   assert.equal(model.getSnapshot().status, 'uncertain');
   const retry = body.querySelectorAll('button').find(button => button.textContent === 'Check match result');
   assert.ok(retry);
   env.click(retry);
   assert.equal(requests.length, 2);
   assert.equal(requests[1].candidate_key, requests[0].candidate_key);
   assert.equal(requests[1].entry_ref, requests[0].entry_ref);
   assert.equal(requests[1].source, requests[0].source);
   assert.equal(model.getSnapshot().status, 'accepting');
  }
  owner.dispose();
  assert.equal(model.getSnapshot().status, 'closed', 'parent lifetime disposal retains cancellation authority');
  if (phase !== 'loading') {
   assert.equal(requests[1].signal.aborted, true);
   rejectAccept(new Error('late retired write'));
   await settle();
   assert.equal(model.getSnapshot().status, 'closed');
  }
  model.dispose();
 });
}

test('creation Selected checkbox removal restores adjacent row and last-row selected tab', async () => {
 const {mountCreationForm} = await import('../../../music_app/static/js/playlists/native-creation-form.mjs');
 const env = fixture(), entries = ['a', 'b', 'c'].map(row);
 const controller = store({...editorState(entries), tab: 'selected', selectedKeys: ['a', 'b', 'c']});
 controller.toggle = key => controller.replace({...controller.getSnapshot(),
  selectedKeys: controller.getSnapshot().selectedKeys.filter(value => value !== key)});
 const props = () => ({controller, state: controller.getSnapshot()});
 const owner = mountCreationForm(env.host, env.runtime, props());
 const off = controller.subscribe(() => owner.update(props()));
 function remove(key) {
  const checkbox = env.host.querySelector(`[data-creation-pick="${key}"]`);
  checkbox.focus();
  checkbox.checked = false;
  checkbox.dispatchEvent(new env.context.Event('change', {bubbles: true}));
 }
 remove('b');
 assert.equal(env.document.activeElement, env.host.querySelector('[data-creation-row-key="c"]'));
 remove('c');
 assert.equal(env.document.activeElement, env.host.querySelector('[data-creation-row-key="a"]'));
 remove('a');
 assert.equal(env.document.activeElement, env.host.querySelector('[role="tab"][aria-selected="true"]'));
 assert.equal(env.host.querySelectorAll('[data-creation-row-key]').length, 0);
 off(); owner.dispose();
});

test('creation results preserve row/control focus but do not override alternate focus or retirement', async () => {
 const {mountCreationResults} = await import('../../../music_app/static/js/playlists/native-creation-form.mjs');
 const {projectCreationState} = await import('../../../music_app/static/js/playlists/creation.mjs');
 const env = fixture(), controller = store({...editorState(), tab: 'selected', selectedKeys: ['a']});
 const props = () => ({controller, state: controller.getSnapshot(), id: 'focus-results',
  projection: projectCreationState(controller.getSnapshot()), disabled: false});
 const owner = mountCreationResults(env.host, env.runtime, props());
 function repaint() {
  const state = controller.getSnapshot(), entries = state.sourceResource.data.entries.map(entry => ({...entry, title: `${entry.title}!`}));
  controller.replace({...state, entries, sourceResource: {...state.sourceResource, data: {...state.sourceResource.data, entries}}});
  owner.update(props());
 }
 for (const selector of ['[data-creation-row-key="a"]', '[data-creation-pick="a"]', '[data-creation-review="a"]']) {
  env.host.querySelector(selector).focus();
  repaint();
  assert.equal(env.document.activeElement, env.host.querySelector(selector));
 }
 const alternate = env.document.createElement('button');
 env.document.body.append(alternate);
 const tableHtml = env.runtime.tableHtml;
 env.host.querySelector('[data-creation-pick="a"]').focus();
 env.runtime.tableHtml = value => {alternate.focus(); return tableHtml(value);};
 repaint();
 assert.equal(env.document.activeElement, alternate);
 env.runtime.tableHtml = value => {owner.dispose(); return tableHtml(value);};
 repaint();
 assert.equal(env.host.childNodes.length, 0);
 assert.equal(env.document.activeElement, alternate);
 owner.dispose();
});

test('creation selection limit and duplicate notices retain independent semantics', async () => {
 const {mountCreationForm} = await import('../../../music_app/static/js/playlists/native-creation-form.mjs');
 const env = fixture(), entries = [row('a'), {...row('b'), entry_ref: 'entry-a'}];
 const controller = store({...editorState(entries), tab: 'selected', selectedKeys: ['a', 'b'], selectionLimit: true});
 const owner = mountCreationForm(env.host, env.runtime, {controller, state: controller.getSnapshot()});
 const fieldset = env.host.querySelector('fieldset.playlists-creation__toolbar');
 assert.equal(fieldset.querySelector('legend').textContent, 'Playlist track selection');
 assert.ok(fieldset.querySelector('label.playlists-creation__select-visible input'));
 const count = env.host.querySelector('[role="status"][aria-atomic="true"]');
 assert.equal(count.textContent, '2 tracks selected');
 assert.equal(count.getAttribute('aria-live'), 'polite');
 assert.match(env.host.querySelector('[role="alert"]').textContent, /5,000 selected tracks/);
 assert.match(env.host.textContent, /1 repeated occurrences shown; each source track will be added once/);
 owner.dispose();
});

test('action destination named form submits once with busy semantics and unchanged grants', async () => {
 const {mountPlaylistActionSession} = await import('../../../music_app/static/js/playlists/native-selection-actions.mjs');
 for (const granted of [true, false]) {
  const env = fixture(), instance = {}, snapshot = {scopeKey: 'scope', instance, revision: 'r1', rows: [{rowKey: 'a', readable: true, selectable: true}]};
  const sourceAdapter = {snapshot: () => snapshot, resolveRows: () => [{rowKey: 'a', track_ref: 'track-a'}], subscribe: () => () => {}};
  const writes = [];
  let finish;
  const providers = {
   readPlaylistDestinations: async () => ({status: 'ready', data: {scopeKey: 'scope', destinations: [
    {playlist_id: 'p', title: 'P', revision: 'r1', allowed_actions: {can_add: granted}}], allowed_actions: {can_create: false}}}),
   addTracks: request => {writes.push(request); return new Promise(resolve => {finish = resolve;});},
  };
  const owner = mountPlaylistActionSession(env.host, {runtime: env.runtime,
   packet: {scopeKey: 'scope', origin: {tableKey: 'tracks', target: 'selection'}, row_keys: ['a']},
   sourceAdapter, lifetime: {isCurrent: () => true}, providers});
  await settle();
  const body = env.forms[0].body, form = body.querySelector('form[aria-label="Add selected tracks to playlist"]');
  assert.ok(form);
  assert.equal(form.getAttribute('aria-busy'), 'false');
  const add = form.querySelectorAll('button').find(button => button.textContent === 'Add to playlist');
  assert.equal(add.getAttribute('type'), 'submit');
  if (granted) {
   env.click(form.querySelector('.ui-choice button'));
   env.choices.at(-1).config.onSelect('p');
  }
  const submit = () => form.dispatchEvent(new env.context.Event('submit', {bubbles: true, cancelable: true}));
  submit(); submit();
  if (granted) assert.equal(form.getAttribute('aria-busy'), 'true');
  await settle();
  assert.equal(writes.length, granted ? 1 : 0);
  if (granted) {
   assert.equal(writes[0].playlist_id, 'p');
   assert.deepEqual(Array.from(writes[0].track_refs), ['track-a']);
   assert.equal(add.disabled, true);
   finish({status: 'denied'});
   await settle();
   assert.equal(form.getAttribute('aria-busy'), 'false');
   submit(); await settle();
   assert.equal(writes.length, 1);
  }
  owner.dispose();
  submit(); await settle();
  assert.equal(writes.length, granted ? 1 : 0);
 }
});
