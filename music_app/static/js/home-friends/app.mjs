import {mountGoalsPanel} from './goals.mjs';
import {createNativeLifetime} from './native-lifetime.mjs';
import {mountSharedHeader, mountListensBadge} from './shared-header.mjs';
import {mountActivityMissingAction} from './activity-missing.mjs';
import {createNowPlaying} from './now-playing.mjs';
import {mountQueuePanel, mountQueueHeader, createExplicitQueue, createQueueDetails} from './queue.mjs';
import {metric, profilePerson} from './model.mjs';
import {openNativeDialog} from './native-dialog.mjs';
import {mountComparisonPanel} from './comparison.mjs';
import {mountActivityPanel} from './activity.mjs';
import {mountHistoryNavigation} from './history-navigation.mjs';
import {activityForQuery, navigateActivityHistory} from './history-presentation.mjs';
import {mountResourceDetail} from './resource-detail.mjs';
import {detailSelection, detailSelectionKey} from './resource-target.mjs';
import {activitySelectionTarget, recentSelectionRow, reconcileSelectionLease, resolveActivitySelection, resolveActivityTrackSelection, resolveListenedAlbum, retireFriendSelections, sameSelectionTarget, selectionDescriptor, selectionEntry, selectionPresentation, selectionQueryKey, selectionSource, updateSelectionEntry} from './selection-presentation.mjs';
import {mountComparisonIdentity, mountProfileIdentity, mountProfileEditor} from './profile.mjs';
import {mountViewControl} from './view-control.mjs';
import {createScrollState, loadFriendRoute, scrollRestoreState, updateOwnedScroll} from './navigation.mjs';
import {HOME_PHONE_QUERY, initialHomeKind} from './presentation.mjs';
import {mountFriendsDirectory} from './friends-directory.mjs';
import {mountMemberProfile} from './member-profile.mjs';
import {mountFriendRequestDialog, currentFriendRequest} from './friend-request.mjs';
import {mountButton, mountRecentAlbums, mountStatus, mountTabs} from './native-controls.mjs';
import {mountPeriod} from './period.mjs';
const kinds = [['albums','Albums'],['tracks','Tracks'],['artists','Artists']];
const deniedResource = Object.freeze({status:'denied',data:null});
const homeSections = [['recent','Recent'],['news','News',{disabled:true}],['queue','Queue']];

