import React, {useId, useLayoutEffect, useMemo, useRef, useState} from 'react';
import {Button, NativeHtml, Tabs} from '../home-friends/components.jsx';
import {detailDuration} from '../home-friends/detail-projection.jsx';
import {PlaylistSelectionPanel} from './selection.jsx';
import {canSubmitCreation, projectCreationState} from './creation.mjs';

const selectable = entry => entry.source_readable === true && entry.entry_ref !== null
  && entry.allowed_actions.can_select === true;
const needsReview = entry => entry.source_readable === true && (entry.availability === 'unresolved'
  || entry.metadata_state !== 'current' || entry.canonical_track_ref === null || entry.parent_album.state !== 'known');
const known = value => typeof value === 'string' && value.trim() ? value : 'Unknown';

// This adapter supplies only readable display facts to the existing information
// panel. Source occurrence keys never become persisted Playlist item identities.
export function creationReviewRow(entry, source) {
  if (entry?.source_readable !== true) return null;
  const parent = entry.parent_album;
  return {row_key: entry.row_key, source_readable: true, title: entry.title, artist: entry.artist,
    album_title: entry.album_title, track_number: entry.track_number, disc_number: entry.disc_number,
    duration_seconds: entry.duration_seconds, artwork_url: entry.artwork_url,
    metadata_state: entry.metadata_state, availability: entry.availability,
    source_kind: source?.kind, source_label: source?.kind === 'library' ? 'Library source' : 'Playlist source',
    album_ref: parent?.state === 'known' ? parent.album_ref : null,
    allowed_actions: {can_read: true, can_view_details: Boolean(parent?.allowed_actions
      && Object.hasOwn(parent.allowed_actions, 'can_view_details') && parent.allowed_actions.can_view_details === true)}};
}

function groupLabel(group) {
  const parent = group.parent_album;
  const identity = [parent?.artist || '', parent?.title || 'Unknown album', parent?.year ?? ''].filter(value => value !== '').join(' · ');
  return identity + (parent?.state === 'known' && group.completeness === 'incomplete' ? ' · Incomplete' : '');
}

export function creationResultsHtml(runtime, {id, projection, selectedKeys, disabled}) {
  const escape = runtime.escapeHtml, selected = new Set(selectedKeys);
  return projection.groups.map((group, groupIndex) => {
    const label = groupLabel(group);
    const table = runtime.tableHtml({id: `${id}-group-${groupIndex}`, ariaLabel: label, density: 'compact',
      frame: 'outline', overflow: 'none', mobile: 'preserve', headers: groupIndex === 0 ? 'visible' : 'screen-reader',
      columns: '30px 32px minmax(0,1fr) minmax(48px,auto)',
      columnsConfig: [{key: 'selection', label: 'Select', header: 'screen-reader'}, {key: 'number', label: '#'},
        {key: 'title', label: 'Track'}, {key: 'duration', label: 'Length', action: true}],
      rows: group.entries.map(entry => {
        const readable = entry.source_readable === true, title = readable ? known(entry.title) : 'Unavailable track';
        const duration = entry.duration_seconds === null ? '—' : detailDuration(entry.duration_seconds);
        const native = runtime.albumTrackRow({title, secondary_artist: readable ? entry.artist : '', duration_display: duration,
          availability: readable ? entry.availability : null}, 0);
        const artwork = runtime.artboxHtml({state: readable && entry.artwork_url ? 'ready' : 'empty', label: `${title} artwork`,
          coverHtml: readable && entry.artwork_url ? `<img src="${escape(entry.artwork_url)}" alt="" loading="lazy" decoding="async">` : ''});
        const review = needsReview(entry) ? runtime.buttonHtml({label: 'Review', size: 'small', disabled,
          attributes: {'data-creation-review': entry.row_key, 'aria-label': `Review ${title}`}}) : '';
        const note = readable && entry.availability !== 'local'
          ? `<span class="album-track-table__secondary">${entry.availability === 'missing' ? 'Confirmed missing' : 'Availability unresolved'}</span>` : '';
        return {key: entry.row_key, className: native.className, ariaSelected: selected.has(entry.row_key),
          dataAttributes: {'creation-row-key': entry.row_key}, cells: {
            selection: {content: `<input type="checkbox" data-creation-pick="${escape(entry.row_key)}" aria-label="Select ${escape(title)}"${selected.has(entry.row_key) ? ' checked' : ''}${disabled || !selectable(entry) ? ' disabled' : ''}>`},
            // Native numbered play cells assume an album position. A source may
            // have neither, so the read-only picker keeps that fact unknown.
            number: {content: escape(readable && entry.track_number !== null ? entry.track_number : '—')},
            title: {content: `<div class="playlists-creation__identity"><div class="home-detail__release">${artwork}<div>${native.cells.title.content}${note}</div></div>${review}</div>`},
            duration: native.cells.duration,
          }};
      })});
    return `<section class="album-track-table__disc"><h3 class="album-track-table__disc-heading">${escape(label)}</h3>${table}</section>`;
  }).join('');
}

