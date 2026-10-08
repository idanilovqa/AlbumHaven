import React, {useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore} from 'react';
import {Button, NativeHtml, Status} from '../home-friends/components.jsx';
import {NativeChoice} from '../home-friends/native-choice.jsx';
import {NativeDialog} from '../home-friends/native-dialog.jsx';
import {readTrackPreference} from '../home-friends/track-preference.mjs';
import {PlaylistGroupedDirectory, PlaylistFilterControls} from './directory-filters.jsx';
import {PlaylistSelectionPanel} from './selection.jsx';
import {PlaylistCreationSession} from './creation-session.jsx';
import {canOpenPlaylistCreation, playlistCreationContext} from './creation-session.mjs';
import {inspectMissingPlaylist} from './missing-inspection.mjs';
import {hasConfirmedMissingRows} from './missing-source.mjs';
import {PlaylistTracks, restorePlaylistSelectionFocus} from './track-table.jsx';
export {playlistTableHtml, playlistReorderSnapshot, paintPlaylistCurrent, restorePlaylistSelectionFocus} from './track-table.jsx';
import {createPlaylistIntegrations} from './integrations.mjs';
import {PlaylistPlaybackControls, PlaylistMatchReview} from './integrations.jsx';
import {playlistDialogVisible, playlistSharingCurrent, restorePlaylistDialogFocus} from './dialog-state.mjs';
import {defaultFilters, draftDirty, granted, hasPlaylistFilters, playlistText, playlistDraft, playlistFilters, validMetadata, visiblePlaylistRows} from './model.mjs';

const actionMessages = {loading: 'Saving…', ready: 'The server confirmed the change.', error: 'The change was not confirmed. Your draft is still here.',
  denied: 'You do not have permission to make this change.', unavailable: 'This action is not available on this server yet.'};
