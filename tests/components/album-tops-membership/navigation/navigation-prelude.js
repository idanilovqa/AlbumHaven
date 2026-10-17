// Synthetic transport and shell DTO boundary. Settings/mobile/Top/confirmation owners load unchanged afterward.
window.bootstrapNavigationFixture=function(options={}){
  const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0'),TOP=id(1),OTHER=id(2),STAMP='a'.repeat(64);
  const calls={navigation:[],settings:[],writes:[],confirm:0,forms:0,reads:0,search:[],aborts:0};
  window.navFixture={calls,options,TOP,OTHER,STAMP};
  window.state={view:{surface:{active:'album_tops'},top_ref:TOP,context_ref:STAMP},ui:{activeViewRequestId:0,librarySidebarMode:'album_tops'}};
  const prior=options.previousSettings?'/account':'/?surface=album_tops';
  history.replaceState({albumHavenNavigationPosition:0},'',prior);
  history.pushState({albumHavenNavigationPosition:1},'','/?surface=album_tops&top_ref='+TOP);
  window.getLibrarySidebarMode=()=>state.ui.librarySidebarMode;
  window.selectLibrarySidebarMode=mode=>{state.ui.librarySidebarMode=mode;return true;};
  window.closeArtistsDrawer=()=>{};
  window.AlbumHavenHomeRuntime={buttonHtml:value=>ButtonComponent.renderButton(value),actionHtml:value=>ButtonComponent.renderActionButton(value),
    alertHtml:value=>buildOnPageAlertHtml(value),galleryCardHtml:value=>buildGalleryCardHtml(value),artboxHtml:value=>buildAlbumArtboxHtml(value),
    searchHtml:value=>buildSearchInputHtml(value),tabsHtml:value=>buildInPageTabsHtml(value),mountTabs:value=>mountInPageTabs(value),
    navigationItemHtml:value=>NavigationTree.renderItem(value)};
  window.fetch=async value=>{calls.settings.push(String(value));return{ok:true,status:200,url:new URL(value,location).href,headers:new Headers({'content-type':'text/html'}),
    text:async()=>'<html><head><title>Fixture account</title></head><body><nav data-settings-nav><a href="/account" data-navigation-tree-item="settings" data-navigation-tree-key="account">Account</a></nav><main data-settings-outlet><h1>Account fixture</h1></main></body></html>'};};
  window.fetchAndRender=async(url,push,request={})=>{
    const parameters=new URL(url,location).searchParams;
    const payload={surface:{active:'album_tops'},top_ref:parameters.get('top_ref'),context_ref:document.querySelector('#app-shell').dataset.privateUiContext};
    const requestId=++state.ui.activeViewRequestId;
    // This historical synthetic transport now honors the optional dispatch hook.
    // It does not emulate the genuine owner's busy/queue algorithm.
    if(request.onStart?.({requestId})===false||state.ui.activeViewRequestId!==requestId)return false;
    let applied=false,error=null;
    try{
      calls.navigation.push(url);await Promise.resolve();
      if(options.navigationFailure==='reject')throw Object.assign(new Error('Synthetic destination unavailable'),{status:503});
      if(options.navigationFailure==='false')return false;
      if(options.navigationFailure==='wrong-resource')payload.top_ref=parameters.get('top_ref')===TOP?OTHER:TOP;
      if(request.shouldApplyResponse&&request.shouldApplyResponse(payload)!==true)return false;
      state.view=payload;if(push)AlbumHavenSettingsNavigation.instance.pushLibraryHistory('/?'+parameters.toString(),{});
      AlbumHavenAlbumTopsRuntime.sync();applied=true;return true;
    }catch(caught){error=caught;throw caught;}
    finally{
      // Completion is observed only after actual synthetic dispatch. The real
      // native queue is independently tested, never emulated in this fixture.
      try{request.onSettled?.({applied,error,requestId});}catch(_error){/* Preserve the transport outcome. */}
    }
  };
  window.handleGalleryBootstrapPopState=()=>{
    if(location.pathname!=='/')return;const parameters=new URL(location.href).searchParams;
    state.view={surface:{active:'album_tops'},top_ref:parameters.get('top_ref'),context_ref:document.querySelector('#app-shell').dataset.privateUiContext};
    AlbumHavenAlbumTopsRuntime.sync();
  };
  navFixture.allowNavigation=()=>{options.navigationFailure=null;};
};
window.installNavigationObservers=function(){
  const confirm=window.showAppConfirmDialog,form=window.showAppFormDialog;
  window.showAppConfirmDialog=function(...args){navFixture.calls.confirm++;return confirm(...args);};
  window.showAppFormDialog=function(...args){navFixture.calls.forms++;return form(...args);};
  // Same destination renderer boundary as the native Gallery bubble listener. The actual Settings capture owner may stop it.
  window.addEventListener('popstate',()=>{if(!handleMobilePagePopState())handleGalleryBootstrapPopState();});
};