export function CreationSearch({runtime, id, value, disabled, onChange}) {
  const root = useRef(null);
  const initial = useRef(null);
  if (initial.current === null) initial.current = runtime.searchHtml({id, value, disabled,
    label: 'Search tracks, albums or artists', placeholder: 'Search tracks, albums or artists'});
  useLayoutEffect(() => {
    const host = root.current, input = host.querySelector('input[type="search"]');
    if (!input) return;
    if (input.value !== value) input.value = value;
    for (const control of [input, ...host.querySelectorAll('button')]) {
      control.disabled = disabled;
      if (disabled) control.setAttribute('aria-disabled', 'true');
      else control.removeAttribute('aria-disabled');
    }
    const clear = host.querySelector('[data-search-clear]');
    if (clear) clear.hidden = !value || disabled;
  }, [value, disabled]);
  return <div ref={root} className="playlists-creation__search" dangerouslySetInnerHTML={{__html: initial.current}}
    onInput={event => {if (!disabled && event.target.matches('input[type="search"]')) onChange(event.target.value);}}
    onKeyDown={event => {
      if (event.key === 'Enter' && event.target.matches('input[type="search"]')) {event.preventDefault(); event.stopPropagation();}
    }} onClick={event => {
      // Clear belongs to the shared SearchInput owner and emits bubbling input.
      const submit = event.target.closest('[data-search-submit]');
      if (!submit) return;
      event.preventDefault();
      if (!disabled) root.current.querySelector('input[type="search"]')?.focus({preventScroll: true});
    }}/>;
}

export function CreationResults({runtime, id, state, projection, disabled, controller}) {
  const root = useRef(null);
  const html = useMemo(() => creationResultsHtml(runtime, {id, projection, selectedKeys: state.selectedKeys, disabled}),
    [runtime, id, projection, state.selectedKeys, disabled]);
  const initial = useRef(html);
  useLayoutEffect(() => {
    const host = root.current, document = host.ownerDocument, focused = host.contains(document.activeElement) ? document.activeElement : null;
    const attribute = focused?.hasAttribute('data-creation-review') ? 'data-creation-review' : 'data-creation-pick';
    const key = focused?.getAttribute(attribute), priorRows = [...host.querySelectorAll('[data-creation-row-key]')];
    const index = priorRows.findIndex(row => row.dataset.creationRowKey === key);
    if (host.innerHTML !== html) host.innerHTML = html;
    if (!key || document.activeElement?.isConnected && document.activeElement !== document.body) return;
    const rows = [...host.querySelectorAll('[data-creation-row-key]')], row = rows.find(item => item.dataset.creationRowKey === key);
    const same = row?.querySelector(`[${attribute}]`);
    const fallback = rows[Math.min(Math.max(index, 0), rows.length - 1)]?.querySelector('[data-creation-pick]');
    const target = same && !same.disabled ? same : fallback && !fallback.disabled ? fallback
      : host.closest('form')?.querySelector('[role="tab"][aria-selected="true"]');
    target?.focus({preventScroll: true});
  }, [html]);
  return <div ref={root} className="album-track-table playlists-creation__results" dangerouslySetInnerHTML={{__html: initial.current}}
    onChange={event => {
      const input = event.target.closest('[data-creation-pick]');
      if (input && !input.disabled && !disabled) controller.toggle(input.dataset.creationPick);
    }} onClick={event => {
      const button = event.target.closest('[data-creation-review]');
      if (button) {if (!button.disabled && !disabled) controller.review(button.dataset.creationReview); return;}
      if (disabled || event.target.closest('button,a,input,select,textarea')) return;
      const row = event.target.closest('[data-creation-row-key]');
      if (row) controller.toggle(row.dataset.creationRowKey);
    }}/>;
}