export function MutationStatus({runtime, value}) {
  if (value.status === 'idle') return null;
  return <NativeHtml html={runtime.alertHtml({severity: ['error', 'denied'].includes(value.status) ? 'error' : 'info',
    role: ['error', 'denied'].includes(value.status) ? 'alert' : 'status', message: actionMessages[value.status]})}/>;
}
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
      ['add', 'Add tracks', !actions.add, 'add'],
      ...(hasConfirmedMissingRows(detail?.track_rows) ? [['missing', 'Inspect missing tracks', !actions.missing, 'missing-playlist']] : []),
      ['top', 'Create Album Top', !actions.top, 'create-top'], ['export', 'Export TXT', !actions.export, 'download'], ['share', 'Share', !detail, 'share'],
      ['filters', 'Filters', !detail, 'filters'], ['save', 'Save', !actions.save, 'save'], ['discard', 'Discard unsaved changes', !draft, 'close'],
    ].map(([action, label, disabled, icon]) => runtime.actionHtml({icon, ariaLabel: label, presentation: 'bare', semantic: action === 'save' ? 'save' : 'default', disabled: busy || disabled,
        title: action === 'missing' && disabled ? 'Missing-track inspection is not available for this source yet.' : label,
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
  return <section id="playlists-filters" aria-label="Playlist filters">
    <div className="playlists__filters tag-editor-form">
      <label>Find tracks<input type="search" value={filters.query} maxLength={200} disabled={disabled} onChange={event => onChange({query: event.target.value})}/></label>
      <NativeChoice runtime={runtime} label="Availability" value={filters.availability} disabled={disabled}
        options={ [['all', 'All tracks'], ['local', 'Confirmed local'], ['missing', 'Confirmed missing'], ['unresolved', 'Needs review']] }
        onChange={availability => onChange({availability})}/>
    </div>
    <PlaylistFilterControls runtime={runtime} rows={rows} filters={filters} onChange={onChange} disabled={disabled}
      canReset={hasPlaylistFilters(filters)} onReset={() => onChange(defaultFilters)}/>
  </section>;
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
export function SharingFields({runtime, value, busy, onChange}) {
  return <div className="playlists__sharing">
    <label>Who can access this playlist?<select aria-label="Sharing mode" value={value.mode} disabled={busy || !value.can_manage} onChange={event => onChange({...value, mode: event.target.value})}>
      {['private', 'people', 'link'].map(mode => <option key={mode} value={mode} disabled={!value.allowed_modes.includes(mode)}>{{private: 'Only me', people: 'Selected people', link: 'Anyone with the link'}[mode]}</option>)}
    </select></label>
    {value.mode === 'people' && <fieldset disabled={busy || !value.can_manage}><legend>People</legend>{value.people.map(person => <div key={person.account_ref} className="playlists__share-person">
      <label><input type="checkbox" checked={person.selected} disabled={!person.can_edit} onChange={event => onChange({...value,
        people: value.people.map(row => row.account_ref === person.account_ref ? {...row, selected: event.target.checked} : row)})}/>{person.display_name || person.account_ref}</label>
      <label><span className="sr-only">{person.display_name} role</span><select value={person.role} disabled={!person.can_edit || !person.selected} onChange={event => onChange({...value,
        people: value.people.map(row => row.account_ref === person.account_ref ? {...row, role: event.target.value} : row)})}>
        <option value="viewer">Viewer</option><option value="editor">Editor</option>
      </select></label>
    </div>)}</fieldset>}
    <p className="playlists__note">Sharing changes require server confirmation. Personal ratings and listening progress are not shared here.</p>
  </div>;
}
export function playlistSharingRenderCurrent(subject, state) {
  return playlistSharingCurrent(subject, state) && (subject === state.resource.data?.detail
    || !state.resource.data?.detail && state.mutation.status === 'loading' && state.mutation.action === 'saveSharing');
}
function SharePlaylist({runtime, controller, state, onClose}) {
  const detail = state.resource.data?.detail, form = useRef(null);
  const [sharing, setSharing] = useState({subject: null, value: {status: 'loading', data: null}}), [draft, setDraft] = useState(null);
  const current = playlistSharingRenderCurrent(sharing.subject, state);
  useEffect(() => {
    if (!detail) return;
    const request = new AbortController(), subject = detail;
    setSharing({subject, value: {status: 'loading', data: null}}); setDraft(null);
    controller.readSharing({signal: request.signal}).then(value => {
      if (!request.signal.aborted && controller.getSnapshot().resource.data?.detail === subject) {setSharing({subject, value}); setDraft(value.data);}
    });
    return () => request.abort();
  }, [controller, detail, state.scopeKey]);
  const busy = state.mutation.status === 'loading';
  return <NativeDialog runtime={runtime} title="Share playlist" onClose={onClose}>{close =>
    <div ref={form} className="playlists__form tag-editor-form">
      <Status runtime={runtime} value={current ? sharing.value : {status: 'loading'}} label="Playlist sharing"/>
      {current && draft && <SharingFields runtime={runtime} value={draft} busy={busy} onChange={setDraft}/>}
      <MutationStatus runtime={runtime} value={state.mutation}/>
      <div className="playlists__actions"><Button runtime={runtime} disabled={busy || !current || !draft?.can_manage || !controller.available('saveSharing')}
        onClick={async () => {if (current && await controller.mutate('saveSharing', {mode: draft.mode, people: draft.people.filter(person => person.selected)}))
          close({restoreFocus: form.current?.contains(document.activeElement) === true});}}>Save sharing</Button>
        <Button runtime={runtime} disabled={busy} onClick={() => close()}>Close</Button></div>
    </div>}
  </NativeDialog>;
}
const EMPTY_PROVIDERS = Object.freeze({});
export function PlaylistsView({runtime, controller, state, onSelect, onPrepareDraft, integrationProviders = EMPTY_PROVIDERS, readDetail, navigationError = false}) {
  const [dialog, setDialog] = useState(null), [filtersOpen, setFiltersOpen] = useState(false), [message, setMessage] = useState('');
  const [inspectionBusy, setInspectionBusy] = useState(false), inspectionRequest = useRef(null), inspectionView = useRef(null);
  const [selection, setSelection] = useState(null), [picking, setPicking] = useState(false), [discarding, setDiscarding] = useState(false);
  const picker = useRef(null), page = useRef(null), pendingFocus = useRef(null), selectionFocus = useRef(null), discardRequest = useRef(null);
  const [integrations] = useState(() => createPlaylistIntegrations({providers: integrationProviders}));
  const integration = useSyncExternalStore(integrations.subscribe, integrations.getSnapshot, integrations.getSnapshot);
  const previousProviders = useRef(integrationProviders);
  const detail = state.resource.data?.detail, draft = detail && playlistDraft(state, detail.playlist_id);
  inspectionView.current = {controller, scopeKey: state.scopeKey, playlistId: state.selectedPlaylistId, detail, integrationProviders, onPrepareDraft};
  useLayoutEffect(() => {
    setInspectionBusy(false);
    return () => {inspectionRequest.current?.abort(); inspectionRequest.current = null;};
  }, [controller, state.scopeKey, state.selectedPlaylistId, detail, integrationProviders, onPrepareDraft]);
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
    if (kind === 'create' && !canOpenPlaylistCreation(controller.getSnapshot(), integrationProviders)) return;
    setDialog({kind, scopeKey: state.scopeKey, playlistId: state.selectedPlaylistId, sharingGranted: granted(detail, 'can_share'),
      source: kind === 'create' ? playlistCreationContext(state).source : null});
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
    setDialog(null); setMessage(''); setPicking(false); setDiscarding(false);
    return () => {picker.current?.abort(); picker.current = null; discardRequest.current = null;};
  }, [state.selectedPlaylistId, state.scopeKey]);
  const run = async action => {
    setMessage('');
    if (action === 'filters') setFiltersOpen(value => !value);
    if (action === 'share') openDialog('share');
    if (action === 'missing') {
      if (inspectionRequest.current || !hasConfirmedMissingRows(detail?.track_rows)) return;
      const request = new AbortController(), view = inspectionView.current;
      inspectionRequest.current = request; setInspectionBusy(true);
      const current = () => inspectionRequest.current === request && !request.signal.aborted && page.current?.isConnected
        && Object.keys(view).every(key => inspectionView.current?.[key] === view[key]);
      try {
        const result = await inspectMissingPlaylist({playlists: controller, providers: integrationProviders,
          signal: request.signal, isCurrent: current, onPrepareDraft});
        if (current() && !['ready', 'retired'].includes(result.status)) setMessage({empty: 'No confirmed missing tracks remain in this source.',
          denied: 'This missing-track source is no longer available to inspect.', unavailable: 'Missing-track inspection is not available for this source.',
          error: 'Missing tracks could not be loaded.'}[result.status] || 'Missing tracks could not be loaded.');
      } catch {if (current()) setMessage('Missing tracks could not be loaded.');}
      finally {if (inspectionRequest.current === request) {inspectionRequest.current = null; setInspectionBusy(false);}}
    }
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
    if (!canExport || controller.getSnapshot() !== state || missingOnly && !hasConfirmedMissingRows(exportRows)) return;
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
      canCreate={!busy && canOpenPlaylistCreation(state, integrationProviders)}/>
    <main className="playlists__content" aria-label="Playlist">
      <PlaylistHeader {...{runtime, detail, draft, filtersOpen}} busy={busy || discarding || inspectionBusy} actions={{add: !picking && controller.available('addTracks') && typeof runtime.pickTracks === 'function',
        missing: canOpenPlaylistCreation(state, integrationProviders, 'missing'), top: controller.available('createAlbumTop'),
        export: canExport && exportRows.some(row => row.source_readable !== false), save: canSave}} onAction={run}/>
      <div className="playlists__scroll gallery-scrollbar">
        {navigationError && <NativeHtml html={runtime.alertHtml({severity: 'error', role: 'alert', message: 'The playlist could not be opened. Your previous selection has been restored.'})}/>}
        <Status runtime={runtime} value={state.resource} label="Playlists" retry={() => controller.load()}/>
        {detail ? <>
          <MetadataFields {...{detail, draft, busy}} onChange={patch => controller.edit(patch)}/>
          {filtersOpen && <PlaylistFilters key={detail.playlist_id} runtime={runtime} filters={filters} rows={exportRows} disabled={busy} onChange={patch => controller.filter(patch)}/>}
          {currentIntegration && <PlaylistPlaybackControls runtime={runtime} controller={integrations} state={integration}/>}
          {!currentIntegration && integrationDenied && <Status runtime={runtime} value={{status: 'denied'}} label="Playlist integrations"/>}
          <div className="playlists__summary"><span>{rows.length} displayed tracks</span>
            <Button runtime={runtime} disabled={busy || !controller.available('createSamplePlaylist')} onClick={() => controller.mutate('createSamplePlaylist')}>Create sample playlist</Button>
            <Button runtime={runtime} disabled={!canExport || !hasConfirmedMissingRows(exportRows)} onClick={() => exportText(true)}>Missing-only TXT</Button>
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
          <p className="playlists__note">TXT uses playlist or draft order, regardless of filters. Missing-only exports confirmed missing tracks. Export does not save the draft.</p>
        </> : state.resource.status === 'ready' && <p>Select a playlist to see its tracks.</p>}
        {!dialogVisible && <MutationStatus runtime={runtime} value={state.mutation}/>}
        {message && <NativeHtml html={runtime.alertHtml({severity: 'info', role: 'status', message})}/>}
      </div>
    </main>
    {dialogVisible && dialog.kind === 'create' && <PlaylistCreationSession
      key={`${dialog.kind}:${dialog.scopeKey}:${dialog.playlistId || ''}`} {...{runtime, controller, state, readDetail}}
      providers={integrationProviders}
      onClose={closeDialog} onNavigate={onSelect} onNotice={setMessage}/>}
    {dialogVisible && dialog.kind === 'share' && <SharePlaylist key={dialog.playlistId} {...{runtime, controller, state}} onClose={closeDialog}/>}
  </div>;
}
