/* Adapter for the isolated preview. Every native node is single-instance. */
(function(){
  const q=s=>document.querySelector(s);
  let initialized=false, currentMode='gallery', callbacks={}, currentAlbum=null,recentHeading='Recent albums';
  const positions=new Map();
  const mark=node=>{if(node&&!positions.has(node)){const marker=document.createComment('original native position');node.before(marker);positions.set(node,marker);}};
  const restore=node=>{const marker=positions.get(node);if(marker?.parentNode)marker.after(node);};
  const make=(tag,id,className)=>{const node=document.createElement(tag);node.id=id;if(className)node.className=className;return node;};
  function initialize() {
    if(initialized)return;
    initialized=true;
    const main=q('#shell-main-surface'),bar=q('[data-gallery-bar-instance="gallery"]'),scroll=q('#albums-scroll'),modal=q('#track-modal'),info=q('[data-artist-info-overlay]');
    [bar,scroll,modal,info].forEach(mark);
    if(typeof mobileHomeBarPosition!=='undefined'&&mobileHomeBarPosition)mark(mobileHomeBarPosition);
    const heading=make('div','mock-heading');main.prepend(heading);
    const workspace=make('div','mock-workspace');
    const activity=make('section','mock-activity','mock-flat-panel');
    const tools=make('div','mock-activity-tools');const custom=make('div','mock-activity-custom','gallery-scrollbar');
    activity.append(tools,custom);
    const albumPanel=make('section','mock-album-panel','mock-flat-panel');
    const albumTools=make('div','mock-album-tools');albumPanel.append(albumTools);
    const artistPanel=make('section','mock-artist-panel','mock-flat-panel');
    const artistTools=make('div','mock-artist-tools');artistPanel.append(artistTools);
    workspace.append(activity,albumPanel,artistPanel);main.append(workspace);
    const single=make('div','mock-single-custom','gallery-scrollbar');main.append(single);
    const toolbar=make('div','mock-feature-actions','toolbar-right');q('.app-bar--library .toolbar-right').prepend(toolbar);
    const noticeMount=make('div','mock-request-notices');q('#cover-lookup-drawer-body').prepend(noticeMount);
    new MutationObserver(()=>{if(!q('#mock-request-notices')){q('#cover-lookup-drawer-body').prepend(noticeMount);}}).observe(q('#cover-lookup-drawer-body'),{childList:true});
    const collapse=make('span','mock-gallery-collapse');bar.querySelector('.gallery-bar__actions').append(collapse);
    const galleryContext=make('span','mock-gallery-context-label','gallery-bar__summary');bar.querySelector('.gallery-bar__context').append(galleryContext);
    const fullTools=make('div','mock-full-album-tools');main.append(fullTools);
    new MutationObserver(decorateGalleryTitle).observe(bar,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['data-gallery-context-kind']});
    new MutationObserver(()=>{
      decorateAlbum();
      if(currentMode==='album'&&modal.hidden)callbacks.albumClosed?.();
    }).observe(modal,{childList:true,subtree:true,attributes:true,attributeFilter:['hidden']});
    new MutationObserver(()=>callbacks.galleryRendered?.()).observe(q('#artist-groups'),{childList:true,subtree:true});
    window.addEventListener('resize',()=>{
      const narrow=window.innerWidth<=900;
      if(narrow&&['home','profile'].includes(currentMode)&&modal.dataset.mockPlacement==='embedded'){
        closeTrackModal();
        if(typeof returnMobilePagesToGallery==='function')returnMobilePagesToGallery();
      }
      callbacks.viewportChanged?.(narrow);
    },{capture:true});
    document.addEventListener('click',event=>{
      if(event.target.closest('#mock-feature-actions,#mock-heading,#mock-activity-tools,#mock-album-tools,#mock-artist-tools,#mock-full-album-tools,#mock-gallery-collapse'))return;
      const artist=event.target.closest('[data-mock-album-artist]');
      if(artist){event.preventDefault();event.stopImmediatePropagation();callbacks.artist?.(artist.dataset.mockAlbumArtist);return;}
      const card=event.target.closest('[data-open-tracklist="1"]');
      if(card){
        const album=getIndexedAlbum(card.dataset.albumKey)||(()=>{try{return JSON.parse(card.dataset.album||'null');}catch{return null;}})();
        if(album){event.preventDefault();event.stopImmediatePropagation();callbacks.album?.(album);return;}
      }
      const nativeArtist=event.target.closest('#sidebar-list a[data-nav],#sidebar-list [data-nav]');
      if(nativeArtist){callbacks.beforeNativeGallery?.();return;}
      const brand=event.target.closest('.app-bar-brand');
      if(brand){event.preventDefault();event.stopImmediatePropagation();callbacks.library?.();}
    },true);
    document.addEventListener('submit',event=>{
      if(event.target.matches('#search-form')){callbacks.beforeNativeGallery?.();return;}
      if(event.target.matches('form[action="/logout"]')){
        event.preventDefault();event.stopImmediatePropagation();
        showToast('This is a fictional preview. There is no real account to sign out.','info',3000);
      }
    },true);
    const portalIds=['mock-heading','mock-activity-tools','mock-activity-custom','mock-album-tools','mock-artist-tools','mock-single-custom','mock-feature-actions','mock-request-notices','mock-gallery-collapse','mock-gallery-context-label','mock-full-album-tools'];
    const portals=Object.fromEntries(portalIds.map(id=>[id,document.getElementById(id)]));
    window.MockRealLayout={portals,setRecentContext:(person,period)=>{recentHeading=`${person}'s recent albums (${period})`;decorateGalleryTitle();},initialize,layout,openAlbum,showArtist,loadGallery,activateCovers,decorateAlbum,setCallbacks:value=>callbacks=value,
      getMode:()=>currentMode,getAlbum:()=>currentAlbum,readView:()=>state.view,
      card:(album)=>albumCardHtml(album,{coverPriority:'visible',displayMode:'cards'}),
      table:config=>buildCompactDataTable(config),trackPlay:track=>buildAlbumTrackPlayButtonHtml(track),
      dialog:options=>showAppFormDialog(options),confirm:options=>showAppConfirmDialog(options),
      toast:(message,type='success')=>showToast(message,type,3200),
      closeDialog:()=>q('#app-form-cancel')?.click(),
      closeAlbum:()=>closeTrackModal(),
    };
    window.dispatchEvent(new Event('mock-real-ui-ready'));
  }
  function layout(mode,kind='albums') {
    currentMode=mode;
    const multi=['home','profile'].includes(mode), main=q('#shell-main-surface'),bar=q('[data-gallery-bar-instance="gallery"]'),scroll=q('#albums-scroll'),modal=q('#track-modal'),info=q('[data-artist-info-overlay]');
    if(mode!=='album'&&typeof mobilePageState!=='undefined'&&mobilePageState.pages.some(page=>page.kind==='album'))returnMobilePagesToGallery();
    main.dataset.mockMode=mode;main.dataset.mockKind=kind;
    q('#mock-workspace').hidden=!multi;
    q('#mock-heading').hidden=!multi&&!['compare','activity'].includes(mode);
    q('#mock-single-custom').hidden=!['compare','activity'].includes(mode);
    q('#mock-activity-custom').hidden=kind==='albums';
    q('#mock-activity-tools').hidden=false;
    q('#mock-full-album-tools').hidden=mode!=='album';
    if(multi){
      if(typeof mobileHomeBarPosition!=='undefined'&&mobileHomeBarPosition)q('#mock-activity').insertBefore(mobileHomeBarPosition,q('#mock-activity-tools'));
      q('#mock-activity').insertBefore(bar,q('#mock-activity-tools'));q('#mock-activity').append(scroll);
      q('#mock-album-panel').append(modal);q('#mock-artist-panel').append(info);
      modal.dataset.mockPlacement='embedded';info.dataset.mockPlacement='embedded';
      bar.hidden=kind!=='albums';scroll.hidden=kind!=='albums';info.hidden=false;
      const dialog=modal.querySelector('.track-modal-dialog');dialog.setAttribute('role','region');dialog.setAttribute('aria-modal','false');
    }else{
      if(typeof mobileHomeBarPosition!=='undefined'&&mobileHomeBarPosition)restore(mobileHomeBarPosition);
      restore(bar);restore(scroll);restore(info);info.hidden=true;delete info.dataset.mockPlacement;
      if(mode==='album'){
        // Narrow-screen placement belongs to the actual mobile page owner.
        // Moving it out of that outlet would hide it under has-mobile-page.
        if(!usesMobilePageLayout()||!modal.classList.contains('is-mobile-page'))main.append(modal);
        modal.dataset.mockPlacement='full';
        const list=q('#track-modal-list');if(list)list.before(q('#mock-full-album-tools'));
        modal.querySelector('.track-modal-dialog').setAttribute('role','region');
        modal.querySelector('.track-modal-dialog').setAttribute('aria-modal','false');
        bar.hidden=true;scroll.hidden=true;
      }else{
        main.append(q('#mock-full-album-tools'));
        restore(modal);delete modal.dataset.mockPlacement;
        if(!modal.hidden&&typeof closeTrackModal==='function')closeTrackModal();
        modal.querySelector('.track-modal-dialog').setAttribute('role','dialog');modal.querySelector('.track-modal-dialog').setAttribute('aria-modal','true');
        bar.hidden=['compare','activity'].includes(mode);scroll.hidden=bar.hidden;
      }
    }
    document.body.classList.toggle('mock-multi-view',multi);
    document.body.classList.toggle('mock-full-album',mode==='album');
    document.body.classList.remove('modal-open');
    requestAnimationFrame(()=>{window.dispatchEvent(new Event('resize'));decorateAlbum();});
  }
  function decorateGalleryTitle(){
    if(!['home','profile','recent'].includes(currentMode))return;
    const bar=q('[data-gallery-bar-instance="gallery"]');
    if(!bar||!['gallery','home',undefined].includes(bar.dataset.galleryContextKind))return;
    const name=bar.querySelector('[data-gallery-context-name]'),title=currentMode==='recent'?recentHeading:'Recent albums';
    if(name&&name.textContent!==title)name.textContent=title;
  }
  async function loadGallery(search,fixtureOptions={}) {
    window.MockViewContext=fixtureOptions;
    const query=new URLSearchParams(search);
    query.set('surface','albums');
    await fetchAndRender('/view-data?'+query.toString(),false,{preserveScroll:false});
    decorateGalleryTitle();
    const kind=q('#shell-main-surface').dataset.mockKind||'albums';layout(currentMode,kind);
  }
  function openAlbum(album,placement='embedded') {
    currentAlbum=album;
    if(placement==='full')layout('album');
    openTrackModal(album,{foreground:true});
    // Mobile's existing page owner may reparent it. Full remains a real mobile
    // Album Details page; desktop and multi-panel hosting use the same node.
    if(!usesMobilePageLayout())layout(currentMode,q('#shell-main-surface').dataset.mockKind||'albums');
    document.body.classList.remove('modal-open');
    decorateAlbum();
  }
  function showArtist(artist){
    const info=q('[data-artist-info-overlay]');
    if(!artist)return;
    const anchor=document.createElement('button');anchor.dataset.artist=artist.name;
    openGalleryArtistInfo(anchor);
    if(['home','profile'].includes(currentMode)){
      closeGalleryMainSurface(false);
      q('#mock-artist-panel').append(info);info.dataset.mockPlacement='embedded';info.hidden=false;
      info.setAttribute('role','region');info.removeAttribute('aria-modal');
    }
  }
  function activateCovers(root){
    if(typeof virtualGrid!=='undefined'&&typeof virtualGrid.activateGalleryCoverImages==='function')virtualGrid.activateGalleryCoverImages(root);
  }
  function decorateAlbum(){
    const album=typeof getCurrentTrackModalAlbum==='function'?getCurrentTrackModalAlbum():currentAlbum;
    if(!album)return;currentAlbum=album;
    for(const header of document.querySelectorAll('#track-modal .album-details-header')){
      if(header.dataset.mockArtist===album.album_artist)continue;
      const secondary=header.querySelector('.album-details-header__secondary');
      const candidate=secondary?[...secondary.querySelectorAll('span')].find(span=>span.textContent===album.album_artist):null;
      const button=document.createElement('button');button.type='button';button.className='mock-artist-link';button.dataset.mockAlbumArtist=album.album_artist;button.textContent=album.album_artist;
      if(candidate){
        candidate.replaceWith(button);header.dataset.mockArtist=album.album_artist;
      }else{
        const owner=header.querySelector('.album-details-header__eyebrow')||header.querySelector('.album-details-header__primary');
        const walker=owner?document.createTreeWalker(owner,NodeFilter.SHOW_TEXT):null;
        let textNode;while(walker&&(textNode=walker.nextNode())){
          if(textNode.textContent.startsWith(album.album_artist)){
            const tail=document.createTextNode(textNode.textContent.slice(album.album_artist.length));
            textNode.replaceWith(button,tail);header.dataset.mockArtist=album.album_artist;break;
          }
        }
      }
    }
    callbacks.albumRendered?.(album);
  }
  if(document.readyState==='loading')window.addEventListener('DOMContentLoaded',initialize,{once:true});else initialize();
})();
