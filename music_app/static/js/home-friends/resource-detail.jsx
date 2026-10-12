import React, {useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore} from 'react';
import {createDetailProjectionController, detailSelection, detailSelectionKey} from './detail-projection.mjs';
import {DetailProjectionPanel} from './detail-projection.jsx';

export function ResourceDetail({runtime, scopeKey, selection, origin, readDetail, onSelectAlbum, onError, listenedAlbumsHost, onDetailChange}) {
  const provider = typeof readDetail === 'function' ? readDetail : runtime.readAlbumProjection;
  const selectionKey = detailSelectionKey(origin ? {...selection, origin} : selection);
  const target = useMemo(() => detailSelection(origin ? {...selection, origin} : selection), [selectionKey]);
  const [controller] = useState(() => createDetailProjectionController({readDetail: provider}));
  const configured = useRef(provider), current = useRef(null), nativeHost = useRef(null), detailChanged = useRef(onDetailChange), currentDetail = useRef(null);
  detailChanged.current = onDetailChange;
  const [nativeState, setNativeState] = useState(null);
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const context = useMemo(() => ({scopeKey, ...(target?.origin ? {origin: target.origin} : {})}), [scopeKey, selectionKey]);
  const lifecycle = useRef(null);
  useLayoutEffect(() => {
    const owner = new AbortController(); lifecycle.current = owner;
    return () => {owner.abort(); if (lifecycle.current === owner) lifecycle.current = null;};
  }, [runtime, context, target, provider]);
  current.current = {runtime, context, target, provider};
  useLayoutEffect(() => {
    configured.current = provider;
    controller.configure({readDetail: provider}); controller.setScope(scopeKey); controller.select(target); controller.load();
    return () => controller.clear();
  }, [controller, provider, scopeKey, target]);
  useEffect(() => () => controller.dispose(), [controller]);
  useLayoutEffect(() => {
    const owner = current.current;
    if (!target || typeof runtime.mountResourceSelection !== 'function' || !nativeHost.current) return;
    const active = () => current.current?.runtime === owner.runtime && current.current?.context === owner.context
      && current.current?.target === owner.target && current.current?.provider === owner.provider && nativeHost.current?.isConnected;
    const lease = runtime.mountResourceSelection(nativeHost.current, {selection: target, ...context,
      onState: status => {if (active()) setNativeState({owner, status});},
      onError: error => {if (active() && error?.name !== 'AbortError') onError?.('Album information could not be opened.');}});
    return () => lease?.dispose();
  }, [runtime, target, context, provider]);
  const value = configured.current === provider && snapshot.scopeKey === scopeKey
    && detailSelectionKey(snapshot.selection) === selectionKey ? snapshot.detail : {status: 'unavailable', data: null};
  currentDetail.current = {runtime, target, context, provider, value};
  useLayoutEffect(() => {detailChanged.current?.(value, target);}, [value.status, value.data, target, context, provider]);
  useLayoutEffect(() => () => {detailChanged.current?.({status: 'unavailable', data: null}, target);}, [target, context, provider]);
  useLayoutEffect(() => {
    if (value.status !== 'ready' || target?.kind !== 'artist') return;
    const retained = currentDetail.current;
    const release = runtime.retainArtistAlbums?.(target, context, value.data);
    return () => {
      const latest = currentDetail.current;
      // Intentional source unmount can transfer an already admitted native
      // Album. A new detail/provider/selection still retires the old authority.
      const retire = latest.runtime !== retained.runtime || latest.target !== retained.target
        || latest.context !== retained.context || latest.provider !== retained.provider || latest.value !== retained.value;
      release?.({retire});
    };
  }, [runtime, target, context, value.status, value.data, provider]);
  const selectAlbum = selected => {
    const latest = controller.getSnapshot();
    if (!owns() || latest.scopeKey !== scopeKey || latest.detail !== value || latest.detail.status !== 'ready') return;
    const available = latest.detail.data.listened_albums?.some(row => {
      const candidate = detailSelection({...row.detail_target, native_actions: row.native_actions || row.detail_target?.native_actions});
      return candidate?.allowed_actions.can_view_details && detailSelectionKey(candidate) === detailSelectionKey(selected);
    });
    if (available) onSelectAlbum?.(selected);
  };
  const owns = () => current.current?.runtime === runtime && current.current?.target === target
    && current.current?.context === context && current.current?.provider === provider;
  const canIntent = (intent, actionTarget) => owns()
    && runtime.canResourceIntent?.(intent, actionTarget, context) === true;
  const intent = (kind, actionTarget) => {
    if (!canIntent(kind, actionTarget) || !lifecycle.current || lifecycle.current.signal.aborted) return;
    try {Promise.resolve(runtime.resourceIntent(kind, actionTarget, {...context, signal: lifecycle.current.signal})).catch(error => {
      if (owns() && error?.name !== 'AbortError') onError?.('This resource action could not be completed.');
    });} catch (error) {if (owns()) onError?.('This resource action could not be completed.');}
  };

  const nativeReady = nativeState?.owner.runtime === runtime && nativeState.owner.target === target
    && nativeState.owner.context === context && nativeState.owner.provider === provider && nativeState.status === 'ready';
  return <div className="home-detail__selection">
    <div ref={nativeHost} className="home-detail__native-host" data-native-ready={nativeReady ? 'true' : 'false'}/>
    {!nativeReady && <DetailProjectionPanel runtime={runtime} value={value} selection={target}
      onRetry={() => controller.load()} listenedAlbumsHost={listenedAlbumsHost} canIntent={canIntent} onIntent={intent} onSelectAlbum={typeof onSelectAlbum === 'function' ? selectAlbum : undefined}/>}
  </div>;
}
