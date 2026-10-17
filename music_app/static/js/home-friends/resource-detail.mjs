import {createDetailProjectionController, detailSelection, detailSelectionKey} from './detail-projection.mjs';
import {mountDetailProjectionPanel} from './detail-projection-ui.mjs';

export function mountResourceDetail(host, runtime, initial) {
  let props, provider, target, context, selectionKey, owner = 0, abort, nativeLease, nativeReady = false, panel, retained, retainedValue,
    disposed = false, configuring = false, notifiedValue, notifiedTarget, unsubscribe;
  host.classList.add('home-detail__selection');
  const nativeHost = host.ownerDocument.createElement('div'), projectionHost = host.ownerDocument.createElement('section');
  nativeHost.className = 'home-detail__native-host'; host.append(nativeHost, projectionHost);
  const controller = createDetailProjectionController({readDetail: initial.readDetail || runtime.readAlbumProjection});
  const unavailable = {status: 'unavailable', data: null};
  function currentValue() {const state = controller.getSnapshot(); return state.scopeKey === props.scopeKey && detailSelectionKey(state.selection) === selectionKey ? state.detail : unavailable;}
  const current = generation => !disposed && owner === generation && props?.isOwnerCurrent?.() !== false;
  function release(retire) {const previous=retained;retained=null;retainedValue=null;previous?.({retire});}
  function paint() {
    if (disposed || configuring) return;
    const generation = owner;if(!current(generation))return;const value = currentValue(), selected = target;
    if (retainedValue !== value) {release(true); if(current(generation)&&value.status==='ready'&&target?.kind==='artist'){const acquired=runtime.retainArtistAlbums?.(target,context,value.data);if(!current(generation)){acquired?.({retire:true});return;}retained=acquired;retainedValue=value;}}
    if(!current(generation))return;
    const canIntent = (intent, actionTarget) => current(generation) && runtime.canResourceIntent?.(intent, actionTarget, context) === true && current(generation);
    const onIntent = (kind, actionTarget) => {
      if (!canIntent(kind, actionTarget) || abort.signal.aborted) return;
      try {Promise.resolve(runtime.resourceIntent(kind, actionTarget, {...context, signal: abort.signal})).catch(error => {if (current(generation) && error?.name !== 'AbortError') props.onError?.('This resource action could not be completed.');});}
      catch {if (current(generation)) props.onError?.('This resource action could not be completed.');}
    };
    const onSelectAlbum = selectedAlbum => {
      const latest = controller.getSnapshot();
      if (!current(generation) || latest.scopeKey !== props.scopeKey || latest.detail !== value || value.status !== 'ready') return;
      const available = value.data.listened_albums?.some(row => {const candidate = detailSelection({...row.detail_target, native_actions: row.native_actions || row.detail_target?.native_actions}); return candidate?.allowed_actions.can_view_details && detailSelectionKey(candidate) === detailSelectionKey(selectedAlbum);});
      if (available) props.onSelectAlbum?.(selectedAlbum);
    };
    nativeHost.dataset.nativeReady = nativeReady ? 'true' : 'false'; projectionHost.hidden = nativeReady;
    if(nativeReady){const previous=panel;panel=null;previous?.dispose();if(!current(generation))return;}
    else {const presentation = {value, selection: target, onRetry: () => {if (current(generation)) controller.load();}, listenedAlbumsHost: props.listenedAlbumsHost,
      canIntent, onIntent, onSelectAlbum: typeof props.onSelectAlbum === 'function' ? onSelectAlbum : undefined};
      if (panel) panel.update(presentation); else {const acquired=mountDetailProjectionPanel(projectionHost,runtime,presentation);if(!current(generation)){acquired.dispose();return;}panel=acquired;}}
    if(!current(generation))return;
    if (notifiedValue !== value || notifiedTarget !== selected) {notifiedValue = value; notifiedTarget = selected; props.onDetailChange?.(value, selected);}
  }
  function retire() {
    owner++;const lease=nativeLease,child=panel;nativeLease=panel=null;nativeReady=false;let failure;
    for(const cleanup of [()=>abort?.abort(),()=>lease?.dispose(),()=>child?.dispose(),()=>release(true)]){try{cleanup();}catch(error){failure ||= error;}}
    if(failure){dispose({retire:true,notify:false});throw failure;}if(disposed)return;nativeHost.replaceChildren();controller.clear();
  }
  function render(){if(disposed)return;try{paint();}catch(error){dispose({retire:true,notify:false});throw error;}}
  function update(next) {
    if (disposed) return;
    const nextProvider = typeof next.readDetail === 'function' ? next.readDetail : runtime.readAlbumProjection;
    const nextKey = detailSelectionKey(next.origin ? {...next.selection, origin: next.origin} : next.selection);
    const changed = !props || provider !== nextProvider || props.scopeKey !== next.scopeKey || selectionKey !== nextKey;
    props = next;if(props.isOwnerCurrent?.()===false){dispose({retire:true,notify:false});return;}
    if (!changed) {render(); return;}
    configuring = true; retire(); if(disposed)return; provider = nextProvider; selectionKey = nextKey;
    target = detailSelection(next.origin ? {...next.selection, origin: next.origin} : next.selection);
    context = {scopeKey: props.scopeKey, ...(target?.origin ? {origin: target.origin} : {})}; abort = new AbortController();
    const generation = owner;
    controller.configure({readDetail: provider}); controller.setScope(props.scopeKey); controller.select(target);
    if (target && typeof runtime.mountResourceSelection === 'function') {
      const acquired = runtime.mountResourceSelection(nativeHost, {selection: target, ...context,
        onState: status => {if (current(generation) && nativeHost.isConnected) {nativeReady = status === 'ready'; render();}},
        onError: error => {if (current(generation) && nativeHost.isConnected && error?.name !== 'AbortError') props.onError?.('Album information could not be opened.');}});
      if(!current(generation)){try{acquired?.dispose();}finally{if(props.isOwnerCurrent?.()===false)dispose({retire:true,notify:false});}return;}nativeLease=acquired;
    }
    configuring = false; render(); if(current(generation))controller.load();
  }
  function dispose({retire=false,notify=true}={}) {
    if(disposed)return;disposed=true;owner++;
    const lease=nativeLease,child=panel;nativeLease=panel=null;
    for(const releaseOwned of [()=>abort?.abort(),()=>unsubscribe?.(),()=>lease?.dispose(),()=>release(retire),()=>child?.dispose(),()=>controller.dispose(),()=>{if(notify)props?.onDetailChange?.(unavailable,target);},()=>host.replaceChildren()]){try{releaseOwned();}catch(_cleanupError){}}
  }
  try {unsubscribe=controller.subscribe(render);update(initial);return {element:host,update,dispose};}
  catch(error){dispose({retire:true,notify:false});throw error;}
}
