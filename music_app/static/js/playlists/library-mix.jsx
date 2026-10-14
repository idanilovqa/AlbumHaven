import React, {useEffect, useMemo, useState, useSyncExternalStore} from 'react';
import {Button, NativeHtml, Status} from '../home-friends/components.jsx';
import {NativeDialog} from '../home-friends/native-dialog.jsx';
import {NativeChoice} from '../home-friends/native-choice.jsx';
import {SharedHeader} from '../home-friends/shared-header.jsx';
import {PlaylistTracks} from './track-table.jsx';
import {PlaylistSelectionPanel} from './selection.jsx';
import {MIX_ORDER_OPTIONS, mixOrder, normalizeMixRecipe, orderUnplayedMixRows} from './library-mix.mjs';

export function SavedLibraryMixOrder({runtime, detail, scopeKey, rows = detail.track_rows}) {
  const [choice, setChoice] = useState(null);
  const [starting, setStarting] = useState(false), [message, setMessage] = useState('');
  const playlistId = detail.playlist_id;
  const current = choice?.scopeKey === scopeKey && choice.playlistId === playlistId;
  const mode = current ? choice.mode : detail.library_mix.playback_order;
  const first = rows.find(row => runtime.canTrackIntent?.('play', row, {scopeKey, playlist_id: playlistId}) === true);
  useEffect(() => {
    let active = true, notifications = 0;
    const abort = new AbortController();
    const accept = value => {
      if (!active || value?.status !== 'ready' || value.data?.scopeKey !== scopeKey
        || value.data.playlist_id !== playlistId || !mixOrder(value.data.library_mix_order)) return;
      setChoice({scopeKey, playlistId, mode: value.data.library_mix_order});
    };
    const unsubscribe = runtime.subscribePlayback?.({scopeKey, playlist_id: playlistId,
      onChange: value => {notifications++; accept(value);}});
    const before = notifications;
    Promise.resolve(runtime.readPlayback?.({scopeKey, playlist_id: playlistId, signal: abort.signal}))
      .then(value => {if (notifications === before) accept(value);}).catch(() => {});
    return () => {active = false; abort.abort(); unsubscribe?.();};
  }, [runtime, scopeKey, playlistId, detail]);
  return <><Button runtime={runtime} icon="play" disabled={!current || starting || !first || detail.allowed_actions.can_play !== true}
    onClick={async () => {
      if (!first || starting) return;
      setStarting(true); setMessage('');
      try {await runtime.trackIntent('play', first, {scopeKey, playlist_id: playlistId,
        displayedItemIds: rows.map(row => row.playlist_item_id), fromStart: true});}
      catch (error) {if (error?.name !== 'AbortError') setMessage('This mix could not be played.');}
      finally {setStarting(false);}
    }}>Play mix</Button><NativeChoice runtime={runtime} label="Playback order" value={mode} options={MIX_ORDER_OPTIONS}
    title="Order for the next playlist start; saved default is unchanged"
    disabled={!current || starting || detail.allowed_actions.can_play !== true || typeof runtime.setLibraryMixOrder !== 'function'}
    onChange={next => {if (runtime.setLibraryMixOrder({scopeKey, playlist_id: playlistId, mode: next})) setChoice({scopeKey, playlistId, mode: next});}}/>
    {message && <NativeHtml html={runtime.alertHtml({severity: 'error', role: 'alert', message})}/>}</>;
}

export function LibraryMixSetup({runtime, controller, onReady, onClose}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [basis, setBasis] = useState('per_artist'), [count, setCount] = useState('3');
  const [automatic, setAutomatic] = useState(false), [order, setOrder] = useState('regular');
  const busy = state.resource.status === 'loading';
  const recipe = normalizeMixRecipe({selection_basis: basis, songs_per_group: /^\d+$/.test(count) ? Number(count) : null,
    auto_update: automatic, playback_order: order});
  return <NativeDialog runtime={runtime} title="Library Mix" pageId="library-mix" onClose={onClose}>{close =>
    <form className="tag-editor-form" onSubmit={async event => {
      event.preventDefault();
      if (!busy && recipe && await controller.prepare(recipe)) await onReady(close);
    }}>
      <p className="playlists__note">Choose popular songs from your whole server library, ranked by Last.fm global plays.</p>
      <NativeChoice runtime={runtime} label="Choose songs" value={basis} disabled={busy}
        options={ [['per_artist', 'Per artist'], ['per_album', 'Per album']] } onChange={setBasis}/>
      <label>Songs per group<input type="number" min="1" max="5000" step="1" inputMode="numeric"
        aria-label="Songs per group" value={count} disabled={busy} onChange={event => setCount(event.target.value)}/></label>
      <NativeChoice runtime={runtime} label="Playback order" value={order} options={MIX_ORDER_OPTIONS} disabled={busy} onChange={setOrder}/>
      <NativeChoice runtime={runtime} label="Update automatically when saved" value={automatic ? 'on' : 'off'} disabled={busy}
        options={ [['off', 'Off'], ['on', 'On']] } onChange={value => setAutomatic(value === 'on')}/>
      <p className="playlists__note">Songs without resolved Last.fm popularity are left out. Auto-updating mixes recalculate the top songs as your library changes and keep generated membership locked. Mixes are limited to 5,000 songs; reduce songs per group if the result is too large.</p>
      {['loading', 'error', 'denied'].includes(state.resource.status) && <Status runtime={runtime} value={state.resource} label="Library Mix"/>}
      <div className="dialog-actions">
        <Button runtime={runtime} onClick={() => close()}>Cancel</Button>
        <Button runtime={runtime} icon="play" disabled={busy || !recipe} onClick={async () => {
          if (!busy && recipe && await controller.prepare(recipe)) await onReady(close);
        }}>Create mix</Button>
      </div>
    </form>
  }</NativeDialog>;
}

