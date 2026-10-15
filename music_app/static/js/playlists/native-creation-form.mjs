import {createNativeOwnerScope} from './native-owner-scope.mjs';
import {mountButton,mountTabs} from '../home-friends/native-controls.mjs';
import {mountCreationSearch} from './native-creation.mjs';
import {mountPlaylistSelectionPanel} from './native-selection.mjs';
import {mountRetryOriginalRequest} from './native-mutation-status.mjs';
import {mountEditorPlaytableSelection,editorRowSelectable} from '../playtables/native-editor-selection.mjs';
import {canSubmitCreation,projectCreationState} from './creation.mjs';
const detailDuration=value=>{if(typeof value!=='number'||!Number.isFinite(value)||value<0)return 'Unknown';const seconds=Math.floor(value);return `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;};
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
  if (!projection.entries.length) return '';
  const flat = projection.mode === 'ordinary';
  const groups = flat ? [{entries: projection.entries}] : projection.groups;
  return groups.map((group, groupIndex) => {
    const label = flat ? 'Playlist tracks' : groupLabel(group);
    const table = runtime.tableHtml({id: flat ? `${id}-tracks` : `${id}-group-${groupIndex}`, ariaLabel: label, density: 'compact',
      frame: 'outline', selection: 'multiple', overflow: 'none', mobile: 'preserve', headers: groupIndex === 0 ? 'visible' : 'screen-reader',
      columns: '30px 32px minmax(0,1fr) minmax(48px,auto)',
      columnsConfig: [{key: 'selection', label: 'Select', header: 'screen-reader'}, {key: 'number', label: '#'},
        {key: 'title', label: 'Track'}, {key: 'duration', label: 'Length', action: true}],
      rows: group.entries.map(entry => {
        const readable = entry.source_readable === true, title = readable ? known(entry.title) : 'Unavailable track';
        const duration = entry.duration_seconds === null ? '—' : detailDuration(entry.duration_seconds);
        const native = runtime.albumTrackRow({title, secondary_artist: readable ? entry.artist : '', duration_display: duration,
          availability: readable ? entry.availability : null}, 0);
        const artwork = runtime.artboxHtml({state: readable && entry.artwork_url ? 'ready' : 'empty', label: `${title} artwork`,
          coverHtml: readable && entry.artwork_url ? `<img src="${escape(entry.artwork_url)}" alt="" loading="lazy" decoding="async" onerror="handleUtilityAlbumArtboxError(this)">` : ''});
        const review = needsReview(entry) ? runtime.buttonHtml({label: 'Review', size: 'small', disabled,
          attributes: {'data-creation-review': entry.row_key, 'aria-label': `Review ${title}`}}) : '';
        const note = readable && entry.availability !== 'local'
          ? `<span class="album-track-table__secondary">${entry.availability === 'missing' ? 'Confirmed missing' : 'Availability unresolved'}</span>` : '';
        return {key: entry.row_key, className: native.className,
          tabIndex: !disabled && editorRowSelectable(entry) ? 0 : undefined, ariaDisabled: disabled || !editorRowSelectable(entry),
          dataAttributes: {'creation-row-key': entry.row_key}, cells: {
            selection: {content: `<input type="checkbox" data-creation-pick="${escape(entry.row_key)}" aria-label="Select ${escape(title)}"${selected.has(entry.row_key) ? ' checked' : ''}${disabled || !selectable(entry) ? ' disabled' : ''}>`},
            // Native numbered play cells assume an album position. A source may
            // have neither, so the read-only picker keeps that fact unknown.
            number: {content: escape(readable && entry.track_number !== null ? entry.track_number : '—')},
            title: {content: `<div class="playlists-creation__identity"><div class="home-detail__release">${artwork}<div>${native.cells.title.content}${note}</div></div>${review}</div>`},
            duration: native.cells.duration,
          }};
      })});
    return flat ? table : `<section class="album-track-table__disc"><h3 class="album-track-table__disc-heading">${escape(label)}</h3>${table}</section>`;
  }).join('');
}

let nextId=0;
export function mountCreationResults(host, runtime, initial) {
  const scope = createNativeOwnerScope();
  let props = initial, disposed = false, revision = 0, selection;
  const document = host.ownerDocument;
  const actions = document.createElement('div'), table = document.createElement('div');
  const note = document.createElement('p');
  function dispose() {
    if (disposed) return;
    disposed = true;
    revision++;
    scope.dispose();
    host.replaceChildren();
  }
  try {
    table.className = 'album-track-table playlists-creation__results';
    note.className = 'playlists__note';
    note.textContent = 'Add to playlist is unavailable while this creation form is open. Use the checkboxes to choose this playlist’s tracks.';
    host.replaceChildren(actions, note, table);
    const current = () => !disposed && !props.disabled && props.controller.getSnapshot() === props.state;
    scope.listen(table, 'change', event => {
      const input = event.target.closest('[data-creation-pick]');
      if (input && table.contains(input) && !input.disabled && current()) props.controller.toggle(input.dataset.creationPick);
    });
    scope.listen(table, 'click', event => {
      const button = event.target.closest('[data-creation-review]');
      if (button && table.contains(button) && !button.disabled && current()) props.controller.review(button.dataset.creationReview);
    });
    function update(next) {
      if (disposed) return;
      props = next;
      const pass = ++revision, ownsPass = () => !disposed && revision === pass && props === next;
      const active = table.contains(document.activeElement) ? document.activeElement : null;
      const key = active?.closest('[data-creation-row-key]')?.dataset.creationRowKey;
      const attribute = active?.hasAttribute('data-creation-review') ? 'data-creation-review'
        : active?.hasAttribute('data-creation-pick') ? 'data-creation-pick' : null;
      const priorRows = [...table.querySelectorAll('[data-creation-row-key]')];
      const index = priorRows.findIndex(row => row.dataset.creationRowKey === key);
      const html = creationResultsHtml(runtime, {id: next.id, projection: next.projection,
        selectedKeys: next.state.selectedKeys, disabled: next.disabled});
      if (!ownsPass()) return;
      if (table.innerHTML !== html) table.innerHTML = html;
      const options = {runtime, actionsHost: actions, controller: next.controller, state: next.state,
        rows: next.projection.entries, tableKey: 'playlist-creation', disabled: next.disabled,
        onInspect: key => {if (ownsPass()) next.controller.review(key);}};
      if (selection) selection.update(options);
      else {
        const acquired = mountEditorPlaytableSelection(table, options);
        if (!ownsPass()) {acquired.dispose(); return;}
        selection = scope.own(acquired);
      }
      if (!ownsPass() || !key || document.activeElement?.isConnected && document.activeElement !== document.body) return;
      const rows = [...table.querySelectorAll('[data-creation-row-key]')];
      const sameRow = rows.find(row => row.dataset.creationRowKey === key);
      const same = attribute ? sameRow?.querySelector(`[${attribute}]:not(:disabled)`)
        : sameRow?.getAttribute('tabindex') === '0' ? sameRow : null;
      const adjacent = rows[Math.min(Math.max(index, 0), rows.length - 1)];
      const fallback = adjacent?.getAttribute('tabindex') === '0' ? adjacent
        : adjacent?.querySelector('[data-creation-pick]:not(:disabled)');
      const target = same || fallback || host.closest('form')?.querySelector('[role="tab"][aria-selected="true"]');
      if (ownsPass()) target?.focus({preventScroll: true});
    }
    update(initial);
    return {update, dispose};
  } catch (error) {
    dispose();
    throw error;
  }
}
export function mountCreationForm(host,runtime,initial){
 const scope=createNativeOwnerScope();scope.defer(()=>host.replaceChildren());
 try {
 const doc=host.ownerDocument,id=`playlist-creation-native-${++nextId}`,form=doc.createElement('form');form.className='playlists__form playlists-creation';form.setAttribute('aria-label','Create playlist');
 const make=(tag,parent=form)=>{const node=doc.createElement(tag);parent.append(node);return node;};
 const metadata=make('div');metadata.className='playlists__metadata tag-editor-form playlists-creation__metadata';const titleLabel=make('label',metadata);titleLabel.append('Name');const title=make('input',titleLabel);title.required=true;title.maxLength=100;title.setAttribute('aria-label','Playlist name');const descriptionLabel=make('label',metadata);descriptionLabel.append('Description');const description=make('textarea',descriptionLabel);description.rows=2;description.maxLength=1000;description.setAttribute('aria-label','Playlist description');
 const searchHost = make('div'), sourceHost = make('div'), reloadHost = make('span');
 const toolbar = make('fieldset'), legend = make('legend', toolbar), tabsHost = make('div', toolbar);
 const selectLabel = make('label', toolbar), select = make('input', selectLabel);
 toolbar.className = 'playlists-creation__toolbar';
 legend.className = 'sr-only';
 legend.textContent = 'Playlist track selection';
 selectLabel.className = 'playlists-creation__select-visible';
 select.type = 'checkbox';
 select.setAttribute('aria-label', 'Select visible tracks');
 selectLabel.append('Select visible');
 const count = make('span');
 count.className = 'sr-only';
 count.setAttribute('role', 'status');
 count.setAttribute('aria-live', 'polite');
 count.setAttribute('aria-atomic', 'true');
 const notes = make('p'), limitHost = make('div'), resultsHost = make('div');
 const pageStatusHost = make('div'), retryPageHost = make('span'), moreHost = make('span');
 const emptyHost = make('p'), reviewHost = make('div'), mutationHost = make('div');
 const reconcileHost = make('span'), retryHost = make('div'), actions = make('div');
 const submitHost = make('span', actions), dismissHost = make('span', actions);
 actions.className = 'playlists__actions';
 host.replaceChildren(form);
 let props=initial,disposed=false,pending=false,completing=false,completionError=false,submitError=false,review=null,reviewKey=null;
 const current=()=>!disposed&&props.controller.getSnapshot()===props.state;
 const search=scope.own(mountCreationSearch(searchHost,runtime,{id:`${id}-search`,value:'',onChange:query=>{if(current())props.controller.setQuery(query);}})),tabs=scope.own(mountTabs(tabsHost,runtime,{id:`${id}-tabs`,label:'Playlist tracks',items:[['all','All'],['selected','Selected']],value:'all'})),reload=scope.own(mountButton(reloadHost,runtime,{label:'Reload tracks'})),reconcile=scope.own(mountButton(reconcileHost,runtime,{label:'Check creation result'})),submitButton=scope.own(mountButton(submitHost,runtime,{label:'Create playlist',type:'submit'})),dismiss=scope.own(mountButton(dismissHost,runtime,{label:'Cancel'}));
 const retryPage=scope.own(mountButton(retryPageHost,runtime,{label:'Retry search'})),more=scope.own(mountButton(moreHost,runtime,{label:'Load more tracks'}));
 const results=scope.own(mountCreationResults(resultsHost,runtime,{...initial,id,projection:projectCreationState(initial.state),disabled:true}));
 const retry=scope.own(mountRetryOriginalRequest(retryHost,runtime,{scopeKey:initial.state.scopeKey,available:false}));
 const editTitle=()=>{if(current())props.controller.edit({title:title.value});},editDescription=()=>{if(current())props.controller.edit({description:description.value});},selectVisible=()=>{if(current()&&!select.disabled)props.controller.selectVisible(select.checked);};scope.listen(title,'input',editTitle);scope.listen(description,'input',editDescription);scope.listen(select,'change',selectVisible);
 async function recovered(ack){if(disposed)return;completing=true;paint();try{await props.onCreated?.(ack);}catch{if(!disposed)completionError=true;}finally{if(!disposed){completing=false;paint();}}}
 async function submit(event){event.preventDefault();const controller=props.controller;if(pending||disposed||!canSubmitCreation(controller.getSnapshot())||controller.getSnapshot().mode==='missing'&&typeof props.onPrepareDraft!=='function')return;pending=true;submitError=false;completionError=false;paint();try{if(controller.getSnapshot().mode==='missing'){const packet=controller.prepareDraft();if(!packet||disposed)return;completing=true;paint();if(await props.onPrepareDraft(packet)!==true&&!disposed)submitError=true;}else{const ack=await controller.submit(),state=controller.getSnapshot();if(!ack||disposed||state.mutation.status!=='ready'||['scopeKey','request_key','playlist_id','revision'].some(key=>state.mutation.data?.[key]!==ack[key]))return;await recovered(ack);}}catch{if(!disposed)submitError=true;}finally{pending=false;if(!disposed){completing=false;paint();}}}scope.listen(form,'submit',submit);
 function paint(){if(disposed)return;const {state,controller}=props,p=projectCreationState(state),ready=state.sourceResource.status==='ready',busy=state.mutation.status==='loading'||completing,locked=busy||state.mutation.request_key!==null,eligible=p.entries.filter(selectable).length,mixed=p.visibleSelectedCount>0&&p.visibleSelectedCount<eligible;
 form.setAttribute('aria-busy',String(busy));if(title.value!==state.title)title.value=state.title;if(description.value!==state.description)description.value=state.description;title.disabled=description.disabled=locked||!state.canCreate;
 search.update({id:`${id}-search`,value:state.query,disabled:locked||!ready,onChange:query=>{if(current())controller.setQuery(query);}});toolbar.hidden=!ready;toolbar.disabled=locked;tabs.update({id:`${id}-tabs`,label:'Playlist tracks',items:[['all','All'],['selected',`Selected (${p.selectedCount})`]],value:state.tab,onChange:tab=>{if(current()&&!locked)controller.setTab(tab);}});select.indeterminate=mixed;select.checked=eligible>0&&p.visibleSelectedCount===eligible;select.disabled=locked||!eligible;select.setAttribute('aria-checked',mixed?'mixed':String(p.visibleSelectedCount>0));count.textContent=`${p.selectedCount} tracks selected`;
 notes.className = 'playlists__note';
 notes.hidden = !p.duplicateCount;
 notes.textContent = p.duplicateCount > 0
   ? `${p.duplicateCount} repeated occurrences shown; each source track will be added once.` : '';
 limitHost.innerHTML = state.selectionLimit ? runtime.alertHtml({severity: 'error', role: 'alert',
   message: 'A playlist can include up to 5,000 selected tracks. Remove a track before selecting more.'}) : '';
 const sourceMessages={loading:'Loading tracks…',denied:'You no longer have permission to use this source.',unavailable:'Playlist creation is not available for this source yet.',error:'The source tracks could not be loaded.',conflict:'This source changed. Reload its tracks and choose your selection again.',expired:'This selection session expired. Close this form and open Create playlist again.',refresh_required:'Source access was refreshed. Reload its tracks and choose your selection again.',incomplete:'The source is incomplete. All tracks must be available before creating a playlist.'};sourceHost.innerHTML=ready||state.mutation.status==='ready'?'':runtime.alertHtml({severity:['error','conflict','incomplete','refresh_required'].includes(state.sourceResource.status)?'error':'info',role:['error','conflict','incomplete','refresh_required'].includes(state.sourceResource.status)?'alert':'status',message:sourceMessages[state.sourceResource.status]||'The source tracks are unavailable.'});reloadHost.hidden=!['error','conflict','incomplete','refresh_required'].includes(state.sourceResource.status)||state.mutation.status==='ready';reload.update({label:'Reload tracks',disabled:locked,onClick:()=>{if(current())controller.load();}});
 const paged=ready&&state.tab==='all'&&state.sourceResource.data.source_protocol==='library_selection_v1';pageStatusHost.hidden=!paged;pageStatusHost.innerHTML=paged&&['error','conflict','unavailable'].includes(state.pageStatus)?runtime.alertHtml({severity:'error',role:'alert',message:'These search results could not be loaded. Your selection is retained.'}):paged&&state.pageStatus==='loading'?'<p role="status">Loading tracks…</p>':'';retryPageHost.hidden=!paged||!['error','conflict','unavailable'].includes(state.pageStatus);retryPage.update({label:'Retry search',disabled:locked,onClick:()=>{if(current()&&!locked)controller.retryPage();}});moreHost.hidden=!paged||!state.sourceResource.data.has_more;more.update({label:'Load more tracks',disabled:locked||state.pageStatus==='loading',onClick:()=>{if(current()&&!locked)controller.loadMore();}});emptyHost.hidden=!ready||Boolean(p.entries.length);emptyHost.setAttribute('role','status');emptyHost.textContent=state.tab==='selected'?'No tracks selected.':state.mode==='ordinary'&&!state.query.trim()?'Search for tracks to add to this playlist.':state.pageStatus==='loading'?'':state.query.trim()?'No matching tracks.':'No tracks are available in this source.';resultsHost.setAttribute('role','tabpanel');resultsHost.setAttribute('aria-labelledby',`${id}-tabs-${state.tab}`);resultsHost.hidden=!ready;results.update({...props,id,projection:p,disabled:locked});const entry=ready?[...(state.pinnedEntries||[]),...state.sourceResource.data.entries].find(row=>row.row_key===state.reviewKey&&row.source_readable===true):null,row=creationReviewRow(entry,state.source);if(row){const rp={scopeKey:state.scopeKey,row,readDetail:props.readDetail,onClose:()=>{if(current())controller.review(null);}};if(review)review.update(rp);else review=scope.own(mountPlaylistSelectionPanel(reviewHost,runtime,rp));if(reviewKey!==row.row_key)reviewHost.querySelector('button')?.focus({preventScroll:true});reviewKey=row.row_key;}else{const previousReviewKey=reviewKey;review?.dispose();review=null;reviewKey=null;const active=doc.activeElement;if(previousReviewKey&&(!active||active===doc.body||!active.isConnected)){const row=[...resultsHost.querySelectorAll('[data-creation-row-key]')].find(row=>row.dataset.creationRowKey===previousReviewKey);row?.querySelector('[data-creation-review]:not(:disabled)')?.focus({preventScroll:true});}}
 const m=state.mutation;let message='';if(state.mode==='missing')message=submitError?'The unsaved playlist could not be opened. Your selection has not been saved.':completing?'Opening unsaved playlist…':'';else if(m.status!=='idle'||submitError)message=m.status==='ready'?(completionError?'Playlist created, but the playlist list could not be refreshed.':completing?'Playlist created. Refreshing playlists…':'Playlist created.'):({loading:'Creating playlist…',denied:'You do not have permission to create this playlist.',unavailable:'Playlist creation is not available from this provider.',conflict:'This source changed. Creation was not confirmed.'}[m.status]||'Creation was not confirmed. Check your playlists before starting another attempt.');mutationHost.innerHTML=message?runtime.alertHtml({severity:completionError||submitError||['denied','conflict','error'].includes(m.status)?'error':'info',role:completionError||submitError||['denied','conflict','error'].includes(m.status)?'alert':'status',message}):'';
 reconcileHost.hidden=!(state.mode==='ordinary'&&m.request_key&&['error','conflict','unavailable'].includes(m.status)&&typeof controller.reconcile==='function');reconcile.update({label:'Check creation result',disabled:busy,onClick:async()=>{if(pending||!current())return;pending=true;try{const ack=await controller.reconcile();if(ack&&!disposed)await recovered(ack);}catch{if(!disposed)completionError=true;}finally{pending=false;paint();}}});retry.update({scopeKey:state.scopeKey,available:controller.canRetryOriginal?.()===true,disabled:busy,retry:controller.retryOriginal,current:()=>!disposed&&controller.getSnapshot().scopeKey===state.scopeKey&&controller.getSnapshot().mutation.request_key===m.request_key,onRecovered:recovered});submitButton.update({label:'Create playlist',type:'submit',variant:state.mode==='ordinary'?'primary':'secondary',disabled:busy||!canSubmitCreation(state)||state.mode==='missing'&&typeof props.onPrepareDraft!=='function'});dismiss.update({label:m.status==='ready'?'Close':state.dirty?'Discard':'Cancel',disabled:busy&&!props.canDismissWhileLoading,onClick:()=>props.onDismiss?.({reason:m.status!=='ready'&&state.dirty?'discard':'cancel'})});
 }
 paint();return {update(next){if(disposed)return;props=next;paint();},dispose(){if(disposed)return;disposed=true;scope.dispose();form.removeEventListener('submit',submit);title.removeEventListener('input',editTitle);description.removeEventListener('input',editDescription);select.removeEventListener('change',selectVisible);for(const owner of [search,tabs,reload,reconcile,retryPage,more,submitButton,dismiss,results,review,retry])owner?.dispose();host.replaceChildren();}};

 }catch(error){scope.dispose();throw error;}
}
