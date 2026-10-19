import {normalizeArtistLovedDescriptor} from './artist-loved-recipe.mjs';
import {createPlaylistEditNotifications} from './edit-request-notifications.mjs';
import {createPlaylistController, granted, playlistDraft, draftDirty} from './model.mjs';
import {mountPlaylistsView, mountPlaylistDirectory} from './native-app.mjs';
import {applyPlaylistShell, completeDeletedPlaylistNavigation, playlistShareIntentCurrent} from './shell.mjs';
import {playlistCreationContext} from './creation-session.mjs';
import {createMissingPlaylistDraftController} from './draft.mjs';
import {mountMissingPlaylistDraftPage} from './native-draft.mjs';
import {createLibraryMixController} from './library-mix.mjs';
import {normalizeArtistMixScope} from './library-mix-recipe.mjs';
import {mountLibraryMixSetup, mountLibraryMixPage} from './native-library-mix.mjs';
import {createPlaylistTopPreview} from './album-top-preview.mjs';
import {mountPlaylistAlbumTopPreview} from './native-album-top-preview.mjs';

// The existing production boot owns when/where to mount this slice. No global
// bridge, second boot, history store, mock provider or persistent client data.
export function mountPlaylists({host, runtime, providers = {}, isRuntimeCurrent = () => globalThis.window?.AlbumHavenPlaylistRuntime === runtime}) {
  if (!host || !runtime || typeof runtime.snapshot !== 'function' || typeof runtime.subscribe !== 'function') throw new TypeError('A native playlist host and runtime are required.');
  const controller = createPlaylistController({readPlaylists: runtime.readPlaylists, providers});
  let configuredProviders = {...providers};
  let disposed = false, generation = 0, navigationSequence = 0, customReader = typeof providers.readPlaylists === 'function';
  let activeDraft = null, deletedNavigation = null, copiedNavigation = null, shareRequest = null, notifications = null;
  let activeMix = null, activeTop = null;
  let view = null, viewKind = null, viewKey = null, viewEpoch = 0;
  let acquiring = true, rendering = false, renderQueued = false, renderRevision = 0, configurationDepth = 0, navigationError = false, lastShell = null, lastNotifiedMutation = null;
  function clearView() {
    const old = view;
    view = null; viewKind = null; viewKey = null; viewEpoch++;
    try {old?.dispose();} finally {host.replaceChildren();}
  }
  function requestRender() {
    if (disposed) return;
    renderQueued = true; renderRevision++;
    if (acquiring || rendering || configurationDepth) return;
    rendering = true;
    try {while (renderQueued && !disposed) {renderQueued = false; render();}}
    finally {rendering = false;}
  }
  function show(kind, key, mount, props, current) {
    if (!current()) return;
    if (!view || viewKind !== kind || viewKey !== key) {
      clearView();
      if (!current()) return;
      viewKind = kind; viewKey = key; const epoch = viewEpoch;
      const mounted = mount(props);
      if (!current() || epoch !== viewEpoch || viewKind !== kind || viewKey !== key) mounted.dispose();
      else view = mounted;
    } else view.update(props);
  }
  // The covered header lease ends at transfer; runtime ownership never does.
  // Once replacement is observed, even restoring the same object cannot revive it.
  let lovedRuntimeRetired = false;
  const lovedRuntimeCurrent = () => {
    if (disposed || lovedRuntimeRetired) return false;
    try {if (isRuntimeCurrent() !== true) lovedRuntimeRetired = true;}
    catch {lovedRuntimeRetired = true;}
    return !lovedRuntimeRetired;
  };
  const mixCurrent = owner => !disposed && activeMix === owner && !owner.retired
    && (!owner.artistLovedDescriptor || lovedRuntimeCurrent());
  const clearMix = owner => {
    if (activeMix !== owner) return;
    activeMix = null; owner.retired = true; owner.controller.dispose();
    if (!disposed) requestRender();
  };
  let unsubscribeMix, unsubscribeTop, unsubscribeNotifications, unsubscribeSource, unsubscribeRender, unsubscribeShell;
  const topCurrent = owner => !disposed && activeTop === owner && !owner.retired && lovedRuntimeCurrent();
  function clearTop(owner) {
    if (activeTop !== owner) return;
    owner.controller.dispose(); owner.abort.abort(); owner.details?.dispose(); owner.unsubscribe?.();
    owner.retired = true; activeTop = null;
    if (!disposed) requestRender();
  }
  function onTopShell() {
    const owner = activeTop; if (!owner) return;
    const shell = runtime.snapshot();
    if (!topCurrent(owner) || !shell.authenticated || shell.scopeKey !== owner.scopeKey
      || owner.opened && shell.retainedDraftToken !== owner.token) {
      runtime.releaseDraft?.(owner.token); clearTop(owner);
    }
  }
  function prepareAlbumTop(detail) {
    const state = controller.getSnapshot(), shell = runtime.snapshot();
    if (disposed || !detail || activeTop || activeMix || activeDraft || state.resource.data?.detail !== detail
      || !shell.visible || !shell.authenticated || shell.scopeKey !== state.scopeKey
      || state.mutation.status === 'loading' || draftDirty(detail, playlistDraft(state))
      || !detail?.track_rows?.length || !granted(detail, 'can_create_album_top')
      || typeof configuredProviders.captureAlbumTopPreview !== 'function' || typeof configuredProviders.saveAlbumTopPreview !== 'function'
      || typeof configuredProviders.resolveAlbumTopPreview !== 'function' || typeof configuredProviders.discardAlbumTopPreview !== 'function'
      || typeof runtime.openDraft !== 'function' || typeof runtime.closeDraft !== 'function'
      || typeof runtime.createAlbumTopPreviewRuntime !== 'function' || typeof runtime.completeAlbumTopPreview !== 'function') return false;
    const owner = {token: crypto.randomUUID(), scopeKey: shell.scopeKey, retired: false, opened: false, abort: new AbortController(), details: null};
    owner.controller = createPlaylistTopPreview({providers: configuredProviders, scopeKey: owner.scopeKey,
      playlistRef: detail.playlist_id, sourceRevision: detail.revision, requestKey: owner.token, isCurrent: () => topCurrent(owner)});
    activeTop = owner;
    try {
      const opened = runtime.openDraft({token: owner.token, scopeKey: owner.scopeKey,
        isCurrent: () => topCurrent(owner), onDiscard: () => clearTop(owner),
        confirmLeave: async () => {
          const before = owner.controller.getSnapshot();
          if (!topCurrent(owner) || !owner.controller.canLeave()) return false;
          if (before.save.status === 'ready' || !before.preview
            || before.title === before.preview.title && before.description === before.preview.description) return true;
          const accepted = await runtime.confirmDraft?.(owner.token, 'Discard this unsaved Album Top?');
          return accepted === true && topCurrent(owner) && owner.controller.canLeave()
            && owner.controller.getSnapshot() === before;
        }});
      if (!opened || !topCurrent(owner)) {clearTop(owner); return false;}
      owner.opened = true; owner.unsubscribe = owner.controller.subscribe(requestRender);
      requestRender(); void owner.controller.load(); return true;
    } catch (error) {runtime.releaseDraft?.(owner.token); clearTop(owner); throw error;}
  }
  function topProps(owner) {
    return {controller: owner.controller, token: owner.token, onClose: () => runtime.closeDraft(owner.token),
      onOpenAlbum: albumRef => {
        if (!topCurrent(owner)) return false;
        const preview = owner.controller.getSnapshot().preview;
        if (!preview) return false;
        if (!owner.details) owner.details = runtime.createAlbumTopPreviewRuntime({token: owner.token, scopeKey: owner.scopeKey,
          preview, isCurrent: () => topCurrent(owner),
          resolveAlbum: (ref, options) => configuredProviders.resolveAlbumTopPreview(preview, ref, options)});
        return owner.details.openAlbum(albumRef, {signal: owner.abort.signal});
      },
      onSaved: receipt => topCurrent(owner) && owner.controller.getSnapshot().save.data === receipt
        ? runtime.completeAlbumTopPreview({token: owner.token, scopeKey: owner.scopeKey, top_ref: receipt.top_ref}) : false};
  }
  const onMixShell = () => {
    const owner = activeMix;
    if (!owner) return;
    const shell = runtime.snapshot();
    if (owner.artistLovedDescriptor && !lovedRuntimeCurrent()
      || !shell.authenticated || shell.scopeKey !== owner.scopeKey
      || owner.phase === 'setup' && shell.entryKey !== owner.entryKey
      || owner.artistLovedDescriptor && owner.phase === 'page' && shell.retainedDraftToken !== owner.token) {
      owner.retired = true; runtime.releaseDraft?.(owner.token); clearMix(owner);
    }
  };
  async function prepareMixPage(owner, close) {
    if (!mixCurrent(owner) || !owner.controller.source()) return false;
    owner.phase = 'transferring';
    if (await close({force: true, restoreFocus: false}) !== true || !mixCurrent(owner)) {clearMix(owner); return false;}
    const opened = runtime.openDraft({token: owner.token, scopeKey: owner.scopeKey, fromGlobal: true,
      isCurrent: () => mixCurrent(owner), onDiscard: () => clearMix(owner),
      confirmLeave: async () => {
        const before = owner.controller.getSnapshot();
        if (!mixCurrent(owner) || before.mutation.status === 'loading') return false;
        if (!before.dirty) return true;
        return await runtime.confirmDraft?.(owner.token, 'Discard this unsaved Library Mix?') === true
          && mixCurrent(owner) && owner.controller.getSnapshot() === before;
      }});
    if (!opened || !mixCurrent(owner)) {clearMix(owner); return false;}
    owner.phase = 'page'; requestRender(); return true;
  }
  async function openSavedMix(owner, receipt) {
    if (!mixCurrent(owner) || owner.controller.getSnapshot().mutation.data !== receipt) return false;
    // An acknowledged Loved save retains this owner until destination admission.
    // Retrying this action only navigates; it never sends another Create.
    try {return await runtime.completeLibraryMixDraft({token: owner.token, scopeKey: owner.scopeKey, playlist_id: receipt.playlist_id, artistLoved: Boolean(owner.artistLovedDescriptor)});}
    catch {runtime.notifyPlaytableCreation?.(); return false;}
  }
  const mountNotifications = () => {
    if (disposed || notifications || !runtime.notificationRegistry?.()?.registerSource) return;
    notifications = createPlaylistEditNotifications({runtime, notifications: runtime.notificationRegistry(), providers: configuredProviders,
      async onOpen(row, isCurrent) {
        if (!isCurrent() || !runtime.openSharedPlaylist) return false;
        const opened = await runtime.openSharedPlaylist({playlist_id: row.playlist_id, isCurrent});
        if (opened === false || !isCurrent()) return false;
        shareRequest = {row, nativeSnapshot: runtime.snapshot(), generation, isCurrent}; requestRender(); return true;
      }});
  };
  const clearDraft = owner => {
    if (activeDraft !== owner) return;
    activeDraft = null; owner.unsubscribe?.(); owner.abort.abort(); owner.controller.dispose(); owner.nativePayload = null;
    if (!disposed) requestRender();
  };
  const draftCurrent = owner => !disposed && activeDraft === owner && owner.controller.getSnapshot().draftToken === owner.token;
  function syncDraftContext() {
    const owner = activeDraft;
    if (!owner) return;
    const source = controller.getSnapshot(), snapshot = owner.controller.getSnapshot();
    if (owner.external) {
      if (runtime.snapshot().scopeKey !== owner.scopeKey || source.resource.status === 'denied') {
        runtime.releaseDraft?.(owner.token); clearDraft(owner);
      }
      return;
    }
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
  function prepareDraft(packet, externalScopeKey = null) {
    if (disposed || activeTop || activeDraft || activeMix || typeof runtime.openDraft !== 'function') return false;
    const external = externalScopeKey !== null;
    if (external && (packet?.source?.kind !== 'activity' || packet.source.source_protocol !== 'missing_activity_selection_v1')) return false;
    const shell = runtime.snapshot();
    if (external) controller.setScope(shell.scopeKey);
    const source = controller.getSnapshot(), context = external ? packet : playlistCreationContext(source, 'missing');
    if ((!shell.visible && !external) || shell.scopeKey !== packet?.scopeKey || context.scopeKey !== packet.scopeKey || !context.canCreate
      || context.source?.kind !== packet.source?.kind || context.source?.ref !== packet.source?.ref) return false;
    const local = createMissingPlaylistDraftController({prepared: packet, providers: configuredProviders});
    if (!local.getSnapshot().draftToken) {local.dispose(); return false;}
    const owner = {controller: local, token: packet.draftToken, scopeKey: packet.scopeKey, completing: false,
      external, sourcePlaylistId: external ? null : source.selectedPlaylistId, nativePayload: shell.payload, abort: new AbortController(),
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
      requestRender();
    });
    syncDraftContext();
    if (!draftCurrent(owner)) {clearDraft(owner); return false;}
    const opened = runtime.openDraft({token: owner.token, scopeKey: owner.scopeKey, externalScopeKey,
      isCurrent: () => draftCurrent(owner), onDiscard: () => clearDraft(owner),
      confirmLeave: async () => {
        const before = local.getSnapshot();
        if (!draftCurrent(owner) || before.mutation.status === 'loading' || owner.completing) return false;
        if (before.mutation.status === 'ready') return true;
        const accepted = await runtime.confirmDraft?.(owner.token, 'Discard this unsaved playlist?');
        return accepted === true && draftCurrent(owner) && local.getSnapshot() === before;
      }});
    if (!opened) {clearDraft(owner); return false;}
    if (external) controller.load();
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
  function draftProps(owner, directory) {
    return {controller: owner.controller, state: owner.controller.getSnapshot(), directory,
      readDetail: configuredProviders.readDetail, onClose: () => runtime.closeDraft(owner.token),
      onSaved: ack => savedDraft(owner, ack),
      onTop: typeof configuredProviders.openAlbumTopDraft === 'function' ? intent => {
        const current = owner.controller.topIntent(), entries = owner.controller.getSnapshot().entries;
        if (!draftCurrent(owner) || !current || JSON.stringify(current) !== JSON.stringify(intent)) return false;
        const isCurrent = () => draftCurrent(owner) && owner.controller.getSnapshot().entries === entries
          && JSON.stringify(owner.controller.topIntent()) === JSON.stringify(current);
        const retainNavigation = callback => isCurrent() ? runtime.retainDraft(owner.token, callback) : false;
        return retainNavigation(() => configuredProviders.openAlbumTopDraft(current,
          {signal: owner.abort.signal, isCurrent, retainNavigation}));
      } : undefined};
  }
  async function select(playlist_id) {
    if (disposed) return false;
    const deferred = runtime.deferFormNavigation?.(() => select(playlist_id));
    if (deferred) return deferred;
    const scopeKey = controller.getSnapshot().scopeKey, sequence = ++navigationSequence;
    if (!controller.select(playlist_id, {load: false})) return false;
    navigationError = false; requestRender();
    try {return await runtime.navigate({playlist_id});} catch (error) {
      if (error?.name === 'AbortError') return false;
      if (disposed || sequence !== navigationSequence || controller.getSnapshot().scopeKey !== scopeKey) return false;
      const current = runtime.snapshot();
      if (current.scopeKey !== scopeKey || !current.visible) return false;
      applyPlaylistShell(controller, current, customReader);
      navigationError = true; requestRender(); return false;
    }
  }
  function render() {
    const revision = renderRevision, providerGeneration = generation;
    const shell = runtime.snapshot();
    if (shareRequest && !playlistShareIntentCurrent(shareRequest, shell, generation)) shareRequest = null;
    const state = controller.getSnapshot(), mutation = state.mutation;
    const current = () => {
      if (disposed) return false;
      const latest = runtime.snapshot();
      const live = revision === renderRevision && generation === providerGeneration
        && controller.getSnapshot() === state
        && ['scopeKey', 'visible', 'payload', 'playlistId', 'retainedDraftToken', 'draftToken', 'entryKey', 'authenticated']
          .every(key => latest[key] === shell[key]);
      if (!live) renderQueued = true;
      return live;
    };
    if (mutation.action === 'deletePlaylist' && mutation.status === 'ready' && state.selectedPlaylistId === null
      && shell.scopeKey === state.scopeKey && shell.playlistId === mutation.playlist_id && deletedNavigation !== mutation) {
      deletedNavigation = mutation;
      Promise.resolve(completeDeletedPlaylistNavigation(controller, runtime, mutation)).catch(() => {
        if (!disposed && controller.getSnapshot().scopeKey === state.scopeKey && controller.getSnapshot().mutation === mutation) {
          navigationError = 'delete'; requestRender();
        }
      });
    }
    if (!current()) return;
    if (lastNotifiedMutation !== mutation) {
      lastNotifiedMutation = mutation;
      if (mutation.status === 'ready' && ['decideEditRequest', 'setPlaylistEditor', 'saveSharing'].includes(mutation.action)) notifications?.refresh();
    }
    if (!current()) return;
    if (mutation.action === 'copyPlaylist' && mutation.status === 'ready' && mutation.copied_playlist_id
      && copiedNavigation !== mutation && shell.scopeKey === state.scopeKey) {
      copiedNavigation = mutation; const scopeKey = state.scopeKey;
      Promise.resolve(runtime.navigate({playlist_id: mutation.copied_playlist_id})).catch(() => {
        if (!disposed && controller.getSnapshot().scopeKey === scopeKey && controller.getSnapshot().mutation === mutation) {
          navigationError = true; requestRender();
        }
      });
    }
    if (!current()) return;
    const shellInputs = [shell.scopeKey, shell.visible, shell.payload, shell.playlistId, shell.retainedDraftToken, generation];
    if (!lastShell || shellInputs.some((value, index) => value !== lastShell[index])) {
      lastShell = shellInputs; navigationError = false;
      if (activeDraft && shell.retainedDraftToken === activeDraft.token && shell.scopeKey === activeDraft.scopeKey) {
        if (shell.payload && shell.payload !== activeDraft.nativePayload
          && shell.payload.playlist_detail?.playlist_id === activeDraft.sourcePlaylistId) {
          activeDraft.nativePayload = shell.payload;
          controller.accept(shell.payload, activeDraft.sourcePlaylistId);
        }
      } else applyPlaylistShell(controller, shell, customReader);
    }
    if (!current()) return;
    const mix = activeMix;
    if (mix && mixCurrent(mix) && shell.scopeKey === mix.scopeKey && mix.phase === 'setup') {
      show('mix-setup', mix, props => mountLibraryMixSetup(host, mix.runtime, props),
        {controller: mix.controller, onReady: close => prepareMixPage(mix, close),
          onClose: () => {if (mix.phase === 'setup') clearMix(mix);}}, current);
      return;
    }
    if (mix && mixCurrent(mix) && shell.scopeKey === mix.scopeKey && shell.draftToken === mix.token && mix.phase === 'page') {
      show('mix-page', mix, props => mountLibraryMixPage(host, mix.runtime, props),
        {controller: mix.controller, readDetail: configuredProviders.readDetail,
          onClose: () => runtime.closeDraft(mix.token), onSaved: receipt => openSavedMix(mix, receipt),
          consumeAutomaticPlay: mix.artistLovedDescriptor ? () => {
            if (mix.autoPlayConsumed) return false;
            mix.autoPlayConsumed = true;
            return mixCurrent(mix) && mix.phase === 'page' && mix.playbackIntent?.() === true;
          } : undefined}, current);
      return;
    }
    if (!shell.visible || state.scopeKey !== shell.scopeKey) {clearView(); return;}
    if (activeTop && topCurrent(activeTop) && shell.draftToken === activeTop.token) {
      const owner = activeTop;
      show('album-top-preview', owner, props => mountPlaylistAlbumTopPreview(host, runtime, props), topProps(owner), current);
      return;
    }
    if (activeDraft && shell.draftToken === activeDraft.token) {
      const owner = activeDraft;
      show('draft', owner, () => {
        const directory = host.ownerDocument.createElement('div');
        const directoryOwner = mountPlaylistDirectory(directory, runtime, {state, onSelect: select, canCreate: false});
        let page;
        try {page = mountMissingPlaylistDraftPage(host, runtime, draftProps(owner, directory));}
        catch (error) {directoryOwner.dispose(); directory.remove(); throw error;}
        return {
          update({state}) {directoryOwner.update({state, onSelect: select, canCreate: false}); page.update(draftProps(owner, directory));},
          dispose() {try {page.dispose();} finally {directoryOwner.dispose(); directory.remove();}},
        };
      }, {state}, current);
      return;
    }
    show('playlist', `${shell.scopeKey}:${generation}`, props => mountPlaylistsView(host, runtime, props),
      {controller, state, integrationProviders: configuredProviders, readDetail: configuredProviders.readDetail,
        navigationError, shareRequest: shareRequest?.row || null,
        onShareRequestHandled: request => {if (shareRequest?.row === request) shareRequest = null;},
        onSelect: select, onPrepareDraft: prepareDraft, onCreateAlbumTop: prepareAlbumTop}, current);
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    let failure;
    const clean = callback => {try {callback();} catch (error) {failure ||= error;}};
    const oldNotifications = notifications; notifications = null;
    const mix = activeMix; activeMix = null;
    const draft = activeDraft; activeDraft = null;
    clean(() => oldNotifications?.dispose());
    clean(() => unsubscribeNotifications?.());
    clean(() => unsubscribeMix?.());
    clean(() => unsubscribeTop?.());
    if (activeTop) {const owner = activeTop; clean(() => runtime.releaseDraft?.(owner.token)); clean(() => clearTop(owner));}
    if (mix) {
      mix.retired = true;
      clean(() => runtime.releaseDraft?.(mix.token));
      clean(() => mix.controller.dispose());
    }
    if (draft) {
      clean(() => runtime.releaseDraft?.(draft.token));
      clean(() => draft.unsubscribe?.());
      clean(() => draft.abort.abort());
      clean(() => draft.controller.dispose());
      draft.nativePayload = null;
    }
    clean(() => unsubscribeSource?.());
    clean(() => unsubscribeRender?.());
    clean(() => unsubscribeShell?.());
    clean(clearView);
    clean(() => controller.dispose());
    if (failure) throw failure;
  }
  // No owner is returned until acquisition succeeds. Unwind everything already
  // acquired if native mounting or a synchronous subscription callback fails.
  try {
    unsubscribeMix = runtime.subscribe(onMixShell);
    unsubscribeTop = runtime.subscribe(onTopShell);
    unsubscribeNotifications = runtime.subscribeNotificationRegistry?.(() => {if (!acquiring) mountNotifications();});
    unsubscribeSource = controller.subscribe(syncDraftContext);
    unsubscribeRender = controller.subscribe(requestRender);
    unsubscribeShell = runtime.subscribe(requestRender);
    acquiring = false;
    mountNotifications();
    requestRender();
  } catch (error) {
    try {dispose();} catch {}
    throw error;
  }
  return Object.freeze({
    openArtistLoved({descriptor, launchContext} = {}) {
      const normalized = normalizeArtistLovedDescriptor(descriptor);
      const leaseCurrent = () => {try {return launchContext?.runtime === runtime && lovedRuntimeCurrent()
        && launchContext?.descriptor === descriptor && launchContext?.isCurrent?.() === true;} catch {return false;}};
      if (!normalized || !leaseCurrent()) return false;
      const shell = runtime.snapshot(), configuration = generation;
      if (disposed || activeTop || activeMix || activeDraft || !shell.authenticated || !runtime.canOpenPlaytableForm?.()
        || typeof configuredProviders.beginArtistLoved !== 'function' || typeof runtime.createLibraryMixRuntime !== 'function'
        || typeof runtime.openDraft !== 'function' || !leaseCurrent() || generation !== configuration) return false;
      const owner = {token: crypto.randomUUID(), scopeKey: shell.scopeKey, entryKey: shell.entryKey,
        phase: 'transferring', retired: false, artistLovedDescriptor: normalized, autoPlayConsumed: false};
      owner.playbackIntent = runtime.captureLibraryMixPlaybackIntent?.();
      if (!leaseCurrent() || disposed || activeTop || activeMix || activeDraft || generation !== configuration) return false;
      owner.controller = createLibraryMixController({providers: configuredProviders, scopeKey: owner.scopeKey,
        artistLovedDescriptor: normalized, isCurrent: () => mixCurrent(owner)});
      activeMix = owner;
      try {
        owner.runtime = runtime.createLibraryMixRuntime({scopeKey: owner.scopeKey, isCurrent: () => mixCurrent(owner),
          source: () => owner.controller.source(), order: () => owner.controller.getSnapshot().playbackOrder,
          automaticPlayCurrent: () => owner.playbackIntent?.() === true});
        if (!mixCurrent(owner) || !leaseCurrent() || generation !== configuration) {clearMix(owner); return false;}
        // Transfer validates the parent lease before ownership changes. After the
        // accepted push, token and scope replace only the covered header lease;
        // mixCurrent retains the permanently fenced bound-runtime owner.
        let transferring = true;
        const opened = runtime.openDraft({token: owner.token, scopeKey: owner.scopeKey, fromGlobal: true,
          isCurrent: () => mixCurrent(owner) && (!transferring || leaseCurrent()),
          onDiscard: () => clearMix(owner),
          confirmLeave: async () => {
            const before = owner.controller.getSnapshot();
            if (!mixCurrent(owner) || before.mutation.status === 'loading') return false;
            if (!before.dirty) return true;
            return await runtime.confirmDraft?.(owner.token, 'Discard this unsaved Loved and Obsessed playlist?') === true
              && mixCurrent(owner) && owner.controller.getSnapshot() === before;
          }, onTransfer: () => {transferring = false;}});
        transferring = false;
        if (!opened || !mixCurrent(owner)) {runtime.releaseDraft?.(owner.token); clearMix(owner); return false;}
        owner.phase = 'page'; requestRender();
        if (!mixCurrent(owner)) return false;
        void owner.controller.prepare();
        return mixCurrent(owner);
      } catch (error) {runtime.releaseDraft?.(owner.token); clearMix(owner); throw error;}
    },
    openLibraryMix(options = {}) {
      const artistScope = options.artistScope == null ? null : normalizeArtistMixScope(options.artistScope);
      if (options.artistScope != null && !artistScope) return false;
      const shell = runtime.snapshot();
      if (disposed || activeTop || activeMix || activeDraft || !shell.authenticated || !runtime.canOpenPlaytableForm?.()
        || typeof (artistScope ? configuredProviders.beginArtistMix : configuredProviders.beginLibraryMix) !== 'function' || typeof runtime.createLibraryMixRuntime !== 'function') return false;
      const owner = {token: crypto.randomUUID(), scopeKey: shell.scopeKey, entryKey: shell.entryKey, phase: 'setup', retired: false};
      activeMix = owner;
      owner.controller = createLibraryMixController({providers: configuredProviders, scopeKey: owner.scopeKey, artistScope, isCurrent: () => mixCurrent(owner)});
      owner.runtime = runtime.createLibraryMixRuntime({scopeKey: owner.scopeKey, isCurrent: () => mixCurrent(owner),
        source: () => owner.controller.source(), order: () => owner.controller.getSnapshot().playbackOrder});
      requestRender(); return true;
    },
    prepareActivityDraft(packet, externalScopeKey) {
      return typeof externalScopeKey === 'string' && prepareDraft(packet, externalScopeKey);
    },
    configureProviders(next = {}) {if (!disposed) {
      if (!next || typeof next !== 'object' || Array.isArray(next)) throw new TypeError('Playlist providers must be an object.');
      const changed = Object.keys({...configuredProviders, ...next}).some(key => configuredProviders[key] !== next[key]);
      configurationDepth++;
      try {
        configuredProviders = {...next}; customReader = typeof next.readPlaylists === 'function';
        const configuration = ++generation; shareRequest = null;
        clearView();
        if (disposed || generation !== configuration) return;
        if (activeMix) {const owner = activeMix; owner.retired = true; runtime.releaseDraft?.(owner.token); clearMix(owner);}
        if (activeTop) {const owner = activeTop; runtime.releaseDraft?.(owner.token); clearTop(owner);}
        if (disposed || generation !== configuration) return;
        if (activeDraft && changed) {const owner = activeDraft; runtime.releaseDraft?.(owner.token); clearDraft(owner);}
        if (disposed || generation !== configuration) return;
        controller.configure(next);
        if (!disposed && generation === configuration) notifications?.configure(configuredProviders);
      } finally {configurationDepth--; requestRender();}
    }},
    refresh() {if (!disposed) return controller.load();},
    dispose,
  });
}