export function LibraryMixPage({runtime, controller, onClose, onSaved, readDetail}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [selected, select] = useState(null), [message, setMessage] = useState(''), [starting, setStarting] = useState(false);
  const [displayedView, setDisplayedView] = useState(null);
  const detail = state.resource.data?.detail;
  const rows = useMemo(() => !detail ? [] : state.playbackOrder === 'unplayed_first'
    ? orderUnplayedMixRows(detail.track_rows) : detail.track_rows, [detail, state.playbackOrder]);
  const playbackRows = displayedView?.detail === detail && displayedView.scopeKey === state.scopeKey ? displayedView.rows : rows;
  const busy = state.mutation.status === 'loading', saved = state.mutation.status === 'ready';
  const pending = controller.pendingSave(), selectedRow = rows.find(row => row.row_key === selected) || null;
  const play = async () => {
    const row = playbackRows.find(item => runtime.canTrackIntent?.('play', item, {playlist_id: detail?.playlist_id, scopeKey: state.scopeKey}) === true);
    if (!row || starting) return;
    setStarting(true); setMessage('');
    try {await runtime.trackIntent('play', row, {playlist_id: detail.playlist_id, scopeKey: state.scopeKey,
      displayedItemIds: playbackRows.map(item => item.playlist_item_id), playbackOrder: state.playbackOrder, fromStart: true});}
    catch (error) {if (error?.name !== 'AbortError') setMessage('This mix could not be played.');}
    finally {setStarting(false);}
  };
  const save = async retry => {
    const receipt = await (retry ? controller.retrySave() : controller.save());
    if (receipt) await onSaved(receipt);
  };
  return <main className="playlists__content" aria-label="Temporary Library Mix">
    <SharedHeader runtime={runtime} id="library-mix" className="playlists__header" actions={[
      <Button key="play" runtime={runtime} icon="play" disabled={starting || !detail?.allowed_actions.can_play || !rows.length} onClick={play}>Play</Button>,
      <NativeChoice key="order" runtime={runtime} label="Playback order" value={state.playbackOrder} options={MIX_ORDER_OPTIONS}
        disabled={busy || saved || pending} onChange={order => controller.setOrder(order)}/>,
      <Button key="save" runtime={runtime} icon="save" disabled={!controller.canSave()} onClick={() => save(false)}>Save as playlist</Button>,
    ]} finalAction={<Button runtime={runtime} icon="close" disabled={busy} onClick={onClose}>Close mix</Button>}>
      <div className="gallery-bar__title">{state.title || 'Library Mix'}</div>
    </SharedHeader>
    <div className="playlists__scroll gallery-scrollbar">
      <div className="playlists__metadata tag-editor-form">
        <label>Title<input aria-label="Playlist title" maxLength="100" value={state.title} disabled={busy || saved || pending}
          onChange={event => controller.edit({title: event.target.value})}/></label>
        <label>Description<textarea aria-label="Playlist description" rows="2" maxLength="1000" value={state.description}
          disabled={busy || saved || pending} onChange={event => controller.edit({description: event.target.value})}/></label>
      </div>
      <p className="playlists__note" role="status">Temporary mix · {rows.length} songs · Last.fm global plays
        {state.recipe?.auto_update ? ' · Auto-updating after save; generated membership is locked' : ' · Save keeps this selection'}
      </p>
      {Number.isSafeInteger(state.coverage.excluded_count) && <p className="playlists__note">
        {state.coverage.excluded_count} local tracks excluded because popularity or grouping could not be resolved.
      </p>}
      {['queued', 'running'].includes(state.popularityRefreshStatus) && <p className="playlists__note" role="status">Last.fm popularity refresh is in progress. This temporary mix keeps its captured selection; create another mix later to use newly resolved counts.</p>}
      {(state.popularityRefreshStatus === 'blocked' || state.popularityRefreshError) && <p className="playlists__note" role="status">{state.popularityRefreshError === 'not_configured' ? 'Last.fm popularity refresh is not configured.' : 'Last.fm popularity refresh is unavailable.'} Resolved cached counts are still used.</p>}
      {!rows.length && detail && <p role="status">No local songs with resolved Last.fm popularity match this mix.</p>}
      {detail && <PlaylistTracks runtime={runtime} rows={rows} detail={detail} controller={controller} state={state}
        selected={selected} currentItemId={null} onSelect={row => select(row.row_key)} onError={setMessage} onDisplayedRowsChange={setDisplayedView}/>}
      {selectedRow && <PlaylistSelectionPanel runtime={runtime} scopeKey={state.scopeKey} row={selectedRow} readDetail={readDetail} onClose={() => select(null)}/>}
      <Status runtime={runtime} value={state.resource} label="Library Mix"/>
      {state.mutation.status !== 'idle' && <Status runtime={runtime} value={state.mutation} label="Saving playlist"/>}
      {pending && !busy && <Button runtime={runtime} onClick={() => save(true)}>Check original save</Button>}
      {saved && <Button runtime={runtime} onClick={() => onSaved(state.mutation.data)}>Open saved playlist</Button>}
      {message && <NativeHtml html={runtime.alertHtml({severity: 'error', role: 'alert', message})}/>}
    </div>
  </main>;
}
