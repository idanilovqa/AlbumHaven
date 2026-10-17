import {
  createNativeOwnerScope
}
from './native-owner-scope.mjs';
import {
  mountButton,
  mountChoice,
  mountStatus
}
from '../home-friends/native-controls.mjs';
import {mountPlaylistHeader} from './native-headers.mjs';
import {
  readTrackPreference
}
from '../home-friends/track-preference.mjs';
import {
  mountPlaylistGroupedDirectory,
  mountPlaylistFilterControls
}
from './native-directory-filters.mjs';
import {
  mountPlaylistSelectionPanel
}
from './native-selection.mjs';
import {
  mountPlaylistCreationSession
}
from './native-creation-session.mjs';
import {
  mountSharePlaylist
}
from './native-sharing.mjs';
import {
  mountPlaylistSettings
}
from './native-settings.mjs';
import {
  mountMutationStatus,
  mountRetryOriginalRequest
}
from './native-mutation-status.mjs';
import {
  mountCreationSearch
}
from './native-creation.mjs';
import {
  mountPlaylistFilterSurface
}
from './native-filter-surface.mjs';
import {
  createPlaylistFilterSession
}
from './native-filter-session.mjs';
import {
  canOpenPlaylistCreation,
  playlistCreationContext,
  preparePlaylistCreationOpening
}
from './creation-session.mjs';
import {
  mountPlaylistTracks,
  restorePlaylistSelectionFocus
}
from './native-track-table.mjs';
import {
  createPlaylistIntegrations
}
from './integrations.mjs';
import {
  mountPlaylistPlaybackControls,
  mountPlaylistMatchReview
}
from './native-integrations.mjs';
import {
  playlistDialogVisible,
  playlistSharingCurrent,
  playlistDialogFocusTarget,
  restorePlaylistDialogFocus
}
from './dialog-state.mjs';
import {
  defaultFilters,
  draftDirty,
  granted,
  hasPlaylistFilters,
  playlistText,
  playlistDraft,
  playlistFilters,
  validMetadata,
  visiblePlaylistRows
}
from './model.mjs';
import {
  mountSavedLibraryMixOrder
}
from './native-library-mix.mjs';
export {
  playlistTableHtml,
  playlistReorderSnapshot,
  paintPlaylistCurrent,
  restorePlaylistSelectionFocus
}
from './native-track-table.mjs';
const node=(host,tag='div',className='')=> {
  const value=host.ownerDocument.createElement(tag);
  value.className=className;
  host.append(value);
  return value;
};
export function resolvePlaylistSelection(selection, {
  scopeKey,
  detail,
  rows
}) {
  if (!selection || !detail || selection.scopeKey !== scopeKey || selection.playlistId !== detail.playlist_id) return null;
  if (!selection.itemId && selection.detail !== detail) return null;
  const matches = rows.filter(row => row.source_readable === true && (selection.itemId ? row.playlist_item_id === selection.itemId : row.row_key === selection.rowKey));
  return matches.length === 1 ? matches[0] : null;
}
export function playlistIntegrationCurrent(value, state, selectedItemId = null) {
  return value.scopeKey === state.scopeKey && value.status === state.resource.status && value.detail === (state.resource.status === 'ready' ? state.resource.data?.detail || null : null) && value.selectedItemId === selectedItemId;
}
export async function confirmPlaylistDiscard(runtime, controller) {
  const before = controller.getSnapshot(),
  draft = playlistDraft(before),
  detail = before.resource.data?.detail;
  if (!draft || before.mutation.status === 'loading' || typeof runtime.confirm !== 'function') return false;
  if (await runtime.confirm('Discard unsaved changes to this playlist?') !== true) return false;
  const current = controller.getSnapshot();
  if (current.scopeKey !== before.scopeKey || current.selectedPlaylistId !== before.selectedPlaylistId || current.resource.data?.detail !== detail || playlistDraft(current) !== draft || current.mutation.status === 'loading') return false;
  return controller.discard(before.selectedPlaylistId);
}
export function playlistSharingRenderCurrent(subject, state) {
  return playlistSharingCurrent(subject, state) && (subject === state.resource.data?.detail || !state.resource.data?.detail && state.mutation.status === 'loading' && state.mutation.action === 'saveSharing');
}
const EMPTY_PROVIDERS = Object.freeze({
});
const filterSourceIdentity = state => state.resource.status === 'ready' && state.resource.data?.detail ? [state.scopeKey, state.selectedPlaylistId, state.resource.data.detail] : null;
export function mountPlaylistDirectory(host,runtime,initial) {
  let props=initial,
  disposed=false;
  const scope=createNativeOwnerScope();
  scope.defer(()=>host.replaceChildren());
  const acquire=value=>scope.own(value);
  try {
    host.className='playlists__directory';
    host.setAttribute('aria-label','Playlist directory');
    const header=node(host,'div','playlists__directory-header');
    node(header,'h2').textContent='Playlists';
    const create=acquire(mountButton(node(header,'span'),runtime, {
      label:'Create playlist',
      icon:'add'
    })),
    group=acquire(mountPlaylistGroupedDirectory(node(host,'nav'),runtime, {
    })),
    statusHost=node(host),
    status=acquire(mountStatus(statusHost,runtime, {
      value: {
        status:'idle'
      },
      label:'Playlists'
    }));
    function update(next) {
      if(disposed)return;
      props=next;
      const items=props.state.resource.data?.items||[];
      create.update({
        label:'Create playlist',
        icon:'add',
        disabled:!props.canCreate,
        title:props.canCreate?'Create playlist':'Playlist creation is not available for this account yet.',
        attributes: {
          'data-playlists-create':'1'
        },
        onClick:()=>props.onCreate?.()
      });
      group.update({
        items,
        selectedPlaylistId:props.state.selectedPlaylistId,
        disabled:props.state.mutation.status==='loading',
        onSelect:id=>props.onSelect?.(id)
      });
      status.update({
        value:props.state.resource.status==='ready'? {
          status:'empty'
        }
        :props.state.resource,
        label:'Playlists'
      });
      if(items.length>0)statusHost.hidden=true;
    }
    update(props);
    return {
      element:host,
      update,
      dispose() {
        disposed=true;
        scope.dispose();
      }
    };
  }catch(error) {
    disposed=true;
    scope.dispose();
    throw error;
  }
}
export function mountPlaylistFilters(host,runtime,initial) {
  let props=initial,
  disposed=false;
  const scope=createNativeOwnerScope();
  scope.defer(()=>host.replaceChildren());
  const acquire=value=>scope.own(value);
  try {
    const controls=acquire(mountPlaylistFilterControls(host,runtime,initial)),
    search=acquire(mountCreationSearch(node(controls.children),runtime, {
      id:'playlists-filter-search',
      value:initial.filters.query,
      label:'Find tracks',
      placeholder:'Track, artist or album'
    })),
    availability=acquire(mountChoice(node(controls.children),runtime, {
      label:'Availability',
      value:initial.filters.availability,
      options:[['all','All tracks']]
    }));
    function update(next) {
      if(disposed)return;
      props=next;
      controls.update({
        ...props,
        canReset:hasPlaylistFilters(props.filters),
        onReset:()=>props.onChange(defaultFilters)
      });
      if(disposed)return;
      search.update({
        id:'playlists-filter-search',
        className:'playlists-filter__search',
        maxLength:200,
        value:props.filters.query,
        disabled:props.disabled,
        label:'Find tracks',
        placeholder:'Track, artist or album',
        onChange:query=>props.onChange({
          query
        })
      });
      if(disposed)return;
      availability.update({
        label:'Availability',
        value:props.filters.availability,
        disabled:props.disabled,
        options:[['all','All tracks'],['local','Confirmed local'],['missing','Confirmed missing'],['unresolved','Needs review']],
        onChange:value=>props.onChange({
          availability:value
        })
      });
    }
    update(props);
    return {
      element:host,
      update,
      dispose() {
        if(disposed)return;
        disposed=true;
        scope.dispose();
      }
    };
  }catch(error) {
    disposed=true;
    scope.dispose();
    throw error;
  }
}
export function mountPlaylistsView(host,runtime,initial) {
  let props= {
    integrationProviders:EMPTY_PROVIDERS,
    ...initial
  },
  disposed=false,
  contextVersion=0,
  rendering=false,
  again=false,
  selection=null,
  dialog=null,
  dialogView=null,
  dialogMounted=null,
  message='',
  picker=null,
  discardRequest=null,
  creationOpening=null,
  displayedView=null,
  filterSurface=null,
  filterMounted=null,
  table=null,
  panel=null,
  playback=null,
  mix=null,
  match=null,
  previousScope=props.state.scopeKey,
  previousPlaylist=props.state.selectedPlaylistId,
  previousProviders=props.integrationProviders,
  handledShare=null;
  const scope=createNativeOwnerScope();
  scope.defer(()=>host.replaceChildren());
  scope.defer(()=> {
    disposed=true;
    contextVersion++;
    picker?.abort();
    creationOpening?.abort();
    discardRequest=null;
  });
  try {
    host.className='playlists';
    const directoryHost=node(host,'aside'),
    main=node(host,'main','playlists__content');
    main.setAttribute('aria-label','Playlist');
    const headerHost=node(main),
    filterHost=node(main),
    scroll=node(main,'div','playlists__scroll gallery-scrollbar'),
    navigationHost=node(scroll),
    resourceHost=node(scroll),
    content=node(scroll),
    dialogHost=node(host);
    const header=scope.own(mountPlaylistHeader(headerHost,runtime,{actions:{},onAction:run}));
    const directory=scope.own(mountPlaylistDirectory(directoryHost,runtime, {
      state:props.state,
      onSelect:selectPlaylist,
      onCreate:()=>openDialog('create'),
      canCreate:false
    })),
    resource=scope.own(mountStatus(resourceHost,runtime, {
      value:props.state.resource,
      label:'Playlists',
      retry:()=>props.controller.load()
    }));
    const metadata=node(content,'div','playlists__metadata tag-editor-form'),
    titleLabel=node(metadata,'label');
    titleLabel.append('Title');
    const title=node(titleLabel,'input');
    title.maxLength=100;
    title.setAttribute('aria-label','Playlist title');
    const titleInput=()=>props.controller.edit({
      title:title.value
    });
    scope.listen(title,'input',titleInput);
    const descriptionLabel=node(metadata,'label');
    descriptionLabel.append('Description');
    const description=node(descriptionLabel,'textarea');
    description.rows=2;
    description.maxLength=1000;
    description.setAttribute('aria-label','Playlist description');
    const descriptionInput=()=>props.controller.edit({
      description:description.value
    });
    scope.listen(description,'input',descriptionInput);
    const metadataNotes=node(metadata),
    playbackHost=node(content),
    deniedHost=node(content),
    denied=scope.own(mountStatus(deniedHost,runtime, {
      value: {
        status:'denied'
      },
      label:'Playlist integrations'
    })),
    summary=node(content,'div','playlists__summary'),
    count=node(summary,'span'),
    sample=scope.own(mountButton(node(summary,'span'),runtime, {
      label:'Sample Playlist'
    })),
    missing=scope.own(mountButton(node(summary,'span'),runtime, {
      label:'Missing-only TXT'
    })),
    tableHost=node(content),
    selectionHost=node(content,'div','playlists__selection-context'),
    panelHost=node(selectionHost),
    matchHost=node(selectionHost),
    exportNote=node(content,'p','playlists__note'),
    empty=node(scroll,'p'),
    retryHost=node(scroll),
    mutationHost=node(scroll),
    messageHost=node(scroll);
    exportNote.textContent='TXT uses the complete playlist or unsaved draft order, regardless of filters. Missing-only includes unresolved originals and excludes confirmed local matches and unreadable sources. Export does not save the draft.';
    empty.textContent='Select a playlist to see its tracks.';
    const retry=scope.own(mountRetryOriginalRequest(retryHost,runtime, {
    })),
    mutation=scope.own(mountMutationStatus(mutationHost,runtime, {
      value:props.state.mutation,
      controller:props.controller
    }));
    const integrations=scope.own(createPlaylistIntegrations({
      providers:props.integrationProviders
    })),
    unsubscribeIntegration=integrations.subscribe(render);
    scope.defer(unsubscribeIntegration);
    const unsubscribePreferences=runtime.subscribeTrackPreferences?.(render);
    if(unsubscribePreferences)scope.defer(unsubscribePreferences);
    const filterSession=scope.own(createPlaylistFilterSession(props.controller,filterSourceIdentity,props.integrationProviders,render));
    scope.defer(()=> {
      for(const owner of [dialogView,filterSurface,table,panel,match,mix,playback]) {
        try {
          owner?.dispose();
        }catch {
        }
      }
    });
    function data() {
      const state=props.state,
      detail=state.resource.data?.detail,
      draft=detail&&playlistDraft(state,detail.playlist_id),
      filters=playlistFilters(state),
      rows=visiblePlaylistRows(detail,draft,filters,Date.now(),row=> {
        const preference=readTrackPreference(runtime,row, {
          scopeKey:state.scopeKey,
          playlist_id:detail?.playlist_id
        });
        return preference? {
          ...row,
          love_tier:preference.love_tier
        }
        :row;
      });
      return {
        state,
        detail,
        draft,
        filters,
        rows,
        exportRows:visiblePlaylistRows(detail,draft,defaultFilters),
        busy:state.mutation.status==='loading'
      };
    }
    function selectPlaylist(id) {
      if(runtime.deferFormNavigation?.(()=>props.onSelect(id)))return;
      props.onSelect(id);
    }
    function notice(value) {
      if(disposed)return;
      message=value;
      render();
    }
    function closeDialog(options= {
    }) {
      const old=dialog;
      dialog=null;
      dialogMounted=null;
      const view=dialogView;
      dialogView=null;
      view?.dispose();
      if(!disposed) {
        render();
        if(options.restoreFocusRequested&&old?.scopeKey===props.state.scopeKey&&old.playlistId===props.state.selectedPlaylistId)restorePlaylistDialogFocus(host,old.kind,host.ownerDocument);
      }
    }
    function closeSelection({
      rowKey,
      restoreFocusRequested=false
    }
    = {
    }) {
      selection=null;
      render();
      if(restoreFocusRequested)restorePlaylistSelectionFocus(host,rowKey,host.ownerDocument);
    }
    function openDialog(kind) {
      const {
        state,
        detail
      }
      =data(),
      providers=props.integrationProviders,
      mode=kind==='missing'?'missing':'ordinary';
      if(disposed||creationOpening||dialog)return;
      if(['create','missing'].includes(kind)&&!canOpenPlaylistCreation(props.controller.getSnapshot(),providers,mode))return;
      if(kind==='create'&&typeof providers.beginPlaylistCreationSource==='function'||kind==='missing'&&typeof providers.recoverPlaylistCreation==='function') {
        const request=new AbortController();
        creationOpening=request;
        message='';
        render();
        preparePlaylistCreationOpening({
          controller:props.controller,
          providers,
          mode,
          signal:request.signal,
          isCurrent:()=>!disposed&&creationOpening===request
        }).then(context=> {
          if(!context||disposed||creationOpening!==request||request.signal.aborted)return;
          if(context.recoveredCreation)message='Your previous playlist was created. Check Playlists before starting another.';
          else dialog= {
            kind,
            scopeKey:context.scopeKey,
            playlistId:context.playlistId,
            sharingGranted:false,
            source:context.source
          };
        }).catch(error=> {
          if(!disposed&&creationOpening===request&&!request.signal.aborted)message=error?.status==='unknown'?'A previous playlist creation is still unconfirmed. Check its result before starting another playlist.':'Playlist creation could not be opened. Try again.';
        }).finally(()=> {
          if(creationOpening===request) {
            creationOpening=null;
            render();
          }
        });
        return;
      }
      dialog= {
        kind,
        scopeKey:state.scopeKey,
        playlistId:state.selectedPlaylistId,
        sharingGranted:granted(detail,'can_view_sharing')||granted(detail,'can_share'),
        source:['create','missing'].includes(kind)?playlistCreationContext(state,mode).source:null
      };
      render();
    }
    function exportText(missingOnly) {
      const {
        state,
        detail,
        exportRows
      }
      =data();
      if(!detail?.items_complete||!detail.author_order||!granted(detail,'can_export')||typeof runtime.downloadText!=='function'||props.controller.getSnapshot()!==state)return;
      Promise.resolve().then(()=> {
        if(!disposed&&props.controller.getSnapshot()===state)return runtime.downloadText({
          text:playlistText(exportRows, {
            missingOnly
          }),
          filename:missingOnly?'playlist-missing.txt':'playlist.txt'
        });
      }).catch(()=> {
        if(!disposed&&props.controller.getSnapshot().scopeKey===state.scopeKey&&props.controller.getSnapshot().selectedPlaylistId===state.selectedPlaylistId)notice('TXT export is unavailable.');
      });
    }
    async function run(action) {
      const {
        state,
        detail
      }
      =data(),
      controller=props.controller;
      message='';
      if(action==='filters') {
        const current=controller.getSnapshot();
        if(detail&&current.mutation.status!=='loading'&&current.resource.status==='ready'&&current.scopeKey===state.scopeKey&&current.selectedPlaylistId===state.selectedPlaylistId&&current.resource.data?.detail===detail)filterSession.toggle();
        return;
      }
      if(['share','settings','missing'].includes(action)) {
        openDialog(action);
        return;
      }
      if(action==='export') {
        exportText(false);
        return;
      }
      if(['save','copy','top'].includes(action)) {
        await controller.mutate({
          save:'savePlaylist',
          copy:'copyPlaylist',
          top:'createAlbumTop'
        }
        [action]);
        return;
      }
      if(action==='discard') {
        if(discardRequest)return;
        if(typeof runtime.confirm!=='function') {
          notice('Discard confirmation is unavailable. Your draft is unchanged.');
          return;
        }
        const request= {
        };
        discardRequest=request;
        render();
        try {
          await confirmPlaylistDiscard(runtime,controller);
        }catch {
          if(discardRequest===request)message='Discard confirmation could not be completed. Your draft is unchanged.';
        }finally {
          if(discardRequest===request) {
            discardRequest=null;
            render();
          }
        }
      }
      if(action==='add') {
        if(picker||!detail)return;
        const request=new AbortController();
        picker=request;
        render();
        try {
          const refs=await runtime.pickTracks({
            playlist_id:detail.playlist_id,
            signal:request.signal
          });
          const current=controller.getSnapshot();
          if(!disposed&&!request.signal.aborted&&current.scopeKey===state.scopeKey&&current.selectedPlaylistId===detail.playlist_id&&current.resource.data?.detail===detail&&refs?.length)await controller.mutate('addTracks',refs);
        }catch {
          if(!disposed&&!request.signal.aborted&&controller.getSnapshot().scopeKey===state.scopeKey)message='Track selection is unavailable.';
        }finally {
          if(picker===request) {
            picker=null;
            render();
          }
        }
      }
    }
    function render() {
      if(disposed)return;
      if(rendering) {
        again=true;
        return;
      }
      rendering=true;
      const version=contextVersion,
      live=()=>!disposed&&contextVersion===version;
      const acquireCurrent=mount=> {
        if(!live())return null;
        const owner=mount();
        if(!live()) {
          owner?.dispose();
          return null;
        }
        return owner;
      };
      try {
        const {
          state,
          detail,
          draft,
          filters,
          rows,
          exportRows,
          busy
        }
        =data(),
        controller=props.controller,
        providers=props.integrationProviders;
        if(previousScope!==state.scopeKey||previousPlaylist!==state.selectedPlaylistId) {
          previousScope=state.scopeKey;
          previousPlaylist=state.selectedPlaylistId;
          picker?.abort();
          picker=null;
          creationOpening?.abort();
          creationOpening=null;
          discardRequest=null;
          selection=null;
          message='';
          dialog=null;
          dialogMounted=null;
          dialogView?.dispose();
          dialogView=null;
          table?.dispose();
          table=null;
        }
        if(!live())return;
        filterSession.update(controller,filterSourceIdentity,providers);
        if(!live())return;
        const selectedRow=resolvePlaylistSelection(selection, {
          scopeKey:state.scopeKey,
          detail,
          rows
        });
        if(selection&&!selectedRow)selection=null;
        const selectedItemId=selectedRow?.playlist_item_id||null;
        if(previousProviders!==providers) {
          integrations.setContext({
            status:'unavailable'
          });
          if(!live())return;
          integrations.configure(providers);
          if(!live())return;
          previousProviders=providers;
        }
        integrations.setContext({
          scopeKey:state.scopeKey,
          detail,
          selectedItemId,
          status:state.resource.status
        });
        if(!live())return;
        const integration=integrations.getSnapshot(),
        currentIntegration=playlistIntegrationCurrent(integration,state,selectedItemId),
        integrationDenied=integration.scopeKey===state.scopeKey&&integration.selectedItemId===selectedItemId&&integration.playback.status==='denied'&&integration.matches.status==='denied';
        if(dialog&&!playlistDialogVisible(dialog,state)) {
          dialog=null;
          dialogMounted=null;
          dialogView?.dispose();
          dialogView=null;
        }
        if(props.shareRequest&&handledShare!==props.shareRequest&&detail?.playlist_id===props.shareRequest.playlist_id&&state.resource.status==='ready'&&(granted(detail,'can_view_sharing')||granted(detail,'can_share'))) {
          handledShare=props.shareRequest;
          openDialog('share');
          props.onShareRequestHandled?.(props.shareRequest);
          if(!live())return;
        }
        const canExport=Boolean(detail?.items_complete&&detail.author_order&&granted(detail,'can_export')&&typeof runtime.downloadText==='function'),
        canSave=controller.available('savePlaylist')&&!draft?.conflict&&draftDirty(detail,draft)&&validMetadata(draft),
        filterOwner=filterSession.opening;
        directory.update({
          state,
          onSelect:selectPlaylist,
          onCreate:()=>openDialog('create'),
          canCreate:!busy&&!creationOpening&&canOpenPlaylistCreation(state,providers)
        });
        if(!live())return;
        const enabled= {
          add:!picker&&controller.available('addTracks')&&typeof runtime.pickTracks==='function',
          missing:canOpenPlaylistCreation(state,providers,'missing'),
          top:controller.available('createAlbumTop'),
          export:canExport&&exportRows.some(row=>row.source_readable!==false),
          share:detail&&(granted(detail,'can_view_sharing')||granted(detail,'can_share')),
          copy:controller.available('copyPlaylist'),
          settings:Boolean(detail),
          filters:Boolean(detail),
          save:canSave,
          discard:Boolean(draft)
        };
        header.update({isCurrent:live,detail,draft,actions:enabled,busy:busy||Boolean(discardRequest),filtersOpen:Boolean(filterOwner),onAction:run});
        if(!live())return;
        if(filterOwner) {
          const childProps= {
            filters,
            rows:exportRows,
            disabled:busy,
            onChange:patch=> {
              const current=controller.getSnapshot();
              if(!busy&&current.mutation.status!=='loading'&&filterSession.current(filterOwner))controller.filter(patch);
            }
          },
          surfaceProps= {
            id:'playlists-filters',
            returnFocus:()=>filterSession.sourceCurrent(filterOwner)?playlistDialogFocusTarget(host,'filters'):null,
            onClose:()=>filterSession.close(filterOwner),
            mount:target=>mountPlaylistFilters(target,runtime,childProps),
            childProps
          };
          if(filterMounted!==filterOwner||!filterSurface) {
            const previous=filterSurface;
            filterSurface=null;
            filterMounted=null;
            previous?.dispose();
            if(!live())return;
            const nextSurface=acquireCurrent(()=>mountPlaylistFilterSurface(filterHost,runtime,surfaceProps));
            if(nextSurface&&live()&&filterSession.opening===filterOwner) {
              filterSurface=nextSurface;
              filterMounted=filterOwner;
            }else nextSurface?.dispose();
          }else filterSurface.update(surfaceProps);
        }else {
          filterSurface?.dispose();
          filterSurface=null;
          filterMounted=null;
        }
        if(!live())return;
        navigationHost.innerHTML=props.navigationError?runtime.alertHtml({
          severity:'error',
          role:'alert',
          message:props.navigationError==='delete'?'The playlist was deleted, but its directory could not be opened. Open Playlists again.':'The playlist could not be opened. Your previous selection has been restored.'
        }):'';
        resource.update({
          value:state.resource,
          label:'Playlists',
          retry:()=>controller.load()
        });
        if(!live())return;
        content.hidden=!detail;
        empty.hidden=Boolean(detail)||state.resource.status!=='ready';
        if(detail) {
          if(title.value!==(draft?.title??detail.title))title.value=draft?.title??detail.title;
          title.readOnly=!granted(detail,'can_edit')||!granted(detail,'can_rename');
          title.disabled=busy;
          if(description.value!==(draft?.description??detail.description))description.value=draft?.description??detail.description;
          description.readOnly=!granted(detail,'can_edit');
          description.disabled=busy;
          metadataNotes.replaceChildren();
          const note=(text,alert=false)=> {
            const p=node(metadataNotes,'p','playlists__note');
            p.setAttribute('role',alert?'alert':'status');
            p.textContent=text;
          };
          note(`${draftDirty(detail,draft)?'Unsaved draft · kept while switching playlists in this session.':'Saved playlist'}${detail.visibility?` · ${detail.visibility}`:''}`);
          if(detail.library_mix) {
            const value=detail.library_mix;
            note(`Last.fm global plays · ${value.songs_per_group} per ${value.selection_basis==='per_artist'?'artist':'album'}${value.auto_update?' · Generated membership is locked; recalculated when the owner opens this playlist':' · Saved snapshot'}${['unavailable','too_large'].includes(value.refresh_status)?' · Refresh unavailable; showing the last computed selection':value.refresh_status==='owner_refresh_required'?' · Showing the owner’s last computed selection':''}`);
            if(Number.isSafeInteger(value.coverage?.excluded_count))note(`${value.coverage.excluded_count} local tracks excluded because popularity or grouping could not be resolved.`);
            if(['queued','running'].includes(value.popularity_refresh_status))note('Last.fm popularity refresh is in progress. Auto-updating mixes use newly resolved counts when the owner next opens them.');
            if(value.popularity_refresh_status==='blocked'||value.popularity_refresh_error)note(`${value.popularity_refresh_error==='not_configured'?'Last.fm popularity refresh is not configured.':'Last.fm popularity refresh is unavailable.'} Resolved cached counts are still used.`);
          }
          if(draft?.conflict)note('This playlist changed on the server. Your draft is preserved. Discard it to reload the current values before saving.',true);
          if(currentIntegration) {
            const playbackProps= {
              controller:integrations,
              state:integration,
              providers,
              hasOrderControl:Boolean(detail.library_mix)
            };
            if(!playback)playback=acquireCurrent(()=>mountPlaylistPlaybackControls(playbackHost,runtime,playbackProps));
            else playback.update(playbackProps);
            if(!live())return;
            if(detail.library_mix) {
              const mixProps= {
                detail,
                scopeKey:state.scopeKey,
                rows:displayedView?.detail===detail&&displayedView.scopeKey===state.scopeKey?displayedView.rows:rows
              };
              if(!mix)mix=acquireCurrent(()=>mountSavedLibraryMixOrder(playback.orderHost,runtime,mixProps));
              else mix.update(mixProps);
            }else {
              mix?.dispose();
              mix=null;
            }
          }else {
            mix?.dispose();
            mix=null;
            playback?.dispose();
            playback=null;
          }
          if(!live())return;
          deniedHost.hidden=currentIntegration||!integrationDenied;
          count.textContent=`${rows.length} displayed tracks`;
          sample.update({
            label:'Sample Playlist',
            disabled:busy||!controller.available('createSamplePlaylist'),
            onClick:()=>controller.mutate('createSamplePlaylist')
          });
          if(!live())return;
          missing.update({
            label:'Missing-only TXT',
            disabled:!canExport||!exportRows.some(row=>row.source_readable!==false&&row.availability!=='local'),
            onClick:()=>exportText(true)
          });
          if(!live())return;
          const tableProps= {
            rows,
            detail,
            controller,
            state,
            selected:selectedRow?.row_key||null,
            currentItemId:currentIntegration?integration.currentItemId:null,
            onSelect:row=> {
              if(!rows.includes(row)||row.source_readable!==true)return;
              selection= {
                scopeKey:state.scopeKey,
                playlistId:detail.playlist_id,
                itemId:row.playlist_item_id,
                rowKey:row.row_key,
                detail
              };
              render();
            },
            onError:notice,
            onDisplayedRowsChange:detail.library_mix?value=> {
              displayedView=value;
              if(mix&&value?.detail===detail&&value.scopeKey===state.scopeKey)mix.update({
                detail,
                scopeKey:state.scopeKey,
                rows:value.rows
              });
            }
            :undefined
          };
          if(!table)table=acquireCurrent(()=>mountPlaylistTracks(tableHost,runtime,tableProps));
          else table.update(tableProps);
          if(!live())return;
          selectionHost.hidden=!selectedRow;
          if(selectedRow) {
            const panelProps= {
              scopeKey:state.scopeKey,
              row:selectedRow,
              readDetail:props.readDetail,
              onClose:closeSelection
            };
            if(!panel)panel=acquireCurrent(()=>mountPlaylistSelectionPanel(panelHost,runtime,panelProps));
            else panel.update(panelProps);
            if(!live())return;
            if(currentIntegration) {
              const matchProps= {
                controller:integrations,
                state:integration,
                onAccepted:()=> {
                  if(playlistIntegrationCurrent(integrations.getSnapshot(),controller.getSnapshot(),selectedItemId))controller.load();
                }
              };
              if(!match)match=acquireCurrent(()=>mountPlaylistMatchReview(matchHost,runtime,matchProps));
              else match.update(matchProps);
            }else {
              match?.dispose();
              match=null;
            }
          }else {
            panel?.dispose();
            panel=null;
            match?.dispose();
            match=null;
          }
        }else {
          table?.dispose();
          table=null;
          panel?.dispose();
          panel=null;
          match?.dispose();
          match=null;
          mix?.dispose();
          mix=null;
          playback?.dispose();
          playback=null;
        }
        if(!live())return;
        retryHost.hidden=mutationHost.hidden=Boolean(dialog);
        retry.update({
          scopeKey:state.scopeKey,
          available:!dialog&&providers.hasPendingPlaylistOperation?.({
            scopeKey:state.scopeKey,
            action:'create'
          })===true,
          retry:()=>providers.retryPlaylistOperation({
            scopeKey:state.scopeKey,
            action:'create'
          }),
          current:()=>!disposed&&controller.getSnapshot().scopeKey===state.scopeKey,
          onRecovered:async()=> {
            await controller.load();
            notice('Your previous playlist was created. Check Playlists before starting another.');
          }
        });
        if(!live())return;
        mutation.update({
          value:dialog? {
            status:'idle'
          }
          :state.mutation,
          controller
        });
        if(!live())return;
        messageHost.innerHTML=message?runtime.alertHtml({
          severity:'info',
          role:'status',
          message
        }):'';
        if(dialog) {
          const dialogProps= {
            controller,
            state,
            readDetail:props.readDetail,
            mode:dialog.kind==='missing'?'missing':'ordinary',
            providers,
            onClose:closeDialog,
            onNavigate:id=>props.onSelect(id),
            onPrepareDraft:props.onPrepareDraft,
            onNotice:notice
          };
          if(dialogMounted!==dialog||!dialogView) {
            const owner=dialog,
            previous=dialogView;
            dialogView=null;
            dialogMounted=null;
            previous?.dispose();
            if(!live())return;
            const mount=['create','missing'].includes(owner.kind)?mountPlaylistCreationSession:owner.kind==='share'?mountSharePlaylist:mountPlaylistSettings;
            const view=acquireCurrent(()=>mount(dialogHost,runtime,dialogProps));
            if(view&&live()&&dialog===owner) {
              dialogView=view;
              dialogMounted=owner;
            }else view?.dispose();
          }else dialogView.update(dialogProps);
        }
      }finally {
        rendering=false;
        if(again) {
          again=false;
          render();
        }
      }
    }
    const keydown=event=> {
      if(event.key==='Escape'&&!event.defaultPrevented&&selection) {
        event.preventDefault();
        event.stopPropagation();
        closeSelection({
          rowKey:selection.rowKey,
          restoreFocusRequested:true
        });
      }
    };
    scope.listen(selectionHost,'keydown',keydown);
    render();
    return {
      element:host,
      update(next) {
        if(disposed)return;
        contextVersion++;
        props= {
          integrationProviders:EMPTY_PROVIDERS,
          ...next
        };
        render();
      },
      dispose() {
        if(disposed)return;
        disposed=true;
        contextVersion++;
        scope.dispose();
      }
    };
  }catch(error) {
    disposed=true;
    contextVersion++;
    scope.dispose();
    throw error;
  }
}
