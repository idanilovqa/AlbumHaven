import React, {useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore} from 'react';
import {Button, NativeHtml, Tabs} from '../home-friends/components.jsx';
import {NativeDialog} from '../home-friends/native-dialog.jsx';
import {CreationSearch} from '../playlists/creation.jsx';
import {mountCollectionReorder} from '../playlists/reorder.mjs';
import {albumTopActionAllowed} from './model.mjs';
import {createAlbumTopDraft} from './draft.mjs';
import {MutationNotice, albumTopDraftErrorMessage} from './mutation-notice.jsx';

function PickerCard({runtime, row, selected, disabled, onSelect}) {
  const host = useRef(null);
  const html = runtime.galleryCardHtml({identity: selected ? row.album_ref : String(row.local_album_id),
    actionRef: String(row.local_album_id || row.album_ref), interaction: selected ? 'none' : 'controlled',
    actions: {select: !selected}, title: row.title, artist: row.artist, year: row.year, displayMode: 'cards',
    artboxHtml: runtime.artboxHtml({state: 'empty', label: `${row.title} artwork`})});
  const markup = useRef({__html: html});
  useLayoutEffect(() => {
    if (markup.current.__html !== html) {host.current.innerHTML = html; markup.current.__html = html;}
    const button = host.current.querySelector('[data-gallery-card-intent="select"]');
    if (button) {button.disabled = disabled; button.setAttribute('aria-disabled', String(disabled));}
  }, [html, disabled]);
  return <div ref={host} dangerouslySetInnerHTML={markup.current} onClick={event => {
    if (!disabled && event.target.closest('[data-gallery-card-intent="select"]')) onSelect(event);
  }}/>;
}

