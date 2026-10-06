/* Isolated review adapter. Native shell, Gallery, Details, tree and player stay single-instance. */
(function () {
  const q = selector => document.querySelector(selector) || (selector.startsWith('#mock-') ? window.MockRealLayout?.portals?.[selector.slice(1)] : null);
  const positions = new Map();
  const mark = node => { if (node && !positions.has(node)) { const marker = document.createComment('native home'); node.before(marker); positions.set(node, marker); } };
  const restore = node => { const marker = positions.get(node); if (marker?.parentNode && (node.parentNode !== marker.parentNode || marker.nextSibling !== node)) marker.after(node); };
  const make = (tag, id, className = '') => { const node = document.createElement(tag); node.id = id; node.className = className; return node; };
  let currentMode = 'gallery', currentKind = 'albums', placement = null, currentAlbum = null, callbacks = {}, initialized = false;
  let recentContext = { person: 'Alex Morgan', period: 'Last week', kind: 'albums' };
  let albumEntryIntent = null;
  let renderingAlbum = false, lastClosed = false, desktopFocusedAlbumKey='', recentView='cards';
  let lightboxPopHandled=false,fullArtGesture={},completeLightboxNavigation=()=>{},sidebarMode='artists',socialOwners={},lastListenTimeZone='';
  let sharedViewRoot=null,galleryViewNodes=[],nativeViewControlSync=null,viewContext={context:'gallery',scope:''};
  const originalTitle=document.title;
  const modal = () => q('#track-modal');
  let previewChoiceTrigger=null,choiceEscapeHeld=false;
  function choiceDropdown(trigger,options){const slim=trigger.classList.contains('mock-choice-trigger--slim');openUtilityChoiceDropdown(trigger,slim?{...options,matchTriggerWidth:true}:options);previewChoiceTrigger=utilityChoiceTrigger===trigger?trigger:null;}
  function handleChoiceEscape(event){
    if(event.key!=='Escape')return;
    const menu=document.querySelector('.settings-foobar-format-menu'),owned=menu&&previewChoiceTrigger&&utilityChoiceTrigger===previewChoiceTrigger;
    if(!owned&&!choiceEscapeHeld)return;
    if(owned){const top=getTopmostOpenModal();if(top&&Number(getComputedStyle(top).zIndex)>Number(getComputedStyle(menu).zIndex))return;}
    event.preventDefault();event.stopImmediatePropagation();
    if(event.repeat||event.isComposing||choiceEscapeHeld)return;
    choiceEscapeHeld=true;const trigger=previewChoiceTrigger;utilityFoobarFormatCleanup?.();previewChoiceTrigger=null;if(trigger?.isConnected)trigger.focus({preventScroll:true});
  }
  const recent = () => ['home', 'profile', 'recent'].includes(currentMode);
  // Recent selection belongs to its body, independently of native card focus.
  // Only structural whitespace is eligible; card children and text never are.
  function isRecentAlbumEmptySpace(root, target) {
    const element=target?.nodeType===1?target:target?.parentElement;
    if(!root.isConnected||!element||!root.contains(element)||element.closest('[hidden],[inert],[aria-hidden="true"],.album-card,button,a,input,select,textarea,[contenteditable],[role="button"],[data-track-row-path]'))return false;
    return element===root||element.matches('#mock-recent-content,#mobile-home-albums,.mock-recent-composition[data-recent-kind="albums"],.mock-native-home-content,.mock-flat-gallery,.mock-fluid-gallery,.mobile-home-grid');
  }
  function bindRecentAlbumEmptySpace(root, {context, onClear}) {
    let gesture=null;
    const reset=()=>{gesture=null;};
    const selectionActive=()=>root.ownerDocument.getSelection?.()?.isCollapsed===false;
    const scrollers=()=>{const rows=[];for(let node=root;node;node=node.parentElement)rows.push({node,left:node.scrollLeft,top:node.scrollTop});return rows;};
    const moved=event=>Math.hypot(event.clientX-gesture.x,event.clientY-gesture.y)>6;
    const valid=event=>gesture&&context()===gesture.context&&isRecentAlbumEmptySpace(root,event.target)&&!selectionActive()&&!gesture.scroll.some(row=>row.node.scrollLeft!==row.left||row.node.scrollTop!==row.top)&&!moved(event);
    const down=event=>{
      reset();const scope=context();
      if(!scope||event.defaultPrevented||event.button!==0||event.isPrimary===false||event.altKey||event.ctrlKey||event.metaKey||event.shiftKey||!isRecentAlbumEmptySpace(root,event.target))return;
      gesture={id:event.pointerId,x:event.clientX,y:event.clientY,context:scope,scroll:scrollers(),released:false};
    };
    const move=event=>{if(gesture&&(event.pointerId!==gesture.id||moved(event)))reset();};
    const up=event=>{if(!gesture)return;if(event.pointerId!==gesture.id||event.defaultPrevented||!valid(event)){reset();return;}gesture.released=true;};
    // Touch releases implicit capture before click and may emit pointerleave.
    const leave=()=>{if(!gesture?.released)reset();};
    const click=event=>{
      const clear=gesture?.released&&event.detail>0&&event.button===0&&!event.defaultPrevented&&!event.altKey&&!event.ctrlKey&&!event.metaKey&&!event.shiftKey&&valid(event);
      reset();if(clear)onClear();
    };
    const handlers={pointerdown:down,pointermove:move,pointerup:up,pointercancel:reset,pointerleave:leave,dragstart:reset,contextmenu:reset,scroll:reset,wheel:reset,click};
    for(const [type,handler] of Object.entries(handlers))root.addEventListener(type,handler,{capture:true,passive:true});
    return ()=>{reset();for(const [type,handler] of Object.entries(handlers))root.removeEventListener(type,handler,true);};
  }
  function paintRecentAlbumSelection(id, albumKey) {
    const root=q('#'+id);if(!root)return;
    for(const card of root.querySelectorAll('.album-card')){
      const selected=!!albumKey&&card.querySelector('[data-open-tracklist="1"]')?.dataset.albumKey===albumKey;
      card.dataset.mockRecentAlbumSelected=String(selected);
      for(const trigger of card.querySelectorAll('button[data-open-tracklist="1"]'))trigger.setAttribute('aria-pressed',String(selected));
    }
  }
  function clearRecentAlbumDetails() {
    if(!recent()||currentKind!=='albums'||placement==='modal')return;
    // Retire the native Details model without invoking its page-dismiss owner.
    // This invalidates late hydration while leaving player and queue untouched.
    modal().hidden=true;currentAlbum=null;lastClosed=true;
    invalidatePendingTrackModalLoad();resumeAllGalleryCoverLoadsAfterTrackModalActions();
    state.modalReleases=[];state.modalReleaseIndex=0;hideVersionContextMenu();clearTrackModalRenderedState();
    q('[data-artist-info-overlay]').hidden=true;
    q('#mock-album-placeholder').hidden=false;q('#mock-artist-placeholder').hidden=false;q('#mock-album-native-actions').hidden=true;
  }
  function clearArtistAlbumDetails() {
    if(currentMode!=='artist-page'||placement==='modal')return;
    // Close only this selected pane. Never enter the native dismiss/Back owner
    // or hide Artist Info, and invalidate any late Album hydration.
    modal().hidden=true;currentAlbum=null;lastClosed=true;
    invalidatePendingTrackModalLoad();resumeAllGalleryCoverLoadsAfterTrackModalActions();
    state.modalReleases=[];state.modalReleaseIndex=0;hideVersionContextMenu();clearTrackModalRenderedState();
    q('#mock-album-panel').hidden=true;
    const slot=q('[data-mock-artist-album-slot]');if(slot)slot.hidden=true;
  }
  // Intent is metadata on the native resource entry, never a second Back stack.
  // Native openTrackModal presents before hydration; explicit options must be
  // available at that boundary and the same entry must retain them on replay.
  function resolveAlbumExpansionIntent(descriptor) {
    if(descriptor?.kind!=='album')return false;
    if(albumEntryIntent?.albumKey===descriptor.albumKey)return albumEntryIntent.expanded;
    const url=new URL(location.href);
    if(url.searchParams.get('mock_expanded')==='album')return true;
    if(url.searchParams.get('mobile_page')!=='album')return false;
    const saved=history.state?.mobilePages?.find(page=>page.kind==='album'&&page.albumKey===descriptor.albumKey);
    return saved?.mockExpandedModule===true;
  }
  function syncAlbumExpansionUrl() {
    const active=mobilePageState.pages.at(-1);if(active?.kind!=='album')return;
    const url=new URL(location.href),before=url.href;
    if(active.mockExpandedModule)url.searchParams.set('mock_expanded','album');
    else if(url.searchParams.get('mock_expanded')==='album')url.searchParams.delete('mock_expanded');
    // The native owner already created/replaced the entry. Annotate that exact
    // entry only, leaving its parent position, stack, focus and scroll intact.
    if(url.href!==before)history.replaceState(history.state,'',url);
  }
  function syncAlbumReturnAction() {
    const back=q('#mobile-back-button');if(!back)return;
    const active=mobilePageState.pages.at(-1),foreground=placement==='full'&&(!usesMobilePageLayout()||active?.kind==='album');
    const descriptor=active?.kind==='album'?active:mobilePageDescriptor('album',currentAlbum);
    const expanded=foreground&&resolveAlbumExpansionIntent(descriptor);
    const label=expanded?'Collapse Album details':'Back';
    back.setAttribute('aria-label',label);back.title=label;
    back.dataset.mockReturnAction=expanded?'collapse':'back';
    const glyph=back.querySelector('svg path');
    if(glyph)glyph.setAttribute('d',expanded?'M3 9h6V3M21 9h-6V3M9 21v-6H3M15 21v-6h6M3 3l6 6M21 3l-6 6M3 21l6-6M21 21l-6-6':'m10 5-7 7 7 7M3 12h18');
  }
  function initialize() {
    if (initialized) return; initialized = true;
    const nativeArtistInfo=openGalleryArtistInfo;
    openGalleryArtistInfo=anchor=>openArtistInfoPreview(anchor,nativeArtistInfo);
    // Native Gallery/mobile navigation restore their own positions; the added
    // preview surfaces do likewise. Avoid a second browser restoration of a
    // temporarily hidden custom scroll region during the same history turn.
    history.scrollRestoration='manual';
    let descriptionsQueued=false;new MutationObserver(()=>{if(descriptionsQueued)return;descriptionsQueued=true;queueMicrotask(()=>{descriptionsQueued=false;describeButtons();});}).observe(document.body,{childList:true,subtree:true});describeButtons();
    const main = q('#shell-main-surface'), bar = q('[data-gallery-bar-instance="gallery"]'), scroll = q('#albums-scroll'), info = q('[data-artist-info-overlay]');
    // The native breakpoint scanner must not promote a component hosted inside
    // a module or transitionary modal into a different page/history entry.
    // Mount the unchanged 0.9.48 Home owner once, then supply data only to its
    // existing panels. Route visibility is local to this standalone preview.
    shouldShowMobileHome = () => true;
    renderMobileHome();
    shouldShowMobileHome = () => usesMobilePageLayout() && ['home','profile'].includes(currentMode);
    for(const key of ['tracks','albums','artists']){
      const panel=q('#mobile-home-'+key);panel.replaceChildren();panel.classList.remove('mobile-home-empty');
    }
    const nativeWriteMobilePageHistory=writeMobilePageHistory;
    writeMobilePageHistory=(...args)=>{const result=nativeWriteMobilePageHistory(...args);syncAlbumExpansionUrl();return result;};
    const presentNativePage = presentMobilePage;
    presentMobilePage = descriptor => {
      if(descriptor?.kind==='album'&&['embedded','modal'].includes(placement))return false;
      if(descriptor?.kind==='album')descriptor={...descriptor,mockExpandedModule:resolveAlbumExpansionIntent(descriptor)};
      if(descriptor?.kind==='album'&&placement==='full'&&!usesMobilePageLayout()){showDesktopAlbumPage(descriptor);return true;}
      if(descriptor?.kind==='album'&&placement==='full'&&usesMobilePageLayout()&&!mobilePageState.pages.length&&new URL(location.href).searchParams.get('mock')==='album'){
        const snapshot=history.state||{};
        history.replaceState({...snapshot,mobilePages:[{...descriptor,parentPosition:callbacks.albumOriginPosition?.()??snapshot.albumHavenNavigationPosition}]},'',location.href);
        const restoring=mobilePageState.restoring;mobilePageState.restoring=true;
        try{const result=presentNativePage(descriptor);writeMobilePageHistory('replace');return result;}finally{mobilePageState.restoring=restoring;}
      }
      const result=presentNativePage(descriptor);
      // Re-presenting the same album skips the native push. If an explicit
      // entry intent changed, ask its existing owner to replace its metadata.
      const saved=history.state?.mobilePages?.find(page=>page.kind===descriptor?.kind&&page.albumKey===descriptor?.albumKey);
      if(result&&descriptor?.kind==='album'&&!mobilePageState.restoring&&saved?.mockExpandedModule!==descriptor.mockExpandedModule)writeMobilePageHistory('replace');
      return result;
    };
    const nativeDismiss=dismissMobilePage;
    dismissMobilePage=kind=>{
      const owned=kind==='album'&&!mobilePageState.cleaning&&mobilePageState.pages.some(page=>page.kind==='album');
      const dismissed=nativeDismiss(kind);
      // Native direct-entry fallback replaces history synchronously and emits
      // no popstate. Mirror its completed return; never request another Back.
      if(owned&&dismissed&&!mobilePageState.pages.some(page=>page.kind==='album'))callbacks.albumReturned?.();
      return dismissed;
    };
    // Every native Album entry, including player artwork, reaches this owner.
    // Hydration/history replay remain the original renderer's responsibility.
    const nativeDetailsHeader=buildAlbumDetailsHeaderHtml;buildAlbumDetailsHeaderHtml=config=>nativeDetailsHeader(placement==='embedded'&&config?.variant!=='copy'?{...config,layout:'stacked_bar'}:config);
    const nativeOpen=openTrackModal;
    openTrackModal=(album,options={})=>{
      if(!renderingAlbum&&!mobilePageState.restoring&&options.foreground!==false&&callbacks.albumPage){callbacks.albumPage(album,options);return;}
      const previousIntent=albumEntryIntent;
      albumEntryIntent=placement==='full'&&typeof options.expandedModule==='boolean'?{albumKey:String(getAlbumRequestKey(album)||''),expanded:options.expandedModule}:null;
      try{return nativeOpen(album,options);}finally{albumEntryIntent=previousIntent;}
    };
    installLightboxPreview();
    const nativeActivateTrack=activateSharedTrackButton;
    activateSharedTrackButton=(button,options)=>button?.dataset.trackPath?.startsWith('mock-track:')?previewTrack(button,options):nativeActivateTrack(button,options);
    const nativeEnded=handleStreamingPlaybackEnded;let endedIdentity='';handleStreamingPlaybackEnded=event=>{const path=String(event?.trackPath||'');if(!path.startsWith('mock-track:'))return nativeEnded(event);const identity=[event.generation,event.streamId,path].join(':');if(identity===endedIdentity||path!==state.player.current?.path)return;endedIdentity=identity;callbacks.queueStep?.('ended');};
    const nativePlayerUi=updatePlayerUi;updatePlayerUi=(...args)=>{const result=nativePlayerUi(...args);projectTablePlayback();return result;};
    document.addEventListener('pointerover',event=>{const cell=event.target.closest('[data-track-duration-path]');if(cell?.dataset.mockRemaining)cell.textContent=cell.dataset.mockRemaining;});document.addEventListener('pointerout',event=>{const cell=event.target.closest('[data-track-duration-path]');if(cell?.dataset.mockElapsed)cell.textContent=cell.dataset.mockElapsed;});
    const nativeAlbumHeaderSync=syncMobileAlbumHeader;syncMobileAlbumHeader=(...args)=>{const result=nativeAlbumHeaderSync(...args);syncAlbumActionHost();syncAlbumReturnAction();return result;};
    const nativePageShell=syncMobilePageShell;
    syncMobilePageShell=()=>{nativePageShell();if(currentMode==='album'&&placement==='full'&&!usesMobilePageLayout())showDesktopAlbumPage(mobilePageDescriptor('album',currentAlbum));syncAlbumReturnAction();};
    // Recent owns an information-bearing view preference. The ordinary native
    // Gallery model and its No info choice remain independent and unchanged.
    const nativeControls=updateGalleryMainControls,nativeTransition=transitionGalleryMain;
    sharedViewRoot=q('#gallery-view-cluster-options');mark(sharedViewRoot);galleryViewNodes=[...sharedViewRoot.childNodes];nativeViewControlSync=nativeControls;
    updateGalleryMainControls=()=>{
      const model=ensureGalleryMainState(),saved=model.view,inRecent=recent(),covers=q('[data-gallery-view-choice="covers"]');
      if(covers){covers.hidden=false;covers.disabled=false;covers.removeAttribute('aria-disabled');}
      if(inRecent){recentView=normalizeGalleryView(recentView);model.view=recentView;}
      try{nativeControls();}finally{model.view=saved;}
      if(covers&&inRecent){covers.hidden=true;covers.disabled=true;covers.setAttribute('aria-disabled','true');}
    };
    transitionGalleryMain=action=>{
      if(recent()&&action?.type==='set-view'){
        if(!['cards','list'].includes(action.view))return;
        recentView=action.view;updateGalleryMainControls();callbacks.galleryRendered?.();return;
      }
      return nativeTransition(action);
    };
    let searchCommitDepth=0;
    const nativeCommit=commitGallerySearchQuery,nativeFetch=fetchAndRender,nativeRestoreSearch=tryRestoreClearedSearchView;
    commitGallerySearchQuery=(...args)=>{searchCommitDepth++;try{return nativeCommit(...args);}finally{searchCommitDepth--;}};
    fetchAndRender=(...args)=>{closeViewControl();if(searchCommitDepth)callbacks.beforeNativeGallery?.();return nativeFetch(...args);};
    tryRestoreClearedSearchView=(...args)=>{const restored=nativeRestoreSearch(...args);if(restored&&searchCommitDepth)callbacks.beforeNativeGallery?.();return restored;};
    [bar, scroll, modal(), info].forEach(mark);
    q('.app-bar--library .app-bar-brand').setAttribute('aria-label','Album Haven Home');
    if (typeof mobileHomeBarPosition !== 'undefined') mark(mobileHomeBarPosition);
    main.prepend(make('div', 'mock-heading'));mark(q('#mock-heading'));
    const workspace = make('div', 'mock-workspace');
    const activity = make('section', 'mock-activity', 'mock-module');
    const recentBody = make('div', 'mock-recent-body', 'gallery-scrollbar');
    recentBody.append(make('div', 'mock-recent-content'));
    for(const root of [recentBody,q('#mobile-home-recent')])bindRecentAlbumEmptySpace(root,{context:()=>recent()&&currentKind==='albums'&&placement!=='modal'?[currentMode,recentContext.person,recentContext.period].join(':'):null,onClear:()=>callbacks.recentAlbumCleared?.()});
    activity.append(recentBody,make('div','mock-playlist-content','gallery-scrollbar'));bar.querySelector('.gallery-bar__actions').append(make('span','mock-playlist-expand'),make('span','mock-playlist-header-actions'));
    const albumPanel = make('section', 'mock-album-panel', 'mock-module');
    const albumHeader = make('header', 'mock-album-header', 'mock-module-header');
    const albumTitle = make('strong', 'mock-album-heading'); // React owns this one shared title slot.
    const albumActions = make('div', 'mock-album-actions', 'mock-header-actions gallery-scrollbar');albumActions.setAttribute('role','toolbar');albumActions.setAttribute('aria-label','Album actions');
    albumActions.append(make('span', 'mock-album-expand'), make('span', 'mock-album-native-actions'), make('span', 'mock-artist-album-close'));
    albumHeader.append(albumTitle, albumActions); albumPanel.append(albumHeader, make('div', 'mock-album-preferences'));const albumPlaceholder=make('p','mock-album-placeholder','mock-empty');albumPlaceholder.textContent='Select an album or a song to see the details';albumPanel.append(albumPlaceholder);
    const artistPanel = make('section', 'mock-artist-panel', 'mock-module');
    const artistHeader = make('header', 'mock-artist-header', 'mock-module-header'); artistHeader.innerHTML = '<div id="mock-artist-heading"></div><div class="mock-header-actions"><span id="mock-artist-expand"></span></div>'; 
    artistPanel.append(artistHeader);const artistPlaceholder=make('p','mock-artist-placeholder','mock-empty');artistPlaceholder.textContent='Select an album, a song or an artist to see the details';artistPanel.append(artistPlaceholder);
    workspace.append(activity, albumPanel, artistPanel); main.append(workspace);mark(albumPanel);
    main.append(make('div', 'mock-single-custom', 'gallery-scrollbar'));
    bar.querySelector('.gallery-bar__context').prepend(make('span','mock-gallery-back'));
    const toolbar = make('div', 'mock-feature-actions', 'toolbar-right'); q('.app-bar--library .toolbar-right').prepend(toolbar);
    q('#shell-navigation-compact').append(make('span','mock-playlist-rail-action'));q('#artist-tree-expanded .mobile-artists-mode').after(make('span','mock-sidebar-mode-actions','mock-header-actions'));q('#artist-tree-expanded').append(make('div','mock-playlist-sidebar'));
    const notification=q('#cover-lookup-drawer-button');if(notification){notification.setAttribute('aria-label','Notifications');notification.title='Notifications';const glyph=notification.querySelector('.cover-lookup-drawer-glyph');if(glyph)glyph.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4M12 6v7m0-7 4 1v3l-4-1M12 13a2 2 0 1 1-2-2h2"/></svg>';}
    for(const artist of document.querySelectorAll('#player-artist,[data-compact-player-artist]')){artist.setAttribute('role','link');artist.tabIndex=0;artist.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();callbacks.playerArtist?.(state.player.current?.path);}});}
    const notices = make('div', 'mock-request-notices'); q('#cover-lookup-drawer-body').prepend(notices);
    new MutationObserver(() => { if (!document.getElementById('mock-request-notices')) q('#cover-lookup-drawer-body').prepend(notices); }).observe(q('#cover-lookup-drawer-body'), { childList: true });
    const mobileProfile=make('span','mock-mobile-profile-actions');bar.querySelector('.gallery-bar__title').append(mobileProfile);
    bar.querySelector('.gallery-bar__actions').prepend(make('span', 'mock-recent-expand'),make('span','mock-recent-view-action'));
    const controls = make('div', 'mock-recent-controls'); controls.append(make('div', 'mock-recent-tabs'), make('div', 'mock-recent-period')); bar.append(controls);
    const albumPageActions=make('div','mock-album-page-actions','gallery-bar__actions mock-header-actions');const albumTableControls=make('div','mock-album-table-controls','mock-album-table-playback mock-playback-controls');albumTableControls.setAttribute('role','toolbar');albumTableControls.setAttribute('aria-label','Album playback and statistics');albumTableControls.append(make('span','mock-album-playback-actions'),make('span','mock-album-config-action'));albumPageActions.append(albumTableControls,make('span','mock-album-settings-action'),make('span','mock-album-native-page-actions'));q('#mobile-page-header').append(albumPageActions);
    const phoneTabs=q('#mobile-home-tabs');
    for(const tab of phoneTabs.querySelectorAll('[data-in-page-tab]'))tab.textContent=({tracks:'Tracks',albums:'Albums',artists:'Artists'})[tab.dataset.inPageTab];phoneTabs.addEventListener('click',()=>{const value=phoneTabs.querySelector('[aria-selected=true]')?.dataset.inPageTab;if(value)callbacks.kindChanged?.(value);});phoneTabs.addEventListener('keydown',()=>{const value=phoneTabs.querySelector('[aria-selected=true]')?.dataset.inPageTab;if(value)callbacks.kindChanged?.(value);});
    const phonePeriod=make('div','mock-mobile-period');phonePeriod.hidden=true;main.append(phonePeriod);
    const nativeFoldVisibility=syncArtistTreeFoldVisibility;syncArtistTreeFoldVisibility=(...args)=>{const folded=nativeFoldVisibility(...args);syncSidebarMode();return folded;};
    const nativeSyncHome=syncMobileHome;
    syncMobileHome=()=>{const focused=bar.contains(document.activeElement)?document.activeElement:null;if(focused&&(!main.dataset.mockMode||main.dataset.mockMode===currentMode))bar.mockPendingHeaderFocus={element:focused,mode:currentMode};else if(main.dataset.mockMode&&main.dataset.mockMode!==currentMode)delete bar.mockPendingHeaderFocus;nativeSyncHome();let sections=bar.querySelector('.gallery-bar__home-tabs');const showDesktop=recent()&&!usesMobilePageLayout();if(showDesktop&&!sections){sections=make('div','mock-home-section-tabs','gallery-bar__home-tabs');sections.innerHTML=buildInPageTabsHtml({id:'mobile-recents-navigation',label:'Home sections',selectedKey:'recent',tabs:[{key:'recent',label:'Recent',panelId:'mobile-home-recent'},{key:'news',label:'News',disabled:true}]});bar.insertBefore(sections,q('#mock-recent-controls'));mountInPageTabs(sections.querySelector('[role=tablist]'));}if(sections){sections.classList.add('mock-home-sections-row');if(!sections.contains(phonePeriod))sections.append(phonePeriod);if(showDesktop)sections.hidden=false;}phonePeriod.hidden=!(usesMobilePageLayout()&&['home','profile'].includes(currentMode)&&sections&&!sections.hidden&&sections.contains(phonePeriod));syncRecentHeader();restoreGalleryHeaderFocus();};
    main.append(make('section','mock-friends-page'),make('div','mock-artist-page','gallery-scrollbar'));
    main.append(make('div', 'mock-full-artist-tools', 'mock-full-album-tools'));
    main.append(make('span','mock-profile-actions','mock-header-actions'));mark(q('#mock-profile-actions'));
    const portals = Object.fromEntries(['mock-profile-actions','mock-album-table-controls','mock-album-panel','mock-album-page-actions','mock-album-native-page-actions','mock-gallery-back','mock-album-playback-actions','mock-playlist-content','mock-playlist-expand','mock-playlist-header-actions','mock-playlist-rail-action','mock-sidebar-mode-actions','mock-playlist-sidebar','mock-artist-page','mock-artist-heading','mock-album-config-action','mock-recent-view-action','mock-artist-expand','mock-full-artist-tools','mobile-home-tracks','mobile-home-albums','mobile-home-artists','mock-mobile-profile-actions','mock-heading','mock-recent-content','mock-album-expand','mock-album-preferences','mock-single-custom','mock-feature-actions','mock-request-notices','mock-recent-expand','mock-recent-tabs','mock-recent-period','mock-album-settings-action','mock-mobile-period','mock-friends-page'].map(id => [id, q('#' + id)]));
    new MutationObserver(decorateAlbum).observe(q('#mobile-page-header'),{childList:true,subtree:true});
    new MutationObserver(decorateGallery).observe(bar, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['data-gallery-context-kind'] });
    new MutationObserver(() => {
      if (renderingAlbum) return;
      decorateAlbum();
      const closed = modal().hidden;
      if (closed && !lastClosed) {
        if (placement === 'modal') { placement = null; callbacks.modalClosed?.(); }
      }
      lastClosed = closed;
    }).observe(modal(), { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
    new MutationObserver(() => callbacks.galleryRendered?.()).observe(q('#artist-groups'), { childList: true, subtree: true });
    window.addEventListener('resize', () => callbacks.viewportChanged?.(innerWidth <= 900), { capture: true });
    document.addEventListener('keydown',event=>{const title=event.target.closest?.('[data-mock-gallery-artist-page]');if(currentMode==='gallery'&&title&&['Enter',' '].includes(event.key)&&!event.repeat&&!event.isComposing){event.preventDefault();event.stopImmediatePropagation();callbacks.artistPage?.(title.dataset.mockGalleryArtistPage);} },true);
    document.addEventListener('click', event => {
      const target = event.target;
      if(target.closest('#player-cover-button,[data-compact-player-cover]')&&callbacks.playerArtwork?.()){event.preventDefault();event.stopImmediatePropagation();return;}
      if(target.closest('#player-artist,[data-compact-player-artist]')){event.preventDefault();event.stopImmediatePropagation();callbacks.playerArtist?.(state.player.current?.path);return;}
      if(target.closest('#player-album-link,[data-compact-player-album]')){event.preventDefault();event.stopImmediatePropagation();callbacks.playerAlbum?.(state.player.current?.path);return;}
      const skip=target.closest('[data-playback-control-action=next],[data-playback-control-action=previous]');if(skip&&callbacks.queueStep?.(skip.dataset.playbackControlAction,skip.dataset.playbackControlAction==='previous'?-1:1)){event.preventDefault();event.stopImmediatePropagation();return;}
      if(target.closest('#artist-tree-navigation-button,[data-mobile-artists-mode]')){
        // Mode selection is idempotent. The native fold owner still expands
        // the desktop rail, but a second click cannot toggle it closed again.
        event.preventDefault();event.stopImmediatePropagation();
        callbacks.sidebarArtists?.();
        showSidebar('artists',!!target.closest('#artist-tree-navigation-button'));
        return;
      }
      const recentTrack=target.closest('#mock-recent-body [data-track-row-path],#mobile-home [data-track-row-path]');
      if(recentTrack&&!target.closest('[data-mock-playlist-id]')&&!target.closest('a,input,select,textarea')){
        const play=target.closest('.play-track-button');
        if(play||!target.closest('button')){
          event.preventDefault();event.stopImmediatePropagation();
          callbacks.trackSelected?.(recentTrack.dataset.trackRowPath,recentTrack.dataset.mockTrackAlbum,recentTrack.dataset.mockEventId||null);
          if(play)activateSharedTrackButton(play,{singleTrack:true});
          return;
        }
      }
      const galleryArtist=target.closest('[data-mock-gallery-artist-page]');
      if(currentMode==='gallery'&&galleryArtist){event.preventDefault();event.stopImmediatePropagation();callbacks.artistPage?.(galleryArtist.dataset.mockGalleryArtistPage);return;}
      const artist = target.closest('[data-mock-album-artist]');
      if (artist) { event.preventDefault(); event.stopImmediatePropagation(); callbacks.artist?.(artist.dataset.mockAlbumArtist); return; }
      const title = target.closest('[data-mock-album-page]');
      if (title) { event.preventDefault(); event.stopImmediatePropagation(); (placement==='modal'||currentMode==='artist-page'?callbacks.albumPage:callbacks.albumTitle)?.(currentAlbum); return; }
      const row = target.closest('.album-card[data-gallery-display="list"]');
      const card = target.closest('[data-open-tracklist="1"]') || (row && !target.closest('button,a,input,select,textarea,[role="button"]') ? row.querySelector('[data-open-tracklist="1"]') : null);
      if (card) {
        let album = getIndexedAlbum(card.dataset.albumKey);
        if (!album) { try { album = JSON.parse(card.dataset.album || 'null'); } catch {} }
        if (album) { event.preventDefault(); event.stopImmediatePropagation(); callbacks.album?.(album, { recent: !!card.closest('#mock-recent-body'), phoneHome:!!card.closest('#mobile-home'), comparison: !!card.closest('.mock-comparison') }); return; }
      }
      if(target.closest('#mobile-back-button')&&!usesMobilePageLayout()&&currentMode==='album'){event.preventDefault();event.stopImmediatePropagation();if(mobilePageState.pages.some(page=>page.kind==='album'))navigateMobileBack();else callbacks.albumClosed?.();return;}
      const sidebarArtist=target.closest('#sidebar-list [data-sidebar-artist]');if(sidebarArtist&&callbacks.artistTree?.(sidebarArtist.dataset.sidebarArtist)){event.preventDefault();event.stopImmediatePropagation();return;}
      if (target.closest('#sidebar-list [data-nav]')) { callbacks.beforeNativeGallery?.(); return; }
      if (target.closest('.app-bar-brand')) { event.preventDefault(); event.stopImmediatePropagation(); callbacks.home?.(); }
    }, true);
    // History/popstate owns native page cleanup. A hidden Details node is not
    // another Back request. Only an explicit Escape on the foreground full
    // Album page enters the preview's Back action.
    document.addEventListener('keydown',event=>{
      if(event.key!=='Escape'||event.repeat||event.isComposing||currentMode!=='album'||placement!=='full'||event.target.closest?.('#search-form'))return;
      const blocking=!!getTopmostOpenModal()||!!galleryMainSurfaceController?.current?.()||[...document.querySelectorAll('#account-menu:not([hidden]),[data-anchored-surface]:not([hidden]),[aria-modal="true"]')].some(element=>element.getClientRects().length);
      const active=typeof mobilePageState!=='undefined'?mobilePageState.pages.at(-1):null;
      if(blocking||(usesMobilePageLayout()&&active&&active.kind!=='album'))return;
      event.preventDefault();event.stopImmediatePropagation();callbacks.albumClosed?.();
    },true);
    document.addEventListener('dblclick', event => {
      const recentTrack=event.target.closest('#mock-recent-body [data-track-row-path],#mobile-home [data-track-row-path]');
      if(recentTrack&&!event.target.closest('[data-mock-playlist-id]')&&!event.target.closest('button,a,input,select,textarea')){
        event.preventDefault();event.stopImmediatePropagation();const play=recentTrack.querySelector('.play-track-button');if(play)activateSharedTrackButton(play,{singleTrack:true});return;
      }
      const card = event.target.closest('#mock-recent-body .album-card,#mobile-home .album-card');
      if (!card) return;
      const trigger = card.querySelector('[data-album-key]');
      const album = trigger && getIndexedAlbum(trigger.dataset.albumKey);
      if (album) { event.preventDefault(); event.stopImmediatePropagation(); callbacks.albumPage?.(album); }
    }, true);
    document.addEventListener('submit', event => {
      if (event.target.matches('form[action="/logout"]')) { event.preventDefault(); event.stopImmediatePropagation(); showToast('Fictional preview: there is no real account to sign out.', 'info', 3000); }
    }, true);
    const nativeSettingsRender=renderUtilityModalContent;
    renderUtilityModalContent=(...args)=>{const result=nativeSettingsRender(...args);if(state.utility.activeTab==='appearance'){
      const list=q('#utility-problematic-list');if(list&&!list.querySelector('[data-mock-artist-settings]'))list.insertAdjacentHTML('beforeend',NavigationTree.renderItem({variant:'settings',action:true,key:'mock-artist-navigation',label:'Artist navigation',attributes:{'data-mock-artist-settings':'true'}}));
      const detail=q('#utility-problematic-detail');if(state.utility.appearanceKey==='album-page'&&detail&&!detail.querySelector('[data-mock-album-statistics-settings]'))detail.insertAdjacentHTML('beforeend',ButtonComponent.renderButton({label:'Play statistics',variant:'secondary',size:'small',attributes:{'data-mock-album-statistics-settings':'true'}}));
    }return result;};
    document.addEventListener('click',event=>{if(event.target.closest('[data-mock-artist-settings]')){event.preventDefault();callbacks.artistSettings?.();}if(event.target.closest('[data-mock-album-statistics-settings]')){event.preventDefault();callbacks.albumStatistics?.();}});
    const appearanceStatus=()=>{
      for(const el of document.querySelectorAll('#utility-modal .appearance-save-status,#utility-modal [data-background-status],#utility-modal .editor-footer-status'))if(el.textContent==='Saved to your account')el.textContent='Applied in this preview only';
    };
    new MutationObserver(()=>{appearanceStatus();refreshListenTimes();}).observe(q('#utility-modal'),{childList:true,subtree:true,characterData:true});
    document.addEventListener('input',event=>{if(event.target.matches('[data-lastfm-field=timezone]'))queueMicrotask(()=>refreshListenTimes());});window.addEventListener('focus',()=>refreshListenTimes());
    window.addEventListener('album-haven-appearance-change',()=>{
      if(currentAlbum&&!modal().hidden){renderTrackModalRelease(currentAlbum);attachSharedPlayer();decorateAlbum();}
    });
    window.MockRealLayout = {
      portals,layout,setSocialOwners:value=>socialOwners=value,openAlbum, closeAlbum: () => closeTrackModal(), showArtist,
      setCallbacks: value => callbacks = value, getMode: () => currentMode, getPlacement: () => placement,
      getAlbum: () => currentAlbum, readView: () => state.view,
      fullArtGesture, completeNavigationPresentation:()=>completeLightboxNavigation(), lightboxHistoryHandled: () => {const handled=lightboxPopHandled;lightboxPopHandled=false;return handled;},
      setRecentContext: value => { recentContext = value; currentKind = value.kind;syncRecentHeader();const tab=q('#mobile-home-tabs [data-in-page-tab="'+value.kind+'"]');if(usesMobilePageLayout()&&tab&&tab.getAttribute('aria-selected')!=='true')tab.click(); q('#mobile-home').dataset.accountName=value.person; if(usesMobilePageLayout()&&['home','profile'].includes(currentMode))syncMobileHome();else decorateGallery(); },
      loadGallery, activate, activateCovers: activate, table: config => buildCompactDataTable(config),
      tabs: config => buildInPageTabsHtml(config), mountTabs: node => mountInPageTabs(node),
      previewPalette:id=>{const palette=['black','navy','parchment-pine'].includes(id)?id:'black';window.AlbumHavenAppearance.applyTheme({main_surface_color:null,panel_background_color:null,palette_id:palette,panel_index:0,player_override:null},document.documentElement);document.body.dataset.mockProposal='panel-color';const banner=make('div','mock-proposal-notice');banner.innerHTML='<strong>Panel-color concept</strong> · not saved <a href="/?mock=proposals">All proposals</a> <a href="/?mock=home">Normal mock</a>';q('#shell-main-surface').prepend(banner);},
      canAutoCloseSidebar:()=>sidebarMode==='playlists'&&!isArtistsDrawerMobileViewport()&&canUseArtistsDrawerForCurrentView()&&!state.ui.artistTreeFolded,collapseSidebar:()=>{if(sidebarMode==='playlists'&&!isArtistsDrawerMobileViewport()&&!state.ui.artistTreeFolded)toggleArtistTreeFold();},
      showSidebar,closeSidebar,setViewContext,closeViewControl,
      selectPreviewTrack:(track,album,options={})=>{const holder=document.createElement('div');holder.innerHTML=buildAlbumTrackPlayButtonHtml({...track,album:album.name,albumArtist:album.album_artist,coverPath:track.cover_path||album.cover_path});previewTrack(holder.firstElementChild,options);},
      preferredTimeZone:()=>getPreferredUserTimeZone(),playTable, flatGallery, artistTree, artistTable,paintArtistSelection:(id,key)=>{NavigationTree.setSelection(q('#'+id),key);},paintRecentSelection:(id,trackId,listenId,view)=>{for(const row of document.querySelectorAll('#'+id+'-tracks-1 [data-track-row-path]')){const selected=view==='history'?!!listenId&&row.dataset.mockEventId===listenId:!!trackId&&row.dataset.trackRowPath===trackId;row.classList.toggle('mock-selected-track',selected);row.setAttribute('aria-selected',String(selected));}},trackLoveControl:path=>socialOwners.trackLoveControl?.(path)||'',
      artistViewOwners:{paintFamilySelection:(root,key)=>NavigationTree.setSelection(root?.querySelector('.mock-artist-view__family'),key),paintSelection:(root,key)=>NavigationTree.setSelection(root?.querySelector('.mock-artist-view__releases'),key),renderNavigationItem:config=>NavigationTree.renderItem(config),renderArtbox:(album,options)=>buildUtilityAlbumArtbox(album,options),renderFamilyItem:config=>buildFilterPillHtml(config),renderActionButton:config=>ButtonComponent.renderActionButton(config),albumPopularity:album=>socialOwners.albumPopularity?.(album),activate,mountArtistInfo:(artist,slot)=>{const albumPanel=q('#mock-album-panel');showArtist(artist);const info=q('[data-artist-info-overlay]');slot.append(info);info.dataset.mockPlacement='artist-page';info.hidden=false;info.inert=false;info.removeAttribute('aria-hidden');info.setAttribute('role','region');info.removeAttribute('aria-modal');return()=>{if(albumPanel)restore(albumPanel);if(slot.contains(info)){restore(info);info.hidden=true;delete info.dataset.mockPlacement;}};}},
      paintRecentAlbumSelection,clearRecentAlbumDetails,clearArtistAlbumDetails,
      setSelection: value => {q('#mock-workspace').dataset.hasSelection=String(value);syncRecentHeader();},
      getGalleryView: () => ensureGalleryMainState().view,
      galleryConfig: () => ({view:recent()?normalizeGalleryView(recentView):ensureGalleryMainState().view,keys:getFilteredGalleryMainModel().groups.flatMap(group=>group.albums.map(getAlbumRequestKey))}),
      card: (album, view = 'cards') => albumCardHtml(album, { displayMode: view, coverPriority: 'visible' }),
      choiceDropdown,
      dialog: options => showPreviewDialog(options), confirm: options => showAppConfirmDialog(options),
      closeNotifications: () => q('[data-close-cover-lookup-drawer="1"]')?.click(),
      closeDialog: () => q('#app-form-cancel')?.click(), toast: (message, type = 'info') => showToast(message, type, 3200),
      previewTrack:(button,options)=>previewTrack(button,options),
      openAvatar:(src,name)=>openImageLightbox(src,`${name} avatar`,{items:[{src,alt:`${name} avatar`,key:'mock-avatar:'+name}],sourceAlbumKey:'mock-avatar:'+name}),
      openAlbumAppearance:()=>{setUtilityActiveTab('appearance');state.utility.appearanceKey='album-page';openUtilityModal({resetSelection:false});},
    };
    window.addEventListener('keydown',handleChoiceEscape,true);window.addEventListener('keyup',event=>{if(event.key==='Escape')choiceEscapeHeld=false;},true);
    window.dispatchEvent(new Event('mock-real-ui-ready'));
  }
  // The native lightbox owns pixels, loading, zoom, drag and dismissal. This
  // preview adds one transient entry through the existing library history owner.
  function installLightboxPreview() {
    const overlay=q('#image-lightbox');
    const historyOwner=window.AlbumHavenSettingsNavigation.instance;
    const nativePush=historyOwner.pushLibraryHistory.bind(historyOwner);
    const nativeOpen=openImageLightbox, nativeClose=closeImageLightbox;
    const nativePop=handleMobilePagePopState, nativeShowItem=showLightboxItem;
    let active=null, closing=false, writing=false, queuedOpen=null, pendingRestore=null;
    let knownPosition=history.state?.albumHavenNavigationPosition, serial=0;
    const position=()=>history.state?.albumHavenNavigationPosition;
    const copyOptions=options=>JSON.parse(JSON.stringify(options||{}));
    const openNative=(src,alt,options)=>{
      const key=options?.sourceAlbumKey;
      nativeOpen(src,alt,options);
      // Fictional albums may share artwork. Restore by the saved native album
      // identity, because the native URL-first lookup can match an earlier card.
      const index=key?state.lightbox.items.findIndex(item=>item.key===key):-1;
      if(index>=0&&index!==state.lightbox.currentIndex)showLightboxItem(index);
    };
    const restore=descriptor=>{
      active=descriptor;closing=false;
      openNative(descriptor.src,descriptor.alt,descriptor.options);
    };
    historyOwner.pushLibraryHistory=(url,snapshot)=>{
      if(writing){nativePush(url,snapshot);knownPosition=position();return;}
      // A newer semantic navigation never inherits the previous image marker.
      const clean={...(snapshot||{})};delete clean.mockFullArt;
      queuedOpen=null;closing=false;pendingRestore=null;
      if(active){nativeClose();active=null;}
      nativePush(url,clean);knownPosition=position();
    };
    openImageLightbox=(src,alt,options={})=>{
      if(!src)return;
      if(closing){queuedOpen=[src,alt,options];return;}
      const wasOpen=active&&history.state?.mockFullArt?.id===active.id;
      const descriptor={id:wasOpen?active.id:`preview-art-${performance.timeOrigin}-${++serial}`,
        src,alt,options:copyOptions(options),baseUrl:location.href,
        parentPosition:wasOpen?active.parentPosition:position()};
      active=descriptor;
      if(wasOpen)history.replaceState({...history.state,mockFullArt:descriptor},'',location.href);
      else {
        writing=true;
        try{historyOwner.pushLibraryHistory(location.href,{...history.state,mockFullArt:descriptor});}
        finally{writing=false;}
      }
      openNative(src,alt,options);
    };
    closeImageLightbox=()=>{
      if(closing)return;
      if(active&&history.state?.mockFullArt?.id===active.id){
        closing=true;history.back();return;
      }
      nativeClose();active=null;
    };
    showLightboxItem=index=>{
      const result=nativeShowItem(index),item=state.lightbox.items?.[state.lightbox.currentIndex];
      if(active&&item&&history.state?.mockFullArt?.id===active.id){
        active={...active,src:item.src,alt:item.alt,options:{...active.options,sourceAlbumKey:item.key||''}};
        history.replaceState({...history.state,mockFullArt:active},'',location.href);
      }
      return result;
    };
    handleMobilePagePopState=()=>{
      const target=history.state?.mockFullArt;
      const previous=active,previousPosition=knownPosition;
      knownPosition=position();
      let overlayOnly=false;
      if(target&&target.baseUrl===location.href){
        overlayOnly=previousPosition===target.parentPosition||previous?.id===target.id;
        // Cross-page Forward must restore its native parent before the overlay.
        if(overlayOnly)restore(target);
        else pendingRestore=target;
      }else if(previous){
        overlayOnly=location.href===previous.baseUrl&&position()===previous.parentPosition;
        nativeClose();active=null;closing=false;
      }
      const next=queuedOpen;queuedOpen=null;
      if(next)queueMicrotask(()=>openImageLightbox(...next));
      lightboxPopHandled=overlayOnly;
      return overlayOnly||nativePop();
    };
    // React calls this only after the native parent presentation and its focus
    // work have been scheduled. The child then receives the final native focus.
    completeLightboxNavigation=()=>{
      const target=pendingRestore;pendingRestore=null;
      if(target)requestAnimationFrame(()=>{if(history.state?.mockFullArt?.id===target.id&&location.href===target.baseUrl)restore(target);});
    };
    const initial=history.state?.mockFullArt;
    if(initial?.baseUrl===location.href){active=initial;pendingRestore=initial;}
    // Deliberate touch edge gesture only. Image pan/zoom, interior swipes,
    // vertical scrolling and multi-touch retain their existing owners.
    const pointers=new Set();let gesture=null,suppressClick=false;
    fullArtGesture.pointerdown=event=>{
      suppressClick=false;
      if(overlay.hidden||!overlay.contains(event.target))return;
      pointers.add(event.pointerId);
      if(pointers.size!==1){gesture=null;return;}
      if(event.pointerType!=='touch'||event.clientX<innerWidth-24
        ||state.lightbox.zoom>1||(visualViewport?.scale||1)>1
        ||getTopmostOpenModal()!==overlay||event.target.closest('button'))return;
      gesture={id:event.pointerId,x:event.clientX,y:event.clientY};
    };
    fullArtGesture.pointermove=event=>{
      if(!gesture||gesture.id!==event.pointerId)return;
      const dx=event.clientX-gesture.x,dy=event.clientY-gesture.y;
      if(Math.abs(dy)>32||dx>12){gesture=null;return;}
      if(dx<-60&&Math.abs(dx)>Math.abs(dy)*2){
        gesture=null;suppressClick=true;event.preventDefault();
        if(getTopmostOpenModal()===overlay)closeImageLightbox();
      }
    };
    const end=event=>{pointers.delete(event.pointerId);if(gesture?.id===event.pointerId)gesture=null;};
    fullArtGesture.pointerup=end;fullArtGesture.pointercancel=end;
    fullArtGesture.click=event=>{if(suppressClick&&event.detail!==0){suppressClick=false;event.preventDefault();event.stopImmediatePropagation();}};
    fullArtGesture.blur=event=>{if(event.target===window){gesture=null;pointers.clear();suppressClick=false;}};
  }
  // Native dialog focus, Escape and backdrop owners stay in charge. A request
  // launched from the notification drawer is its foreground child presentation.
  function handleProfileDialogTab(event){
    const modal=q('#app-form-modal');
    if(event.key!=='Tab'||event.ctrlKey||event.altKey||event.metaKey||modal.dataset.mockDialog!=='profile'||getTopmostOpenModal()!==modal)return;
    const controls=[...modal.querySelectorAll('input,button,textarea,select,[tabindex]')].filter(control=>!control.disabled&&control.tabIndex>=0&&!control.closest('[hidden],[inert]')&&control.getClientRects().length);
    if(!controls.length)return;const index=controls.indexOf(document.activeElement),next=event.shiftKey?(index<=0?controls.length-1:index-1):(index+1)%controls.length;
    event.preventDefault();event.stopImmediatePropagation();controls[next].focus();
  }
  function showPreviewDialog(options){
    const parent=options.parentSurface&&q(options.parentSurface),modal=q('#app-form-modal');
    const nested=parent&&!parent.hidden&&parent.getClientRects().length;
    const wasInert=parent?.inert;
    const containClick=event=>event.stopPropagation();
    return showAppFormDialog({...options,onMount:(content,controls)=>{
      if(nested){modal.style.zIndex=String(Math.max(125,Number(getComputedStyle(parent).zIndex)||0)+1);parent.inert=true;modal.addEventListener('click',containClick);}
      if(modal.dataset.mockDialog==='profile')modal.addEventListener('keydown',handleProfileDialogTab,true);
      options.onMount?.(content,controls);
    },onClose:content=>{
      modal.removeEventListener('keydown',handleProfileDialogTab,true);
      if(nested){
        parent.inert=wasInert;
        // A microtask can run between native event listeners. Keep containment
        // through this click's complete bubble phase, then remove only our hook.
        setTimeout(()=>modal.removeEventListener('click',containClick),0);
        requestAnimationFrame(()=>{if(!parent.hidden&&!parent.inert&&modal.hidden&&document.activeElement===document.body)q('[data-close-cover-lookup-drawer="1"]')?.focus({preventScroll:true});});
      }
      options.onClose?.(content);
    }});
  }
  function closeViewControl(){
    const root=sharedViewRoot;if(!root?.querySelector('button'))return;
    UnfoldingActionButton.mount(root).close(root.contains(document.activeElement));
  }
  function setViewContext({context='gallery',scope='',value,onSelect,phone=usesMobilePageLayout(),host=null}={}){
    const root=sharedViewRoot;if(!root)return;
    const direction=phone?'down':'left',changed=context!==viewContext.context||scope!==viewContext.scope;
    const focused=root.contains(document.activeElement),oldOwner=root.querySelector('button')?UnfoldingActionButton.mount(root):null;
    if(changed||root.dataset.unfoldDirection!==direction)oldOwner?.close(focused);
    const replacement=context!==viewContext.context;
    viewContext={context,scope,value,onSelect,phone,host};
    if(replacement){oldOwner?.destroy();root.replaceChildren();}
    if(context==='gallery'){
      if(replacement||!root.hasAttribute('data-gallery-view-cluster'))root.replaceChildren(...galleryViewNodes);
      root.setAttribute('data-gallery-view-cluster','');delete root.dataset.mockViewContext;root.hidden=false;restore(root);
      // Restore the exact native option nodes and its own preference callback.
      // Its WeakMap owner mounts once; subsequent native sync only configures it.
      nativeViewControlSync?.();
    }else{
      // Native updateGalleryMainControls only binds a [data-gallery-view-cluster].
      // Contextual options deliberately have no Gallery routing attributes.
      root.removeAttribute('data-gallery-view-cluster');root.dataset.mockViewContext=context;
      if(context==='none'){root.hidden=true;restore(root);return;}
      root.hidden=false;if(host&&root.parentElement!==host)host.append(root);
      if(replacement||!root.querySelector('button')){
        const actions=context==='recent-tracks'?[{value:'grouped',ariaLabel:'Grouped tracks',title:'Grouped tracks'},{value:'history',ariaLabel:'Listening history',title:'Listening history'}]:context==='recent-artists'?[{value:'rows',ariaLabel:'Artist rows',title:'Artist rows'},{value:'icons',ariaLabel:'Artist icons',title:'Artist icons'}]:[{value:'list',ariaLabel:'Rows',title:'Rows'},{value:'cards',ariaLabel:'Small covers',title:'Small covers'}];
        const rendered=document.createElement('div');rendered.innerHTML=UnfoldingActionButton.render({value,actions});root.replaceChildren(...rendered.firstElementChild.children);
        for(const button of root.querySelectorAll('[data-action-value]')){
          const slot=button.querySelector('.action-button__icon');
          if(context==='recent-tracks'){
            const path=button.dataset.actionValue==='history'?'M12 5v16M12 6C8 3 5 3 2 4v15c3-1 6-1 10 2 4-3 7-3 10-2V4c-3-1-6-1-10 2':'M4 11V4l8-2v7M4 4l8-2M4 11a2 1.5 0 1 1-2-1.5c1.1 0 2 .7 2 1.5M12 9a2 1.5 0 1 1-2-1.5c1.1 0 2 .7 2 1.5M14 21v-7l8-2v7M14 14l8-2M14 21a2 1.5 0 1 1-2-1.5c1.1 0 2 .7 2 1.5M22 19a2 1.5 0 1 1-2-1.5c1.1 0 2 .7 2 1.5';
            slot.innerHTML=`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${path}"/></svg>`;
          }else{
            const choice=['rows','list'].includes(button.dataset.actionValue)?'list':'cards';
            const glyph=galleryViewNodes.find(node=>node.dataset?.galleryViewChoice===choice)?.querySelector('svg');if(glyph)slot.append(glyph.cloneNode(true));
          }
          const glyph=slot.firstElementChild;if(glyph){glyph.classList.add('action-button__icon','ui-icon','mock-recent-view-glyph');glyph.setAttribute('fill','none');glyph.setAttribute('stroke','currentColor');slot.replaceWith(glyph);}
        }
      }
      const owner=UnfoldingActionButton.mount(root,{label:context==='comparison'?'Comparison album view':'Recent view',direction,
        onOpen:()=>{if(phone&&typeof activateTriggerSurface==='function')activateTriggerSurface(root,()=>closeViewControl());},
        onClose:()=>{if(typeof clearTriggerAnchor==='function')clearTriggerAnchor(root);},onSelect:next=>viewContext.onSelect?.(next)});
      owner.select(value);
    }
    if(focused&&!root.hidden)root.querySelector('button.is-active:not([hidden])')?.focus({preventScroll:true});
  }
  // Keep the single native GalleryBar/action group. Rehost only the existing
  // React portal root for a desktop single-panel Home/profile identity.
  function restoreGalleryHeaderFocus(){
    const bar=q('[data-gallery-bar-instance="gallery"]'),pending=bar?.mockPendingHeaderFocus;
    if(!pending)return;
    const active=document.activeElement,target=pending.element;
    if(pending.mode!==currentMode||!target?.isConnected||(active!==document.body&&active!==target)){delete bar.mockPendingHeaderFocus;return;}
    const top=typeof getTopmostOpenModal==='function'?getTopmostOpenModal():null;
    const covered=top&&!(top===modal()&&placement==='embedded');
    if(covered||document.querySelector('.settings-foobar-format-menu')){delete bar.mockPendingHeaderFocus;return;}
    if(target.closest('[hidden],[inert],[aria-hidden="true"]'))return;
    target.focus({preventScroll:true});
    if(document.activeElement===target)delete bar.mockPendingHeaderFocus;
  }
  function syncRecentHeader(){
    const bar=q('[data-gallery-bar-instance="gallery"]'),heading=q('#mock-heading'),workspace=q('#mock-workspace');if(!bar||!heading||!workspace)return;
    const mobile=usesMobilePageLayout(),inRecent=recent(),hasPanels=workspace.dataset.hasSelection==='true';
    const expandedFriend=currentMode==='recent'&&recentContext.personId&&recentContext.personId!=='me';
    const singleHome=!mobile&&(['home','profile'].includes(currentMode)&&!hasPanels||expandedFriend);
    const context=bar.querySelector('.gallery-bar__context');
    if(singleHome){if(heading.parentElement!==context)context.append(heading);}else restore(heading);
    bar.classList.toggle('mock-home-header',singleHome);if(singleHome)heading.hidden=false;
    const period=q('#mock-recent-period'),actions=bar.querySelector('.gallery-bar__actions'),controls=q('#mock-recent-controls');
    const periodHost=!mobile&&inRecent?(bar.querySelector('.gallery-bar__home-tabs')||controls):controls;
    if(period&&periodHost&&period.parentElement!==periodHost)periodHost.append(period);
    // Mobile Home owns a hidden native toolbar. Its visible identity line
    // already hosts Edit/Compare; move the same view portal there, never into
    // the body tabs. Expanded Recent and desktop retain the native action slot.
    const view=q('#mock-recent-view-action'),phoneHome=mobile&&(['home','profile'].includes(currentMode)||expandedFriend);
    const viewHost=phoneHome?bar.querySelector('.gallery-bar__title'):actions;
    if(view&&viewHost&&view.parentElement!==viewHost){const focused=view.contains(document.activeElement)?document.activeElement:null;if(phoneHome)viewHost.append(view);else q('#mock-recent-expand').after(view);focused?.focus({preventScroll:true});}
    if(view)view.hidden=!inRecent||currentKind==='albums';
    const profile=q('#mock-profile-actions'),profileHost=phoneHome?bar.querySelector('.gallery-bar__title'):singleHome?actions:q('#mock-profile-actions-inline');
    if(profile&&profileHost&&profile.parentElement!==profileHost){const focused=profile.contains(document.activeElement)?document.activeElement:null;profileHost.append(profile);focused?.focus({preventScroll:true});}
    if(profile)profile.hidden=!['home','profile','recent'].includes(currentMode);
    q('#mock-mobile-profile-actions').hidden=!(mobile&&(['home','profile'].includes(currentMode)||expandedFriend));
    // Native Home hides this group. Explicit phone Friend Recent moves View
    // and Compare into the same title owner, so its remaining native Gallery
    // actions must stay hidden too. Restore the native Home predicate on exit.
    if(actions){
      if(mobile&&expandedFriend){actions.hidden=true;actions.dataset.mockFriendRecentSuppressed='true';}
      else if(actions.dataset.mockFriendRecentSuppressed==='true'){actions.hidden=shouldShowMobileHome();delete actions.dataset.mockFriendRecentSuppressed;}
    }
    q('#mock-recent-expand').hidden=!['home','profile'].includes(currentMode)||mobile||!hasPanels;
  }
  function rehostPlaylist(bar,body,host){
    // Native syncMobileHome may restore GalleryBar during control updates.
    // Its existing anchor must travel with the same bar, just as Recent does.
    const active=document.activeElement,focused=bar.contains(active)||body.contains(active)?active:null;
    if(typeof mobileHomeBarPosition!=='undefined'&&mobileHomeBarPosition&&mobileHomeBarPosition.parentNode!==host)host.append(mobileHomeBarPosition);
    if(bar.parentElement!==host||bar.nextElementSibling!==body)host.append(bar,body);
    const modalOwner=getTopmostOpenModal(),choice=document.querySelector('.settings-foobar-format-menu');
    if(focused?.isConnected&&focused.getClientRects().length&&!focused.closest('[hidden],[inert],[aria-hidden="true"]')&&(!modalOwner||modalOwner.matches('#track-modal[data-mock-placement=embedded]'))&&!choice?.getClientRects().length)focused.focus({preventScroll:true});
  }
  function layout(mode, kind = currentKind) {
    if(mode!==currentMode||kind!==currentKind)closeViewControl();
    const previousMode=currentMode; currentMode = mode; currentKind = kind;if(mode!=='artist-page')restore(q('#mock-album-panel'));
    if(mode!=='album')desktopFocusedAlbumKey='';
    const main = q('#shell-main-surface'), bar = q('[data-gallery-bar-instance="gallery"]'), scroll = q('#albums-scroll'), info = q('[data-artist-info-overlay]');
    const playlistExpanded=mode==='playlist'&&new URL(location.href).searchParams.get('mock_expanded')==='playlist';
    const multi=['home','profile'].includes(mode)||mode==='playlist'&&!playlistExpanded,phoneHome=['home','profile'].includes(mode)&&usesMobilePageLayout(),inRecent=(['home','profile'].includes(mode)&&!phoneHome)||mode==='recent';
    // Commit height/layout owners before native shell work or singleton moves.
    // Playlist history returns do this in the same synchronous presentation.
    document.body.classList.toggle('mock-multi-view', multi&&!phoneHome);
    document.body.classList.toggle('mock-native-home',phoneHome);
    document.body.classList.toggle('mock-recent-view',inRecent);document.body.classList.toggle('mock-playlist-view',mode==='playlist');document.body.classList.toggle('mock-playlist-expanded',playlistExpanded);
    document.body.classList.toggle('mock-full-album', mode === 'album');
    syncMobileHome();
    q('#mobile-home').dataset.mockPopulated='true';
    q('#mock-mobile-profile-actions').hidden=!phoneHome;
    main.dataset.mockMode = mode; main.dataset.mockKind = kind;
    if (mode !== 'album' && placement !== 'modal' && typeof mobilePageState !== 'undefined' && mobilePageState.pages.some(page => page.kind === 'album')) returnMobilePagesToGallery();
    q('#mock-workspace').hidden = !multi||phoneHome;
    q('#mock-heading').hidden=phoneHome||mode==='playlist'||mode==='proposals'||(!multi&&mode!=='compare');
    q('#mock-single-custom').hidden = !['compare','proposals'].includes(mode);
    q('#mock-recent-controls').hidden=!inRecent;q('#mock-playlist-content').hidden=mode!=='playlist';q('#mock-playlist-expand').hidden=mode!=='playlist'||playlistExpanded;q('#mock-playlist-header-actions').hidden=mode!=='playlist';
    syncRecentHeader();q('#mock-gallery-back').hidden=!['gallery','playlist','recent'].includes(mode);
    q('#mock-album-settings-action').hidden=placement!=='modal'&&!['album','home','profile','playlist'].includes(mode);
    q('#mock-friends-page').hidden=mode!=='friends';q('#mock-artist-page').hidden=mode!=='artist-page';
    q('#mock-full-artist-tools').hidden = mode !== 'artist';
    if(mode==='playlist'){
      const body=q('#mock-playlist-content'),host=playlistExpanded?main:q('#mock-activity');
      rehostPlaylist(bar,body,host);
      bar.hidden=false;scroll.hidden=true;q('#mock-recent-body').hidden=true;
      if(playlistExpanded){
        if(placement!=='modal'){restore(modal());modal().classList.remove('is-mobile-page');modal().hidden=true;placement=null;delete modal().dataset.mockPlacement;}
        restore(info);info.hidden=true;delete info.dataset.mockPlacement;
      }else if(placement!=='modal'){
        modal().classList.remove('is-mobile-page');q('#mock-album-panel').append(modal());q('#mock-artist-panel').append(info);
        modal().dataset.mockPlacement='embedded';placement='embedded';info.dataset.mockPlacement='embedded';info.hidden=false;
      }
    }else if(phoneHome){
      q('#mock-recent-body').hidden=true;scroll.hidden=true;
      if(placement!=='modal'){restore(modal());modal().classList.remove('is-mobile-page');modal().hidden=true;placement=null;delete modal().dataset.mockPlacement;}
      restore(info);info.hidden=true;delete info.dataset.mockPlacement;
    } else if (inRecent) {
      const host = multi ? q('#mock-activity') : main;
      if (typeof mobileHomeBarPosition !== 'undefined' && mobileHomeBarPosition) host.append(mobileHomeBarPosition);
      const body=q('#mock-recent-body');
      if(bar.parentElement!==host || bar.nextElementSibling!==body)host.append(bar,body);
      bar.hidden = false; scroll.hidden = true; q('#mock-recent-body').hidden = false;
      if(!multi&&placement!=='modal'){restore(modal());modal().classList.remove('is-mobile-page');modal().hidden=true;placement=null;delete modal().dataset.mockPlacement;}
      if (multi && placement !== 'modal') {
        modal().classList.remove('is-mobile-page');q('#mock-album-panel').append(modal()); q('#mock-artist-panel').append(info);
        modal().dataset.mockPlacement = 'embedded'; placement = 'embedded';
        info.dataset.mockPlacement = 'embedded'; info.hidden = false;
      }
    } else {
      q('#mock-recent-body').hidden = true;
      if (typeof mobileHomeBarPosition !== 'undefined' && mobileHomeBarPosition) restore(mobileHomeBarPosition);
      restore(bar); restore(scroll);if(mode!=='artist-page'){restore(info);info.hidden=true;delete info.dataset.mockPlacement;}
      bar.hidden = mode !== 'gallery'; scroll.hidden = mode !== 'gallery';
      if (mode !== 'album' && mode !== 'artist-page' && placement !== 'modal') { restore(modal());modal().classList.remove('is-mobile-page'); modal().hidden = true; placement = null; delete modal().dataset.mockPlacement; }
    }
    if(mode==='artist-page'&&placement!=='modal'){const slot=q('[data-mock-artist-album-slot]');if(slot){slot.append(q('#mock-album-panel'));q('#mock-album-panel').append(modal());modal().classList.remove('is-mobile-page');modal().dataset.mockPlacement='embedded';placement='embedded';}}
    if(mode==='album'){
      modal().dataset.mockPlacement='full';placement='full';
      if(!usesMobilePageLayout())showDesktopAlbumPage(mobilePageDescriptor('album',currentAlbum));
    }else if(!mobilePageState.pages.length){
      main.classList.remove('has-mobile-page');q('#mobile-page-header').hidden=true;q('#mobile-page-outlet').hidden=true;
      q('#mobile-back-button').hidden=true;document.title=originalTitle;
    }
    if(mode==='artist'){main.prepend(q('#mock-full-artist-tools'));main.append(info);info.dataset.mockPlacement='full';info.hidden=false;info.removeAttribute('aria-hidden');info.setAttribute('role','region');info.removeAttribute('aria-modal');}
    const dialog = modal().querySelector('.track-modal-dialog');
    if(placement&&placement!=='modal'){dialog.setAttribute('role','region');dialog.removeAttribute('aria-modal');}else if(placement==='modal'){dialog.setAttribute('role','dialog');dialog.setAttribute('aria-modal','true');}
    if (placement !== 'modal') document.body.classList.remove('modal-open');
    updateGalleryMainControls();callbacks.galleryRendered?.();decorateGallery(); decorateAlbum();syncRecentTrackLayout();syncSidebarMode();restoreGalleryHeaderFocus();
    if(mode==='album')document.body.classList.remove('modal-open');
    if(mode==='gallery'&&previousMode!=='gallery')requestAnimationFrame(()=>{if(currentMode==='gallery')virtualGrid?.onResize();});
  }
  function decorateGallery() {
    const bar = q('[data-gallery-bar-instance="gallery"]'); if (!bar) return;
    const identity=bar.querySelector('[data-gallery-context-name]');
    const linkedArtist=currentMode==='gallery'?bar.querySelector('[data-artist-info-trigger]')?.dataset.artist:null;
    if(identity){
      if(linkedArtist){identity.dataset.mockGalleryArtistPage=linkedArtist;identity.setAttribute('role','button');identity.tabIndex=0;identity.title='Open '+linkedArtist+' artist page';identity.setAttribute('aria-label',identity.title);}
      else if(identity.hasAttribute('data-mock-gallery-artist-page')){delete identity.dataset.mockGalleryArtistPage;identity.removeAttribute('role');identity.removeAttribute('tabindex');identity.removeAttribute('title');identity.removeAttribute('aria-label');}
    }
    if ((!recent()&&currentMode!=='playlist')||(['home','profile'].includes(currentMode)&&usesMobilePageLayout())) return;
    if(currentMode==='playlist'){
      const artistInfo=bar.querySelector('[data-artist-info-trigger]');
      const active=typeof galleryMainSurfaceController!=='undefined'?galleryMainSurfaceController?.current?.():null;
      if(artistInfo&&active?.anchor===artistInfo)closeGalleryMainSurface(false);
      artistInfo?.remove();
      if(bar.dataset.galleryContextKind!=='playlist')bar.dataset.galleryContextKind='playlist';
    }
    const name = bar.querySelector('[data-gallery-context-name]'), summary = bar.querySelector('[data-gallery-context-summary]');
    const expandedFriend=currentMode==='recent'&&recentContext.personId&&recentContext.personId!=='me';
    const title=currentMode==='playlist'?'Loved and Obsessed':expandedFriend?recentContext.person:`Recent ${recentContext.kind}`;
    if (name && name.textContent !== title) name.textContent = title;
    const context = currentMode === 'playlist' ? 'Playlist' : currentMode === 'recent'&&!expandedFriend ? recentContext.person : '';
    if(summary)summary.hidden=!context;
    if (summary && summary.textContent !== context) summary.textContent = context;
    bar.querySelector('[data-gallery-context-artist-divider]')?.setAttribute('hidden', '');
    bar.querySelector('[data-gallery-context-inline-total]')?.setAttribute('hidden', '');
  }
  async function loadGallery(search, fixtureOptions = {}) {
    window.MockViewContext = fixtureOptions;
    const query = new URLSearchParams(search); query.set('surface', 'albums');
    await fetchAndRender('/view-data?' + query, false, { preserveScroll: false });
    layout(currentMode, currentKind);
    // The virtualizer may have prepared data while the native Gallery was
    // hidden by a full page. Re-measure only once it owns visible geometry.
    if(currentMode==='gallery')virtualGrid?.onResize();
  }
  // Desktop has no native resource-page presenter. This bounded adapter uses
  // its native page frame and the same singleton Details/layout renderer.
  function showDesktopAlbumPage(descriptor){
    if(!descriptor)return;
    const main=q('#shell-main-surface'),header=q('#mobile-page-header'),outlet=q('#mobile-page-outlet');
    main.classList.add('has-mobile-page');header.hidden=false;outlet.hidden=false;outlet.dataset.mobilePageKind='album';
    const back=q('#mobile-back-button');if(back.parentElement!==header)header.prepend(back);back.hidden=false;syncAlbumReturnAction();
    header.inert=false;header.removeAttribute('aria-hidden');header.setAttribute('data-album-identity-in-body','true');q('#mobile-page-title').textContent=descriptor.title;
    q('#mobile-page-summary').textContent=descriptor.subtitle;q('#mobile-page-cover').hidden=true;
    q('#mobile-settings-button').hidden=true;q('#mobile-settings-actions').hidden=true;
    modal().classList.add('is-mobile-page');outlet.append(modal());modal().inert=false;
    modal().querySelector('.track-modal-dialog').setAttribute('role','region');modal().querySelector('.track-modal-dialog').removeAttribute('aria-modal');
    document.title=descriptor.title+' — Album Haven';
    if(desktopFocusedAlbumKey!==descriptor.albumKey){
      desktopFocusedAlbumKey=descriptor.albumKey;
      requestAnimationFrame(()=>{if(currentMode==='album'&&!usesMobilePageLayout()&&desktopFocusedAlbumKey===descriptor.albumKey){const title=modal().querySelector('.album-details-header__primary')||q('#mobile-back-button');title.tabIndex=-1;title.focus({preventScroll:true});}});
    }
  }
  function openAlbum(album,nextPlacement='embedded',options={}){
    if(!album)return;
    renderingAlbum=true;currentAlbum=album;placement=nextPlacement;if(nextPlacement==='modal'){restore(modal());modal().classList.remove('is-mobile-page');modal().dataset.mockPlacement='modal';}
    try{openTrackModal(album,{foreground:true,...options});}finally{renderingAlbum=false;}
    lastClosed=false;layout(nextPlacement==='full'?'album':currentMode,currentKind);decorateAlbum();
  }
  function openArtistInfoPreview(anchor,nativeOpen){
    const info=q('[data-artist-info-overlay]');
    if(info){restore(info);delete info.dataset.mockPlacement;info.classList.remove('mock-shared-artist-info');info.setAttribute('role','dialog');info.removeAttribute('aria-modal');}
    const result=nativeOpen(anchor),full=info?.querySelector('[data-artist-info-full-page]');
    if(full&&callbacks.artistPage){
      const name=String(anchor.dataset.artist||'').trim();
      full.disabled=false;full.removeAttribute('aria-disabled');full.title='Open '+name+' artist page';full.setAttribute('aria-label',full.title);
      full.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();closeGalleryMainSurface(true);if(anchor.isConnected)anchor.focus({preventScroll:true});callbacks.artistPage(name);},{once:true});
    }
    return result;
  }
  function showArtist(artist) {
    if (!artist) return;
    const info=q('[data-artist-info-overlay]');
    // Preserve the native summary expansion while rehosting the same artist.
    if(info.querySelector('h2')?.textContent!==artist.name){
      const anchor=document.createElement('button');anchor.dataset.artist=artist.name;
      openGalleryArtistInfo(anchor);closeGalleryMainSurface(false);
    }
    const full=currentMode==='artist';
    (full?q('#shell-main-surface'):q('#mock-artist-panel')).append(info);
    info.dataset.mockPlacement=full?'full':'embedded';info.hidden=false;
    info.removeAttribute('aria-hidden');info.setAttribute('role','region');info.removeAttribute('aria-modal');
    info.classList.add('mock-shared-artist-info');
    let metadata=info.querySelector('.mock-artist-details');
    if(!metadata){metadata=make('div','','mock-artist-details');info.querySelector('.artist-info-overlay__body').prepend(metadata);}
    let labels=metadata.querySelector('.mock-artist-labels');
    if(!labels){metadata.querySelector(':scope > strong')?.remove();labels=make('div','','mock-artist-labels');metadata.prepend(labels);}
    const tags=[...(artist.place?[{message:artist.place,className:'mock-artist-country',attributes:{title:'Country: '+artist.place,'aria-label':'Country: '+artist.place}}]:[]),...String(artist.genre||'').split(' · ').filter(Boolean).map(genre=>({message:genre,className:'mock-artist-genre',attributes:{title:'Genre: '+genre,'aria-label':'Genre: '+genre}}))];
    const signature=JSON.stringify(tags);
    if(labels.dataset.signature!==signature){labels.innerHTML=tags.map(tag=>window.AlertComponent.buildAlertLabelHtml({severity:'info',...tag})).join('');labels.dataset.signature=signature;}
    let popularity=info.querySelector('.mock-artist-global-plays');
    if(!popularity)popularity=make('p','mock-artist-global-plays','mock-global-popularity mock-artist-global-plays');
    if(popularity.parentElement!==metadata)metadata.append(popularity);
    const total=socialOwners.artistPopularity?.(artist);popularity.hidden=!Number.isFinite(total);
    let link=popularity.querySelector('a');
    if(!link){popularity.replaceChildren();link=document.createElement('a');link.className='mock-native-link';link.dataset.mockLastfmArtist='';link.href='#mock-lastfm-artist';link.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();showToast('Fictional Last.fm artist page preview; no external account or page is connected.','info',3500);});popularity.append(link);}
    const text=Number.isFinite(total)?`Plays on LastFM: ${total.toLocaleString('en-US')}`:'';
    if(link.textContent!==text)link.textContent=text;
    link.dataset.mockLastfmArtist=artist.id;link.title='Fictional Last.fm page for '+artist.name+'; preview only';link.setAttribute('aria-label',text+'; '+link.title);

  }
  function refreshListenTimes(){
    const zone=socialOwners.listenTimeZone?.()||getPreferredUserTimeZone();if(zone===lastListenTimeZone)return;lastListenTimeZone=zone;
    for(const value of document.querySelectorAll('.mock-listen-time time[datetime]')){const stamp=value.dateTime;value.textContent=socialOwners.formatListenTime?.(stamp)||stamp;value.title=stamp+' · Fictional preview time · '+zone;}
  }
  function describeButtons(root=document){
    for(const button of root.querySelectorAll('button')){
      const labelled=(button.getAttribute('aria-labelledby')||'').split(/\s+/).filter(Boolean).map(id=>document.getElementById(id)?.textContent||'').join(' ').trim();
      const label=button.getAttribute('aria-label')||labelled||button.getAttribute('title')||button.textContent.trim();
      if(!label)continue;
      if(!button.getAttribute('title'))button.title=label;
      if(!button.getAttribute('aria-label')&&!labelled)button.setAttribute('aria-label',label);
    }
  }
  function activate(root) {
    if (!root) return;
    describeButtons(root);syncGalleryCardMetadataMotion(root);syncRecentTrackLayout(root);
    for (const image of root.querySelectorAll('img[data-gallery-cover-src]')) {
      const source = image.getAttribute('data-gallery-cover-src');
      image.removeAttribute('data-gallery-cover-src');
      void loadGalleryCoverPreviewImage(image, source);
    }
    attachSharedPlayer();
    if (state.player.current) updatePlayerUi();
  }
  function playTable({ id, rows, label, person, factor = 1, artwork = false, loveColumn = false, timeColumn = false, history = false, selectedTrack = null, selectedListen = null }) {
    const tracks = rows.map((row, index) => ({ ...row.track, trackNumber: index + 1, secondaryArtist: row.artist,
      albumArtist: row.track.album_artist, coverPath: row.track.cover_path, durationSeconds: row.track.duration_seconds,
      duration: formatDuration(row.track.duration_seconds), originalDuration: formatDuration(row.track.duration_seconds) }));
    const host = document.createElement('div');
    host.innerHTML = buildAlbumTrackTableHtml({ idPrefix: id, ariaLabel: label, groups: [{ tracks }], playingAnimation: false });
    const table = host.querySelector('.compact-data-table');
    table.style.setProperty('--cdt-columns', `36px minmax(0,1fr) ${timeColumn?'minmax(172px,auto) ':''}42px ${loveColumn?'32px ':''}minmax(48px,auto)`);table.dataset.mockTimeColumn=String(timeColumn);
    if(timeColumn&&artwork){
      table.dataset.mockRecentTracks='true';
      // Header and every row share the same metric budgets. Reserve room for
      // the native 28px play target and a signed remaining-time value, while
      // the central identity is the only flexible track in this phone grid.
      const countCharacters=rows.reduce((width,item)=>Math.max(width,String(item?.missing?'—':item?.count??0).length),5);
      const durationCharacters=tracks.reduce((width,track)=>Math.max(width,track.duration.length+1),6);
      table.style.setProperty('--mock-recent-mobile-columns',`30px minmax(0,1fr) ${countCharacters}ch ${loveColumn?'32px ':''}${durationCharacters}ch`);
    }
    let rowIndex=0;
    for (const row of table.querySelectorAll('[role="row"]')) {
      row.querySelector('[data-cdt-column="problem"]')?.remove();
      const duration = row.querySelector('[data-cdt-column="duration"]'); if (!duration) continue;
      const header = !!row.querySelector('[role="columnheader"]');
      const cell = document.createElement('div'); cell.dataset.cdtColumn = 'count'; cell.setAttribute('role', header ? 'columnheader' : 'cell');
      cell.className = 'mock-count-cell';
      if (header) cell.id = table.id + '-count'; else cell.setAttribute('aria-labelledby', table.id + '-count');
      if (header) cell.textContent = 'Plays';
      else {
        const item = rows[rowIndex++];if(item?.listenId){row.dataset.mockEventId=item.listenId;row.dataset.cdtRowKey=item.listenId;}const selected=history?!!selectedListen&&item?.listenId===selectedListen:item?.track.path===selectedTrack;row.classList.toggle('mock-selected-track',selected);row.setAttribute('aria-selected',String(selected));
        cell.textContent = item?.missing ? '—' : String(item?.count ?? 0);
        row.dataset.mockTrackAlbum = item?.album.id || '';
        row.classList.toggle('mock-missing', !!item?.missing);
        if(artwork&&item?.album){const title=row.querySelector('[data-cdt-column=title]');title.classList.add('mock-track-with-art');const art=document.createElement('span');art.className='mock-track-art';art.innerHTML=buildUtilityAlbumArtbox(item.album,{label:`${item.album.name} artwork`,interactive:false});title.prepend(art);if(timeColumn){const identity=title.querySelector('.album-track-table__title');identity.querySelector('.album-track-table__secondary')?.classList.add('mock-recent-track-artist');const album=document.createElement('span');album.className='mock-recent-track-album album-track-table__secondary';album.textContent=item.album.name;identity.append(album);}}
      }
      if(timeColumn){const time=document.createElement(header?'div':'span');time.dataset.cdtColumn='listenTime';time.className='mock-listen-time';time.setAttribute('role',header?'columnheader':'cell');if(header){time.id=table.id+'-listen-time';time.textContent=history?'Played at':'Last played';}else{const item=rows[rowIndex-1],stamp=item?.listenedAt||item?.lastListenedAt;time.setAttribute('aria-labelledby',table.id+'-listen-time');if(stamp){const value=document.createElement('time');value.dateTime=stamp;value.title=stamp+' · Fictional preview time · '+(socialOwners.listenTimeZone?.()||getPreferredUserTimeZone());value.textContent=socialOwners.formatListenTime?.(stamp)||stamp;time.append(value);}else time.textContent='—';}duration.before(time);}
      duration.before(cell);if(loveColumn){const love=document.createElement('div');love.className='mock-track-love-cell';love.dataset.cdtColumn='love';love.setAttribute('role',header?'columnheader':'cell');if(header){love.textContent='Love';love.id=table.id+'-love';}else{love.innerHTML=socialOwners.trackLoveControl?.(rows[rowIndex-1]?.track.path)||'';love.setAttribute('aria-labelledby',table.id+'-love');}duration.before(love);}
    }
    syncRecentTrackLayout(host);return host.innerHTML;
  }
  function syncRecentTrackLayout(root=document){
    const mobile=usesMobilePageLayout();
    for(const table of root.querySelectorAll('.compact-data-table[data-mock-recent-tracks=true]')){
      table.dataset.mockTrackLayout=mobile?'compact':'columns';
      const nativeTable=table.closest('.album-track-table');if(nativeTable)nativeTable.dataset.mockTrackLayout=table.dataset.mockTrackLayout;
      for(const row of table.querySelectorAll('[role=row]')){
        const time=row.querySelector('[data-cdt-column=listenTime]');if(!time)continue;
        if(time.getAttribute('role')==='columnheader'){time.hidden=mobile;continue;}
        const identity=row.querySelector('[data-cdt-column=title]>.album-track-table__title'),count=row.querySelector('[data-cdt-column=count]');
        if(mobile&&identity){time.removeAttribute('role');if(time.parentElement!==identity)identity.append(time);}
        else if(count){time.setAttribute('role','cell');if(time.parentElement!==row||time.nextElementSibling!==count)count.before(time);}
      }
    }
  }
  function formatDuration(seconds) { return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; }
  function flatGallery({ records, width, compact = false, view = 'cards', person, factor = 1, missing = false, homeGrid = false, fluid = false }) {
    const target = compact ? 138 : 190, gap = 16;
    const columns = view === 'list' ? 1 : Math.max(1, Math.floor((width + gap) / (target + gap)));
    const cardWidth = view === 'list' ? Math.max(120, width) : Math.max(110, (width - gap * (columns - 1)) / columns);
    const renderAlbumHtml = album => {
      const host = document.createElement('div'); host.innerHTML = albumCardHtml(album, { displayMode: view, coverPriority: 'visible' });
      const card = host.firstElementChild; card.classList.toggle('mock-missing', missing);
      const info = card.querySelector('.gallery-card-info') || card.querySelector('.album-body');
      if (info) {
        const counts = document.createElement('div'); counts.className = 'mock-card-listen-metrics';
        const full = album.mock.full[person], total = album.mock.counts[person] || 0;
        const fullLabel=document.createElement('span'),trackLabel=document.createElement('span');
        fullLabel.textContent=`${missing||full==null?'—':full*factor} Full listens`;trackLabel.textContent=`${missing?'—':total*factor} Track listens`;counts.append(fullLabel,trackLabel);if(missing)counts.title='No listens in this period';
        info.append(counts);
      }
      return host.innerHTML;
    };
    return fluid||homeGrid ? `<div class="${homeGrid?'mobile-home-grid':'mock-fluid-gallery'}" data-view="${view}">${records.map(renderAlbumHtml).join('')}</div>` : buildArtistSectionRowsHtml(records,columns,{renderAlbumHtml},cardWidth);
  }
  function artistTree({ rows, selected, view = 'rows' }) {
    return `<div class="mock-artist-list" data-view="${view}">${view==='icons'?'':'<div class="mock-artist-columns" aria-hidden="true"><span>Artist</span><span>Plays</span></div>'}<div class="navigation-tree mock-artist-tree">${rows.map(row => NavigationTree.renderItem({ variant: 'wide', action: true, key: row.id, label: row.title, subtitle: row.artist, count: view==='icons'?`Plays: ${row.count}`:row.count, selected: row.id === selected,
      artworkHtml: buildUtilityAlbumArtbox(row.album, { label: row.title, interactive: false }), attributes: { 'data-mock-artist-select': row.id } })).join('')}</div></div>`;
  }
  function artistTable({ id, rows, label }) {
    return buildCompactDataTable({ id, ariaLabel: label, columns: 'minmax(0,1fr) 42px', columnsConfig: [{ key: 'artist', label: 'Artist' }, { key: 'count', label: 'Plays', action: true }], rows: rows.map(row => ({ key: row.id, className: row.missing ? 'mock-missing' : '', cells: {
      artist: { content: `<button class="mock-artist-cell" data-mock-go-artist="${escapeHtml(row.title)}">${buildUtilityAlbumArtbox(row.album, { label: row.title, interactive: false })}<span>${escapeHtml(row.title)}</span></button>` }, count: { content: row.missing ? '—' : String(row.count) },
    } })) });
  }
  function syncSidebarMode(){
    const folded=!isArtistsDrawerMobileViewport()&&canUseArtistsDrawerForCurrentView()&&!!state.ui.artistTreeFolded;
    q('#sidebar-list').hidden=folded||sidebarMode!=='artists';q('#mock-playlist-sidebar').hidden=folded||sidebarMode!=='playlists';
    q('#artist-tree-navigation-button').setAttribute('aria-pressed',String(sidebarMode==='artists'));
    const mobileArtists=q('[data-mobile-artists-mode]');if(mobileArtists){mobileArtists.classList.add('mock-sidebar-mode-button');mobileArtists.setAttribute('aria-pressed',String(sidebarMode==='artists'));mobileArtists.title='Artists';const label=mobileArtists.querySelector('.action-button__content>span');if(label){label.classList.add('mock-action-label');label.hidden=sidebarMode!=='artists';}}
    q('#shell-navigation-rail').dataset.mockSidebarMode=sidebarMode;
    const artistPageSelected=['gallery','artist-page','artist'].includes(currentMode),playlistPageSelected=currentMode==='playlist';
    for(const button of document.querySelectorAll('#artist-tree-navigation-button,[data-mobile-artists-mode]'))button.dataset.mockTargetSelected=String(artistPageSelected);
    for(const button of document.querySelectorAll('#mock-playlist-rail-action button,#mock-sidebar-mode-actions button'))button.dataset.mockTargetSelected=String(playlistPageSelected);
    const heading=q('.desktop-artists-heading');if(heading)heading.textContent=sidebarMode==='playlists'?'Playlists':'Artists';
    const collapse=q('#artist-tree-fold-button');if(collapse){collapse.setAttribute('aria-label',sidebarMode==='playlists'?'Collapse Playlists':'Collapse Artist Tree');collapse.title=collapse.getAttribute('aria-label');}
  }
  function showSidebar(mode='artists',open=false){sidebarMode=mode;syncSidebarMode();if(open){if(isArtistsDrawerMobileViewport()){if(!state.ui.artistsDrawerOpen)openArtistsDrawer();}else if(state.ui.artistTreeFolded)toggleArtistTreeFold();}}
  function closeSidebar(){
    // A playlist row navigates the main body. Only a phone drawer closes;
    // desktop folding stays with its native control and the inactivity policy.
    // Native close restores the connected opener before the old row is inert.
    if(!isArtistsDrawerMobileViewport()||!state.ui.artistsDrawerOpen)return false;
    closeArtistsDrawer({restoreFocus:false});return true;
  }
  function projectTablePlayback(){
    const snapshot=getPlayerPlaybackSnapshot(),path=String(state.player.current?.path||'');
    const artworkLabel=callbacks.playerArtworkLabel?.()||'Open album details';for(const button of document.querySelectorAll('#player-cover-button,[data-compact-player-cover]')){button.setAttribute('aria-label',artworkLabel);button.title=artworkLabel;}
    for(const row of document.querySelectorAll('[data-track-row-path]')){
      const cell=row.querySelector('[data-track-duration-path]');if(!cell)continue;
      const current=!!path&&row.dataset.trackRowPath===path;const original=cell.dataset.originalDuration||'';
      delete cell.dataset.mockRemaining;delete cell.dataset.mockElapsed;cell.title=original?`Full length: ${original}`:'';
      if(current){const elapsed=formatTrackDuration(Math.floor(snapshot.currentTime||0))||'0:00';cell.dataset.mockElapsed=elapsed;const duration=Number(snapshot.duration)||Number(row.querySelector('.play-track-button')?.dataset.trackDurationSeconds)||0;cell.dataset.mockRemaining='−'+(formatTrackDuration(Math.max(0,Math.floor(duration-(snapshot.currentTime||0))))||'0:00');cell.textContent=cell.matches(':hover')?cell.dataset.mockRemaining:elapsed;}
      else cell.textContent=original;
      if(row.closest('#mock-recent-body,#mobile-home,.mock-comparison')){const playing=current&&!snapshot.paused&&!snapshot.ended;row.classList.toggle('is-current',current);row.classList.toggle('album-track-table__row--current',current);row.classList.toggle('album-track-table__row--playing',playing);row.dataset.trackPlaying=playing?'true':'';}
    }
  }
  function previewTrack(button, options={}) {
    const track = { src: button.dataset.src, path: button.dataset.trackPath, title: button.dataset.trackTitle, artist: button.dataset.trackArtist, albumArtist: button.dataset.trackAlbumArtist, album: button.dataset.trackAlbum, coverPath: button.dataset.trackCover, durationSeconds: Number(button.dataset.trackDurationSeconds) || 0 };
    if (!track.path?.startsWith('mock-track:')) return;
    if(!options.queueManaged)callbacks.queueSource?.(track.path,button.closest('#track-modal')?currentAlbum?.id:null);
    state.player.playbackQueue=null;
    setCurrentPlayerTrack(track, { persist:false }); triggerAlbumTrackPlayActivation(button); updatePlayerUi();
    showToast('Track selected in the preview. Audio is unavailable; no stream has started.', 'info', 3400);
  }
  function syncAlbumActionHost(){
    const header=q('#mobile-page-header'),actions=q('#mock-album-page-actions');if(!header||!actions)return;
    const mobile=usesMobilePageLayout(),active=mobilePageState.pages.at(-1),foreground=currentMode==='album'&&placement==='full'&&(!mobile||active?.kind==='album');
    actions.hidden=!foreground;
    const overview=modal()?.querySelector('.mobile-album-overview');
    const inBody=foreground&&mobile&&header.dataset.albumIdentityInBody==='true'&&overview;
    const destination=inBody?overview:header,focused=actions.contains(document.activeElement)?document.activeElement:null;
    if(actions.parentElement!==destination){destination.append(actions);if(focused?.isConnected&&!destination.closest('[inert],[aria-hidden="true"]'))focused.focus({preventScroll:true});}
    actions.dataset.mockAlbumActionHost=inBody?'inline':'page';
  }
  function decorateAlbum() {
    const album = getCurrentTrackModalAlbum() || currentAlbum; if (!album) return; currentAlbum = album;
    // Native layouts put artist identity in different text slots. Decorate
    // just the matching text, preserving separators, tags and independent links.
    const linkText = (owner, text, attribute, value) => {
      if (!owner || owner.querySelector('['+attribute+']')) return;
      const walker = document.createTreeWalker(owner, NodeFilter.SHOW_TEXT);
      let candidate;
      while ((candidate = walker.nextNode())) {
        if (candidate.parentElement.closest('button')) continue;
        const offset = candidate.textContent.indexOf(text);
        if (offset < 0) continue;
        const link = document.createElement('button'); link.type='button'; link.className='mock-native-link';
        link.setAttribute(attribute,value); link.textContent=text;
        candidate.replaceWith(document.createTextNode(candidate.textContent.slice(0,offset)),link,document.createTextNode(candidate.textContent.slice(offset+text.length)));
        return;
      }
    };
    if(placement==='full')linkText(q('#mobile-page-summary'),album.album_artist,'data-mock-album-artist',album.album_artist);
    for (const header of modal().querySelectorAll('.album-details-header')) {
      const slots = [q('#mock-album-native-actions'),q('#mock-album-native-page-actions')].filter(Boolean);
      let actions = header.querySelector('.album-details-header__actions');
      if (!actions) actions = slots.flatMap(slot => [...slot.children]).find(action => positions.get(action)?.parentNode === header);
      const destination = placement === 'embedded' ? slots[0] : placement==='full'?slots[1]:null;
      if (actions && destination) {
        for (const slot of slots) for (const old of [...slot.children]) if (old !== actions) { positions.get(old)?.remove(); positions.delete(old); old.remove(); }
        mark(actions); if (actions.parentElement !== destination) destination.append(actions);
      } else if (actions) restore(actions);
      linkText(header,album.album_artist,'data-mock-album-artist',album.album_artist);
      const title = header.querySelector('.album-details-header__primary');
      if (placement !== 'full') linkText(title,album.name,'data-mock-album-page',album.id);

    }
    const settings=q('#mock-album-settings-action');
    const config=q('#mock-album-config-action'),playback=q('#mock-album-playback-actions'),tableControls=q('#mock-album-table-controls'),settingsHost=placement==='modal'?modal().querySelector('.album-details-header__actions'):q('#mock-album-page-actions');
    if(settings.parentElement!==settingsHost)settingsHost.append(settings);
    const tableHost=modal().querySelector('.track-modal-main');if(tableHost&&tableControls.parentElement!==tableHost)tableHost.prepend(tableControls);
    if(playback.parentElement!==tableControls)tableControls.append(playback);if(config.parentElement!==tableControls)tableControls.append(config);
    config.hidden=false;config.querySelector('button')?.classList.remove('track-modal-cover-tool');
    const close=document.getElementById('track-modal-close');if(close&&close.hidden!==['full','embedded'].includes(placement))close.hidden=['full','embedded'].includes(placement);
    const cover=q('#track-modal-cover');if(cover){let popularity=modal().querySelector('.mock-album-global-plays');if(!popularity)popularity=make('p','mock-album-global-plays','mock-global-popularity mock-album-global-plays');const identity=modal().querySelector('.track-modal-header .album-details-header__identity'),host=placement==='embedded'&&identity?identity:cover;if(popularity.parentElement!==host)host.append(popularity);const total=socialOwners.albumPopularity?.(album);const label=Number.isFinite(total)?`${total.toLocaleString('en-US')} Plays`:'';if(popularity.textContent!==label)popularity.textContent=label;popularity.title='Fictional global album popularity';cover.classList.toggle('mock-cover-with-plays',placement!=='embedded');}
    syncAlbumActionHost();callbacks.albumRendered?.(album);
  }
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', initialize, { once: true }); else initialize();
})();
