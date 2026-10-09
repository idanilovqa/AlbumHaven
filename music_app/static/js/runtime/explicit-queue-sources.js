/* Native Album captures survive navigation, but never survive actor/session
   replacement. Fresh album details retain server authority over playback. */
let explicitQueueAlbumSourceSerial = 0;
function explicitQueueAlbumMetadata(album,row) {
  // Table rows are authority projections. Their secondary_artist deliberately
  // omits the primary artist; recover metadata only from the exact native track.
  const matches=(album?.tracks||[]).filter(track=>track.path===row.path
    &&(!row.inventory_track_ref||!track.inventory_track_ref||track.inventory_track_ref===row.inventory_track_ref));
  const track=matches.length===1?matches[0]:null;
  return {title:String(track?.title||row.title||''),
    artist:String(track?.artist||row.artist||track?.album_artist||album?.album_artist||row.secondary_artist||''),
    album_title:String(track?.album||row.album_title||album?.name||album?.album||album?.title||'')};
}

function captureNativeAlbumQueueSources(album, rows) {
  const scope=TrackActionsRuntime.scope(),albumRef=getAlbumPlaybackQueueRef(album);
  if(!scope.actor||!scope.library||!albumRef||!Array.isArray(rows)||!rows.length)return null;
  const detailRef=`queue-album-source:${++explicitQueueAlbumSourceSerial}`;
  let request=null;
  const load=signal=>{
    if(request&&request.signal===signal)return request.promise;
    const pending={signal};pending.promise=fetchTrackModalAlbumDetails(albumRef,{signal}).finally(()=>{if(request===pending)request=null;});
    request=pending;return pending.promise;
  };
  return rows.map(row=>{
    const inventoryRef=row?.inventory_track_ref,path=String(row?.path||'');
    if(!path||row.source_readable===false||row.availability==='missing')throw new Error('This Album track is unavailable.');
    const metadata=explicitQueueAlbumMetadata(album,row);
    return Object.freeze({display:Object.freeze({title:metadata.title,artist:metadata.artist,album:metadata.album_title}),
      isCurrent:()=>TrackActionsRuntime.scope().token===scope.token,
      async resolve({signal}={}) {
        if(signal?.aborted||TrackActionsRuntime.scope().token!==scope.token)throw Object.assign(new Error('Queue source was superseded.'),{name:'AbortError'});
        const fresh=await load(signal);
        if(fresh?.source_readable===false||fresh?.allowed_actions?.can_read===false)throw Object.assign(new Error('This Album source is unavailable.'),{status:403});
        if(signal?.aborted||TrackActionsRuntime.scope().token!==scope.token||getAlbumPlaybackQueueRef(fresh)!==albumRef
          ||fresh.source_readable===false||fresh.allowed_actions?.can_play_album===false)throw new Error('This Album source is unavailable.');
        const matches=(fresh.track_rows||[]).filter(track=>inventoryRef?track.inventory_track_ref===inventoryRef:track.path===path);
        const track=matches.length===1?matches[0]:null;
        if(track?.source_readable===false||track?.allowed_actions?.can_read===false)throw Object.assign(new Error('This Album track is unavailable.'),{status:403});
        if(!track||track.path!==path||track.source_readable===false||track.playback_state?.can_start_here!==true
          ||['missing','unknown','unresolved'].includes(track.availability))throw new Error('This Album track is unavailable.');
        return {...track,...explicitQueueAlbumMetadata(fresh,track)};
      },
      async resolvePlaylistItem({signal}={}) {
        const fresh=await load(signal);
        if(signal?.aborted||TrackActionsRuntime.scope().token!==scope.token)throw Object.assign(new Error('Queue source was superseded.'),{name:'AbortError'});
        const matches=(fresh?.track_rows||[]).filter(track=>inventoryRef?track.inventory_track_ref===inventoryRef:track.path===path);
        const track=matches.length===1?matches[0]:null;
        if(getAlbumPlaybackQueueRef(fresh)!==albumRef||fresh?.source_readable===false||fresh?.allowed_actions?.can_read===false
          ||!track||track.path!==path||track.source_readable===false||track.allowed_actions?.can_read===false)
          throw Object.assign(new Error('This Album source is unavailable.'),{status:403});
        return {...track,source_provenance:Object.freeze({kind:'inventory',track_ref:track.inventory_track_ref})};
      },
      async resolveDetails(kind,{signal}={}) {
        if(kind!=='album')throw new Error('This queued source has no authorized Artist target.');
        const current=()=>!signal?.aborted&&TrackActionsRuntime.scope().token===scope.token;
        if(!current())throw new Error('This Album source is unavailable.');
        const fresh=await load(signal);
        const matches=(fresh?.track_rows||[]).filter(track=>inventoryRef?track.inventory_track_ref===inventoryRef:track.path===path);
        if(!current()||getAlbumPlaybackQueueRef(fresh)!==albumRef||fresh.source_readable===false
          ||fresh.allowed_actions?.can_read===false||fresh.allowed_actions?.can_view_details===false
          ||album.allowed_actions?.can_view_details===false||matches.length!==1||matches[0].source_readable===false
          ||matches[0].allowed_actions?.can_read===false||matches[0].allowed_actions?.can_view_details===false)throw Object.assign(new Error('This Album source is unavailable.'),{status:403});
        // This is a private receipt identity, not a claimed canonical catalog ID.
        // The native album request key never enters the Queue display snapshot.
        const canOpen=fresh.allowed_actions?.can_open_album!==false&&album.allowed_actions?.can_open_album!==false;
        const target=Object.freeze({kind:'album',ref:detailRef,allowed_actions:Object.freeze({can_view_details:true}),
          native_actions:Object.freeze({album_ref:albumRef,allowed_actions:Object.freeze({can_open_album:canOpen,
            can_play_album:canOpen&&album.allowed_actions?.can_play_album!==false&&fresh.allowed_actions?.can_play_album!==false
              &&(!window.AlbumHavenCapabilities||window.AlbumHavenCapabilities.allows('library.media.read')===true)&&fresh.track_rows.some(track=>track.playback_state?.can_start_here===true),
            can_view_artwork:canOpen&&album.allowed_actions?.can_view_artwork!==false&&fresh.allowed_actions?.can_view_artwork!==false,
            can_open_album_page:canOpen&&album.allowed_actions?.can_open_album_page!==false&&fresh.allowed_actions?.can_open_album_page!==false})})});
        const data=Object.freeze({kind:'album',ref:detailRef,title:String(fresh.name||fresh.album||fresh.title||''),
          artist:String(fresh.album_artist||fresh.artist||''),year:fresh.year==null?null:String(fresh.year),
          metadata_state:['current','last_known'].includes(fresh.metadata_state)?fresh.metadata_state:'unknown',
          source_label:'Local library',track_count:fresh.track_rows.length,tracks:null});
        return Object.freeze({target,data,isCurrent:current});
      }});
  });
}

