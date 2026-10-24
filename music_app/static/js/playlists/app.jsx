import React, {useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore} from 'react';
import {Button, NativeHtml, Status} from '../home-friends/components.jsx';
import {NativeChoice} from '../home-friends/native-choice.jsx';
import {readTrackPreference} from '../home-friends/track-preference.mjs';
import {PlaylistGroupedDirectory, PlaylistFilterControls} from './directory-filters.jsx';
import {PlaylistSelectionPanel} from './selection.jsx';
import {PlaylistCreationSession} from './creation-session.jsx';
import {SharePlaylist} from './sharing.jsx';
import {PlaylistSettings} from './settings.jsx';
import {MutationStatus, RetryOriginalRequest} from './mutation-status.jsx';
export {SharingFields} from './sharing.jsx';
export {MutationStatus} from './mutation-status.jsx';
import {CreationSearch} from './creation.jsx';
import {PlaylistFilterSurface} from './filter-surface.jsx';
import {usePlaylistFilterSession} from './filter-session.jsx';
import {canOpenPlaylistCreation, playlistCreationContext, preparePlaylistCreationOpening} from './creation-session.mjs';
import {PlaylistTracks, restorePlaylistSelectionFocus} from './track-table.jsx';
export {playlistTableHtml, playlistReorderSnapshot, paintPlaylistCurrent, restorePlaylistSelectionFocus} from './track-table.jsx';
import {createPlaylistIntegrations} from './integrations.mjs';
import {PlaylistPlaybackControls, PlaylistMatchReview} from './integrations.jsx';
import {playlistDialogVisible, playlistSharingCurrent, restorePlaylistDialogFocus} from './dialog-state.mjs';
import {defaultFilters, draftDirty, granted, hasPlaylistFilters, playlistText, playlistDraft, playlistFilters, validMetadata, visiblePlaylistRows} from './model.mjs';

export function PlaylistDirectory({runtime, state, onSelect, onCreate, canCreate}) {
  const items = state.resource.data?.items || [];
  return <aside className="playlists__directory" aria-label="Playlist directory">
    <div className="playlists__directory-header"><h2>Playlists</h2><Button runtime={runtime} icon="add" disabled={!canCreate}
      title={canCreate ? 'Create playlist' : 'Playlist creation is not available for this account yet.'}
      attributes={{'data-playlists-create': '1'}} onClick={onCreate}>Create playlist</Button></div>
    <PlaylistGroupedDirectory runtime={runtime} items={items} selectedPlaylistId={state.selectedPlaylistId}
      disabled={state.mutation.status === 'loading'} onSelect={onSelect}/>
    {!items.length && <Status runtime={runtime} value={state.resource.status === 'ready' ? {status: 'empty'} : state.resource} label="Playlists"/>}
  </aside>;
}
export function PlaylistHeader({runtime, detail, draft, busy, actions, filtersOpen, onAction}) {
  const host = useRef(null);
  const html = runtime.galleryBarHtml({contextKind: 'recent', title: draft?.title || detail?.title || 'Playlists',
    actionsHtml: [
      ['add', 'Add tracks', !actions.add, 'add'], ['missing', 'Inspect missing tracks', !actions.missing, 'missing-playlist'],
      ['top', 'Create Album Top', !actions.top, 'create-top'], ['export', 'Export TXT', !actions.export, 'export-text'], ['share', 'Share', !detail || actions.share === false, 'share'],
      ['settings', 'Playlist settings', !detail, 'more'],
      ['filters', 'Filters', !detail, 'filters'], ['save', 'Save', !actions.save, 'save'], ['discard', 'Discard unsaved changes', !draft, 'close'],
    ].map(([action, label, disabled, icon]) => runtime.actionHtml({icon, ariaLabel: label, presentation: 'bare', disabled: busy || disabled,
        title: action === 'missing' && disabled ? 'Missing-track playlist creation is not available for this source yet.' : label,
        attributes: {'data-playlists-action': action, ...(action === 'filters' ? {'aria-expanded': String(filtersOpen), 'aria-controls': 'playlists-filters'} : {})}})).join('')});
  const initialHtml = useRef(html);
  useLayoutEffect(() => {
    const node = host.current, active = node.contains(document.activeElement) ? document.activeElement.dataset.playlistsAction : null;
    if (node.innerHTML !== html) node.innerHTML = html;
    if (active) [...node.querySelectorAll('[data-playlists-action]')].find(button => button.dataset.playlistsAction === active && !button.disabled)?.focus({preventScroll: true});
  }, [html]);
  return <div ref={host} className="gallery-bar playlists__header" dangerouslySetInnerHTML={{__html: initialHtml.current}} onClick={event => {
    const button = event.target.closest('[data-playlists-action]');
    if (button && !button.disabled) onAction(button.dataset.playlistsAction);
  }}/>;
}
export function PlaylistFilters({runtime, filters, rows = [], onChange, disabled = false}) {
  return <PlaylistFilterControls runtime={runtime} rows={rows} filters={filters} onChange={onChange} disabled={disabled}
    canReset={hasPlaylistFilters(filters)} onReset={() => onChange(defaultFilters)}>
    <CreationSearch runtime={runtime} id="playlists-filter-search" className="playlists-filter__search" maxLength={200}
      value={filters.query} disabled={disabled} label="Find tracks" placeholder="Track, artist or album"
      onChange={query => onChange({query})}/>
    <NativeChoice runtime={runtime} label="Availability" value={filters.availability} disabled={disabled}
      options={ [['all', 'All tracks'], ['local', 'Confirmed local'], ['missing', 'Confirmed missing'], ['unresolved', 'Needs review']] }
      onChange={availability => onChange({availability})}/>
  </PlaylistFilterControls>;
}

