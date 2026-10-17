// Synthetic HTTP/shell/paint fixture. The complete actual request, queue,
// Settings/mobile/Top/confirmation owners load unchanged after this file.
window.bootstrapNavigationFixture=function(options={}){
  const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0'),TOP=id(1),OTHER=id(2),STAMP='a'.repeat(64);
  const calls={navigation:[],settings:[],writes:[],confirm:0,forms:0,reads:0,search:[],aborts:0,unhandled:[]};
  const requests=[];let blockerDispatch=false,blockerPromise=null;
  const f=window.navFixture={calls,options,TOP,OTHER,STAMP,requests};
  // Observe native unhandled failures without suppressing default browser reporting.
  window.addEventListener('unhandledrejection',event=>calls.unhandled.push(String(event.reason?.message||event.reason)));
  window.state={view:{surface:{active:'album_tops'},top_ref:TOP,context_ref:STAMP},ui:{activeViewRequestId:0,librarySidebarMode:'album_tops'},
    status:{inventory_mutation_revision:1},gallery:{albumIndex:new Map()},player:{},busy:false};
  history.replaceState({albumHavenNavigationPosition:0},'','/?surface=album_tops');
  history.pushState({albumHavenNavigationPosition:1},'','/?surface=album_tops&top_ref='+TOP);
  window.getLibrarySidebarMode=()=>state.ui.librarySidebarMode;
  window.selectLibrarySidebarMode=mode=>{state.ui.librarySidebarMode=mode;return true;};
  window.closeArtistsDrawer=()=>{};
  window.AlbumHavenHomeRuntime={buttonHtml:value=>ButtonComponent.renderButton(value),actionHtml:value=>ButtonComponent.renderActionButton(value),
    alertHtml:value=>buildOnPageAlertHtml(value),galleryCardHtml:value=>buildGalleryCardHtml(value),artboxHtml:value=>buildAlbumArtboxHtml(value),
    searchHtml:value=>buildSearchInputHtml(value),tabsHtml:value=>buildInPageTabsHtml(value),mountTabs:value=>mountInPageTabs(value),
    navigationItemHtml:value=>NavigationTree.renderItem(value)};
  Object.assign(window,{
    startupMetrics:{markOnce(){},schedulePaintMark(){},completeInitialRefresh(){},completeVisibleInitialRefresh(){}},appBootstrap:{},
    getTrackModalElements:()=>({overlay:null}),getAlbumRequestKey:value=>value?.key||'',getAlbumIdentity:value=>value?.key||'',
    getIndexedAlbum:key=>state.gallery.albumIndex.get(key)||null,
    buildApiUrl:()=>'/view-data?surface=albums&gallery_page_size=50',parseUrlStateFromUrl:()=>({}),
    buildUrl:value=>'/?'+new URLSearchParams({surface:value.surface?.active||'albums',...(value.top_ref?{top_ref:value.top_ref}:{})}),
    scheduleBrowserAnimationFrame:callback=>requestAnimationFrame(callback),cancelBrowserAnimationFrame:id=>cancelAnimationFrame(id),
    scheduleBrowserTimeout:(callback,delay)=>setTimeout(callback,delay),clearBrowserTimeout:id=>clearTimeout(id),
    renderRelated(){},hideGalleryOptionsMenu(){},renderLibraryLoader(){},showToast(){},
  });
  window.fetch=(value,requestOptions={})=>{
    const url=String(value),parameters=new URL(url,location).searchParams;
    if(new URL(url,location).pathname!=='/view-data'){
      calls.settings.push(url);return Promise.resolve({ok:true,status:200,url:new URL(url,location).href,headers:new Headers({'content-type':'text/html'}),
        text:async()=>'<html><head><title>Fixture account</title></head><body><nav data-settings-nav><a href="/account" data-navigation-tree-item="settings" data-navigation-tree-key="account">Account</a></nav><main data-settings-outlet><h1>Account fixture</h1></main></body></html>'});
    }
    const record={url,kind:blockerDispatch?'blocker':'destination',settled:false,aborted:false,failure:options.navigationFailure||null,requestId:state.ui.activeViewRequestId};
    requests.push(record);if(record.kind==='destination')calls.navigation.push(url);
    return new Promise((resolve,reject)=>{
      const payload=()=>({ok:true,surface:{active:'album_tops'},top_ref:parameters.get('top_ref'),context_ref:document.querySelector('#app-shell').dataset.privateUiContext});
      record.release=()=>{if(record.settled)return;record.settled=true;
        if(record.kind==='destination'&&record.failure==='network'){reject(new TypeError('Synthetic destination unavailable'));return;}
        if(record.kind==='destination'&&record.failure==='http'){resolve({ok:false,status:503,json:async()=>({error:'Synthetic destination unavailable'})});return;}
        const data=payload();if(record.kind==='destination'&&record.failure==='wrong-resource')data.top_ref=data.top_ref===TOP?OTHER:TOP;
        resolve({ok:true,status:200,json:async()=>data});};
      requestOptions.signal?.addEventListener('abort',()=>{if(!record.settled){record.settled=true;record.aborted=true;reject(Object.assign(new Error('Synthetic request aborted'),{name:'AbortError'}));}},{once:true});
      if(record.kind==='destination'&&!options.holdDestination)queueMicrotask(record.release);
    });
  };
  f.beginBlocker=kind=>{
    if(state.busy)throw new Error('A real request is already active; reset or release it first');
    const original=window.AbortController;
    // Exercise the owner's supported no-abort-controller branch without
    // fabricating busy/queue fields or replacing its interrupt decision.
    if(kind==='queue')window.AbortController=undefined;
    blockerDispatch=true;
    try{blockerPromise=fetchAndRender('/view-data?surface=album_tops&top_ref='+(kind==='same-url'?OTHER:TOP),false,
      {skipPendingViewTransition:true,shouldApplyResponse:()=>false});}
    finally{blockerDispatch=false;window.AbortController=original;}
    blockerPromise.catch(error=>{f.blockerError=String(error);});
  };
  f.releaseBlocker=()=>requests.find(record=>record.kind==='blocker'&&!record.settled)?.release();
  f.allowNavigation=()=>{options.navigationFailure=null;};
  f.setHoldDestination=value=>{options.holdDestination=value===true;};
  f.releaseDestination=()=>requests.find(record=>record.kind==='destination'&&!record.settled)?.release();
  window.handleGalleryBootstrapPopState=()=>{
    if(location.pathname!=='/')return;const parameters=new URL(location.href).searchParams;
    state.view={surface:{active:'album_tops'},top_ref:parameters.get('top_ref'),context_ref:document.querySelector('#app-shell').dataset.privateUiContext};
    AlbumHavenAlbumTopsRuntime.sync();
  };
};
window.installNavigationObservers=function(){
  // Only final painting/view sink are substituted. Actual request IDs, pending
  // transition, response gates, queue cleanup and history owner stay genuine.
  window.cancelTrackModalAlbumDetailsPrewarms=()=>{};
  window.applyViewPayload=payload=>{state.view=payload;};
  window.renderView=()=>AlbumHavenAlbumTopsRuntime.sync();
  window.renderArtistGroups=()=>{};window.resumeScanPageGalleryCoverLoads=()=>{};
  const confirm=window.showAppConfirmDialog,form=window.showAppFormDialog;
  window.showAppConfirmDialog=function(...args){navFixture.calls.confirm++;return confirm(...args);};
  window.showAppFormDialog=function(...args){navFixture.calls.forms++;return form(...args);};
  window.addEventListener('popstate',()=>{if(!handleMobilePagePopState())handleGalleryBootstrapPopState();});
};
