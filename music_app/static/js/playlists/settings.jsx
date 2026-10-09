import React, {useEffect, useLayoutEffect, useRef, useState} from 'react';
import {Button, Status} from '../home-friends/components.jsx';
import {NativeChoice} from '../home-friends/native-choice.jsx';
import {NativeDialog} from '../home-friends/native-dialog.jsx';
import {MutationStatus, RetryOriginalRequest} from './mutation-status.jsx';
import {draftDirty, playlistDraft} from './model.mjs';

export async function confirmPlaylistDelete(runtime, controller) {
  const before = controller.getSnapshot(), detail = before.resource.data?.detail, version = controller.getLifecycleVersion();
  if (!detail || !controller.available('deletePlaylist') || before.mutation.status === 'loading' || typeof runtime.confirm !== 'function') return false;
  let accepted = false;
  try {accepted = await runtime.confirm(`Delete playlist “${detail.title}”? Its saved playlist entries and unsaved changes will be removed. Your music files will remain.`,
    {title: 'Delete playlist', acceptLabel: 'Delete', danger: true});} catch {return false;}
  if (accepted !== true) return false;
  const current = controller.getSnapshot();
  if (controller.getLifecycleVersion() !== version || current.scopeKey !== before.scopeKey || current.selectedPlaylistId !== before.selectedPlaylistId
    || current.resource.data?.detail !== detail || current.mutation.status === 'loading' || !controller.available('deletePlaylist')) return false;
  return controller.mutate('deletePlaylist');
}

