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
    const pending={signal};pending.promise=fetchTrackModalAlbumDetails(albumRef,{signal,
      // Queue owns the one captured-epoch batch for these metadata/play reads.
      admitPreferences:false,isCurrent:()=>TrackActionsRuntime.scope().token===scope.token}).finally(()=>{if(request===pending)request=null;});
    request=pending;return pending.promise;
  };
  return rows.map(row=>{
    const inventoryRef=row?.inventory_track_ref,path=String(row?.path||'');
    let canonicalRef=row?.canonical_track_ref||null;
    if(!path||row.source_readable===false||row.availability==='missing')throw new Error('This Album track is unavailable.');
    const metadata=explicitQueueAlbumMetadata(album,row);
    return Object.freeze({display:Object.freeze({title:metadata.title,artist:metadata.artist,album:metadata.album_title}),
      isCurrent:()=>TrackActionsRuntime.scope().token===scope.token,
      async resolveMetadata({signal}={}) {
        if(signal?.aborted||TrackActionsRuntime.scope().token!==scope.token)throw Object.assign(new Error('Queue source was superseded.'),{name:'AbortError'});
        const fresh=await load(signal);
        if(signal?.aborted||TrackActionsRuntime.scope().token!==scope.token)throw Object.assign(new Error('Queue source was superseded.'),{name:'AbortError'});
        const matches=(fresh?.track_rows||[]).filter(track=>inventoryRef?track.inventory_track_ref===inventoryRef:track.path===path);
        const track=matches.length===1?matches[0]:null;
        if(getAlbumPlaybackQueueRef(fresh)!==albumRef||fresh?.source_readable===false||fresh?.allowed_actions?.can_read===false
          ||!track||track.source_readable===false||track.allowed_actions?.can_read===false)
          throw Object.assign(new Error('This Album source is unavailable.'),{status:403});
        if(canonicalRef&&track.canonical_track_ref&&canonicalRef!==track.canonical_track_ref)
          throw Object.assign(new Error('This Album track identity changed.'),{status:409});
        canonicalRef ||= track.canonical_track_ref||null;
        return {...track,...explicitQueueAlbumMetadata(fresh,track),source_readable:true,
          availability:track.availability??(track.playback_state?.can_start_here===true?'local':'unknown')};
      },
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

// Both temporary Mix starts and explicit-queue returns revalidate the captured
// source. A temporary source ref is never used as a saved Playlist identity.
async function readLibraryMixNativeQueue({sourceRef, sourceRevision, entryRefs, startingEntryRef, signal, sourceProtocol = 'library_mix_selection_v1'}) {
  const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  if (!uuid(sourceRef) || !uuid(sourceRevision) || !Array.isArray(entryRefs) || !entryRefs.length || entryRefs.length > 5000
    || entryRefs.some(ref => !uuid(ref)) || new Set(entryRefs).size !== entryRefs.length || !entryRefs.includes(startingEntryRef))
    throw new Error('Mix queue membership is unavailable.');
  const routes = {library_mix_selection_v1: 'library-mix', artist_popular_selection_v1: 'artist-popular', artist_loved_selection_v1: 'artist-loved'};
  if (!Object.hasOwn(routes, sourceProtocol)) throw new Error('Mix protocol is unavailable.');
  const route = routes[sourceProtocol];
  const reply = await PrivateUITransport.request(`/playlists/creation-source/${route}/native-queue`, {
    method: 'POST', signal, body: {source_ref: sourceRef, source_revision: sourceRevision,
      entry_refs: entryRefs, starting_entry_ref: startingEntryRef}});
  const data = reply?.data;
  if (reply.status !== 'ready' || data?.source_protocol !== sourceProtocol || data.source?.kind !== 'library'
    || data.source.ref !== sourceRef || data.source.revision !== sourceRevision || data.starting_item_ref !== startingEntryRef
    || !Array.isArray(data.tracks) || !Array.isArray(data.unavailable_item_refs)) throw new Error('Mix playback was not acknowledged.');
  const admitted = data.tracks.map(item => item?.playlist_item_id), missing = new Set(data.unavailable_item_refs);
  const returned = [...admitted, ...data.unavailable_item_refs], requested = new Set(entryRefs);
  if (returned.length !== entryRefs.length || new Set(returned).size !== returned.length || returned.some(ref => !requested.has(ref))
    || !admitted.includes(startingEntryRef) || JSON.stringify(admitted) !== JSON.stringify(entryRefs.filter(ref => !missing.has(ref))))
    throw new Error('Mix queue membership changed.');
  for (const item of data.tracks) {
    const target = item.native_target;
    if (typeof target?.path !== 'string' || !target.path || target.playlist_item_id !== item.playlist_item_id
      || !TrackActionsRuntime.canPlay({...target, playback_state: {can_start_here: true}})) throw new Error('Mix playback is unavailable.');
  }
  return data;
}

async function refreshExplicitQueueReturnTrack(context, track, {signal} = {}) {
  const queue=context?.nativeQueue;
  if (queue?.libraryMixRef && !queue.playlistId && track?.playlistItemId) {
    const data = await readLibraryMixNativeQueue({sourceRef: queue.libraryMixRef, sourceRevision: queue.playlistRevision,
      entryRefs: queue.sourceEntryRefs, startingEntryRef: track.playlistItemId, signal, sourceProtocol:queue.libraryMixProtocol});
    const target = data.tracks.find(item => item.playlist_item_id === track.playlistItemId)?.native_target;
    if (target?.path !== track.path) throw new Error('The temporary Mix playback context is unavailable.');
    return {...track, title: target.title, artist: target.artist, album: target.album_title, durationSeconds: target.duration_seconds};
  }
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
    let canonicalRef=row?.canonical_track_ref||null;
    if(!path||row.source_readable===false||row.availability==='missing')throw new Error('This Loose Track is unavailable.');
    return Object.freeze({display:Object.freeze({title:String(row.title||''),artist:String(row.artist||''),album:''}),
      isCurrent:()=>TrackActionsRuntime.scope().token===scope.token,
      async resolveMetadata({signal}={}) {
        if(signal?.aborted||TrackActionsRuntime.scope().token!==scope.token)throw Object.assign(new Error('Queue source was superseded.'),{name:'AbortError'});
        const {response,fresh}=await load(signal);
        if(signal?.aborted||TrackActionsRuntime.scope().token!==scope.token)throw Object.assign(new Error('Queue source was superseded.'),{name:'AbortError'});
        if(!response.ok)throw Object.assign(new Error('The Loose Tracks source is unavailable.'),{status:response.status});
        const matches=(fresh?.non_album_tracks||[]).filter(track=>inventoryRef?track.inventory_track_ref===inventoryRef:track.path===path);
        const track=matches.length===1?matches[0]:null;
        if(fresh?.ok===false||fresh?.source_readable===false||fresh?.allowed_actions?.can_read===false
          ||!track||track.source_readable===false||track.allowed_actions?.can_read===false)
          throw Object.assign(new Error('The Loose Tracks source is unavailable.'),{status:403});
        if(canonicalRef&&track.canonical_track_ref&&canonicalRef!==track.canonical_track_ref)
          throw Object.assign(new Error('This Loose Track identity changed.'),{status:409});
        canonicalRef ||= track.canonical_track_ref||null;
        // Unresolved personal metadata is unknown, not a read-only Off denial.
        const preferenceInventory=typeof track.inventory_track_ref==='string'
          ?track.inventory_track_ref.match(/^inventory-track:([1-9]\d*):[1-9]\d*$/):null;
        const preferenceAvailable=track.track_preference_state==='available'&&preferenceInventory?.[1]===scope.library
          &&typeof track.canonical_track_ref==='string'&&Boolean(track.canonical_track_ref.trim())
          &&!fresh.read_only_subject&&!track.read_only_subject&&fresh.readable!==false&&track.readable!==false
          &&(!Object.hasOwn(fresh.allowed_actions||{},'can_read')||fresh.allowed_actions.can_read===true)
          &&(!Object.hasOwn(track.allowed_actions||{},'can_read')||track.allowed_actions.can_read===true);
        return {...track,track_ref:Object.hasOwn(track,'track_ref')?track.track_ref:track.path,album_title:'',source_readable:true,
          track_preference:preferenceAvailable?track.track_preference:null,
          availability:track.availability??(track.playback_state?.can_start_here===true?'local':'unknown')};
      },
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