function SourceStatus({runtime, value, reload, disabled}) {
  if (value.status === 'ready') return null;
  const message = {
    loading: 'Loading tracks…', denied: 'You no longer have permission to use this source.',
    unavailable: 'Playlist creation is not available for this source yet.', error: 'The source tracks could not be loaded.',
    conflict: 'This source changed. Reload its tracks and choose your selection again.',
    refresh_required: 'Source access was refreshed. Reload its tracks and choose your selection again.',
    incomplete: 'The source is incomplete. All tracks must be available before creating a playlist.',
  }[value.status] || 'The source tracks are unavailable.';
  const retry = ['error', 'conflict', 'incomplete', 'refresh_required'].includes(value.status);
  return <div aria-busy={value.status === 'loading'}>
    <NativeHtml html={runtime.alertHtml({severity: retry ? 'error' : 'info', role: retry ? 'alert' : 'status', message})}/>
    {retry && <Button runtime={runtime} disabled={disabled} onClick={reload}>Reload tracks</Button>}
  </div>;
}

function CreationMutationStatus({runtime, mode, mutation, completing, completionError, submitError}) {
  if (mode === 'missing') {
    if (!completing && !submitError) return null;
    return <NativeHtml html={runtime.alertHtml({severity: submitError ? 'error' : 'info', role: submitError ? 'alert' : 'status',
      message: submitError ? 'The unsaved playlist could not be opened. Your selection has not been saved.' : 'Opening unsaved playlist…'})}/>;
  }
  if (mutation.status === 'idle' && !submitError) return null;
  const message = mutation.status === 'ready'
    ? completionError ? 'Playlist created, but the playlist list could not be refreshed.'
      : completing ? 'Playlist created. Refreshing playlists…' : 'Playlist created.'
    : {loading: 'Creating playlist…', denied: 'You do not have permission to create this playlist.',
      unavailable: 'Playlist creation is not available from this provider.', conflict: 'This source changed. Creation was not confirmed.',
      error: 'Creation was not confirmed. Check your playlists before starting another attempt.'}[mutation.status]
      || 'Creation was not confirmed. Check your playlists before starting another attempt.';
  const error = completionError || submitError || ['denied', 'conflict', 'error'].includes(mutation.status);
  return <NativeHtml html={runtime.alertHtml({severity: error ? 'error' : 'info', role: error ? 'alert' : 'status', message})}/>;
}