export function resolvePlaylistSelection(selection, {scopeKey, detail, rows}) {
  if (!selection || !detail || selection.scopeKey !== scopeKey || selection.playlistId !== detail.playlist_id) return null;
  if (!selection.itemId && selection.detail !== detail) return null;
  const matches = rows.filter(row => row.source_readable === true && (selection.itemId
    ? row.playlist_item_id === selection.itemId : row.row_key === selection.rowKey));
  return matches.length === 1 ? matches[0] : null;
}
export function playlistIntegrationCurrent(value, state, selectedItemId = null) {
  return value.scopeKey === state.scopeKey && value.status === state.resource.status
    && value.detail === (state.resource.status === 'ready' ? state.resource.data?.detail || null : null)
    && value.selectedItemId === selectedItemId;
}
export async function confirmPlaylistDiscard(runtime, controller) {
  const before = controller.getSnapshot(), draft = playlistDraft(before), detail = before.resource.data?.detail;
  if (!draft || before.mutation.status === 'loading' || typeof runtime.confirm !== 'function') return false;
  if (await runtime.confirm('Discard unsaved changes to this playlist?') !== true) return false;
  const current = controller.getSnapshot();
  if (current.scopeKey !== before.scopeKey || current.selectedPlaylistId !== before.selectedPlaylistId
    || current.resource.data?.detail !== detail || playlistDraft(current) !== draft || current.mutation.status === 'loading') return false;
  return controller.discard(before.selectedPlaylistId);
}

function MetadataFields({detail, draft, busy, onChange}) {
  return <div className="playlists__metadata tag-editor-form">
    <label>Title<input aria-label="Playlist title" value={draft?.title ?? detail.title} maxLength={100}
      readOnly={!granted(detail, 'can_edit') || !granted(detail, 'can_rename')} disabled={busy} onChange={event => onChange({title: event.target.value})}/></label>
    <label>Description<textarea aria-label="Playlist description" rows={2} maxLength={1000} value={draft?.description ?? detail.description}
      readOnly={!granted(detail, 'can_edit')} disabled={busy} onChange={event => onChange({description: event.target.value})}/></label>
    <p className="playlists__note" role="status">{draftDirty(detail, draft) ? 'Unsaved draft · kept while switching playlists in this session.' : 'Saved playlist'}
      {detail.visibility && ` · ${detail.visibility}`}</p>
    {draft?.conflict && <p role="alert">This playlist changed on the server. Your draft is preserved. Discard it to reload the current values before saving.</p>}
  </div>;
}
export function playlistSharingRenderCurrent(subject, state) {
  return playlistSharingCurrent(subject, state) && (subject === state.resource.data?.detail
    || !state.resource.data?.detail && state.mutation.status === 'loading' && state.mutation.action === 'saveSharing');
}
const EMPTY_PROVIDERS = Object.freeze({});
const filterSourceIdentity = state => state.resource.status === 'ready' && state.resource.data?.detail
  ? [state.scopeKey, state.selectedPlaylistId, state.resource.data.detail] : null;