async function refreshExplicitQueueReturnTrack(context, track, {signal} = {}) {
  const queue=context?.nativeQueue;
  if(queue?.playlistId&&track?.playlistItemId) {
    const reply=await PrivateUITransport.request(`/playlists/${encodeURIComponent(queue.playlistId)}/items/${encodeURIComponent(track.playlistItemId)}/native-target?intent=play`,{signal});
    const value=reply?.data,target=value?.native_target;
    if(reply.status!=='ready'||value.playlist_id!==queue.playlistId||value.playlist_item_id!==track.playlistItemId
      ||value.revision!==queue.playlistRevision||value.intent!=='play'||target?.path!==track.path
      ||target.playlist_item_id!==track.playlistItemId)throw new Error('The saved Playlist playback context is unavailable.');
    return {...track,title:target.title,artist:target.artist,album:target.album_title,durationSeconds:target.duration_seconds};
  }
  if(queue?.albumRef&&queue.albumSnapshot) {
    const row=(queue.albumSnapshot.track_rows||[]).find(value=>value.path===track.path);
    const captures=captureNativeAlbumQueueSources(queue.albumSnapshot,[row||track]);
    const fresh=await captures[0].resolve({signal});
    return {...track,title:fresh.title,artist:fresh.artist,album:fresh.album_title,durationSeconds:fresh.duration_seconds};
  }
  throw new Error('This playback context cannot be refreshed.');
}

