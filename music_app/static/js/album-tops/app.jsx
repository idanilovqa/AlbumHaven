import React, {useEffect, useRef, useState} from 'react';
import {Button, NativeHtml, Status} from '../home-friends/components.jsx';
import {SharedHeader} from '../home-friends/shared-header.jsx';
import {albumTopActionAllowed} from './model.mjs';
import {isManualProgress} from './progress.mjs';
import {ShareAlbumTop} from './sharing.jsx';
import {AlbumTopBuilder as TopFields, InlineAlbumTopEdit} from './builder.jsx';
import {MutationNotice} from './mutation-notice.jsx';

export function AlbumTopsView({runtime, controller, state, providers, onOpen, onFormSaved, shareRequest = null, onShareRequestHandled}) {
  const [dialog, setDialog] = useState(null);
  const header = useRef(null), restoreInlineFocus = useRef(false);
  const returnHeaderFocus = preferred => [preferred, header.current?.querySelector('[data-header-tools]'), header.current].find(node =>
    node?.isConnected && !node.disabled && node.getAttribute('aria-disabled') !== 'true'
    && !node.closest('[hidden],[inert],[aria-hidden="true"]') && node.getClientRects().length > 0);
  const denied = state.directory.status === 'denied' || state.detail.status === 'denied';
  useEffect(() => {if (denied) setDialog(null);}, [denied]);
  const selected = state.selectedTopRef, resource = selected ? state.detail : state.directory;
  const detail = state.detail.data, ready = resource.status === 'ready' || resource.status === 'empty';
  const busy = state.mutation.refreshing === true || ['loading', 'uncertain'].includes(state.mutation.status);
  const createAllowed = albumTopActionAllowed(state, 'create');
  const inline = dialog?.kind === 'edit' && dialog.top?.edit_draft && !denied && dialog.top.top_ref === selected;
  useEffect(() => {
    if (dialog?.top && dialog.top.top_ref !== selected) setDialog(null);
    if (!inline && restoreInlineFocus.current) {
      restoreInlineFocus.current = false;
      returnHeaderFocus(header.current?.querySelector('[aria-label="Edit Album Top"]'))?.focus({preventScroll: true});
    }
  }, [selected, dialog, inline]);
  useEffect(() => {
    if (!shareRequest || busy || inline || !shareRequest.isCurrent() || shareRequest.row.top_ref !== selected
      || !albumTopActionAllowed(state, 'view_sharing')) return;
    setDialog({kind: 'share', topRef: selected}); onShareRequestHandled?.(shareRequest);
  }, [shareRequest, selected, detail, busy, inline, onShareRequestHandled]);
  const renderHeader = edit => <SharedHeader runtime={runtime} id="album-tops" headerRef={header} tabIndex={-1} ariaLabel="Album Tops header" className="album-tops__header"
      leading={selected && <Button runtime={runtime} icon="back" disabled={edit?.busy === true} onClick={async () => {
        if (!edit || await edit.cancel({restoreFocus: false})) onOpen(null);
      }}>Back</Button>}
      actions={edit ? edit.actions : <>
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
      </>}>
      <div className="gallery-bar__context"><div className="gallery-bar__title">{edit ? edit.fields : <span>{selected && detail ? detail.title : 'Album Tops'}</span>}</div></div>
    </SharedHeader>;
  return <section className="album-tops" aria-label="Album Tops">
    {inline ? <InlineAlbumTopEdit key={dialog.top.top_ref} runtime={runtime} controller={controller} state={state} providers={providers}
      existing={dialog.top} renderHeader={renderHeader} onRestoreFocus={() => {restoreInlineFocus.current = true;}} onClose={options => {
        restoreInlineFocus.current = options?.restoreFocus === true; setDialog(null);
      }}/> : <>
    {renderHeader(null)}
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
    {dialog && dialog.kind !== 'share' && !denied && <TopFields runtime={runtime} controller={controller} state={state} providers={providers} existing={dialog.top || null} onClose={() => setDialog(null)} onFormSaved={onFormSaved} returnFocus={() => returnHeaderFocus(dialog.opener)}/>}
    {dialog?.kind === 'share' && !denied && dialog.topRef === selected && <ShareAlbumTop key={dialog.topRef}
      runtime={runtime} controller={controller} state={state} onClose={() => setDialog(null)}
      returnFocus={() => returnHeaderFocus(dialog.opener)}/>}
    </>}
  </section>;
}
