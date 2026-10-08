import React, {useLayoutEffect, useRef, useState, useSyncExternalStore} from 'react';
import {Button, NativeHtml} from '../home-friends/components.jsx';
import {NativeChoice} from '../home-friends/native-choice.jsx';
import {NativeDialog} from '../home-friends/native-dialog.jsx';
import {CreationForm} from './creation.jsx';
import {playlistCreationCompletionState} from './creation-session.mjs';
import {createPlaylistActionController, completeSelectionPlaylistCreation} from './selection-actions.mjs';

function ActionStatus({runtime, state}) {
  const mutation = state.mutation;
  const message = mutation.acknowledged
    ? mutation.refresh === 'loading' ? 'Tracks added. Refreshing playlists…'
      : mutation.refresh === 'ready' ? 'Tracks added.' : 'Tracks added, but the playlist list could not be refreshed.'
    : mutation.status !== 'idle' ? {
      loading: 'Checking the destination and adding tracks…', denied: 'You do not have permission to add these tracks to that playlist.',
      unavailable: 'This selected-track action is not available from this provider.', conflict: 'This destination changed. Choose it again before adding tracks.',
      error: state.writeStarted ? 'Adding tracks was not confirmed. Check the playlist before starting another attempt.' : 'The destination could not be checked. Reload playlists and try again.',
    }[mutation.status] : {
      loading: 'Loading playlists…', empty: 'No writable playlists are available.', denied: 'You do not have permission to use these tracks or playlists.',
      unavailable: 'Playlist destinations are not available from this provider.', error: 'Playlist destinations could not be loaded.',
      retired: 'The source changed. Close this form and choose the tracks again.',
    }[state.status];
  if (!message) return null;
  const error = state.status === 'error' || ['error', 'conflict', 'denied'].includes(mutation.status);
  return <NativeHtml html={runtime.alertHtml({severity: error ? 'error' : 'info', role: error ? 'alert' : 'status', message})}/>;
}

function SeededCreation({runtime, action, readDetail, onCreated, onDismiss, completed, canDismissWhileLoading}) {
  const controller = action.getCreationController();
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  return <CreationForm {...{runtime, controller, readDetail, onCreated, onDismiss, canDismissWhileLoading}} state={completed || state}/>;
}

