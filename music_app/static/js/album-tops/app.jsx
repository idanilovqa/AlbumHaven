import React, {useEffect, useRef, useState} from 'react';
import {Button, NativeHtml, Status} from '../home-friends/components.jsx';
import {NativeDialog} from '../home-friends/native-dialog.jsx';
import {MutationStatus} from '../playlists/mutation-status.jsx';
import {albumTopActionAllowed} from './model.mjs';
import {isManualProgress} from './progress.mjs';
import {ShareAlbumTop} from './sharing.jsx';

function MutationNotice({runtime, controller, value}) {
  if (!['error', 'denied', 'uncertain'].includes(value.status)) return null;
  const adapter = {getSnapshot: controller.getSnapshot, retryMutation: controller.retryMutation,
    canRetryMutation: controller.canRetryMutation};
  return <MutationStatus runtime={runtime} value={{...value, status: value.status === 'uncertain' ? 'error' : value.status}} controller={adapter}/>;
}
function TopFields({runtime, controller, state, existing = null, onClose, onFormSaved, returnFocus}) {
  const [title, setTitle] = useState(existing?.title || ''), [description, setDescription] = useState(existing?.description || '');
  const action = existing ? 'save' : 'create';
  const [closeError, setCloseError] = useState(false);
  const dirty = title !== (existing?.title || '') || description !== (existing?.description || '');
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
  const busy = state.mutation.refreshing === true || state.mutation.status === 'loading' || state.mutation.status === 'uncertain';
  const allowed = albumTopActionAllowed(state, action, existing?.top_ref);
  const stale = Boolean(existing && (state.detail.data?.top_ref !== existing.top_ref || state.detail.data?.revision !== existing.revision));
  return <NativeDialog runtime={runtime} title={existing ? 'Edit Album Top' : 'Create Album Top'} pageId={existing ? 'album-top-edit' : 'album-top-create'}
    returnFocus={returnFocus} showCloseButton dismissDisabled={busy} beforeDismiss={() => busy ? false : dirty
      ? runtime.confirm('Discard these unsaved Album Top changes?', {title: 'Discard Album Top changes', acceptLabel: 'Discard', danger: true}) : true} onClose={onClose}>
    {close => {nativeClose.current = close; return <form className="playlists__form tag-editor-form" aria-label={existing ? 'Edit Album Top' : 'Create Album Top'} aria-busy={busy} onSubmit={async event => {
      event.preventDefault();
      const current = controller.getSnapshot();
      if (!title.trim() || busy || stale || !albumTopActionAllowed(current, action, existing?.top_ref)
        || existing && current.detail.data?.revision !== existing.revision) return;
      await controller.mutate(action, {title, description, ...(existing ? {} : {album_refs: []})});
    }}>
      <label>Name<input name="top-name" value={title} onChange={event => setTitle(event.target.value)} maxLength={100} required disabled={busy || stale || !allowed}/></label>
      <label>Subtitle<input name="top-subtitle" value={description} onChange={event => setDescription(event.target.value)} maxLength={200} disabled={busy || stale || !allowed}/></label>
      <MutationNotice runtime={runtime} controller={controller} value={state.mutation}/>
      {closeError && <NativeHtml html={runtime.alertHtml({severity: 'error', message: 'The Top was saved, but this form could not return to its parent. Close it to continue.'})}/>}
      {stale && <NativeHtml html={runtime.alertHtml({severity: 'info', message: 'This Top changed. Your draft is preserved; close and reopen it to review the current values.'})}/>}
      <footer className="playlists__actions"><Button runtime={runtime} disabled={busy} onClick={() => close()}>Cancel</Button>
        <Button runtime={runtime} type="submit" variant="primary" disabled={busy || stale || !allowed || !title.trim()}>{existing ? 'Save' : 'Create Album Top'}</Button></footer>
    </form>;}}
  </NativeDialog>;
}
export function AlbumTopsView({runtime, controller, state, onOpen, onFormSaved, shareRequest = null, onShareRequestHandled}) {
  const [dialog, setDialog] = useState(null);
  const header = useRef(null);
  const denied = state.directory.status === 'denied' || state.detail.status === 'denied';
  useEffect(() => {if (denied) setDialog(null);}, [denied]);
  const selected = state.selectedTopRef, resource = selected ? state.detail : state.directory;
  const detail = state.detail.data, ready = resource.status === 'ready' || resource.status === 'empty';
  const busy = state.mutation.refreshing === true || ['loading', 'uncertain'].includes(state.mutation.status);
  const createAllowed = albumTopActionAllowed(state, 'create');
  useEffect(() => {
    if (!shareRequest || busy || !shareRequest.isCurrent() || shareRequest.row.top_ref !== selected
      || !albumTopActionAllowed(state, 'view_sharing')) return;
    setDialog({kind: 'share', topRef: selected}); onShareRequestHandled?.(shareRequest);
  }, [shareRequest, selected, detail, busy, onShareRequestHandled]);
  return <section className="album-tops" aria-label="Album Tops">
    <header ref={header} tabIndex={-1} aria-label="Album Tops header" className="gallery-bar album-tops__header">
      {selected && <Button runtime={runtime} icon="back" onClick={() => onOpen(null)}>Back</Button>}
      <div className="gallery-bar__context"><div className="gallery-bar__title"><span>{selected && detail ? detail.title : 'Album Tops'}</span></div></div>
      <div className="gallery-bar__actions">
      {!selected && createAllowed && <Button runtime={runtime} icon="add" disabled={busy} onClick={event => {
        if (albumTopActionAllowed(controller.getSnapshot(), 'create')) setDialog({kind: 'create', opener: event?.target?.closest?.('button') || null});
      }}>Create Album Top</Button>}
      {selected && albumTopActionAllowed(state, 'save') &&
        <Button runtime={runtime} icon="edit" disabled={busy} onClick={event => {
          const current = controller.getSnapshot();
          if (albumTopActionAllowed(current, 'save', detail.top_ref) && current.detail.data === detail) {
            setDialog({kind: 'edit', top: detail, opener: event?.target?.closest?.('button') || null});
          }
        }}>Edit Album Top</Button>
      }
      {selected && albumTopActionAllowed(state, 'view_sharing') && <Button runtime={runtime} icon="share" disabled={busy}
        onClick={event => {
          if (albumTopActionAllowed(controller.getSnapshot(), 'view_sharing', detail.top_ref) && controller.getSnapshot().detail.data === detail) {
            setDialog({kind: 'share', topRef: detail.top_ref, opener: event?.target?.closest?.('button') || null});
          }
        }}>Share</Button>}
      {selected && albumTopActionAllowed(state, 'copy') && <Button runtime={runtime} icon="save" disabled={busy}
        onClick={() => {
          if (albumTopActionAllowed(controller.getSnapshot(), 'copy', detail.top_ref) && controller.getSnapshot().detail.data === detail) controller.mutate('copy');
        }}>Save a copy</Button>}
      {selected && albumTopActionAllowed(state, 'delete') &&
        <Button runtime={runtime} icon="delete" disabled={busy} onClick={async () => {
          const current = controller.getSnapshot();
          if (!albumTopActionAllowed(current, 'delete', detail.top_ref) || current.detail.data !== detail) return;
          if (await runtime.confirm(`Delete “${detail.title}”?`, {title: 'Delete Album Top', acceptLabel: 'Delete', danger: true}) !== true) return;
          if (controller.getSnapshot() !== current) return;
          await controller.mutate('delete');
        }}>Delete Album Top</Button>
      }
      </div>
    </header>
    {selected && detail?.description && <p>{detail.description}</p>}
    <Status runtime={runtime} value={resource} label={selected ? 'this Album Top' : 'Album Tops'}
      retry={() => selected ? controller.open(selected) : controller.load()}/>
    {selected && ready && detail.items.length === 0 && <NativeHtml html={runtime.alertHtml({severity: 'info', role: 'status', message: 'No albums in this Top'})}/>}
    {ready && <div className="home-activity__cards home-activity__cards--albums">
      {(selected ? detail.items : state.directory.data.tops).map(row => {
        const ref = selected ? row.item_ref : row.top_ref;
        const progressRows = detail?.top_viewer_overlay?.item_progress;
        const progress = selected && progressRows && Object.hasOwn(progressRows, row.album_ref) ? progressRows[row.album_ref] : null;
        const complete = selected && albumTopActionAllowed(state, 'set_manual_completion') && isManualProgress(progress);
        const completed = complete && progress.manual_completed_at !== null;
        return <NativeHtml key={ref} preserveFocus={complete ? {selector: '[data-gallery-card-intent="complete"]', keyAttribute: 'data-gallery-card-ref'} : undefined}
          html={runtime.galleryCardHtml({identity: ref,
          interaction: !selected || complete ? 'controlled' : 'none', actionRef: selected ? row.album_ref : ref,
          actions: {open: !selected, complete},
          completion: complete ? {completed, disabled: busy,
            label: `${completed ? 'Clear completion' : 'Mark completed'} in this Top: ${row.title}`} : undefined,
          title: row.title, artist: selected ? row.artist : row.description, year: row.year,
          displayMode: 'cards', artboxHtml: runtime.artboxHtml({state: 'empty', label: `${row.title} artwork`})})}
          onClick={event => {
            if (!selected && event.target.closest('[data-gallery-card-intent="open"]')) {onOpen(ref); return;}
            const button = event.target.closest('[data-gallery-card-intent="complete"]');
            const current = controller.getSnapshot();
            if (!complete || !button || button.disabled || button.getAttribute('aria-disabled') === 'true'
              || button.getAttribute('data-gallery-card-ref') !== row.album_ref || current.scopeKey !== state.scopeKey
              || current.detail.data !== detail || current.mutation.refreshing === true || ['loading', 'uncertain'].includes(current.mutation.status)
              || !albumTopActionAllowed(current, 'set_manual_completion', selected)
              || !current.detail.data.items.some(item => item.album_ref === row.album_ref)) return;
            event.preventDefault(); event.stopPropagation();
            return controller.mutate('set_manual_completion', {album_ref: row.album_ref, completed: !completed});
          }}/>;
      })}
    </div>}
    <MutationNotice runtime={runtime} controller={controller} value={state.mutation}/>
    {dialog && dialog.kind !== 'share' && !denied && <TopFields runtime={runtime} controller={controller} state={state} existing={dialog.top || null} onClose={() => setDialog(null)} onFormSaved={onFormSaved} returnFocus={() => dialog.opener?.isConnected ? dialog.opener : header.current}/>}
    {dialog?.kind === 'share' && !denied && dialog.topRef === selected && <ShareAlbumTop key={dialog.topRef}
      runtime={runtime} controller={controller} state={state} onClose={() => setDialog(null)}
      returnFocus={() => dialog.opener?.isConnected ? dialog.opener : header.current}/>}
  </section>;
}
