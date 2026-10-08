import React, {useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore} from 'react';
import {NativeDialog} from '../home-friends/native-dialog.jsx';
import {createPlaylistCreationController} from './creation.mjs';
import {CreationForm} from './creation.jsx';
import {completePlaylistCreation, playlistCreationContext} from './creation-session.mjs';

export function PlaylistCreationSession({runtime, controller: playlists, state, mode, providers, readDetail, onClose, onNavigate, onPrepareDraft, onNotice}) {
  const [controller] = useState(() => createPlaylistCreationController({providers}));
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [completed, setCompleted] = useState(null), acknowledged = useRef(null);
  const value = completed || snapshot;
  const alive = useRef(true), completing = useRef(false), initialized = useRef(false), closeOwner = useRef(null);
  const transferRetired = useRef(false);
  const initial = useRef(playlistCreationContext(state, mode)), ownerVersion = useRef(playlists.getLifecycleVersion());
  const context = playlistCreationContext(state, mode);
  const updateContext = () => {
    const current = playlists.getSnapshot();
    if (playlists.getLifecycleVersion() !== ownerVersion.current || current.scopeKey !== initial.current.scopeKey
      || current.selectedPlaylistId !== initial.current.playlistId || current.resource.status === 'denied') {
      transferRetired.current = true; acknowledged.current = null; setCompleted(null); controller.dispose(); return;
    }
    if (acknowledged.current) return;
    if (!['ready', 'empty'].includes(current.resource.status)) {
      controller.pauseSource(['loading', 'error', 'unavailable'].includes(current.resource.status) ? current.resource.status : 'unavailable');
      return;
    }
    const next = playlistCreationContext(current, mode);
    if (!next.canCreate || next.source?.kind !== initial.current.source?.kind || next.source?.ref !== initial.current.source?.ref) {
      transferRetired.current = true;
    }
    controller.setContext(next);
  };
  const uiController = useMemo(() => ({...controller, async load() {
    if (!alive.current || acknowledged.current || playlists.getLifecycleVersion() !== ownerVersion.current) return false;
    if (!['ready', 'empty'].includes(playlists.getSnapshot().resource.status)) {
      if (!await playlists.load()) return false;
    }
    if (!alive.current || playlists.getLifecycleVersion() !== ownerVersion.current) return false;
    updateContext();
    return controller.load();
  }}), [controller, playlists, mode]);
  useLayoutEffect(() => {
    updateContext();
    if (!initialized.current) {initialized.current = true; controller.load();}
    return playlists.subscribe(updateContext);
  }, [controller, playlists, mode]);
  useEffect(() => () => {alive.current = false; controller.dispose();}, [controller]);
  useLayoutEffect(() => {updateContext();}, [context.scopeKey, context.playlistId, context.canCreate, context.canCreateAlbumTop,
    context.source?.kind, context.source?.ref, context.source?.revision]);
  const beforeDismiss = async () => {
    const snapshot = controller.getSnapshot();
    if (snapshot.mutation.status === 'loading' || completing.current) return false;
    if (acknowledged.current || snapshot.mutation.status === 'ready' || !snapshot.dirty) return true;
    if (typeof runtime.confirm !== 'function') return false;
    const accepted = await runtime.confirm('Discard this unsaved playlist?');
    return accepted === true && alive.current && controller.getSnapshot() === snapshot;
  };
  const created = async ack => {
    const expected = playlistCreationContext(playlists.getSnapshot(), mode);
    const origin = initial.current;
    if (!alive.current || origin.scopeKey !== expected.scopeKey || origin.playlistId !== expected.playlistId
      || origin.source?.kind !== expected.source?.kind || origin.source?.ref !== expected.source?.ref || !expected.canCreate) return false;
    const saved = controller.getSnapshot();
    const completion = {ack, context: expected}; acknowledged.current = completion;
    setCompleted({scopeKey: saved.scopeKey, mode: saved.mode, source: null, canCreate: false,
      sourceResource: {status: 'unavailable', data: null}, mutation: {status: 'ready', request_key: ack.request_key, data: ack},
      title: saved.title, description: saved.description, query: '', tab: 'all', selectedKeys: [], reviewKey: null, dirty: false});
    controller.dispose(); // The acknowledged write no longer needs private source rows.
    completing.current = true;
    try {
      const finished = await completePlaylistCreation({ack, context: expected, controller: playlists,
        isCurrent: () => alive.current && acknowledged.current === completion && playlists.getLifecycleVersion() === ownerVersion.current
          && playlists.getSnapshot().scopeKey === expected.scopeKey && playlists.getSnapshot().selectedPlaylistId === expected.playlistId,
        close: options => closeOwner.current?.(options), navigate: onNavigate, notify: onNotice});
      if (!finished && alive.current && acknowledged.current === completion && playlists.getLifecycleVersion() === ownerVersion.current
        && playlists.getSnapshot().scopeKey === expected.scopeKey && playlists.getSnapshot().selectedPlaylistId === expected.playlistId) {
        if (await closeOwner.current?.({force: true, restoreFocus: false}) === true
          && playlists.getLifecycleVersion() === ownerVersion.current && playlists.getSnapshot().scopeKey === expected.scopeKey
          && playlists.getSnapshot().selectedPlaylistId === expected.playlistId) onNotice?.('Playlist created. Its source changed before it could be opened.');
      }
      return finished;
    } finally {completing.current = false;}
  };
  const prepared = async packet => {
    const expected = playlistCreationContext(playlists.getSnapshot(), 'missing');
    if (mode !== 'missing' || typeof onPrepareDraft !== 'function' || !alive.current || transferRetired.current
      || playlists.getLifecycleVersion() !== ownerVersion.current || controller.prepareDraft() !== packet
      || packet.scopeKey !== expected.scopeKey || !expected.canCreate
      || packet.source.kind !== expected.source?.kind || packet.source.ref !== expected.source?.ref
      || packet.source.revision !== expected.source?.revision) return false;
    completing.current = true;
    // Native close may unmount this form before its history return settles.
    // Observe that transfer lifetime separately from the component lifetime so
    // an away-and-back identity/grant change cannot revive a retired packet.
    const observeTransfer = () => {
      const state = playlists.getSnapshot(), current = playlistCreationContext(state, 'missing');
      if (playlists.getLifecycleVersion() !== ownerVersion.current || state.scopeKey !== expected.scopeKey
        || state.selectedPlaylistId !== expected.playlistId || state.resource.status === 'denied'
        || ['ready', 'empty'].includes(state.resource.status) && (!current.canCreate
          || current.source?.kind !== expected.source.kind || current.source?.ref !== expected.source.ref)) {
        transferRetired.current = true;
      }
    };
    const unsubscribeTransfer = playlists.subscribe(observeTransfer);
    try {
      if (await closeOwner.current?.({force: true, restoreFocus: false}) !== true) return false;
      // The form is disposed; the current native source owner admits the
      // transferred draft without invoking a persistence provider.
      const current = playlistCreationContext(playlists.getSnapshot(), 'missing');
      if (transferRetired.current || playlists.getLifecycleVersion() !== ownerVersion.current || !current.canCreate
        || current.scopeKey !== expected.scopeKey || current.playlistId !== expected.playlistId
        || current.source?.kind !== expected.source.kind || current.source?.ref !== expected.source.ref) return false;
      return await onPrepareDraft(packet);
    } finally {unsubscribeTransfer(); completing.current = false;}
  };
  return <NativeDialog runtime={runtime} title="Create playlist" pageId="create-playlist" beforeDismiss={beforeDismiss} onClose={onClose}>{close => {
    closeOwner.current = close;
    return <CreationForm runtime={runtime} controller={uiController} state={value} readDetail={readDetail}
      onCreated={created} onPrepareDraft={prepared} onDismiss={options => close(options)}/>;
  }}</NativeDialog>;
}