export function AlbumPicker({runtime, draft, value, disabled}) {
  const id = `album-top-picker-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const host = useRef(null), picker = useRef(null), gesture = useRef(null), source = useRef({}), latest = useRef(null), pendingFocus = useRef(null);
  const [announcement, announce] = useState('');
  latest.current = {disabled, value};
  useLayoutEffect(() => {
    gesture.current = mountCollectionReorder(host.current, {
      rowSelector: '[data-album-draft-key]', handleSelector: '[data-album-draft-move]', rowKeyAttribute: 'data-album-draft-key', layout: 'grid',
      collectionKey: () => value.topRef || 'new-album-top', itemKey: row => row.album_ref,
      snapshot: () => {
        const current = draft.getSnapshot();
        return {scopeKey: current.scopeKey, source: source.current, selectedRowKey: null,
          rows: current.items.map(row => ({...row, row_key: row.album_ref})), itemsComplete: true,
          canEdit: !latest.current.disabled, canReorder: !latest.current.disabled && current.tab === 'selected',
          unfiltered: true, defaultOrder: true, busy: current.busy};
      }, onReorder: refs => draft.reorder(refs), onAnnounce: announce,
    });
    return () => {gesture.current?.dispose(); gesture.current = null;};
  }, [draft]);
  useLayoutEffect(() => {gesture.current?.update();}, [value, disabled]);
  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    if (!pending || value.busy) return;
    pendingFocus.current = null;
    const document = host.current.ownerDocument, active = document.activeElement;
    if (disabled || active && active !== document.body && active !== pending.from) return;
    const controls = [...host.current.querySelectorAll(pending.selector)].filter(node => !node.disabled);
    const target = pending.from.isConnected && !pending.from.disabled ? pending.from
      : controls[Math.min(pending.index, controls.length - 1)] || picker.current.querySelector('[role="tab"][aria-selected="true"]');
    target?.focus({preventScroll: true});
  }, [value, disabled]);
  const rememberFocus = (event, selector) => {
    const button = event.target.closest('button'), document = host.current.ownerDocument;
    if (document.activeElement !== button) return;
    pendingFocus.current = {from: button, selector, index: [...host.current.querySelectorAll(selector)].indexOf(button)};
  };
  const selected = value.tab === 'selected', albums = selected ? value.items : value.search.items;
  const atCapacity = value.items.length >= 5000;
  return <section ref={picker} className="album-top-builder__picker" aria-label="Choose albums">
    <CreationSearch runtime={runtime} id={`${id}-search`} value={value.query} disabled={disabled} maxLength={100}
      label="Search albums" placeholder="Search albums or artists" onChange={query => draft.setQuery(query)}/>
    <Tabs runtime={runtime} id={`${id}-tabs`} label="Album selection" items={[[ 'all', 'All' ], ['selected', `Selected (${value.items.length})`]]}
      value={value.tab} onChange={tab => draft.setTab(tab)}/>
    <span className="sr-only" role="status" aria-live="polite">{announcement || `${value.items.length} albums selected`}</span>
    {atCapacity && <p className="playlists__note" role="status">The 5,000-album limit is reached. Remove an album before adding another.</p>}
    <div className="album-top-builder__scroll gallery-scrollbar" role="tabpanel" aria-labelledby={`${id}-tabs-${value.tab}`}>
      <div ref={host} className="home-activity__cards album-top-builder__cards playlists__tracks">
        {albums.map(row => <div key={selected ? row.album_ref : row.local_album_id}
          {...(selected ? {'data-album-draft-key': row.album_ref} : {})}>
          <PickerCard runtime={runtime} row={row} selected={selected} disabled={disabled || !selected && atCapacity} onSelect={event => {
            rememberFocus(event, '[data-gallery-card-intent="select"]'); draft.select(row);
          }}/>
          {selected && <div className="playlists__actions">
            <Button runtime={runtime} size="small" disabled={disabled} attributes={{'data-album-draft-move': '', 'aria-label': `Reorder ${row.title}`}}>Move</Button>
            <Button runtime={runtime} size="small" disabled={disabled} ariaLabel={`Remove ${row.title}`} attributes={{'data-album-draft-remove': ''}}
              onClick={event => {rememberFocus(event, '[data-album-draft-remove]'); draft.remove(row.album_ref);}}>Remove</Button>
          </div>}
        </div>)}
      </div>
      {!albums.length && <p className="playlists__note" role="status">{selected ? 'No albums selected.' : value.search.status === 'loading'
        ? 'Searching albums…' : value.query.trim() ? 'No matching albums on this page.' : 'Type an album or artist to search.'}</p>}
      {!selected && value.search.status === 'error' && <Button runtime={runtime} disabled={disabled} onClick={() => draft.setQuery(value.query)}>Retry search</Button>}
      {!selected && value.search.next_cursor && <Button runtime={runtime} disabled={disabled || value.search.status === 'loading'} onClick={() => draft.loadMore()}>Load more albums</Button>}
    </div>
  </section>;
}

function useTopDraft(controller, providers) {
  const [draft] = useState(() => createAlbumTopDraft({controller, providers}));
  const value = useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot);
  useEffect(() => () => draft.dispose(), [draft]);
  return [draft, value];
}
function draftAccess(state, value, existing) {
  const busy = value.busy || state.mutation.refreshing === true || ['loading', 'uncertain'].includes(state.mutation.status);
  const allowed = albumTopActionAllowed(state, existing ? 'save' : 'create', existing?.top_ref);
  const stale = value.stale || Boolean(existing && (state.detail.data?.top_ref !== existing.top_ref || state.detail.data?.revision !== existing.revision));
  const membershipAllowed = !existing || Boolean(existing.edit_draft) && state.detail.data?.allowed_actions?.['library.album_tops.items.manage'] === true
    && ['add', 'remove', 'reorder'].every(name => albumTopActionAllowed(state, name, existing.top_ref));
  return {busy, stale, disabled: busy || stale || value.denied || !allowed, membershipAllowed};
}
const pickerAvailable = (runtime, providers) => typeof providers.searchAlbums === 'function' && typeof providers.admitAlbum === 'function'
  && typeof runtime.searchHtml === 'function' && typeof runtime.tabsHtml === 'function' && typeof runtime.mountTabs === 'function';
function metadataFields(value, disabled, draft, inline = false) {
  return <div className="album-top-builder__identity tag-editor-form">
    <label>{!inline && <span>Name</span>}<input name="top-name" aria-label="Album Top name" autoFocus={inline} value={value.title}
      onChange={event => draft.edit({title: event.target.value})} maxLength={100} required disabled={disabled}/></label>
    <label>{!inline && <span>Subtitle</span>}<input name="top-subtitle" aria-label="Album Top subtitle" value={value.description}
      onChange={event => draft.edit({description: event.target.value})} maxLength={200} disabled={disabled}/></label>
  </div>;
}

// Keep NativeDialog's existing close/confirmation and acknowledged-return owner.
export function TopFields({runtime, controller, state, providers = {}, existing = null, onClose, onFormSaved, returnFocus}) {
  const [draft, value] = useTopDraft(controller, providers);
  const [expanded, setExpanded] = useState(Boolean(existing?.items?.length));
  const [closeError, setCloseError] = useState(false);
  const action = existing ? 'save' : 'create';
  const initialMutation = useRef(state.mutation), nativeClose = useRef(null), closedRequest = useRef(null);
  useEffect(() => {
    if (state.mutation !== initialMutation.current && state.mutation.status === 'ready' && state.mutation.action === action
      && closedRequest.current !== state.mutation.command?.request_key && nativeClose.current) {
      closedRequest.current = state.mutation.command?.request_key;
      Promise.resolve(nativeClose.current({force: true, restoreFocus: true})).then(closed => {
        if (closed !== false) onFormSaved?.(state.mutation.data);
        else setCloseError(true);
      }).catch(() => setCloseError(true));
    }
  }, [state.mutation, action, onFormSaved]);
  const {busy, stale, disabled, membershipAllowed} = draftAccess(state, value, existing);
  const hasPicker = pickerAvailable(runtime, providers);
  return <NativeDialog runtime={runtime} title={existing ? 'Edit Album Top' : 'Create Album Top'} pageId={existing ? 'album-top-edit' : 'album-top-create'}
    returnFocus={returnFocus} showCloseButton dismissDisabled={busy} beforeDismiss={() => busy ? false : draft.getSnapshot().dirty
      ? runtime.confirm('Discard these unsaved Album Top changes?', {title: 'Discard Album Top changes', acceptLabel: 'Discard', danger: true}) : true} onClose={onClose}>
    {close => {nativeClose.current = close; return <form className="playlists__form tag-editor-form album-top-builder" aria-label={existing ? 'Edit Album Top' : 'Create Album Top'} aria-busy={busy} onSubmit={async event => {
      event.preventDefault();
      if (!disabled) await draft.submit();
    }}>
      {metadataFields(value, disabled, draft)}
      {hasPicker && membershipAllowed && <Button runtime={runtime} disabled={disabled} selected={expanded} onClick={() => setExpanded(!expanded)}>Find albums</Button>}
      {expanded && hasPicker && membershipAllowed && <AlbumPicker runtime={runtime} draft={draft} value={value} disabled={disabled}/>}
      {!hasPicker && <p className="playlists__note">Album selection is unavailable from this provider.</p>}
      {value.error && <NativeHtml html={runtime.alertHtml({severity: 'error', role: 'alert', message: albumTopDraftErrorMessage(value.error) || value.error.message || 'These changes could not be prepared. Your draft is preserved.'})}/>}
      <MutationNotice runtime={runtime} controller={controller} value={state.mutation}/>
      {closeError && <NativeHtml html={runtime.alertHtml({severity: 'error', message: 'The Top was saved, but this form could not return to its parent. Close it to continue.'})}/>}
      {stale && <NativeHtml html={runtime.alertHtml({severity: 'info', message: 'This Top changed. Your draft is preserved; close and reopen it to review the current values.'})}/>}
      <footer className="playlists__actions"><Button runtime={runtime} disabled={busy} onClick={() => close()}>Cancel</Button>
        <Button runtime={runtime} type="submit" variant="primary" disabled={disabled || !value.title.trim() || Boolean(existing && !value.dirty)}>{existing ? 'Save' : 'Create Album Top'}</Button></footer>
    </form>;}}
  </NativeDialog>;
}
export {TopFields as AlbumTopBuilder};

// The existing AlbumTopsView supplies its own canonical header markup. This
// consumer supplies a volatile identity/actions slot and the same album picker.
export function InlineAlbumTopEdit({runtime, controller, state, providers = {}, existing, onClose, onRestoreFocus, renderHeader}) {
  const [draft, value] = useTopDraft(controller, providers), initialMutation = useRef(state.mutation);
  const form = useRef(null), releaseOwner = useRef(null), focused = useRef(false), latestClose = useRef(onClose);
  latestClose.current = onClose;
  const [guardReady, setGuardReady] = useState(false), [guardUnavailable, setGuardUnavailable] = useState(false);
  const access = draftAccess(state, value, existing), {busy, stale, membershipAllowed} = access;
  const disabled = access.disabled || !guardReady;
  const acknowledgedSave = current => {
    const mutation = current.mutation;
    return mutation !== initialMutation.current && mutation.status === 'ready' && mutation.action === 'save'
      && mutation.command?.top_ref === existing.top_ref && mutation.command.revision === existing.revision
      && mutation.data?.top_ref === existing.top_ref && mutation.data.request_key === mutation.command.request_key;
  };
  const saved = acknowledgedSave(state);
  useLayoutEffect(() => {
    const isCurrent = () => {
      const snapshot = draft.getSnapshot(), current = controller.getSnapshot();
      if (snapshot.denied || current.scopeKey !== snapshot.scopeKey || current.selectedTopRef !== existing.top_ref
        || current.directory.status === 'denied' || current.detail.status === 'denied') return false;
      const saved = acknowledgedSave(current);
      // An acknowledged Save owns its pending authoritative refresh, not new
      // edit authority. Controls/departures stay blocked until it settles.
      if (saved && current.mutation.refreshing === true && current.detail.status === 'loading') return true;
      return albumTopActionAllowed(current, 'save', existing.top_ref) && (saved
        ? current.detail.data?.revision === current.mutation.data.revision
        : !snapshot.stale && current.detail.data?.revision === existing.revision);
    };
    const canLeave = () => isCurrent() && !draft.getSnapshot().busy && controller.getSnapshot().mutation.refreshing !== true
      && !['loading', 'uncertain'].includes(controller.getSnapshot().mutation.status);
    const release = typeof runtime.deferDraftNavigation === 'function' && runtime.registerDraftNavigation?.({isCurrent,
      confirmLeave: async confirm => {
        if (!canLeave()) return false;
        if (!draft.getSnapshot().dirty) return true;
        return await confirm('Discard these unsaved Album Top changes?',
          {title: 'Discard Album Top changes', acceptLabel: 'Discard', danger: true}) === true && canLeave();
      },
      onDiscard: () => {draft.dispose(); latestClose.current();}});
    if (typeof release !== 'function') {setGuardUnavailable(true); return;}
    releaseOwner.current = release; setGuardReady(true);
    return () => {release(); if (releaseOwner.current === release) releaseOwner.current = null;};
  }, [runtime, controller, draft, existing.top_ref, existing.revision]);
  useLayoutEffect(() => {
    if (stale && !saved || value.denied) {releaseOwner.current?.(); releaseOwner.current = null; setGuardReady(false);}
    else if (guardReady && !focused.current) {
      focused.current = true; form.current?.querySelector('[name="top-name"]')?.focus({preventScroll: true});
    }
  }, [stale, saved, value.denied, guardReady]);
  useEffect(() => {
    if (value.denied || state.scopeKey !== value.scopeKey || state.selectedTopRef !== existing.top_ref) {onClose(); return;}
    if (saved && !state.mutation.refreshing) onClose({restoreFocus: true});
  }, [state, saved, value.denied, existing.top_ref, onClose]);
  const cancel = async ({restoreFocus = true} = {}) => {
    if (busy) return false;
    if (!guardReady) {onClose({restoreFocus}); return true;}
    return await runtime.deferDraftNavigation(() => {
      if (restoreFocus) onRestoreFocus?.();
      return true;
    }) === true;
  };
  return <form ref={form} className="album-top-inline-edit album-top-builder" aria-label="Edit Album Top" aria-busy={busy}
    onSubmit={event => {event.preventDefault(); if (!disabled) draft.submit();}}>
    {renderHeader({fields: metadataFields(value, disabled, draft, true), busy, cancel,
      actions: <><Button runtime={runtime} type="submit" variant="primary" disabled={disabled || !value.dirty || !value.title.trim()}>Save</Button>
        <Button runtime={runtime} disabled={busy} onClick={() => cancel()}>Cancel</Button></>})}
    <div className="album-top-inline-edit__content">
      {guardUnavailable && <NativeHtml html={runtime.alertHtml({severity: 'error', role: 'alert', message: 'Editing is unavailable because navigation protection could not be started. Cancel and reopen this Top.'})}/>}
      {pickerAvailable(runtime, providers) && membershipAllowed
        ? <AlbumPicker runtime={runtime} draft={draft} value={value} disabled={disabled}/>
        : <p className="playlists__note">Album membership is unavailable for editing. Your existing selection is preserved.</p>}
      {value.error && <NativeHtml html={runtime.alertHtml({severity: 'error', role: 'alert', message: albumTopDraftErrorMessage(value.error) || value.error.message || 'Your draft is preserved.'})}/>}
      {stale && !saved && <NativeHtml html={runtime.alertHtml({severity: 'info', message: 'This Top changed. Your draft is preserved; cancel and reopen it to review the current values.'})}/>}
      <MutationNotice runtime={runtime} controller={controller} value={state.mutation}/>
    </div>
  </form>;
}