// One native form owns both destination selection and the ordinary CreationForm.
// The parent owns the retained source receipt and releases it after onClose.
export function PlaylistActionSession({runtime, packet, lifetime, sourceAdapter, providers, onClose, onNavigate, onNotice,
  readDetail, parentSurface, returnFocus}) {
  const [controller, setController] = useState(() => createPlaylistActionController({packet, lifetime, sourceAdapter, providers}));
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [completed, setCompleted] = useState(null);
  const owner = useRef({providers, sourceAdapter, lifetime});
  const alive = useRef(true), disposedControllers = useRef(new WeakSet()), closeOwner = useRef(null), completing = useRef(false), retiredClose = useRef(false), nativeClosed = useRef(null), reportedClose = useRef(false);
  const latestClose = useRef(onClose); latestClose.current = onClose;
  const reportClose = options => {if (!reportedClose.current) {reportedClose.current = true; latestClose.current?.(options);}};
  useLayoutEffect(() => {
    // Effect replay must acquire a fresh committed owner after cleanup. An
    // abandoned render creates no subscriptions or transport requests.
    if (disposedControllers.current.has(controller)) {
      setController(createPlaylistActionController({packet, lifetime, sourceAdapter, providers}));
      return undefined;
    }
    alive.current = true;
    controller.load();
    return () => {alive.current = false; disposedControllers.current.add(controller); controller.dispose();};
  }, [controller]);
  useLayoutEffect(() => {
    if (owner.current.providers !== providers || owner.current.sourceAdapter !== sourceAdapter || owner.current.lifetime !== lifetime) controller.retire();
  }, [controller, providers, sourceAdapter, lifetime]);
  useLayoutEffect(() => {
    if (state.status !== 'retired' || retiredClose.current || !closeOwner.current) return;
    retiredClose.current = true;
    setCompleted(null);
    closeOwner.current({force: true, restoreFocus: false, returnToParent: false});
  }, [state.status]);
  const beforeDismiss = async () => {
    const creation = controller.getCreationController(), snapshot = creation?.getSnapshot();
    const writePending = () => {
      const latest = controller.getSnapshot();
      return completing.current || latest.writeStarted && (latest.busy || creation?.getSnapshot().mutation.status === 'loading');
    };
    if (writePending()) return false;
    const accept = () => {
      if (writePending()) return false;
      // Native dismissal awaits this callback. Abort the read synchronously so
      // it cannot dispatch a writer in the gap before native teardown.
      controller.dispose(); return true;
    };
    if (completed || !snapshot?.dirty) return accept();
    if (typeof runtime.confirm !== 'function') return false;
    const accepted = await runtime.confirm('Discard this unsaved playlist?');
    return accepted === true && alive.current && controller.isCurrent() && creation.getSnapshot() === snapshot && accept();
  };
  const created = async ack => {
    const saved = controller.getCreationController()?.getSnapshot();
    if (!alive.current || !saved || !controller.acknowledgeCreation(ack)) return false;
    setCompleted(playlistCreationCompletionState(saved, ack));
    completing.current = true;
    try {
      const finished = await completeSelectionPlaylistCreation({controller, ack, close: options => closeOwner.current?.(options),
        navigate: onNavigate, notify: onNotice});
      if (finished && alive.current) reportClose({restoreFocus: false, current: true});
      return finished;
    } finally {
      completing.current = false;
      if (alive.current && nativeClosed.current) reportClose(nativeClosed.current);
    }
  };
  const finished = state.writeStarted;
  return <NativeDialog runtime={runtime} title="Add to playlist" pageId="playlist-track-destination" parentSurface={parentSurface}
    returnFocus={returnFocus} beforeDismiss={beforeDismiss} onClose={options => {
      // Native teardown can precede its awaited parent return. Keep the receipt
      // through that return so the last authority check controls navigation.
      nativeClosed.current = options || {};
      if (!completing.current || !controller.isCurrent()) reportClose(options);
    }}>{close => {
    closeOwner.current = close;
    return <>
      {state.counts && <p className="playlists__note" role="status">{state.counts.selectedRowCount} selected rows · {state.counts.uniqueTrackCount} unique tracks
        {state.counts.unresolvedSourceCount > 0 ? ` · ${state.counts.unresolvedSourceCount} unresolved source entries retained` : ''}
        {state.counts.duplicateCount > 0 ? `; ${state.counts.duplicateCount} repeats included once.` : '.'}</p>}
      {state.mode === 'create' ? <SeededCreation {...{runtime, readDetail, completed}} action={controller} onCreated={created} onDismiss={close}
        canDismissWhileLoading={!state.writeStarted}/>
        : <form className="playlists__form" aria-label="Add selected tracks to playlist" aria-busy={state.busy}
          onSubmit={event => {event.preventDefault(); controller.add();}}>
          <ActionStatus {...{runtime, state}}/>
          {['ready', 'empty'].includes(state.status) && <>
            {state.destinations.length > 0 ? <NativeChoice runtime={runtime} label="Playlist" value={state.selectedId || ''}
              options={[["", 'Choose a playlist', true], ...state.destinations.map(row => [row.playlist_id, row.title || 'Untitled playlist'])]}
              disabled={state.busy || finished || !state.canAdd} onChange={value => controller.select(value)}/>
              : state.status !== 'empty' && <p className="playlists__note" role="status">No writable playlists are available.</p>}
            {!state.canAdd && <p className="playlists__note">{state.counts?.unresolvedSourceCount > 0
              ? 'Some selected rows have no supported Playlist track identity. Create can retain their source entries when available.'
              : 'Adding these tracks is not available from this provider.'}</p>}
            {!state.canCreate && <p className="playlists__note">Creating a playlist from these tracks is not available from this source.</p>}
          </>}
          <div className="playlists__actions">
            <Button runtime={runtime} type="submit" disabled={state.busy || finished || !state.selectedId || !state.canAdd}>Add to playlist</Button>
            <Button runtime={runtime} disabled={state.busy || finished || !state.canCreate} onClick={() => controller.openCreate()}>Create new playlist</Button>
            {state.status === 'error' && !finished && <Button runtime={runtime} disabled={state.busy} onClick={() => controller.load()}>Reload playlists</Button>}
            <Button runtime={runtime} disabled={state.busy && state.writeStarted} onClick={() => close({reason: 'cancel'})}>{finished ? 'Close' : 'Cancel'}</Button>
          </div>
        </form>}
    </>;
  }}</NativeDialog>;
}