// This screen owns explicit DOM slots and state transitions. Native controls,
// resource leases and model controllers retain their own authority/lifetimes.
export function mountHomeFriendsView(host, initial) {
  const {runtime, controller} = initial, document = host.ownerDocument, window = document.defaultView, saved = initial.shell.presentation;
  const initialKind = initialHomeKind(saved, window?.matchMedia?.(HOME_PHONE_QUERY).matches ?? window?.innerWidth <= 900);
  let props = initial, kind = initialKind.kind, kindExplicit = initialKind.kindExplicit, homeSection = ['queue','goals'].includes(saved?.homeSection) ? saved.homeSection : 'recent', period = saved?.period || 'week',
    views = {tracks:'grouped',artists:'list',...saved?.views,albums:'cards'}, friendViews = saved?.friendViews || {albums:'cards',tracks:'grouped',artists:'list'},
    friendKind = saved?.friendKind || 'tracks', friendPeriod = saved?.friendPeriod || 'week', friendMode = saved?.friendMode || 'activity', selectedAlbum = saved?.selectedAlbum || null,
    selections = selectionPresentation(saved?.selectionPresentation), recentListenedAlbumsHost = null, friendListenedAlbumsHost = null, artistDetail = null, albumDetail = null, editing = null, actionError = '', directoryDialog = false, requestDialog = null, comparison = saved?.comparison || null,
    disposed = false, constructing = true, rendering = false, pendingRender = false, pendingProps, ownershipRevision = 0, frameRevision = 0, generation = 0, lifetime = null, resourceLease = null, currentQuery = null, currentArtistDetail = null, currentAlbum = null,
    selectedFocus = null, selectionOpener = null, profileFocus = null, sizeFocus = null, scrollTimer = null, nowPlayingValue = null, queueDetailsOwner, queueDetails,
    activeRouteKey, loadedRecentKey, loadedFriendKey, loadedFriendResource, loadedMembersResource, lastFriends, lastPresentation, originalRestorationKey, latest = null, presentation;
  const lifetimeScope = createNativeLifetime(), owners = new Map(), slots = new Map(), retiredRender = Symbol('retired Home render');
  let goalsVisitIntent = null;
  let profileDialogOwner, directoryDialogOwner, directoryContentOwner, requestDialogOwner;
  // A queued external ownership change retires the active frame immediately,
  // before native focus returns. Ordinary same-input publications keep leases.
  const homeCurrent=()=>!disposed&&(!rendering||frameRevision===ownershipRevision);
  function sameOwnership(left,right) {
    const a=left.shell,b=right.shell,as=left.state,bs=right.state;
    if(left.goalsTransport!==right.goalsTransport||left.readDetail!==right.readDetail||left.readNowPlaying!==right.readNowPlaying||as.scopeKey!==bs.scopeKey||a.section!==b.section||a.friendRef!==b.friendRef||a.profileRef!==b.profileRef||as.selectedFriendRef!==bs.selectedFriendRef||as.selectedProfileRef!==bs.selectedProfileRef)return false;
    if(as.friends?.status!==bs.friends?.status||as.friends?.data!==bs.friends?.data)return false;
    if(latest?.query){const x=selectionSource(as,latest.query),y=selectionSource(bs,latest.query);if(x?.status!==y?.status||x?.data!==y?.data)return false;}
    return true;
  }
  function syncGoalsMarker() {
    if (disposed) return;
    const value = props.goalsOwner?.controller.getSnapshot();
    owners.get('home-sections')?.owner.setAttention?.('goals', value?.attentionStatus === 'ready' ? value.attention.indicator : 'none');
  }
  function checkpoint() {if (!homeCurrent()) throw retiredRender;}
  function accept(owner) {if (!homeCurrent()) {try {owner?.dispose?.();} catch (_cleanupError) {} throw retiredRender;} return owner;}
  function dispose() {
    if (disposed) return; disposed = true; currentQuery = null; pendingRender = false; pendingProps = null; clearTimeout(scrollTimer);
    const held = [...owners.values()].map(value => value.owner); owners.clear();
    for (const owner of [requestDialogOwner,directoryDialogOwner,directoryContentOwner,profileDialogOwner,queueDetailsOwner,...held]) {try {owner?.dispose?.();} catch (_cleanupError) {}}
    requestDialogOwner = directoryDialogOwner = profileDialogOwner = directoryContentOwner = queueDetailsOwner = null;
    lifetimeScope.dispose(); host.replaceChildren();
  }
  try {
  if (initial.goalsOwner) lifetimeScope.defer(initial.goalsOwner.controller.subscribe(syncGoalsMarker));
  if (!selections.length && selectedAlbum) selections = updateSelectionEntry(selections, {section:'recent',account_ref:null,kind:'albums',period:'week'}, {pane:saved.expanded === 'recent' ? 'recent':'album',expanded:saved.expanded === 'selection' ? 'album':saved.expanded,scroll:{source:saved.scroll?.recent}});
  const savedScroll = saved?.scroll && {...saved.scroll,...(saved.kindExplicit === false && saved.kind !== kind ? {recent:0}:{})};
  const scroll = createScrollState(savedScroll); let pendingScroll = savedScroll;
  const restoredPaneScroll = {source:null,artist:null,album:null};
  host.className = 'home-friends';
  host.innerHTML = '<div data-slot="page-header"></div><div data-slot="dialogs"></div><div data-slot="error"></div><div class="gallery-bar home-friends__pane-navigation" data-slot="pane-navigation"><span data-slot="pane-back"></span><div data-slot="pane-tabs"></div></div><div class="home-friends__dashboard" data-dashboard="true"><section class="home-friends__widget" data-home-widget="recent"><div data-slot="recent-header"></div><div class="home-friends__widget-body home-friends__recent-body" data-slot="recent-body"></div></section><section class="home-friends__widget" data-home-widget="friends" aria-label="Friends"><div data-slot="friends-header"></div><div class="home-friends__widget-body gallery-scrollbar" data-slot="friends-body"></div></section><section class="home-friends__widget" data-home-widget="artist" aria-label="Selected Artist Info"><div data-slot="artist-header"></div><div class="home-friends__widget-body gallery-scrollbar" data-slot="artist-body"></div></section><section class="home-friends__widget" data-home-widget="album" aria-label="Selected Album Info"><div data-slot="album-header"></div><div class="home-friends__widget-body gallery-scrollbar" data-slot="album-body"></div></section></div>';
  const slot = name => host.querySelector(`[data-slot="${name}"]`), element = (parent,tag='div',className='') => {const node = document.createElement(tag); node.className = className; parent.append(node); return node;};
  const dashboard = host.querySelector('[data-dashboard]'), widgets = Object.fromEntries(['recent','friends','artist','album'].map(key => [key,host.querySelector(`[data-home-widget="${key}"]`)]));
  function child(key,parent,tag='span') {if (!slots.has(key)) slots.set(key,element(parent,tag)); const node = slots.get(key); if (node.parentNode !== parent) parent.append(node); return node;}
  function mount(key,parent,fn,value,ownerRuntime=runtime,identity) {
    checkpoint(); const node=child(key,parent,'div');node.hidden=false;let held=owners.get(key);
    if(held&&(held.fn!==fn||held.runtime!==ownerRuntime||held.identity!==identity)){owners.delete(key);held.owner.dispose({retire:true});checkpoint();held=null;}
    if(held){held.owner.update(value);checkpoint();}
    else {const owner=accept(fn(node,ownerRuntime,value));held={owner,fn,runtime:ownerRuntime,identity};owners.set(key,held);}
    return held.owner;
  }
  function remove(key,retire=false) {checkpoint();const held=owners.get(key);if(held){owners.delete(key);held.owner.dispose({retire});checkpoint();}slots.get(key)?.remove();slots.delete(key);}
  function show(key,condition,parent,fn,value,ownerRuntime=runtime,identity) {checkpoint();if(condition)return mount(key,parent,fn,value,ownerRuntime,identity);remove(key,fn===mountResourceDetail);return null;}
  const pageHeader = lifetimeScope.own(mountSharedHeader(slot('page-header'),runtime,{id:'home-page',className:'home-friends__page-header'}));
  const recentHeader = lifetimeScope.own(mountSharedHeader(slot('recent-header'),runtime,{id:'home-recent',className:'home-friends__widget-header home-friends__recent-header'}));
  const friendsHeader = lifetimeScope.own(mountSharedHeader(slot('friends-header'),runtime,{id:'home-friends',className:'home-friends__widget-header'}));
  const artistHeader = lifetimeScope.own(mountSharedHeader(slot('artist-header'),runtime,{id:'home-artist',className:'home-friends__widget-header'}));
  const albumHeader = lifetimeScope.own(mountSharedHeader(slot('album-header'),runtime,{id:'home-album',className:'home-friends__widget-header'}));
  const comparisonViewHost = child('comparison-view-host',pageHeader.slots.outsideActions); comparisonViewHost.dataset.homeComparisonViewHost='true';
  const recentContent = element(slot('recent-body')), recentActivityHost = element(recentContent,'div','home-friends__scroll gallery-scrollbar'), recentActivity = element(recentActivityHost), recentHistory = element(recentActivityHost);
  const friendsBody = slot('friends-body'), friendActions = element(friendsBody,'div','home-friends__friend-actions'), friendControls = element(friendsBody,'div','home-friends__control-row'), friendResult = element(friendsBody), friendHistory = element(friendsBody), mutationHost = element(friendsBody);
  const artistBody = slot('artist-body'), albumBody = slot('album-body'), artistProjection = element(artistBody), albumProjection = element(albumBody), albumSummary = element(albumBody,'dl','home-friends__album-summary');
  const explicitQueue = lifetimeScope.own(createExplicitQueue(runtime,() => render()));
  const nowPlaying = lifetimeScope.own(createNowPlaying({allowed:false},value => {if(!disposed){nowPlayingValue=value; queueMicrotask(render);}}));
  const recentScrollBody = () => latest?.queueMode ? null : latest?.ownRecent ? widgets.recent.querySelector('.home-recent__body') : recentActivityHost;
  const sourceBody = () => latest?.section === 'friends' ? friendsBody : latest?.queueMode ? slot('recent-body') : recentScrollBody();
  const change = callback => {pendingScroll=null; callback(); render();};
  function updateEntry(patch) {selections=updateSelectionEntry(selections,latest.query,patch); render();}
  function sourceCurrent() {const x=latest; return homeCurrent() && x.revision===ownershipRevision && currentQuery?.owner===x.owner && controller.getSnapshot().scopeKey===x.state.scopeKey && x.owner.provider===(typeof props.readDetail==='function'?props.readDetail:runtime.readAlbumProjection) && selectionSource(controller.getSnapshot(),x.query)===x.source;}
  function targetCurrent() {const x=latest; return x.queueMode ? homeCurrent() && currentQuery?.owner===x.owner && queueDetails?.adapter && queueDetails.adapter.getSnapshot()===queueDetails.value && queueDetails.value.selectedIds.length>0 && controller.getSnapshot().scopeKey===x.state.scopeKey : sourceCurrent() && (x.ownRecent ? x.selectedRow && selectedAlbum===x.selectedRow.album_ref : x.trackSelection ? Boolean(resolveActivityTrackSelection(controller.getSnapshot(),x.query,x.entry.tracks)) : sameSelectionTarget(resolveActivitySelection(controller.getSnapshot(),x.query,x.entry.selected)?.target,x.selectedTarget));}
  function albumCurrent() {return targetCurrent() && currentAlbum?.owner===latest.owner && currentAlbum.key===latest.albumTargetKey;}
  function navigate(next,friendRef='',profileRef='',mode) {if(disposed)return;pendingScroll=null; runtime.savePresentation({...presentation,...(mode?{friendMode:mode}:{}),scroll},props.shell); if(disposed)return;directoryDialog=false; editing=null; requestDialog=null; actionError='';try{renderDialogs();}catch(error){if(error!==retiredRender){dispose();throw error;}return;}if(disposed)return;runtime.navigate({section:next,friend:friendRef,profile:profileRef});}
  function openProfile(accountRef) {const current=controller.getSnapshot(); if (current.scopeKey===props.state.scopeKey && profilePerson(current,accountRef)) navigate('friends','',accountRef);}
  function openRequest(requestRef,trigger) {const current=controller.getSnapshot(); if (current.scopeKey!==props.state.scopeKey || !currentFriendRequest(current,requestRef)) return; directoryDialog=false; requestDialog={requestRef,scopeKey:props.state.scopeKey,returnFocus:()=>trigger?.isConnected&&!trigger.closest('[hidden],[inert]')?trigger:host.querySelector('[data-home-open-friends]')}; render();}
  function openFriend(accountRef,mode) {const current=controller.getSnapshot(),grant=mode==='comparison'?'can_compare':'can_view_activity',person=['ready','empty'].includes(current.friends.status)&&current.friends.data?.friends.find(value=>value.account_ref===accountRef); if(current.scopeKey===props.state.scopeKey&&person?.relationship==='accepted'&&person.allowed_actions?.[grant]===true)navigate('friends',accountRef,'',mode);}
  function closeProfile({restoreFocus=true}={}) {profileFocus=restoreFocus?{control:editing?.control,section:latest.section,friendRef:props.shell.friendRef}:null; editing=null; render();}
  function setError(message) {actionError=message; if (!disposed) slot('error').innerHTML=message?runtime.alertHtml({severity:'error',role:'alert',message}):'';}
  function dialogFailure(error,close) {if(disposed)return;const fallback=slot('dialogs'); fallback.innerHTML=runtime.alertHtml({severity:'info',role:'status',message:'This dialog is not available right now.'}); mount('dialog-fallback',fallback,mountButton,{label:'Close',onClick:()=>close()});}
  function renderDialogs() {
    if (disposed) return;
    if (!editing || props.state.friends.status==='denied') {profileDialogOwner?.dispose(); profileDialogOwner=null;} else if (!profileDialogOwner) profileDialogOwner=accept(openNativeDialog(runtime,{title:'Edit profile'},{mount:(node,close)=>accept(mountProfileEditor(node,runtime,{profile:editing.profile,controller,onClose:close})),onClose:closeProfile,onError:dialogFailure}));
    checkpoint();
    if (!directoryDialog) {directoryDialogOwner?.dispose();directoryDialogOwner=null;directoryContentOwner=null;} else if (!directoryDialogOwner) directoryDialogOwner=accept(openNativeDialog(runtime,{title:'Friends',contentOwnsFooter:false},{mount:node=>(directoryContentOwner=accept(mountFriendsDirectory(node,runtime,{value:props.state.friends,selected:props.state.selectedFriendRef,controller,onSelect:ref=>navigate('friends',ref),onProfile:openProfile,onRequest:openRequest}))),onClose:()=>{directoryDialog=false;render();},onError:(error,close)=>{directoryContentOwner?.dispose();directoryContentOwner=null;dialogFailure(error,close);}}));
    checkpoint();
    if(directoryDialog&&directoryContentOwner)directoryContentOwner.update({value:props.state.friends,selected:props.state.selectedFriendRef,controller,onSelect:ref=>navigate('friends',ref),onProfile:openProfile,onRequest:openRequest});
    checkpoint();
    if (!requestDialog || requestDialog.scopeKey!==props.state.scopeKey) {requestDialogOwner?.dispose(); requestDialogOwner=null;} else if (!requestDialogOwner) requestDialogOwner=accept(mountFriendRequestDialog(slot('dialogs'),runtime,{controller,...requestDialog,onClose:()=>{requestDialog=null;render();},onProfile:openProfile}));
    checkpoint();
    if(requestDialogOwner&&requestDialog&&requestDialog.scopeKey===props.state.scopeKey)requestDialogOwner.update({controller,...requestDialog,onClose:()=>{requestDialog=null;render();},onProfile:openProfile});
    checkpoint();
    if (!editing&&!directoryDialog&&!requestDialog) {remove('dialog-fallback');slot('dialogs').replaceChildren();}
  }
  function selectResource(row,targetKind) {
    const x=latest;if(!sourceCurrent()||!x.selectionEnabled)return;
    if(row===null){currentQuery=null;updateEntry({selected:null,tracks:null,childAlbumRef:null,pane:'recent',expanded:null});return;}
    if(x.source.status!=='ready'||!x.source.data?.rows?.includes(row))return;
    const target=activitySelectionTarget(row,targetKind,x.query,x.source);if(!target)return;
    resourceLease=null;currentQuery=null;pendingScroll=null;selectionOpener=selectedFocus={queryKey:x.queryKey,ref:row.id,control:document.activeElement};
    updateEntry({selected:selectionDescriptor(row,target,x.source),tracks:null,childAlbumRef:null,pane:target.kind,expanded:null,scroll:{artist:0,album:0}});
  }
  function selectTracks(rowIds,{inspect=false}={}) {
    const x=latest;if(!sourceCurrent()||!x.selectionEnabled||!['tracks','listens'].includes(x.query.kind))return;
    const tracks={rowIds:[...rowIds],snapshotRef:x.source.data?.snapshot_ref??null};if(rowIds.length&&!resolveActivityTrackSelection(controller.getSnapshot(),x.query,tracks))return;
    if(!inspect&&JSON.stringify(x.entry.tracks?.rowIds||[])===JSON.stringify(rowIds))return;
    resourceLease=null;currentQuery=null;pendingScroll=null;selectionOpener={queryKey:x.queryKey,ref:rowIds[0],control:document.activeElement};
    updateEntry({selected:null,tracks:rowIds.length?tracks:null,childAlbumRef:null,pane:'recent',expanded:null,scroll:{artist:0,album:0}});
  }
  function selectQueuedTracks(ids,{inspect=false}={}) {
    const x=latest;if(!x.queueMode||currentQuery?.owner!==x.owner||!queueDetails?.adapter||controller.getSnapshot().scopeKey!==x.state.scopeKey)return;
    if(!inspect&&JSON.stringify(queueDetails.value.selectedIds)===JSON.stringify(ids))return; pendingScroll=null;
    selectionOpener={queryKey:x.queryKey,ref:ids[0],control:document.activeElement};
    selections=updateSelectionEntry(selections,x.query,{tracks:ids.length?{rowIds:ids,snapshotRef:null}:null,pane:'recent',expanded:null,childAlbumRef:null});
    Promise.resolve(queueDetails.adapter.select(ids)).catch(()=>{});render();
  }
  function selectRecentAlbum(ref) {const x=latest;if(!sourceCurrent()||!x.ownRecent||ref!==null&&!recentSelectionRow(x.source,ref,{customDetail:x.customDetail}))return;currentQuery=null;pendingScroll=null;selectionOpener=selectedFocus=ref?{queryKey:x.queryKey,ref,control:document.activeElement}:null;selectedAlbum=ref;updateEntry({pane:ref?'album':'recent',expanded:null,scroll:{album:0}});}
  function selectListenedAlbum(target) {const x=latest;if(!targetCurrent()||currentArtistDetail?.owner!==x.owner||currentArtistDetail.value!==x.liveArtistDetail)return;const selected=resolveListenedAlbum(x.liveArtistDetail,x.artistTarget,target?.ref);if(!sameSelectionTarget(selected,target))return;currentAlbum={owner:x.owner,key:detailSelectionKey(selected)};pendingScroll=null;updateEntry({childAlbumRef:selected.ref,pane:'album',expanded:null,scroll:{album:0}});}
  function showPane(next) {const x=latest;if(currentQuery?.owner!==x.owner||!['recent',...(x.hasArtist?['artist']:[]),...(x.hasAlbum?['album']:[])].includes(next))return;if(next==='recent')selectedFocus=selectionOpener;pendingScroll=null;updateEntry({pane:next});}
  function closeSelection(which) {const x=latest;if(x.queueMode){if(targetCurrent()){queueDetails.adapter.clear();updateEntry({pane:'recent',expanded:null});}return;}if(!targetCurrent()||which==='album'&&!albumCurrent())return;currentQuery=null;selectedFocus=selectionOpener;if(which==='album'&&x.childAlbum)updateEntry({childAlbumRef:null,pane:'artist',expanded:null});else{if(x.ownRecent)selectedAlbum=null;updateEntry({selected:null,tracks:null,childAlbumRef:null,pane:'recent',expanded:null});}}
  function resizeWidget(next) {if(currentQuery?.owner!==latest.owner)return;sizeFocus=next===null?latest.expandedKey:next;pendingScroll=null;updateEntry({expanded:next});}
  function history(value,parent,key) {
    const x=latest,historyKey=x.historyKey;
    const navigateHistory=(method,target)=>navigateActivityHistory({controller,snapshot:x.state,method,target,query:{account_ref:x.section==='friends'?props.shell.friendRef:null,kind:x.section==='friends'?x.friendActivityKind:x.recentKind,period:x.section==='friends'?friendPeriod:period},
      isCurrent:()=>!disposed&&latest.historyKey===historyKey&&(latest.section!=='friends'||friendMode==='activity'),onIntent:()=>{pendingScroll=null;},onPageCommitted:()=>{const body=x.section==='friends'?friendsBody:recentActivityHost;body.scrollTop=0;}});
    mount(key,parent,mountHistoryNavigation,{value,navigation:x.state.activityNavigation,queryKey:historyKey,onPage:page=>navigateHistory('loadActivityPage',page),onLoadMore:()=>navigateHistory('loadMoreActivity'),onRetry:()=>navigateHistory('retryActivityNavigation')});
  }
  function derive() {
    const {state,shell,readDetail}=props,section=shell.section==='friends'?'friends':'recent',queueMode=section==='recent'&&homeSection==='queue';
    const friend=state.friends.data?.friends.find(person=>person.account_ref===state.selectedFriendRef&&person.account_ref===shell.friendRef),profile=state.friends.data?.profile;
    const invalidFriend=Boolean(section==='friends'&&shell.friendRef&&['ready','empty'].includes(state.friends.status)&&!state.friends.data?.friends.some(person=>person.account_ref===shell.friendRef));
    const profileRoute=section==='friends'&&Boolean(shell.profileRef),comparing=!profileRoute&&section==='friends'&&Boolean(friend)&&friendMode==='comparison';
    const memberSource=profileRoute?profilePerson(state,shell.profileRef):null;
    const memberProfile=memberSource&&state.selectedProfileRef===shell.profileRef?state.profile?.status==='ready'&&state.profile.data?.account_ref===shell.profileRef?state.profile.data:state.profile?.status==='unavailable'?memberSource:null:null;
    const recentKind=kind==='tracks'&&views.tracks==='history'?'listens':kind,friendActivityKind=friendKind==='tracks'&&friendViews.tracks==='history'?'listens':friendKind;
    const activityFor=(account_ref,kind,period)=>activityForQuery(state,{account_ref,kind,period});
    const currentRecent=kind==='albums'&&period==='week'?state.recent:state.selectedFriendRef===null?activityFor(null,recentKind,period):{status:'loading',data:null};
    const friendResource=friendMode==='comparison'?state.comparison:friend?.allowed_actions?.can_view_activity===true?activityFor(shell.friendRef,friendActivityKind,friendPeriod):deniedResource;
    const historyKey=JSON.stringify([state.scopeKey,section,section==='friends'?shell.friendRef:null,section==='friends'?friendActivityKind:recentKind,section==='friends'?friendPeriod:period,section==='friends'?friendMode:'activity']);
    const query={section,account_ref:section==='friends'?shell.friendRef:null,kind:section==='friends'?friendActivityKind:recentKind,period:section==='friends'?friendPeriod:period,...(queueMode?{homeSection:'queue',kind:'tracks',period:'week'}:{})};
    const queryKey=selectionQueryKey(query),selectionEnabled=section==='recent'&&homeSection!=='goals'||Boolean(friend&&!profileRoute&&friendMode==='activity'&&friend.allowed_actions?.can_view_activity===true);
    const source=section==='recent'||!profileRoute&&friendMode==='activity'?selectionSource(state,query):{status:'unavailable',data:null};
    const entry=selectionEntry(selections,query),expanded=entry.expanded,queue=explicitQueue.getSnapshot();
    const detailsOptions={runtime,api:queue.api,scopeKey:state.scopeKey,enabled:queueMode,selectedIds:entry.tracks?.rowIds};
    if(queueDetailsOwner)queueDetailsOwner.update(detailsOptions);else queueDetailsOwner=accept(createQueueDetails(detailsOptions,value=>{if(!disposed){queueDetails=value;render();}}));
    checkpoint();
    queueDetails=queueDetailsOwner.getSnapshot();
    const ownRecent=!queueMode&&homeSection!=='goals'&&section==='recent'&&kind==='albums'&&period==='week',customDetail=typeof readDetail==='function';
    const selectedRow=ownRecent&&selectionEnabled&&!queueMode?recentSelectionRow(source,selectedAlbum,{customDetail}):null,recentOrigin={source:'recent',account_ref:null,kind:'albums',period:'week'};
    const recentTarget=selectedRow&&(customDetail?{kind:'album',ref:selectedRow.album_ref,allowed_actions:selectedRow.allowed_actions,origin:recentOrigin}:detailSelection({...runtime.albumDetailSelection?.(selectedRow.album_ref,state.scopeKey),origin:recentOrigin}));
    const candidate=selectionEnabled&&!ownRecent&&!queueMode?resolveActivitySelection(state,query,entry.selected):null,trackCandidate=selectionEnabled&&!queueMode?resolveActivityTrackSelection(state,query,entry.tracks):null;
    const detailProvider=queueMode?queueDetails.adapter?.readAlbumProjection:customDetail?readDetail:runtime.readAlbumProjection;
    if(!queueMode)resourceLease=reconcileSelectionLease(resourceLease,{scopeKey:state.scopeKey,queryKey,descriptor:ownRecent?null:entry.tracks||entry.selected,source,target:trackCandidate?.album||trackCandidate?.artist||candidate?.target,runtime,provider:detailProvider});
    const retiredSelection=!queueMode&&resourceLease?.retired===true,resolved=retiredSelection?null:candidate,trackSelection=queueMode||retiredSelection?null:trackCandidate;
    const selectedTarget=queueMode?null:ownRecent?recentTarget:resolved?.target,artistTarget=queueMode?queueDetails.value.artist:trackSelection?.artist||(selectedTarget?.kind==='artist'?selectedTarget:null);
    const targetKey=queueMode?JSON.stringify(['queue',queueDetails.value.selectedIds,detailSelectionKey(queueDetails.value.album),detailSelectionKey(queueDetails.value.artist)]):trackSelection?JSON.stringify([entry.tracks,detailSelectionKey(trackSelection.album),detailSelectionKey(artistTarget)]):detailSelectionKey(selectedTarget);
    if(lifetime?.scopeKey!==state.scopeKey||lifetime?.queryKey!==queryKey||lifetime?.targetKey!==targetKey||lifetime?.source!==source||lifetime?.runtime!==runtime||lifetime?.provider!==detailProvider||lifetime?.enabled!==selectionEnabled) lifetime={scopeKey:state.scopeKey,queryKey,targetKey,source,runtime,provider:detailProvider,enabled:selectionEnabled,generation:++generation};
    const owner=lifetime,liveArtistDetail=artistDetail?.owner===owner?artistDetail.value:null;currentArtistDetail={owner,value:liveArtistDetail};
    const childAlbum=queueMode?null:resolveListenedAlbum(liveArtistDetail,artistTarget,entry.childAlbumRef),albumTarget=queueMode?queueDetails.value.album:childAlbum||trackSelection?.album||(selectedTarget?.kind==='album'?selectedTarget:null);
    const albumTargetKey=detailSelectionKey(albumTarget);currentAlbum={owner,key:albumTargetKey};
    const selectedQueue=queueMode&&queueDetails.value.selectedIds.length>0,hasArtist=Boolean(artistTarget||trackSelection||selectedQueue),hasAlbum=Boolean(albumTarget||selectedRow||trackSelection||selectedQueue),hasSelection=hasArtist||hasAlbum;
    const activePane=entry.pane==='artist'&&hasArtist||entry.pane==='album'&&hasAlbum?entry.pane:'recent',dashboardKeys=[section,...(hasArtist?['artist']:[]),...(hasAlbum?['album']:[])],expandedKey=dashboardKeys.length>1&&dashboardKeys.includes(expanded)?expanded:null;
    const restorationKey=JSON.stringify([section,homeSection,shell.friendRef,shell.profileRef,kind,period,views,friendKind,friendPeriod,friendViews,friendMode]);
    if(originalRestorationKey===undefined)originalRestorationKey=restorationKey;
    currentQuery={queryKey,owner};
    return {revision:ownershipRevision,state,shell,section,queueMode,friend,profile,invalidFriend,profileRoute,comparing,memberSource,memberProfile,recentKind,friendActivityKind,currentRecent,friendResource,historyKey,query,queryKey,selectionEnabled,source,entry,expanded,queue,ownRecent,customDetail,selectedRow,retiredSelection,resolved,trackSelection,selectedTarget,artistTarget,owner,liveArtistDetail,childAlbum,albumTarget,albumTargetKey,selectedQueue,hasArtist,hasAlbum,hasSelection,activePane,dashboardKeys,expandedKey,restorationKey};
  }
  function render() {
    if(disposed)return;if(constructing){pendingRender=true;return;}if(rendering){pendingRender=true;return;}rendering=true;frameRevision=ownershipRevision;
    try {
      const previous=latest;latest=derive();checkpoint();const x=latest,{state,shell,section,friend,profile,queueMode,comparing,profileRoute,currentRecent,friendResource,hasArtist,hasAlbum,hasSelection,expandedKey}=x;
      // Native selection may resume its inspect callback after a selection
      // notification synchronously changed ownership. Keep the render's token.
      const ownedTracksSelect=(...args)=>{if(x.revision===ownershipRevision&&currentQuery?.owner===x.owner)selectTracks(...args);};
      const routeKey=JSON.stringify([section,shell.friendRef,shell.profileRef]);
      if(activeRouteKey!==undefined&&activeRouteKey!==routeKey){editing=null;requestDialog=null;}activeRouteKey=routeKey;
      if(previous?.queryKey!==x.queryKey)setError('');
      if(lastFriends!==state.friends){lastFriends=state.friends;const retired=retireFriendSelections(selections,state.friends);if(retired!==selections){selections=retired;pendingRender=true;}}
      if(state.friends.status==='denied')editing=null;
      if(comparison?.selection){const owner=state.friends.data?.friends.find(person=>person.account_ref===comparison.friendRef);if(state.friends.status==='denied'||['ready','empty'].includes(state.friends.status)&&owner?.allowed_actions?.can_compare!==true)comparison={...comparison,selection:null};}
      const terminal=['ready','empty','denied'].includes(x.source.status);
      if(!queueMode&&!profileRoute&&(section!=='friends'||friendMode==='activity')) {
        if(terminal&&x.ownRecent&&selectedAlbum&&!x.selectedRow){selectedAlbum=null;pendingRender=true;}
        if((terminal||x.retiredSelection)&&!x.ownRecent&&(x.entry.selected&&!x.resolved||x.entry.tracks&&!x.trackSelection)){selections=updateSelectionEntry(selections,x.query,{selected:null,tracks:null,childAlbumRef:null,pane:'recent',expanded:null});pendingRender=true;}
        else if(x.entry.childAlbumRef&&x.liveArtistDetail&&['ready','empty','denied'].includes(x.liveArtistDetail.status)&&!x.childAlbum){selections=updateSelectionEntry(selections,x.query,{childAlbumRef:null,pane:hasArtist?'artist':'recent',expanded:null});pendingRender=true;}
      }
      if(selectedAlbum&&['ready','empty','denied'].includes(state.recent.status)&&!recentSelectionRow(state.recent,selectedAlbum,{customDetail:x.customDetail})){selectedAlbum=null;pendingRender=true;}
      if(queueMode&&queueDetails.adapter&&JSON.stringify(x.entry.tracks?.rowIds||[])!==JSON.stringify(queueDetails.value.selectedIds)){const ids=queueDetails.value.selectedIds;selections=updateSelectionEntry(selections,x.query,{tracks:ids.length?{rowIds:ids,snapshotRef:null}:null,...(!ids.length?{pane:'recent',expanded:x.expanded==='recent'?'recent':null}:{})});pendingRender=true;}
      host.dataset.homeSection=section;host.dataset.homePane=x.activePane;
      dashboard.dataset.dashboardLayout=x.dashboardKeys.length===1?'single':expandedKey?'expanded':'ordinary';if(expandedKey)dashboard.dataset.dashboardExpandedKey=expandedKey;else delete dashboard.dataset.dashboardExpandedKey;
      for(const [key,widget] of Object.entries(widgets)){widget.hidden=key==='recent'?section!=='recent':key==='friends'?section!=='friends':key==='artist'?!hasArtist:!hasAlbum;widget.dataset.dashboardWidgetState=x.dashboardKeys.length===1?'fill':expandedKey===null?'ordinary':expandedKey===key?'expanded':'suppressed';}
      widgets.recent.setAttribute('aria-label',queueMode?'Queued tracks':section==='recent'&&homeSection==='goals'?'Goals':'Recent listening');
      const leading=expandedKey?{label:'Back',icon:'back',attributes:{'data-dashboard-action':'back'},onClick:()=>resizeWidget(null)}:comparing?{label:'Back to friends',icon:'back',attributes:{'data-home-comparison-back':'true'},onClick:()=>navigate('friends')}:null;
      show('page-leading',Boolean(leading),pageHeader.slots.leading,mountButton,leading);
      show('page-comparison-identity',comparing,pageHeader.slots.identity,mountComparisonIdentity,{profile,friend});
      show('page-profile-identity',!comparing,pageHeader.slots.identity,mountProfileIdentity,{profile:profileRoute?x.memberProfile:section==='friends'&&friend?friend:profile,own:!profileRoute&&!(section==='friends'&&friend),fallbackName:profileRoute?'Profile':shell.accountName||'My music'});
      const badgeVisible=!profileRoute&&!comparing&&(section==='recent'||friend?.allowed_actions?.can_view_activity===true),badgeResource=section==='recent'?currentRecent:friendResource;
      show('page-listens',badgeVisible,pageHeader.slots.identity,mountListensBadge,{total:['ready','empty'].includes(badgeResource.status)?badgeResource.data?.total_listens:null,range:['ready','empty'].includes(badgeResource.status)?badgeResource.data?.range_label:undefined});
      show('profile-edit',!comparing&&!profileRoute&&!(section==='friends'&&friend)&&profile?.allowed_actions?.can_edit===true,pageHeader.slots.actions,mountButton,{label:'Edit profile',icon:'edit',attributes:{'data-home-profile-edit':'true'},onClick:event=>{editing={profile:latest.profile,control:event.target.closest('button')};render();}});
      show('open-friends',!comparing,pageHeader.slots.actions,mountButton,{label:'Friends',icon:'friends',attributes:{'data-home-open-friends':'true'},selected:section==='friends',onClick:()=>{if(latest.section==='recent'&&window.innerWidth>900){directoryDialog=true;render();}else navigate(latest.section==='friends'?'recent':'friends');}});
      comparisonViewHost.hidden=!comparing;
      slot('pane-navigation').hidden=!hasSelection;
      show('pane-back',hasSelection,slot('pane-back'),mountButton,{label:x.activePane==='album'&&hasArtist?'Back to Artist Info':queueMode?'Back to Queue':'Back to Recent',icon:'back',disabled:x.activePane==='recent',onClick:()=>showPane(latest.activePane==='album'&&latest.hasArtist?'artist':'recent')});
      show('pane-tabs',hasSelection,slot('pane-tabs'),mountTabs,{id:'home-selected-sections',label:'Selected resource sections',items:[['recent',queueMode?'Queue':'Recent'],...(hasArtist?[['artist','Artist Info']]:[]),...(hasAlbum?[['album','Album Info']]:[])],value:x.activePane,onChange:showPane});
      for(const [key,header] of [['recent',recentHeader],['friends',friendsHeader],['artist',artistHeader],['album',albumHeader]])show(`expand-${key}`,x.dashboardKeys.length>1&&expandedKey!==key&&x.dashboardKeys.includes(key),header.slots.leading,mountButton,{label:'Full size',icon:'expand',attributes:{'data-dashboard-action':'expand','aria-expanded':'false'},onClick:()=>resizeWidget(key)});
      mount('home-sections',recentHeader.slots.identity,mountTabs,{id:'home-recent-sections',label:'Home sections',items:section==='recent'&&props.goalsTransport?[...homeSections,['goals','Goals']]:section==='recent'?homeSections:homeSections.filter(([key])=>key!=='queue'),value:homeSection,onActivate:value=>{if(value==='goals')change(()=>{goalsVisitIntent={};});},onChange:value=>change(()=>{homeSection=value;goalsVisitIntent=value==='goals'?{}:null;})});
      syncGoalsMarker();
      show('recent-period',homeSection==='recent',recentHeader.slots.actions,mountPeriod,{value:period,onChange:value=>change(()=>{period=value;}),range:currentRecent.data?.range_label||(period==='week'?'Last 7 days':'')});
      show('recent-missing',homeSection==='recent',recentHeader.slots.actions,mountActivityMissingAction,{value:currentRecent,scopeKey:state.scopeKey,kind:x.recentKind,period,selectedRowIds:x.trackSelection?.rows.map(row=>row.id),enabled:section==='recent',onError:setError});
      show('recent-view',homeSection==='recent'&&kind!=='albums',recentHeader.slots.outsideActions,mountViewControl,{kind,value:views[kind],onChange:value=>change(()=>{views={...views,[kind]:value};})});
      show('recent-kinds',homeSection!=='queue'&&homeSection!=='goals',recentHeader.slots.content,mountTabs,{id:'home-recent-kinds',label:'Recent listening view',items:kinds,value:kind,onChange:value=>change(()=>{kind=value;kindExplicit=true;})});
      show('queue-header',homeSection==='queue'&&section==='recent',recentHeader.slots.content,mountQueueHeader,x.queue);
      slot('recent-body').className=`home-friends__widget-body ${queueMode?'gallery-scrollbar':'home-friends__recent-body'}`;
      const retryRecent=()=>kind==='albums'&&period==='week'?controller.loadRecent():controller.loadActivity({kind:latest.recentKind,period});
      show('queue-panel',queueMode,recentContent,mountQueuePanel,{...x.queue,scopeKey:state.scopeKey,selectedIds:queueDetails.value.selectedIds,onSelect:selectQueuedTracks});
      show('goals-panel',section==='recent'&&homeSection==='goals'&&Boolean(props.goalsTransport),recentContent,mountGoalsPanel,{transport:props.goalsTransport,sourceTransport:props.goalsSourceTransport,owner:props.goalsOwner,visitIntent:goalsVisitIntent,header:{actions:pageHeader.slots.actions,content:recentHeader.slots.content},isCurrent:()=>homeCurrent()&&props.shell.section!=='friends'&&homeSection==='goals'},runtime,props.goalsTransport);
      show('recent-albums',!queueMode&&homeSection!=='queue'&&homeSection!=='goals'&&kind==='albums'&&period==='week',recentContent,mountRecentAlbums,{value:state.recent,retry:retryRecent,selected:selectedAlbum,selectionMode:x.customDetail?'details':'native',onSelect:selectRecentAlbum,onError:setError});
      const activityVisible=homeSection!=='queue'&&homeSection!=='goals'&&!(kind==='albums'&&period==='week');recentActivityHost.hidden=!activityVisible;
      show('recent-status',activityVisible,recentActivity,mountStatus,{value:currentRecent,label:'Listening activity',retry:retryRecent});
      show('recent-activity',activityVisible&&['ready','empty'].includes(currentRecent.status)&&Boolean(currentRecent.data),recentActivity,mountActivityPanel,{scopeKey:state.scopeKey,readDetail:props.readDetail,account_ref:null,period,value:currentRecent,kind:x.recentKind,selectedResourceId:x.resolved?.row.id??null,onResourceSelect:selectResource,onTracksSelect:ownedTracksSelect,selectedTrackIds:x.trackSelection?.rows.map(row=>row.id),listenedAlbumsRef:value=>{if(recentListenedAlbumsHost!==value){recentListenedAlbumsHost=value;pendingRender=true;}},view:views[kind]==='list'?'rows':views[kind]});
      if(activityVisible&&['ready','empty'].includes(currentRecent.status)&&currentRecent.data)history(currentRecent,recentHistory,'recent-history');else remove('recent-history');
      friendsHeader.update({id:'home-friends',className:'home-friends__widget-header',hidden:comparing&&!hasSelection});
      const friendTitle=child('friends-title',friendsHeader.slots.identity,'h2');friendTitle.className=friend&&friendMode==='comparison'?'sr-only':'';friendTitle.textContent=profileRoute?'Profile':friend?friendMode==='comparison'?'Taste comparison':'Recent':'Friends';
      show('friends-back',section==='friends'&&!comparing,friendsHeader.slots.actions,mountButton,{label:friend||profileRoute?'Back to friends':'Back to Home',icon:'back',onClick:()=>navigate(latest.friend||latest.profileRoute?'friends':'recent')});
      show('friend-missing',Boolean(friend&&friendMode==='activity'),friendsHeader.slots.actions,mountActivityMissingAction,{value:friendResource,scopeKey:state.scopeKey,account_ref:friend?.account_ref,kind:x.friendActivityKind,period:friendPeriod,selectedRowIds:x.trackSelection?.rows.map(row=>row.id),enabled:section==='friends',onError:setError});
      show('friend-view',Boolean(friend&&friendMode==='activity'),friendsHeader.slots.outsideActions,mountViewControl,{kind:friendKind,value:friendViews[friendKind],onChange:value=>change(()=>{friendViews={...friendViews,[friendKind]:value};})});
      show('invalid-friend',x.invalidFriend,friendsBody,mountStatus,{value:{status:'denied'},label:"This friend's activity"});
      show('member-profile',profileRoute,friendResult,mountMemberProfile,{controller,accountRef:shell.profileRef,showIdentity:false,onActivity:ref=>openFriend(ref,'activity'),onCompare:ref=>openFriend(ref,'comparison')});
      show('friends-directory',!profileRoute&&!friend,friendResult,mountFriendsDirectory,{value:state.friends,selected:state.selectedFriendRef,controller,onSelect:ref=>navigate('friends',ref),onProfile:openProfile,onRequest:openRequest});
      friendActions.hidden=!friend||profileRoute;friendControls.hidden=!friend||profileRoute;
      show('friend-activity-action',Boolean(friend&&!profileRoute),friendActions,mountButton,{label:'Recent',selected:friendMode==='activity',disabled:friend?.allowed_actions?.can_view_activity!==true,onClick:()=>change(()=>{friendMode='activity';})});
      show('friend-compare-action',Boolean(friend&&!profileRoute),friendActions,mountButton,{label:'Compare with you',icon:'compare',selected:friendMode==='comparison',disabled:friend?.allowed_actions?.can_compare!==true,onClick:()=>change(()=>{friendMode='comparison';})});
      mount('friend-kinds',friendControls,mountTabs,{id:'home-friend-kinds',label:friendMode==='comparison'?'Comparison view':'Friend activity view',items:kinds,value:friendKind,onChange:value=>change(()=>{friendKind=value;})});
      show('friend-period',Boolean(friend&&!profileRoute),friendControls,mountPeriod,{value:friendPeriod,onChange:value=>change(()=>{friendPeriod=value;}),total:friendResource.data?.total_listens,range:friendResource.data?.range_label});
      const retryFriend=()=>friendMode==='comparison'?controller.loadComparison({kind:friendKind,period:friendPeriod}):controller.loadActivity({kind:latest.friendActivityKind,period:friendPeriod});
      const compareActive=Boolean(friend&&!profileRoute&&friendMode==='comparison');
      if(!compareActive&&friendControls.parentNode!==friendsBody)friendsBody.insertBefore(friendControls,friendResult);
      show('comparison',compareActive,friendResult,mountComparisonPanel,{value:friend?.allowed_actions?.can_compare===true?friendResource:deniedResource,friendName:friend?.display_name,friendRef:friend?.account_ref,kind:friendKind,period:friendPeriod,presentation:comparison,onPresentationChange:value=>{comparison=value;render();},headerControls:friendControls,viewControlsHost:comparisonViewHost,retry:retryFriend,onUserIntent:()=>{pendingScroll=null;}});
      const friendActivityVisible=Boolean(friend&&!profileRoute&&friendMode==='activity');
      show('friend-status',friendActivityVisible,friendResult,mountStatus,{value:friendResource,label:'Friend activity',retry:retryFriend});
      show('friend-activity',friendActivityVisible&&['ready','empty'].includes(friendResource.status),friendResult,mountActivityPanel,{scopeKey:state.scopeKey,readDetail:props.readDetail,account_ref:friend?.account_ref,period:friendPeriod,nowPlaying:nowPlayingValue,value:friendResource,kind:x.friendActivityKind,selectedResourceId:x.resolved?.row.id??null,onResourceSelect:selectResource,onTracksSelect:ownedTracksSelect,selectedTrackIds:x.trackSelection?.rows.map(row=>row.id),listenedAlbumsRef:value=>{if(friendListenedAlbumsHost!==value){friendListenedAlbumsHost=value;pendingRender=true;}},view:friendViews[friendKind]==='list'?'rows':friendViews[friendKind]});
      if(friendActivityVisible&&['ready','empty'].includes(friendResource.status))history(friendResource,friendHistory,'friend-history');else remove('friend-history');
      show('comparison-next',compareActive&&['ready','empty'].includes(friendResource.status)&&Boolean(friendResource.data?.next_cursor),friendResult,mountButton,{label:'Next page',onClick:()=>controller.loadComparison({kind:friendKind,period:friendPeriod,cursor:latest.friendResource.data.next_cursor})});
      show('friend-mutation',['loading','error','denied','unavailable'].includes(state.mutation.status),mutationHost,mountStatus,{value:state.mutation,label:'Friend changes'});
      const detailRuntime=queueMode?queueDetails.runtime:runtime;
      for(const [which,header,body,target,present] of [['artist',artistHeader,artistProjection,x.artistTarget,hasArtist],['album',albumHeader,albumProjection,x.albumTarget,hasAlbum]]) {
        const heading=child(`${which}-heading`,header.slots.identity,'h2');heading.textContent=which==='artist'?'Artist Info':'Album Info';
        show(`${which}-close`,present,header.slots.finalAction,mountButton,{label:which==='artist'?'Close Artist Info':'Close Album Info',icon:'close',onClick:()=>closeSelection(which)});
        const missing=present&&!target&&(x.trackSelection||x.selectedQueue);let note=slots.get(`${which}-missing`);if(missing){note=child(`${which}-missing`,body,'p');note.className='home-friends__muted';note.textContent=`Selected tracks do not share one available ${which}.`;}else remove(`${which}-missing`);
        const owner=x.owner,key=x.albumTargetKey,revision=ownershipRevision;
        show(`${which}-detail`,present&&!missing,body,mountResourceDetail,{isOwnerCurrent:()=>!disposed&&revision===ownershipRevision,scopeKey:state.scopeKey,readDetail:queueMode?queueDetails.adapter?.readAlbumProjection:props.readDetail,selection:target,listenedAlbumsHost:which==='artist'&&!queueMode&&x.query.kind==='artists'?(section==='friends'?friendListenedAlbumsHost:recentListenedAlbumsHost):undefined,onSelectAlbum:which==='artist'&&!queueMode?selectListenedAlbum:undefined,
          onDetailChange:(value,selected)=>{if(which==='artist'){if(!targetCurrent()||latest.owner!==owner||!sameSelectionTarget(selected,latest.artistTarget))return;currentArtistDetail={owner,value};if(artistDetail?.owner!==owner||artistDetail.value!==value){artistDetail={owner,value};render();}}else{if(!albumCurrent()||latest.owner!==owner||latest.albumTargetKey!==key||!sameSelectionTarget(selected,latest.albumTarget))return;if(albumDetail?.owner!==owner||albumDetail.value!==value){albumDetail={owner,value};render();}}},onError:message=>{if(which==='artist'?targetCurrent():albumCurrent())setError(message);}},detailRuntime,`${owner.generation}:${which}${which==='album'?`:${x.albumTargetKey}`:''}`);
      }
      albumSummary.hidden=!x.selectedRow;if(x.selectedRow){albumSummary.replaceChildren();for(const [label,value] of [['Listen events',x.selectedRow.listen_event_count],['Listened tracks',x.selectedRow.listened_track_count],['Album tracks',x.selectedRow.album_track_count]]){element(albumSummary,'dt').textContent=label;element(albumSummary,'dd').textContent=metric(value);}}
      renderDialogs();checkpoint();finishRender(x);
    } catch(error) {if(error!==retiredRender){dispose();throw error;}} finally {rendering=false;if(!disposed&&pendingProps){props=pendingProps;pendingProps=null;pendingRender=true;}if(!disposed&&pendingRender){pendingRender=false;queueMicrotask(render);}}
  }
  function finishRender(x) {
    checkpoint();const {state,shell,section}=x;
    nowPlaying.update({read:props.readNowPlaying,scopeKey:state.scopeKey,accountRef:shell.friendRef,allowed:section==='friends'&&!x.profileRoute&&friendMode==='activity'&&x.friend?.allowed_actions?.can_view_activity===true});
    checkpoint();const recentKey=JSON.stringify([section,kind,x.recentKind,period]);
    if(loadedRecentKey!==recentKey){loadedRecentKey=recentKey;if(section==='recent'){controller.selectFriend(null);checkpoint();if(!(kind==='albums'&&period==='week'))controller.loadActivity({kind:x.recentKind,period});}}
    checkpoint();const friendKey=JSON.stringify([section,shell.profileRef,shell.friendRef,friendMode,friendKind,x.friendActivityKind,friendPeriod]);
    if(loadedFriendKey!==friendKey||loadedFriendResource!==state.friends||loadedMembersResource!==state.members){loadedFriendKey=friendKey;loadedFriendResource=state.friends;loadedMembersResource=state.members;if(section==='friends')loadFriendRoute(controller,{profileRef:shell.profileRef,friendRef:shell.friendRef,mode:friendMode,kind:friendMode==='comparison'?friendKind:x.friendActivityKind,period:friendPeriod});}
    checkpoint();presentation={homeSection,kind,kindExplicit,period,views,friendKind,friendPeriod,friendViews,friendMode,selectedAlbum,expanded:x.expanded,comparison,selectionPresentation:selections};
    const serialized=JSON.stringify(presentation);if(serialized!==lastPresentation){lastPresentation=serialized;runtime.savePresentation({...presentation,scroll},shell);}
    checkpoint();if(pendingScroll){
      if(x.restorationKey!==originalRestorationKey)pendingScroll=null;
      else {const restore=scrollRestoreState({section,friendRef:shell.friendRef,selectedFriendRef:state.selectedFriendRef,profileRef:shell.profileRef,selectedProfileRef:state.selectedProfileRef,profileExists:Boolean(x.memberSource),profileStatus:state.profile?.status,friendExists:state.friends.data?.friends.some(person=>person.account_ref===shell.friendRef),friendsStatus:state.friends.status,recentStatus:x.currentRecent.status,historyStatus:x.friendResource.status});
        if(restore==='discard')pendingScroll=null;else if(restore==='ready'){const recentBody=recentScrollBody();if(recentBody)recentBody.scrollTop=pendingScroll.recent;friendsBody.scrollTop=pendingScroll.friends;host.scrollTop=pendingScroll.page;pendingScroll=null;}}
    }
    const restorePane=(name,key,node,ready)=>{if(!ready||!node||restoredPaneScroll[name]===key)return;restoredPaneScroll[name]=key;if(selections.some(value=>selectionQueryKey(value.query)===x.queryKey))node.scrollTop=x.entry.scroll[name];};
    restorePane('source',x.queryKey,sourceBody(),x.queueMode?Boolean(x.queue.api):['ready','empty'].includes(x.source.status));
    restorePane('artist',`${x.owner.generation}:${detailSelectionKey(x.artistTarget)}`,artistBody,x.hasArtist&&x.liveArtistDetail?.status==='ready');
    restorePane('album',`${x.owner.generation}:${x.albumTargetKey}`,albumBody,x.hasAlbum&&albumDetail?.owner===x.owner&&albumDetail.value.status==='ready');
    checkpoint();
    if(sizeFocus){const selector=x.expandedKey?'[data-dashboard-action="back"]':`[data-home-widget="${sizeFocus}"] [data-dashboard-action="expand"]`;sizeFocus=null;host.querySelector(selector)?.focus({preventScroll:true});}
    const phone=window?.matchMedia?.(HOME_PHONE_QUERY).matches===true;
    checkpoint();
    if(selectedFocus&&!(phone&&x.activePane!=='recent')){const pending=selectedFocus;selectedFocus=null;if(pending.queryKey===x.queryKey){const scope=widgets[section];const control=pending.control?.isConnected&&scope.contains(pending.control)?pending.control:[...scope.querySelectorAll('[data-gallery-card-intent="select"],[data-home-activity-select],[data-home-artist-select]')].find(button=>[button.getAttribute('data-gallery-card-ref'),button.getAttribute('data-home-activity-select'),button.getAttribute('data-home-artist-select')].includes(pending.ref))||scope.querySelector('[data-in-page-tab][aria-selected="true"]');if(control&&!control.closest('[hidden],[inert],[data-dashboard-widget-state="suppressed"]'))control.focus({preventScroll:true});}}
    checkpoint();
    if(phone&&x.activePane!=='recent'){const active=document.activeElement,focusedPane=active?.closest?.('[data-home-widget]')?.getAttribute('data-home-widget');if(!active?.isConnected||active===document.body||focusedPane&&focusedPane!==x.activePane)host.querySelector(`[data-in-page-tab="${x.activePane}"]`)?.focus({preventScroll:true});}
    checkpoint();
    if(!editing&&profileFocus){const pending=profileFocus;profileFocus=null;let control=pending.control?.isConnected?pending.control:host.querySelector('[data-home-profile-edit]');if(control?.closest('[inert]'))control=control.closest('[data-shared-header]')?.querySelector('[data-header-tools]');if(pending.section===section&&pending.friendRef===shell.friendRef&&control&&!control.closest('[hidden],[inert]'))control.focus({preventScroll:true});}
    checkpoint();
    // Header owners measure child slots only after the consumer has populated them.
    pageHeader.update({id:'home-page',className:'home-friends__page-header'});checkpoint();recentHeader.update({id:'home-recent',className:'home-friends__widget-header home-friends__recent-header'});checkpoint();artistHeader.update({id:'home-artist',className:'home-friends__widget-header'});checkpoint();albumHeader.update({id:'home-album',className:'home-friends__widget-header'});
  }
  function rememberScroll(event) {
    if(disposed||!latest)return;const target=event.target,x=latest,selectionPane=target===sourceBody()?'source':target===artistBody?'artist':target===albumBody?'album':null;
    if(selectionPane&&x.queryKey&&Number.isFinite(target.scrollTop)&&target.scrollTop>=0)selections=updateSelectionEntry(selections,x.query,{scroll:{[selectionPane]:target.scrollTop}});
    if(!updateOwnedScroll(scroll,target,{page:host,recent:recentScrollBody(),friends:friendsBody}))return;
    pendingScroll=null;clearTimeout(scrollTimer);const expected=props.shell;
    scrollTimer=setTimeout(()=>{scrollTimer=null;if(!disposed)runtime.savePresentation({...presentation,selectionPresentation:selections,scroll},expected);},150);
  }
  host.addEventListener('scroll',rememberScroll,true);lifetimeScope.defer(()=>host.removeEventListener('scroll',rememberScroll,true));
  const media=window?.matchMedia?.(HOME_PHONE_QUERY),resize=()=>{if(!kindExplicit){const next=initialHomeKind(null,media.matches);if(next.kind!==kind){kind=next.kind;kindExplicit=next.kindExplicit;render();}}};media?.addEventListener?.('change',resize);lifetimeScope.defer(()=>media?.removeEventListener?.('change',resize));
  function update(next) {if(disposed)return;if(next.runtime!==runtime||next.controller!==controller)throw new Error('Home/Friends session ownership changed; dispose and remount this view.');if(!sameOwnership(pendingProps||props,next))ownershipRevision++;if(rendering){pendingProps=next;return;}props=next;render();}
  constructing=false;render();
  return {element:host,update,dispose};
  } catch(error) {dispose();if(error!==retiredRender)throw error;return {element:host,update() {},dispose};}
}