export function PlaylistSettings({runtime, controller, state, providers, onClose, onDeleted}) {
  const detail = state.resource.data?.detail, scopeKey = state.scopeKey;
  const [sort, setSort] = useState(() => detail?.saved_default_sort || null);
  const [preference, setPreference] = useState({status: 'loading', data: null});
  const [remember, setRemember] = useState(null), [preferenceMutation, setPreferenceMutation] = useState({status: 'idle'});
  const [confirming, setConfirming] = useState(false), alive = useRef(null), request = useRef(null), pending = useRef(null), render = useRef(null);
  const frame = {}; render.current = frame;
  const busy = state.mutation.status === 'loading' || preferenceMutation.status === 'loading' || confirming;
  useLayoutEffect(() => {
    const owner = {controller, providers, scopeKey}; alive.current = owner;
    pending.current = null; setConfirming(false); setPreferenceMutation({status: 'idle'});
    return () => {if (alive.current === owner) alive.current = null; request.current?.abort();};
  }, [controller, providers, scopeKey]);
  useEffect(() => {setSort(detail?.saved_default_sort || null);}, [detail]);
  useEffect(() => {
    const owner = alive.current, read = providers.readPlaylistPreferences;
    if (typeof read !== 'function') {setPreference({status: 'unavailable', data: null}); return;}
    const operation = new AbortController(); request.current = operation; setPreference({status: 'loading', data: null});
    Promise.resolve().then(() => {
      if (operation.signal.aborted || alive.current !== owner) return null;
      return read({scopeKey, signal: operation.signal});
    }).then(value => {
      if (!operation.signal.aborted && alive.current === owner && value.scopeKey === scopeKey) {
        setPreference({status: 'ready', data: value.preferences}); setRemember(value.preferences.remember_order_mode);
      }
    }).catch(error => {if (!operation.signal.aborted && alive.current === owner) setPreference({status: [401, 403].includes(error?.status) ? 'denied' : 'error', data: null});});
    return () => operation.abort();
  }, [controller, providers, scopeKey]);
  const active = () => render.current === frame && alive.current?.controller === controller && alive.current.providers === providers && alive.current.scopeKey === scopeKey
    && controller.getSnapshot().scopeKey === scopeKey && controller.getSnapshot().resource.data?.detail === detail
    && controller.getSnapshot().mutation.status !== 'loading' && !pending.current;
  const savePreferences = async ({retry = false} = {}) => {
    if (!active() || preference.status !== 'ready' || typeof providers[retry ? 'retryPlaylistOperation' : 'savePlaylistPreferences'] !== 'function') return;
    const owner = alive.current, operation = new AbortController(); request.current = operation; pending.current = operation;
    setPreferenceMutation({status: 'loading'});
    try {
      const value = retry ? await providers.retryPlaylistOperation({scopeKey, action: 'playlist_preferences', signal: operation.signal})
        : await providers.savePlaylistPreferences({scopeKey, revision: preference.data.revision, remember_order_mode: remember, signal: operation.signal});
      if (alive.current !== owner || operation.signal.aborted || value.scopeKey !== scopeKey) return;
      setPreference({status: 'ready', data: value.preferences}); setRemember(value.preferences.remember_order_mode); setPreferenceMutation({status: 'ready'});
    } catch (error) {if (alive.current === owner && !operation.signal.aborted) setPreferenceMutation({status: [401, 403].includes(error?.status) ? 'denied' : 'error'});}
    finally {if (pending.current === operation) pending.current = null;}
  };
  const dirtySort = JSON.stringify(sort) !== JSON.stringify(detail?.saved_default_sort || null);
  const metadataDirty = draftDirty(detail, playlistDraft(state));
  return <NativeDialog runtime={runtime} title="Playlist settings" onClose={onClose} beforeDismiss={() => !pending.current && !confirming && controller.getSnapshot().mutation.status !== 'loading'}>{close =>
    <div className="playlists__form tag-editor-form">
      <NativeChoice runtime={runtime} label="Saved default sort" value={sort?.key || 'author'} disabled={busy || metadataDirty || !controller.available('saveDefaultSort')}
        options={ [['author', 'Author order'], ['love_tier', 'Love'], ['play_count', 'Play count'], ['popularity_count', 'Popularity'], ['duration', 'Length']] }
        onChange={key => {if (active()) setSort(key === 'author' ? null : {key, direction: sort?.direction || 'desc'});}}/>
      {sort && <NativeChoice runtime={runtime} label="Sort direction" value={sort.direction} disabled={busy || metadataDirty || !controller.available('saveDefaultSort')}
        options={ [['asc', 'Ascending'], ['desc', 'Descending']] } onChange={direction => {if (active()) setSort({...sort, direction});}}/>}
      <Button runtime={runtime} disabled={busy || metadataDirty || !dirtySort || !controller.available('saveDefaultSort')}
        onClick={() => {if (active() && !draftDirty(detail, playlistDraft(controller.getSnapshot()))) controller.mutate('saveDefaultSort', {sort});}}>Save default sort</Button>
      {metadataDirty && <p className="playlists__note">Save or discard the playlist's unsaved changes before updating its saved default sort.</p>}
      <p className="playlists__note">The saved default is used when this playlist opens. Sorting the current view does not change it.</p>
      <Status runtime={runtime} value={preference} label="Playlist playback preferences"/>
      {preference.data && <><NativeChoice runtime={runtime} label="Remember Regular or Shuffle" value={remember ? 'on' : 'off'}
        disabled={busy || typeof providers.savePlaylistPreferences !== 'function'} options={ [['on', 'On'], ['off', 'Off']] }
        onChange={value => {if (active()) setRemember(value === 'on');}}/>
        <Button runtime={runtime} disabled={busy || remember === preference.data.remember_order_mode || typeof providers.savePlaylistPreferences !== 'function'}
          onClick={savePreferences}>Save playback preference</Button></>}
      <p className="playlists__note">This preference belongs to your account. With memory off, each new playlist starts in Regular order. Repeat applies only to the current queue.</p>
      <RetryOriginalRequest runtime={runtime} scopeKey={scopeKey} disabled={busy}
        available={providers.hasPendingPlaylistOperation?.({scopeKey, action: 'playlist_preferences'}) === true}
        retry={() => savePreferences({retry: true})} current={active}/>
      <MutationStatus runtime={runtime} value={preferenceMutation}/><MutationStatus runtime={runtime} value={state.mutation} controller={controller}/>
      <div className="playlists__actions">
        {controller.available('deletePlaylist') && <Button runtime={runtime} disabled={busy} icon="delete" semantic="destructive" onClick={async () => {
          if (!active()) return; const owner = alive.current; pending.current = owner; setConfirming(true);
          try {
            if (await confirmPlaylistDelete(runtime, controller)) {
              if (alive.current === owner) close({restoreFocus: false});
              const current = controller.getSnapshot();
              if (current.scopeKey === scopeKey && current.selectedPlaylistId === null && current.mutation.action === 'deletePlaylist' && current.mutation.status === 'ready') onDeleted?.();
            }
          }
          finally {if (pending.current === owner) pending.current = null; if (alive.current === owner) setConfirming(false);}
        }}>Delete playlist</Button>}
        <Button runtime={runtime} disabled={busy} onClick={() => close()}>Close</Button>
      </div>
    </div>}
  </NativeDialog>;
}