function captureNativeLooseQueueSources(view, rows) {
  const scope=TrackActionsRuntime.scope(),url=buildApiUrl(view,{payloadTier:'full'});
  if(!scope.actor||!scope.library||!Array.isArray(rows)||!rows.length||!url.startsWith('/view-data'))return null;
  let request=null;
  const load=signal=>{
    if(request&&request.signal===signal)return request.promise;
    const pending={signal};pending.promise=fetch(url,{headers:{Accept:'application/json'},credentials:'same-origin',cache:'no-store',signal})
      .then(async response=>({response,fresh:await response.json()})).finally(()=>{if(request===pending)request=null;});
    request=pending;return pending.promise;
  };
  return rows.map(row=>{
    const inventoryRef=row?.inventory_track_ref,path=String(row?.path||'');
    if(!path||row.source_readable===false||row.availability==='missing')throw new Error('This Loose Track is unavailable.');
    return Object.freeze({display:Object.freeze({title:String(row.title||''),artist:String(row.artist||''),album:''}),
      isCurrent:()=>TrackActionsRuntime.scope().token===scope.token,
      async resolvePlaylistItem({signal}={}) {
        const {response,fresh}=await load(signal);
        if(!response.ok)throw Object.assign(new Error('The Loose Tracks source is unavailable.'),{status:response.status});
        if(signal?.aborted||TrackActionsRuntime.scope().token!==scope.token)throw Object.assign(new Error('Queue source was superseded.'),{name:'AbortError'});
        const matches=(fresh?.non_album_tracks||[]).filter(track=>inventoryRef?track.inventory_track_ref===inventoryRef:track.path===path);
        const track=matches.length===1?matches[0]:null;
        if(fresh?.ok===false||fresh?.source_readable===false||fresh?.allowed_actions?.can_read===false
          ||!track||track.path!==path||track.source_readable===false||track.allowed_actions?.can_read===false)
          throw Object.assign(new Error('The Loose Tracks source is unavailable.'),{status:403});
        return {...track,source_provenance:Object.freeze({kind:'inventory',track_ref:track.inventory_track_ref})};
      },
      async resolve({signal}={}) {
        const {response,fresh}=await load(signal);
        if(!response.ok)throw Object.assign(new Error('The Loose Tracks source is unavailable.'),{status:response.status});
        if(fresh?.source_readable===false||fresh?.allowed_actions?.can_read===false)throw Object.assign(new Error('The Loose Tracks source is unavailable.'),{status:403});
        if(signal?.aborted||TrackActionsRuntime.scope().token!==scope.token||fresh?.ok===false)throw new Error('The Loose Tracks source is unavailable.');
        const matches=(fresh.non_album_tracks||[]).filter(track=>inventoryRef?track.inventory_track_ref===inventoryRef:track.path===path);
        const track=matches.length===1?matches[0]:null;
        if(track?.source_readable===false||track?.allowed_actions?.can_read===false)throw Object.assign(new Error('This Loose Track is unavailable.'),{status:403});
        if(!track||track.path!==path||track.source_readable===false||track.playback_state?.can_start_here!==true
          ||['missing','unknown','unresolved'].includes(track.availability))throw new Error('This Loose Track is unavailable.');
        return {...track,album_title:''};
      }});
  });
}