// NativeDialog and its parent retain form lifetime, dirty dismissal, mobile
// navigation, provider replacement and authoritative post-create refresh.
export function CreationForm({runtime, controller, state, onCreated, onPrepareDraft, onDismiss, readDetail}) {
  const id = `playlist-creation-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const form = useRef(null), selectAll = useRef(null), reviewHost = useRef(null), previousReview = useRef(null);
  const mounted = useRef(true), pending = useRef(false);
  const [completing, setCompleting] = useState(false), [completionError, setCompletionError] = useState(false), [submitError, setSubmitError] = useState(false);
  const projection = useMemo(() => projectCreationState(state), [state]);
  const ready = state.sourceResource.status === 'ready', busy = state.mutation.status === 'loading' || completing;
  const locked = busy || state.mutation.request_key !== null;
  const eligibleCount = projection.entries.filter(selectable).length;
  const mixed = projection.visibleSelectedCount > 0 && projection.visibleSelectedCount < eligibleCount;
  const reviewEntry = ready ? state.sourceResource.data.entries.find(entry => entry.row_key === state.reviewKey && entry.source_readable === true) : null;
  const reviewRow = creationReviewRow(reviewEntry, state.source);
  useLayoutEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  useLayoutEffect(() => {if (selectAll.current) selectAll.current.indeterminate = mixed;}, [mixed]);
  useLayoutEffect(() => {
    const oldKey = previousReview.current;
    previousReview.current = reviewRow?.row_key || null;
    if (reviewRow && reviewRow.row_key !== oldKey) {reviewHost.current?.querySelector('button')?.focus({preventScroll: true}); return;}
    if (!oldKey || reviewRow || !form.current) return;
    const document = form.current.ownerDocument;
    if (document.activeElement && document.activeElement !== document.body && document.activeElement.isConnected) return;
    const row = [...form.current.querySelectorAll('[data-creation-row-key]')].find(item => item.dataset.creationRowKey === oldKey);
    const target = row?.querySelector('[data-creation-review]');
    if (target && !target.disabled) target.focus({preventScroll: true});
  }, [reviewRow?.row_key]);
  const submit = async event => {
    event.preventDefault();
    if (pending.current || !canSubmitCreation(controller.getSnapshot())
      || controller.getSnapshot().mode === 'missing' && typeof onPrepareDraft !== 'function') return;
    pending.current = true; setSubmitError(false); setCompletionError(false);
    try {
      if (controller.getSnapshot().mode === 'missing') {
        const prepared = controller.prepareDraft();
        if (!prepared || !mounted.current || typeof onPrepareDraft !== 'function') return;
        setCompleting(true);
        if (await onPrepareDraft(prepared) !== true && mounted.current) setSubmitError(true);
        return;
      }
      const result = await controller.submit();
      const current = controller.getSnapshot();
      if (!result || !mounted.current || current.mutation.status !== 'ready'
        || ['scopeKey', 'request_key', 'playlist_id', 'revision'].some(key => current.mutation.data?.[key] !== result[key])) return;
      setCompleting(true);
      try {await onCreated?.(result);} catch (_error) {if (mounted.current) setCompletionError(true);}
    } catch (_error) {if (mounted.current) setSubmitError(true);}
    finally {pending.current = false; if (mounted.current) setCompleting(false);}
  };
  return <form ref={form} className="playlists__form playlists-creation" aria-label="Create playlist" aria-busy={busy} onSubmit={submit}>
    <div className="playlists__metadata tag-editor-form playlists-creation__metadata">
      <label>Name<input autoFocus required aria-label="Playlist name" value={state.title} maxLength={100}
        disabled={locked || !state.canCreate} onChange={event => controller.edit({title: event.target.value})}/></label>
      <label>Description<textarea aria-label="Playlist description" rows={2} value={state.description} maxLength={1000}
        disabled={locked || !state.canCreate} onChange={event => controller.edit({description: event.target.value})}/></label>
    </div>
    <CreationSearch runtime={runtime} id={`${id}-search`} value={state.query} disabled={locked || !ready} onChange={query => controller.setQuery(query)}/>
    {state.mutation.status !== 'ready' && <SourceStatus runtime={runtime} value={state.sourceResource} disabled={locked} reload={() => controller.load()}/>}
    {ready && <>
      <fieldset className="playlists-creation__toolbar" disabled={locked}>
        <legend className="sr-only">Playlist track selection</legend>
        <Tabs runtime={runtime} id={`${id}-tabs`} label="Playlist tracks" items={[['all', 'All'], ['selected', `Selected (${projection.selectedCount})`]]}
          value={state.tab} onChange={tab => {if (!locked) controller.setTab(tab);}}/>
        <label className="playlists-creation__select-visible"><input ref={selectAll} type="checkbox" aria-label="Select visible tracks"
          aria-checked={mixed ? 'mixed' : projection.visibleSelectedCount > 0} checked={eligibleCount > 0 && projection.visibleSelectedCount === eligibleCount}
          disabled={locked || !eligibleCount} onChange={event => controller.selectVisible(event.target.checked)}/><span>Select visible</span></label>
      </fieldset>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{projection.selectedCount} tracks selected</span>
      <div role="tabpanel" aria-labelledby={`${id}-tabs-${state.tab}`}>
        <CreationResults {...{runtime, id, state, projection, controller}} disabled={locked}/>
        {!projection.entries.length && <p className="playlists__note" role="status">{state.tab === 'selected' ? 'No tracks selected.'
          : state.query.trim() ? 'No matching tracks.' : 'No tracks are available in this source.'}</p>}
      </div>
    </>}
    {reviewRow && <div ref={reviewHost} className="playlists-creation__review">
      <PlaylistSelectionPanel runtime={runtime} scopeKey={state.scopeKey} row={reviewRow} readDetail={readDetail} onClose={() => controller.review(null)}/>
    </div>}
    <CreationMutationStatus {...{runtime, completing, completionError, submitError}} mode={state.mode} mutation={state.mutation}/>
    <div className="playlists__actions">
      <Button runtime={runtime} type="submit" disabled={busy || !canSubmitCreation(state)
        || state.mode === 'missing' && typeof onPrepareDraft !== 'function'}>Create playlist</Button>
      <Button runtime={runtime} disabled={busy} onClick={() => onDismiss?.({reason: state.mutation.status !== 'ready' && state.dirty ? 'discard' : 'cancel'})}>
        {state.mutation.status === 'ready' ? 'Close' : state.dirty ? 'Discard' : 'Cancel'}
      </Button>
    </div>
  </form>;
}