export function PlaylistsView({runtime, controller, state, onSelect, onPrepareDraft, integrationProviders = EMPTY_PROVIDERS, readDetail, navigationError = false}) {
  const [dialog, setDialog] = useState(null), [message, setMessage] = useState('');
  const filterSession = usePlaylistFilterSession(controller, filterSourceIdentity, integrationProviders);
  const filterOwner = filterSession.opening, filtersOpen = Boolean(filterOwner);
  const [selection, setSelection] = useState(null), [picking, setPicking] = useState(false), [discarding, setDiscarding] = useState(false);
  const [openingCreation, setOpeningCreation] = useState(false), creationOpening = useRef(null);
  const picker = useRef(null), page = useRef(null), pendingFocus = useRef(null), selectionFocus = useRef(null), discardRequest = useRef(null);
  const [integrations] = useState(() => createPlaylistIntegrations({providers: integrationProviders}));
  const integration = useSyncExternalStore(integrations.subscribe, integrations.getSnapshot, integrations.getSnapshot);
  const previousProviders = useRef(integrationProviders);
  const detail = state.resource.data?.detail, draft = detail && playlistDraft(state, detail.playlist_id);
  const busy = state.mutation.status === 'loading', filters = playlistFilters(state);
  const [preferenceVersion, setPreferenceVersion] = useState(0);
  useLayoutEffect(() => runtime.subscribeTrackPreferences?.(() => setPreferenceVersion(value => value + 1)), [runtime]);
  const rows = useMemo(() => visiblePlaylistRows(detail, draft, filters, Date.now(), row => {
    const preference = readTrackPreference(runtime, row, {scopeKey: state.scopeKey, playlist_id: detail?.playlist_id});
    return preference ? {...row, love_tier: preference.love_tier} : row;
  }), [runtime, state.scopeKey, detail, draft, filters, preferenceVersion]);
  const exportRows = useMemo(() => visiblePlaylistRows(detail, draft, defaultFilters), [detail, draft]);
  const selectedRow = resolvePlaylistSelection(selection, {scopeKey: state.scopeKey, detail, rows});
  const selectedItemId = selectedRow?.playlist_item_id || null;
  const currentIntegration = playlistIntegrationCurrent(integration, state, selectedItemId);
  const integrationDenied = integration.scopeKey === state.scopeKey && integration.selectedItemId === selectedItemId
    && integration.playback.status === 'denied' && integration.matches.status === 'denied';
  useLayoutEffect(() => {
    if (previousProviders.current !== integrationProviders) {
      integrations.setContext({status: 'unavailable'}); integrations.configure(integrationProviders); previousProviders.current = integrationProviders;
    }
    integrations.setContext({scopeKey: state.scopeKey, detail, selectedItemId, status: state.resource.status});
  }, [integrations, integrationProviders, state.scopeKey, state.resource.status, detail, selectedItemId]);
  useEffect(() => () => integrations.dispose(), [integrations]);
  useLayoutEffect(() => {if (selection && !selectedRow) setSelection(null);}, [selection, selectedRow]);
  const chooseRow = row => {
    if (!rows.includes(row) || row.source_readable !== true) return;
    setSelection({scopeKey: state.scopeKey, playlistId: detail.playlist_id, itemId: row.playlist_item_id,
      rowKey: row.row_key, detail});
  };
  const closeSelection = ({rowKey, restoreFocusRequested = false} = {}) => {
    selectionFocus.current = restoreFocusRequested && selectedRow?.row_key === rowKey
      ? {scopeKey: state.scopeKey, playlistId: state.selectedPlaylistId, rowKey} : null;
    setSelection(null);
  };
  const dialogVisible = playlistDialogVisible(dialog, state);
  const openDialog = kind => {
    const mode = kind === 'missing' ? 'missing' : 'ordinary';
    if (creationOpening.current || dialog) return;
    if (['create', 'missing'].includes(kind) && !canOpenPlaylistCreation(controller.getSnapshot(), integrationProviders, mode)) return;
    if (kind === 'create' && typeof integrationProviders.beginPlaylistCreationSource === 'function'
      || kind === 'missing' && typeof integrationProviders.recoverPlaylistCreation === 'function') {
      const request = new AbortController(); creationOpening.current = request; setOpeningCreation(true); setMessage('');
      preparePlaylistCreationOpening({controller, providers: integrationProviders, mode, signal: request.signal,
        isCurrent: () => creationOpening.current === request}).then(context => {
        if (!context || creationOpening.current !== request || request.signal.aborted) return;
        if (context.recoveredCreation) setMessage('Your previous playlist was created. Check Playlists before starting another.');
        else setDialog({kind, scopeKey: context.scopeKey, playlistId: context.playlistId, sharingGranted: false, source: context.source});
      }).catch(error => {
        if (creationOpening.current === request && !request.signal.aborted) setMessage(error?.status === 'unknown'
          ? 'A previous playlist creation is still unconfirmed. Check its result before starting another playlist.'
          : 'Playlist creation could not be opened. Try again.');
      }).finally(() => {
        if (creationOpening.current === request) {creationOpening.current = null; setOpeningCreation(false);}
      });
      return;
    }
    setDialog({kind, scopeKey: state.scopeKey, playlistId: state.selectedPlaylistId, sharingGranted: granted(detail, 'can_share'),
      source: ['create', 'missing'].includes(kind) ? playlistCreationContext(state, mode).source : null});
  };
  const closeDialog = ({restoreFocusRequested = false} = {}) => {
    pendingFocus.current = restoreFocusRequested ? {kind: dialog?.kind, scopeKey: state.scopeKey, playlistId: state.selectedPlaylistId} : null;
    setDialog(null);
  };
  useLayoutEffect(() => {
    if (!dialog && pendingFocus.current) {
      const pending = pendingFocus.current; pendingFocus.current = null;
      if (pending.scopeKey === state.scopeKey && pending.playlistId === state.selectedPlaylistId) restorePlaylistDialogFocus(page.current, pending.kind, document);
    }
    if (!selection && selectionFocus.current) {
      const pending = selectionFocus.current; selectionFocus.current = null;
      if (pending.scopeKey === state.scopeKey && pending.playlistId === state.selectedPlaylistId && rows.some(row => row.row_key === pending.rowKey))
        restorePlaylistSelectionFocus(page.current, pending.rowKey, document);
    }
  }, [dialog, selection, state.scopeKey, state.selectedPlaylistId, rows]);
  useEffect(() => {if (dialog && !dialogVisible) setDialog(null);}, [dialog, dialogVisible]);
  const canExport = Boolean(detail?.items_complete && detail.author_order && granted(detail, 'can_export') && typeof runtime.downloadText === 'function');
  const canSave = controller.available('savePlaylist') && !draft?.conflict && draftDirty(detail, draft) && validMetadata(draft);
  useEffect(() => {
    setDialog(null); setMessage(''); setPicking(false); setDiscarding(false); setOpeningCreation(false);
    return () => {picker.current?.abort(); picker.current = null; discardRequest.current = null;
      creationOpening.current?.abort(); creationOpening.current = null;};
  }, [state.selectedPlaylistId, state.scopeKey]);
  const run = async action => {
    setMessage('');
    if (action === 'filters') {
      const current = controller.getSnapshot();
      if (!detail || current.mutation.status === 'loading' || current.resource.status !== 'ready'
        || current.scopeKey !== state.scopeKey || current.selectedPlaylistId !== state.selectedPlaylistId
        || current.resource.data?.detail !== detail) return;
      filterSession.toggle();
      return;
    }
    if (action === 'share') openDialog('share');
    if (action === 'settings') openDialog('settings');
    if (action === 'missing') openDialog('missing');
    if (action === 'export') exportText(false);
    if (action === 'save') await controller.mutate('savePlaylist');
    if (action === 'discard') {
      if (discardRequest.current) return;
      if (typeof runtime.confirm !== 'function') {setMessage('Discard confirmation is unavailable. Your draft is unchanged.'); return;}
      const request = {}; discardRequest.current = request; setDiscarding(true);
      try {await confirmPlaylistDiscard(runtime, controller);} catch {
        if (discardRequest.current === request) setMessage('Discard confirmation could not be completed. Your draft is unchanged.');
      } finally {if (discardRequest.current === request) {discardRequest.current = null; setDiscarding(false);}}
    }
    if (action === 'top') await controller.mutate('createAlbumTop');
    if (action === 'add') {
      if (picker.current) return;
      const request = new AbortController(); picker.current = request; setPicking(true);
      const scopeKey = state.scopeKey, playlist_id = detail.playlist_id;
      try {
        const refs = await runtime.pickTracks({playlist_id, signal: request.signal});
        if (!request.signal.aborted && controller.getSnapshot().scopeKey === scopeKey && controller.getSnapshot().selectedPlaylistId === playlist_id && controller.getSnapshot().resource.data?.detail === detail && refs?.length) await controller.mutate('addTracks', refs);
      } catch {if (!request.signal.aborted && controller.getSnapshot().scopeKey === scopeKey) setMessage('Track selection is unavailable.');}
      finally {if (picker.current === request) {picker.current = null; setPicking(false);}}
    }
  };
  const exportText = missingOnly => {
    if (!canExport || controller.getSnapshot() !== state) return;
    const scopeKey = state.scopeKey, playlistId = state.selectedPlaylistId;
    Promise.resolve().then(() => {
      if (controller.getSnapshot() !== state) return;
      return runtime.downloadText({text: playlistText(exportRows, {missingOnly}), filename: missingOnly ? 'playlist-missing.txt' : 'playlist.txt'});
    })
      .catch(() => {if (controller.getSnapshot().scopeKey === scopeKey && controller.getSnapshot().selectedPlaylistId === playlistId) setMessage('TXT export is unavailable.');});
  };
  return <div ref={page} className="playlists">
    <PlaylistDirectory runtime={runtime} state={state} onSelect={id => {
      if (runtime.deferFormNavigation?.(() => onSelect(id))) return;
      onSelect(id);
    }} onCreate={() => openDialog('create')}
      canCreate={!busy && !openingCreation && canOpenPlaylistCreation(state, integrationProviders)}/>
    <main className="playlists__content" aria-label="Playlist">
      <PlaylistHeader {...{runtime, detail, draft, filtersOpen}} busy={busy || discarding} actions={{add: !picking && controller.available('addTracks') && typeof runtime.pickTracks === 'function',
        missing: canOpenPlaylistCreation(state, integrationProviders, 'missing'), top: controller.available('createAlbumTop'),
        export: canExport && exportRows.some(row => row.source_readable !== false), save: canSave, share: granted(detail, 'can_share')}} onAction={run}/>
      {filtersOpen && <PlaylistFilterSurface key={filterOwner.id} runtime={runtime} id="playlists-filters"
        returnFocus={() => page.current?.querySelector('[data-playlists-action="filters"]')}
        onClose={() => filterSession.close(filterOwner)}>
        <PlaylistFilters runtime={runtime} filters={filters} rows={exportRows} disabled={busy} onChange={patch => {
          const current = controller.getSnapshot();
          if (!busy && current.mutation.status !== 'loading' && filterSession.current(filterOwner)) controller.filter(patch);
        }}/>
      </PlaylistFilterSurface>}
      <div className="playlists__scroll gallery-scrollbar">
        {navigationError && <NativeHtml html={runtime.alertHtml({severity: 'error', role: 'alert', message: navigationError === 'delete' ? 'The playlist was deleted, but its directory could not be opened. Open Playlists again.' : 'The playlist could not be opened. Your previous selection has been restored.'})}/>}
        <Status runtime={runtime} value={state.resource} label="Playlists" retry={() => controller.load()}/>
        {detail ? <>
          <MetadataFields {...{detail, draft, busy}} onChange={patch => controller.edit(patch)}/>

          {currentIntegration && <PlaylistPlaybackControls runtime={runtime} controller={integrations} state={integration} providers={integrationProviders}/>}
          {!currentIntegration && integrationDenied && <Status runtime={runtime} value={{status: 'denied'}} label="Playlist integrations"/>}
          <div className="playlists__summary"><span>{rows.length} displayed tracks</span>
            <Button runtime={runtime} disabled={busy || !controller.available('createSamplePlaylist')} onClick={() => controller.mutate('createSamplePlaylist')}>Create sample playlist</Button>
            <Button runtime={runtime} disabled={!canExport || !exportRows.some(row => row.source_readable !== false && row.availability !== 'local')} onClick={() => exportText(true)}>Missing-only TXT</Button>
          </div>
          <PlaylistTracks key={`${state.scopeKey}:${detail.playlist_id}`} {...{runtime, rows, detail, controller, state}} selected={selectedRow?.row_key || null}
            currentItemId={currentIntegration ? integration.currentItemId : null} onSelect={chooseRow} onError={setMessage}/>
          {selectedRow && <div className="playlists__selection-context" onKeyDown={event => {
            if (event.key === 'Escape' && !event.defaultPrevented) {event.preventDefault(); event.stopPropagation();
              closeSelection({rowKey: selectedRow.row_key, restoreFocusRequested: true});}
          }}>
            <PlaylistSelectionPanel runtime={runtime} scopeKey={state.scopeKey} row={selectedRow} readDetail={readDetail} onClose={closeSelection}/>
            {currentIntegration && <PlaylistMatchReview runtime={runtime} controller={integrations} state={integration} onAccepted={() => {
              if (playlistIntegrationCurrent(integrations.getSnapshot(), controller.getSnapshot(), selectedItemId)) controller.load();
            }}/>}
          </div>}
          <p className="playlists__note">TXT uses the complete playlist or unsaved draft order, regardless of filters. Missing-only includes unresolved originals and excludes confirmed local matches and unreadable sources. Export does not save the draft.</p>
        </> : state.resource.status === 'ready' && <p>Select a playlist to see its tracks.</p>}
        {!dialogVisible && <RetryOriginalRequest runtime={runtime} scopeKey={state.scopeKey}
          available={integrationProviders.hasPendingPlaylistOperation?.({scopeKey: state.scopeKey, action: 'create'}) === true}
          retry={() => integrationProviders.retryPlaylistOperation({scopeKey: state.scopeKey, action: 'create'})}
          current={() => controller.getSnapshot().scopeKey === state.scopeKey}
          onRecovered={async () => {await controller.load(); setMessage('Your previous playlist was created. Check Playlists before starting another.');}}/>}
        {!dialogVisible && <MutationStatus runtime={runtime} value={state.mutation} controller={controller}/>}
        {message && <NativeHtml html={runtime.alertHtml({severity: 'info', role: 'status', message})}/>}
      </div>
    </main>
    {dialogVisible && ['create', 'missing'].includes(dialog.kind) && <PlaylistCreationSession
      key={`${dialog.kind}:${dialog.scopeKey}:${dialog.playlistId || ''}`} {...{runtime, controller, state, readDetail}}
      mode={dialog.kind === 'missing' ? 'missing' : 'ordinary'} providers={integrationProviders}
      onClose={closeDialog} onNavigate={onSelect} onPrepareDraft={onPrepareDraft} onNotice={setMessage}/>}
    {dialogVisible && dialog.kind === 'share' && <SharePlaylist key={dialog.playlistId} {...{runtime, controller, state}} onClose={closeDialog}/>}
    {dialogVisible && dialog.kind === 'settings' && <PlaylistSettings key={`${state.scopeKey}:${dialog.playlistId}`} {...{runtime, controller, state}}
      providers={integrationProviders} onClose={closeDialog}/>}
  </div>;
}
