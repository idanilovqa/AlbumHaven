/* Isolated review adapter. Native shell, Gallery, Details, tree and player stay single-instance. */
(function () {
  const q = selector => document.querySelector(selector) || (selector.startsWith('#mock-') ? window.MockRealLayout?.portals?.[selector.slice(1)] : null);
  const positions = new Map();
  const mark = node => { if (node && !positions.has(node)) { const marker = document.createComment('native home'); node.before(marker); positions.set(node, marker); } };
  const restore = node => { const marker = positions.get(node); if (marker?.parentNode && (node.parentNode !== marker.parentNode || marker.nextSibling !== node)) marker.after(node); };
  const make = (tag, id, className = '') => { const node = document.createElement(tag); node.id = id; node.className = className; return node; };
  let currentMode = 'gallery', currentKind = 'albums', placement = null, currentAlbum = null, callbacks = {}, initialized = false;
  let recentContext = { person: 'Alex Morgan', period: 'Last week', kind: 'albums' };
  let renderingAlbum = false, lastClosed = false;
  const modal = () => q('#track-modal');
  const recent = () => ['home', 'profile', 'recent'].includes(currentMode);
  function initialize() {
    if (initialized) return; initialized = true;
    // Native Gallery/mobile navigation restore their own positions; the added
    // preview surfaces do likewise. Avoid a second browser restoration of a
    // temporarily hidden custom scroll region during the same history turn.
    history.scrollRestoration='manual';
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
    const presentNativePage = presentMobilePage;
    presentMobilePage = descriptor => descriptor?.kind === 'album' && ['embedded','modal'].includes(placement) ? false : presentNativePage(descriptor);
    [bar, scroll, modal(), info].forEach(mark);
    q('.app-bar--library .app-bar-brand').setAttribute('aria-label','Album Haven Home');
    if (typeof mobileHomeBarPosition !== 'undefined') mark(mobileHomeBarPosition);
    main.prepend(make('div', 'mock-heading'));
    const workspace = make('div', 'mock-workspace');
    const activity = make('section', 'mock-activity', 'mock-module');
    const recentBody = make('div', 'mock-recent-body', 'gallery-scrollbar');
    recentBody.append(make('div', 'mock-recent-content'));
    activity.append(recentBody);
    const albumPanel = make('section', 'mock-album-panel', 'mock-module');
    const albumHeader = make('header', 'mock-album-header', 'mock-module-header');
    const albumTitle = make('strong', 'mock-album-heading'); albumTitle.textContent = 'Album details';
    const albumActions = make('div', 'mock-album-actions', 'mock-header-actions');
    albumActions.append(make('span', 'mock-album-expand'), make('span', 'mock-album-native-actions'));
    albumHeader.append(albumTitle, albumActions); albumPanel.append(albumHeader, make('div', 'mock-album-preferences'));
    const artistPanel = make('section', 'mock-artist-panel', 'mock-module');
    const artistHeader = make('header', 'mock-artist-header', 'mock-module-header'); artistHeader.innerHTML = '<strong>Artist info</strong><div class="mock-header-actions"><span id="mock-artist-expand"></span></div>'; 
    artistPanel.append(artistHeader);
    workspace.append(activity, albumPanel, artistPanel); main.append(workspace);
    main.append(make('div', 'mock-single-custom', 'gallery-scrollbar'));
    const toolbar = make('div', 'mock-feature-actions', 'toolbar-right'); q('.app-bar--library .toolbar-right').prepend(toolbar);
    const notices = make('div', 'mock-request-notices'); q('#cover-lookup-drawer-body').prepend(notices);
    new MutationObserver(() => { if (!document.getElementById('mock-request-notices')) q('#cover-lookup-drawer-body').prepend(notices); }).observe(q('#cover-lookup-drawer-body'), { childList: true });
    const mobileProfile=make('span','mock-mobile-profile-actions');bar.querySelector('.gallery-bar__title').append(mobileProfile);
    bar.querySelector('.gallery-bar__actions').prepend(make('span', 'mock-recent-expand'));
    const controls = make('div', 'mock-recent-controls'); controls.append(make('div', 'mock-recent-tabs'), make('div', 'mock-recent-period')); bar.append(controls);
    main.append(make('div', 'mock-full-album-tools', 'mock-full-album-tools'));
    main.append(make('div', 'mock-full-artist-tools', 'mock-full-album-tools'));
    const popupTools = make('span', 'mock-modal-page-action'); popupTools.hidden=true; main.append(popupTools);
    const portals = Object.fromEntries(['mock-artist-expand','mock-full-artist-tools','mobile-home-tracks','mobile-home-albums','mobile-home-artists','mock-mobile-profile-actions','mock-heading','mock-recent-content','mock-album-expand','mock-album-preferences','mock-single-custom','mock-feature-actions','mock-request-notices','mock-recent-expand','mock-recent-tabs','mock-recent-period','mock-full-album-tools','mock-modal-page-action'].map(id => [id, q('#' + id)]));
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
    document.addEventListener('click', event => {
      const target = event.target;
      const artist = target.closest('[data-mock-album-artist]');
      if (artist) { event.preventDefault(); event.stopImmediatePropagation(); callbacks.artist?.(artist.dataset.mockAlbumArtist); return; }
      const title = target.closest('[data-mock-album-page]');
      if (title) { event.preventDefault(); event.stopImmediatePropagation(); callbacks.albumPage?.(currentAlbum); return; }
      const row = target.closest('.album-card[data-gallery-display="list"]');
      const card = target.closest('[data-open-tracklist="1"]') || (row && !target.closest('button,a,input,select,textarea,[role="button"]') ? row.querySelector('[data-open-tracklist="1"]') : null);
      if (card) {
        let album = getIndexedAlbum(card.dataset.albumKey);
        if (!album) { try { album = JSON.parse(card.dataset.album || 'null'); } catch {} }
        if (album) { event.preventDefault(); event.stopImmediatePropagation(); callbacks.album?.(album, { recent: !!card.closest('#mock-recent-body'), phoneHome:!!card.closest('#mobile-home'), comparison: !!card.closest('.mock-comparison') }); return; }
      }
      if (target.closest('#sidebar-list [data-nav]')) { callbacks.beforeNativeGallery?.(); return; }
      if (target.closest('.app-bar-brand')) { event.preventDefault(); event.stopImmediatePropagation(); callbacks.home?.(); }
    }, true);
    // History/popstate owns native page cleanup. A hidden Details node is not
    // another Back request. Only an explicit Escape on the foreground full
    // Album page enters the preview's Back action.
    document.addEventListener('keydown',event=>{
      if(event.key!=='Escape'||currentMode!=='album'||placement!=='full')return;
      const blocking=[...document.querySelectorAll('[aria-modal="true"]')].some(element=>element.getClientRects().length);
      const active=typeof mobilePageState!=='undefined'?mobilePageState.pages.at(-1):null;
      if(blocking||(usesMobilePageLayout()&&active&&active.kind!=='album'))return;
      event.preventDefault();event.stopImmediatePropagation();callbacks.albumClosed?.();
    },true);
    document.addEventListener('dblclick', event => {
      const card = event.target.closest('#mock-recent-body .album-card,#mobile-home .album-card');
      if (!card) return;
      const trigger = card.querySelector('[data-album-key]');
      const album = trigger && getIndexedAlbum(trigger.dataset.albumKey);
      if (album) { event.preventDefault(); event.stopImmediatePropagation(); callbacks.albumModal?.(album); }
    }, true);
    document.addEventListener('submit', event => {
      if (event.target.matches('#search-form')) callbacks.beforeNativeGallery?.();
      if (event.target.matches('form[action="/logout"]')) { event.preventDefault(); event.stopImmediatePropagation(); showToast('Fictional preview: there is no real account to sign out.', 'info', 3000); }
    }, true);
    window.MockRealLayout = {
      portals, layout, openAlbum, closeAlbum: () => closeTrackModal(), showArtist,
      setCallbacks: value => callbacks = value, getMode: () => currentMode, getPlacement: () => placement,
      getAlbum: () => currentAlbum, readView: () => state.view,
      setRecentContext: value => { recentContext = value; currentKind = value.kind; q('#mobile-home').dataset.accountName=value.person; if(usesMobilePageLayout()&&['home','profile'].includes(currentMode))syncMobileHome();else decorateGallery(); },
      loadGallery, activate, activateCovers: activate, table: config => buildCompactDataTable(config),
      tabs: config => buildInPageTabsHtml(config), mountTabs: node => mountInPageTabs(node),
      playTable, flatGallery, artistTree, artistTable,
      getGalleryView: () => ensureGalleryMainState().view,
      galleryConfig: () => ({view:ensureGalleryMainState().view,keys:getFilteredGalleryMainModel().groups.flatMap(group=>group.albums.map(getAlbumRequestKey))}),
      card: (album, view = 'cards') => albumCardHtml(album, { displayMode: view, coverPriority: 'visible' }),
      dialog: options => showAppFormDialog(options), confirm: options => showAppConfirmDialog(options),
      closeDialog: () => q('#app-form-cancel')?.click(), toast: (message, type = 'info') => showToast(message, type, 3200),
      previewTrack: button => previewTrack(button),
    };
    window.dispatchEvent(new Event('mock-real-ui-ready'));
  }
  function layout(mode, kind = currentKind) {
    const previousMode=currentMode; currentMode = mode; currentKind = kind;
    const main = q('#shell-main-surface'), bar = q('[data-gallery-bar-instance="gallery"]'), scroll = q('#albums-scroll'), info = q('[data-artist-info-overlay]');
    const multi = ['home', 'profile'].includes(mode), phoneHome=multi&&usesMobilePageLayout(), inRecent=(multi&&!phoneHome)||mode==='recent';
    syncMobileHome();
    q('#mobile-home').dataset.mockPopulated='true';
    q('#mock-mobile-profile-actions').hidden=!phoneHome;
    main.dataset.mockMode = mode; main.dataset.mockKind = kind;
    if (mode !== 'album' && placement !== 'modal' && typeof mobilePageState !== 'undefined' && mobilePageState.pages.some(page => page.kind === 'album')) returnMobilePagesToGallery();
    q('#mock-workspace').hidden = !multi||phoneHome;
    q('#mock-heading').hidden = phoneHome||(!multi && mode !== 'compare');
    q('#mock-single-custom').hidden = mode !== 'compare';
    q('#mock-recent-controls').hidden = !inRecent;
    q('#mock-recent-expand').hidden = !inRecent;
    q('#mock-full-album-tools').hidden = mode !== 'album';
    q('#mock-full-artist-tools').hidden = mode !== 'artist';
    if(phoneHome){
      q('#mock-recent-body').hidden=true;scroll.hidden=true;
      restore(modal());modal().hidden=true;placement=null;delete modal().dataset.mockPlacement;
      restore(info);info.hidden=true;delete info.dataset.mockPlacement;
    } else if (inRecent) {
      const host = multi ? q('#mock-activity') : main;
      if (typeof mobileHomeBarPosition !== 'undefined' && mobileHomeBarPosition) host.append(mobileHomeBarPosition);
      const body=q('#mock-recent-body');
      if(bar.parentElement!==host || bar.nextElementSibling!==body)host.append(bar,body);
      bar.hidden = false; scroll.hidden = true; q('#mock-recent-body').hidden = false;
      if(!multi&&placement!=='modal'){restore(modal());modal().hidden=true;placement=null;delete modal().dataset.mockPlacement;}
      if (multi && placement !== 'modal') {
        q('#mock-album-panel').append(modal()); q('#mock-artist-panel').append(info);
        modal().dataset.mockPlacement = 'embedded'; placement = 'embedded';
        info.dataset.mockPlacement = 'embedded'; info.hidden = false;
      }
    } else {
      q('#mock-recent-body').hidden = true;
      if (typeof mobileHomeBarPosition !== 'undefined' && mobileHomeBarPosition) restore(mobileHomeBarPosition);
      restore(bar); restore(scroll); restore(info); info.hidden = true; delete info.dataset.mockPlacement;
      bar.hidden = mode !== 'gallery'; scroll.hidden = mode !== 'gallery';
      if (mode !== 'album' && placement !== 'modal') { restore(modal()); modal().hidden = true; placement = null; delete modal().dataset.mockPlacement; }
    }
    if (mode === 'album') {
      const tools=q('#mock-full-album-tools');
      if(tools.parentElement!==main || main.firstElementChild!==tools)main.prepend(tools);
      if (!modal().classList.contains('is-mobile-page') && modal().parentElement!==main)main.append(modal());
      modal().dataset.mockPlacement = 'full'; placement = 'full';
    } else if (placement !== 'modal' && q('#mock-full-album-tools').parentElement!==main) main.append(q('#mock-full-album-tools'));
    if(mode==='artist'){main.prepend(q('#mock-full-artist-tools'));main.append(info);info.dataset.mockPlacement='full';info.hidden=false;info.removeAttribute('aria-hidden');info.setAttribute('role','region');info.removeAttribute('aria-modal');}
    const dialog = modal().querySelector('.track-modal-dialog');
    dialog.setAttribute('role', placement === 'modal' ? 'dialog' : 'region');
    dialog.setAttribute('aria-modal', String(placement === 'modal'));
    document.body.classList.toggle('mock-multi-view', multi&&!phoneHome);
    document.body.classList.toggle('mock-native-home',phoneHome);
    document.body.classList.toggle('mock-recent-view', inRecent);
    document.body.classList.toggle('mock-full-album', mode === 'album');
    if (placement !== 'modal') document.body.classList.remove('modal-open');
    decorateGallery(); decorateAlbum();
    if(mode==='gallery'&&previousMode!=='gallery')requestAnimationFrame(()=>{if(currentMode==='gallery')virtualGrid?.onResize();});
  }
  function decorateGallery() {
    if (!recent()||(['home','profile'].includes(currentMode)&&usesMobilePageLayout())) return;
    const bar = q('[data-gallery-bar-instance="gallery"]'); if (!bar) return;
    const name = bar.querySelector('[data-gallery-context-name]'), summary = bar.querySelector('[data-gallery-context-summary]');
    const title = `Recent ${recentContext.kind}`;
    if (name && name.textContent !== title) name.textContent = title;
    const context = currentMode === 'recent' ? recentContext.person : '';
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
  function openAlbum(album, nextPlacement = 'embedded') {
    if (!album) return;
    renderingAlbum = true; currentAlbum = album; placement = nextPlacement;
    if (nextPlacement === 'modal') {
      restore(modal()); delete modal().dataset.mockPlacement;
      modal().classList.remove('is-mobile-page');
    }
    // Embedded and transitionary presentations must not ask the native phone
    // page owner to create an entry. Full pages retain that owner unchanged.
    const mobilePresenter = typeof presentMobileAlbumPage === 'function' ? presentMobileAlbumPage : null;
    try {
      if (nextPlacement !== 'full' && mobilePresenter) presentMobileAlbumPage = () => {};
      openTrackModal(album, { foreground: true });
    } finally { if (mobilePresenter) presentMobileAlbumPage = mobilePresenter; renderingAlbum = false; }
    lastClosed = false;
    if (nextPlacement === 'modal') {
      modal().dataset.mockPlacement = 'modal';
      modal().querySelector('.track-modal-dialog').setAttribute('role', 'dialog');
      modal().querySelector('.track-modal-dialog').setAttribute('aria-modal', 'true');
      document.body.classList.add('modal-open');
    } else layout(nextPlacement === 'full' ? 'album' : currentMode, currentKind);
    decorateAlbum();
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
  }
  function activate(root) {
    if (!root) return;
    syncGalleryCardMetadataMotion(root);
    for (const image of root.querySelectorAll('img[data-gallery-cover-src]')) {
      const source = image.getAttribute('data-gallery-cover-src');
      image.removeAttribute('data-gallery-cover-src');
      void loadGalleryCoverPreviewImage(image, source);
    }
    attachSharedPlayer();
    if (state.player.current) updatePlayerUi();
  }
  function playTable({ id, rows, label, person, factor = 1 }) {
    const tracks = rows.map((row, index) => ({ ...row.track, trackNumber: index + 1, secondaryArtist: row.artist,
      albumArtist: row.track.album_artist, coverPath: row.track.cover_path, durationSeconds: row.track.duration_seconds,
      duration: formatDuration(row.track.duration_seconds), originalDuration: formatDuration(row.track.duration_seconds) }));
    const host = document.createElement('div');
    host.innerHTML = buildAlbumTrackTableHtml({ idPrefix: id, ariaLabel: label, groups: [{ tracks }], playingAnimation: false });
    const table = host.querySelector('.compact-data-table');
    table.style.setProperty('--cdt-columns', '36px minmax(0,1fr) 42px minmax(48px,auto)');
    for (const row of table.querySelectorAll('[role="row"]')) {
      row.querySelector('[data-cdt-column="problem"]')?.remove();
      const duration = row.querySelector('[data-cdt-column="duration"]'); if (!duration) continue;
      const header = !!row.querySelector('[role="columnheader"]');
      const cell = document.createElement('div'); cell.dataset.cdtColumn = 'count'; cell.setAttribute('role', header ? 'columnheader' : 'cell');
      cell.className = 'mock-count-cell';
      if (header) cell.id = table.id + '-count'; else cell.setAttribute('aria-labelledby', table.id + '-count');
      if (header) cell.textContent = 'Count';
      else {
        const item = rows.find(item => item.track.path === row.dataset.trackRowPath);
        cell.textContent = item?.missing ? '—' : String(item?.count ?? 0);
        row.dataset.mockTrackAlbum = item?.album.id || '';
        row.classList.toggle('mock-missing', !!item?.missing);
      }
      duration.before(cell);
    }
    return host.innerHTML;
  }
  function formatDuration(seconds) { return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; }
  function flatGallery({ records, width, compact = false, view = 'cards', person, factor = 1, missing = false, homeGrid = false }) {
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
        fullLabel.textContent=`${missing||full==null?'—':full*factor} full`;trackLabel.textContent=`${missing?'—':total*factor} tracks`;counts.append(fullLabel,trackLabel);if(missing)counts.title='No listens in this period';
        info.append(counts);
      }
      return host.innerHTML;
    };
    return homeGrid ? `<div class="mobile-home-grid">${records.map(renderAlbumHtml).join('')}</div>` : buildArtistSectionRowsHtml(records,columns,{renderAlbumHtml},cardWidth);
  }
  function artistTree({ rows, selected }) {
    return `<div class="navigation-tree mock-artist-tree">${rows.map(row => NavigationTree.renderItem({ variant: 'wide', action: true, key: row.id, label: row.title, subtitle: row.artist, count: row.count, selected: row.id === selected,
      artworkHtml: buildUtilityAlbumArtbox(row.album, { label: row.title, interactive: false }), attributes: { 'data-mock-artist-select': row.id } })).join('')}</div>`;
  }
  function artistTable({ id, rows, label }) {
    return buildCompactDataTable({ id, ariaLabel: label, columns: 'minmax(0,1fr) 42px', columnsConfig: [{ key: 'artist', label: 'Artist' }, { key: 'count', label: 'Count', action: true }], rows: rows.map(row => ({ key: row.id, className: row.missing ? 'mock-missing' : '', cells: {
      artist: { content: `<button class="mock-artist-cell" data-mock-go-artist="${escapeHtml(row.title)}">${buildUtilityAlbumArtbox(row.album, { label: row.title, interactive: false })}<span>${escapeHtml(row.title)}</span></button>` }, count: { content: row.missing ? '—' : String(row.count) },
    } })) });
  }
  function previewTrack(button) {
    const track = { src: button.dataset.src, path: button.dataset.trackPath, title: button.dataset.trackTitle, artist: button.dataset.trackArtist, albumArtist: button.dataset.trackAlbumArtist, album: button.dataset.trackAlbum, coverPath: button.dataset.trackCover, durationSeconds: Number(button.dataset.trackDurationSeconds) || 0 };
    if (!track.path?.startsWith('mock-track:')) return;
    setCurrentPlayerTrack(track, { persist:false }); triggerAlbumTrackPlayActivation(button); updatePlayerUi();
    showToast('Track selected in the preview. Audio is unavailable; no stream has started.', 'info', 3400);
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
      const slots = [q('#mock-album-native-actions'), q('#mock-full-native-actions')].filter(Boolean);
      let actions = header.querySelector('.album-details-header__actions');
      if (!actions) actions = slots.flatMap(slot => [...slot.children]).find(action => positions.get(action)?.parentNode === header);
      const destination = placement === 'embedded' ? slots[0] : placement === 'full' ? q('#mock-full-native-actions') : null;
      if (actions && destination) {
        for (const slot of slots) for (const old of [...slot.children]) if (old !== actions) { positions.get(old)?.remove(); positions.delete(old); old.remove(); }
        mark(actions); if (actions.parentElement !== destination) destination.append(actions);
      } else if (actions) restore(actions);
      linkText(header,album.album_artist,'data-mock-album-artist',album.album_artist);
      const title = header.querySelector('.album-details-header__primary');
      if (placement !== 'full') linkText(title,album.name,'data-mock-album-page',album.id);

    }
    const actions = modal().querySelector('.album-details-header__actions');
    const target = q('#mock-modal-page-action');
    if (placement === 'modal' && actions) { if(target.parentElement!==actions||actions.firstElementChild!==target)actions.prepend(target); } else if(target.parentElement!==q('#shell-main-surface'))q('#shell-main-surface').append(target);
    target.hidden = placement !== 'modal';
    callbacks.albumRendered?.(album);
  }
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', initialize, { once: true }); else initialize();
})();
