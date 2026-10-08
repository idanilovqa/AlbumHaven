import React, {useEffect, useState, useSyncExternalStore} from 'react';
import {createRoot} from 'react-dom/client';
import {createPlaylistController, granted} from './model.mjs';
import {PlaylistsView, PlaylistDirectory} from './app.jsx';
import {applyPlaylistShell} from './shell.mjs';
import {playlistCreationContext} from './creation-session.mjs';
import {createMissingPlaylistDraftController} from './draft.mjs';
import {MissingPlaylistDraftPage} from './draft.jsx';

// The existing production boot owns when/where to mount this slice. No global
// bridge, second boot, history store, mock provider or persistent client data.
export function mountPlaylists({host, runtime, providers = {}}) {
  if (!host || !runtime || typeof runtime.snapshot !== 'function' || typeof runtime.subscribe !== 'function') throw new TypeError('A native playlist host and runtime are required.');
  const root = createRoot(host), controller = createPlaylistController({readPlaylists: runtime.readPlaylists, providers});
  let configuredProviders = {...providers};
  let disposed = false, generation = 0, navigationSequence = 0, customReader = typeof providers.readPlaylists === 'function';
  let activeDraft = null;
  const clearDraft = owner => {
    if (activeDraft !== owner) return;
    activeDraft = null; owner.unsubscribe?.(); owner.abort.abort(); owner.controller.dispose(); owner.nativePayload = null;
    if (!disposed) root.render(<Session/>);
  };
  const draftCurrent = owner => !disposed && activeDraft === owner && owner.controller.getSnapshot().draftToken === owner.token;
  function syncDraftContext() {
    const owner = activeDraft;
    if (!owner) return;
    const source = controller.getSnapshot(), snapshot = owner.controller.getSnapshot();
    if (source.scopeKey !== owner.scopeKey || source.resource.status === 'denied') {
      runtime.releaseDraft?.(owner.token); clearDraft(owner); return;
    }
    if (!['ready', 'empty'].includes(source.resource.status)) {
      if (snapshot.mutation.status === 'ready') return;
      owner.controller.pauseSource(['loading', 'error', 'unavailable'].includes(source.resource.status) ? source.resource.status : 'unavailable');
      return;
    }
    owner.controller.setContext(playlistCreationContext(source, 'missing'));
  }
  const unsubscribeSource = controller.subscribe(syncDraftContext);
  function prepareDraft(packet) {
    if (disposed || activeDraft || typeof runtime.openDraft !== 'function') return false;
    const shell = runtime.snapshot(), source = controller.getSnapshot(), context = playlistCreationContext(source, 'missing');
    if (!shell.visible || shell.scopeKey !== packet?.scopeKey || context.scopeKey !== packet.scopeKey || !context.canCreate
      || context.source?.kind !== packet.source?.kind || context.source?.ref !== packet.source?.ref) return false;
    const local = createMissingPlaylistDraftController({prepared: packet, providers: configuredProviders});
    if (!local.getSnapshot().draftToken) {local.dispose(); return false;}
    const owner = {controller: local, token: packet.draftToken, scopeKey: packet.scopeKey, completing: false,
      sourcePlaylistId: source.selectedPlaylistId, nativePayload: shell.payload, abort: new AbortController(),
      topEntries: local.getSnapshot().entries, topIntent: JSON.stringify(local.topIntent())};
    activeDraft = owner;
    owner.unsubscribe = local.subscribe(() => {
      const snapshot = local.getSnapshot(), topIntent = JSON.stringify(local.topIntent());
      if (snapshot.entries !== owner.topEntries || topIntent !== owner.topIntent) {
        owner.abort.abort(); owner.abort = new AbortController(); owner.topEntries = snapshot.entries; owner.topIntent = topIntent;
      }
      if (activeDraft === owner && !local.getSnapshot().draftToken) {
        controller.suspend(); runtime.releaseDraft?.(owner.token); clearDraft(owner);
      }
    });
    syncDraftContext();
    if (!draftCurrent(owner)) {clearDraft(owner); return false;}
    const opened = runtime.openDraft({token: owner.token, scopeKey: owner.scopeKey,
      isCurrent: () => draftCurrent(owner), onDiscard: () => clearDraft(owner),
      confirmLeave: async () => {
        const before = local.getSnapshot();
        if (!draftCurrent(owner) || before.mutation.status === 'loading' || owner.completing) return false;
        if (before.mutation.status === 'ready') return true;
        const accepted = await runtime.confirmDraft?.(owner.token, 'Discard this unsaved playlist?');
        return accepted === true && draftCurrent(owner) && local.getSnapshot() === before;
      }});
    if (!opened) {clearDraft(owner); return false;}
    return true;
  }
  async function savedDraft(owner, ack) {
    if (!draftCurrent(owner) || owner.completing || owner.controller.getSnapshot().mutation.data !== ack) return false;
    owner.completing = true;
    try {
      const refreshed = await controller.load();
      if (!draftCurrent(owner) || !refreshed) return false;
      const state = controller.getSnapshot();
      const target = state.resource.data?.items.find(item => item.playlist_id === ack.playlist_id && granted(item, 'can_open'));
      if (!target || runtime.snapshot().scopeKey !== owner.scopeKey) return false;
      owner.completing = false;
      const opened = await runtime.navigate({playlist_id: ack.playlist_id}), current = runtime.snapshot();
      return opened !== false && current.scopeKey === owner.scopeKey && current.playlistId === ack.playlist_id;
    } finally {owner.completing = false;}
  }
  function DraftSession({owner, directory}) {
    const state = useSyncExternalStore(owner.controller.subscribe, owner.controller.getSnapshot, owner.controller.getSnapshot);
    return <MissingPlaylistDraftPage runtime={runtime} controller={owner.controller} state={state} directory={directory}
      readDetail={configuredProviders.readDetail} onClose={() => runtime.closeDraft(owner.token)} onSaved={ack => savedDraft(owner, ack)}
      onTop={typeof configuredProviders.openAlbumTopDraft === 'function' ? intent => {
        const current = owner.controller.topIntent(), entries = owner.controller.getSnapshot().entries;
        if (!draftCurrent(owner) || !current || JSON.stringify(current) !== JSON.stringify(intent)) return false;
        const isCurrent = () => draftCurrent(owner) && owner.controller.getSnapshot().entries === entries
          && JSON.stringify(owner.controller.topIntent()) === JSON.stringify(current);
        const retainNavigation = callback => isCurrent() ? runtime.retainDraft(owner.token, callback) : false;
        return retainNavigation(() => configuredProviders.openAlbumTopDraft(current,
          {signal: owner.abort.signal, isCurrent, retainNavigation}));
      } : undefined}/>;
  }
  function Session() {
    const [navigationError, setNavigationError] = useState(false);
    const shell = useSyncExternalStore(runtime.subscribe, runtime.snapshot, runtime.snapshot);
    const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
    useEffect(() => {
      setNavigationError(false);
      if (activeDraft && shell.retainedDraftToken === activeDraft.token && shell.scopeKey === activeDraft.scopeKey) {
        if (shell.payload && shell.payload !== activeDraft.nativePayload
          && shell.payload.playlist_detail?.playlist_id === activeDraft.sourcePlaylistId) {
          activeDraft.nativePayload = shell.payload;
          controller.accept(shell.payload, activeDraft.sourcePlaylistId);
        }
        return;
      }
      applyPlaylistShell(controller, shell, customReader);
    }, [shell.scopeKey, shell.visible, shell.payload, shell.playlistId, shell.retainedDraftToken, generation]);
    // A changed native scope is hidden immediately, before the effect erases it.
    if (!shell.visible || state.scopeKey !== shell.scopeKey) return null;
    const select = async playlist_id => {
      const deferred = runtime.deferFormNavigation?.(() => select(playlist_id));
      if (deferred) return deferred;
      const scopeKey = state.scopeKey, sequence = ++navigationSequence;
      if (!controller.select(playlist_id, {load: false})) return;
      setNavigationError(false);
      try {await runtime.navigate({playlist_id});} catch (error) {
        if (error?.name === 'AbortError') return;
        if (disposed || sequence !== navigationSequence || controller.getSnapshot().scopeKey !== scopeKey) return;
        const current = runtime.snapshot();
        if (current.scopeKey !== scopeKey || !current.visible) return;
        applyPlaylistShell(controller, current, customReader);
        setNavigationError(true);
      }
    };
    if (activeDraft && shell.draftToken === activeDraft.token) return <DraftSession owner={activeDraft}
      directory={<PlaylistDirectory runtime={runtime} state={state} onSelect={select} canCreate={false}/>}/>;
    return <PlaylistsView key={`${shell.scopeKey}:${generation}`} runtime={runtime} controller={controller} state={state}
      integrationProviders={configuredProviders} readDetail={configuredProviders.readDetail} navigationError={navigationError}
      onSelect={select} onPrepareDraft={prepareDraft}/>;
  }
  root.render(<Session/>);
  return Object.freeze({
    configureProviders(next) {if (!disposed) {
      if (activeDraft && Object.keys({...configuredProviders, ...next}).some(key => configuredProviders[key] !== next?.[key])) {
        const owner = activeDraft; runtime.releaseDraft?.(owner.token); clearDraft(owner);
      }
      controller.configure(next); configuredProviders = {...next}; customReader = typeof next?.readPlaylists === 'function'; generation++; root.render(<Session/>);
    }},
    refresh() {if (!disposed) return controller.load();},
    dispose() {if (!disposed) {
      disposed = true;
      if (activeDraft) {const owner = activeDraft; runtime.releaseDraft?.(owner.token); clearDraft(owner);}
      unsubscribeSource(); controller.dispose(); root.unmount();
    }},
  });
}
