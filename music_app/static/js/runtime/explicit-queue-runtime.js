/* One session-local planner around the existing native queue and streaming
   facade. Source callbacks hold private authority; public snapshots never do. */
const ExplicitQueueRuntime = (() => {
  let scopeToken=null, planner=null, serial=0, session=0, generation=0, snapshot=null;
  let prepared=null, refreshController=null, pendingStart=null, snapshotFacts='', successorCache=null;
  const sources=new Map(), listeners=new Set(), trackKeys=new WeakMap(), queues=new WeakMap();
  const aborted=()=>Object.assign(new Error('Queue action was superseded.'),{name:'AbortError'});
  const notify=()=>{snapshot=null;for(const listener of [...listeners])try{listener();}catch{/* Paint cannot change playback. */}};
  const playback=()=>typeof getPlayerPlaybackSnapshot==='function'?getPlayerPlaybackSnapshot():{};
  const permitted=()=>!window.AlbumHavenCapabilities || window.AlbumHavenCapabilities.allows?.('library.media.read')===true;
  const sourceCurrent=(source,media=true)=>{try{return source?.scope===scopeToken&&source.capture.isCurrent()===true&&(!media||permitted());}catch{return false;}};
  const denySource=source=>{
    source.readable=false;source.authorityEpoch=(source.authorityEpoch||0)+1;
    const entry=prepared?.next?.source==='explicit'&&planner?.getSnapshot().entries.find(value=>value.id===prepared.next.entryId);
    if(entry&&sources.get(entry.trackId)===source){refreshController?.abort();generation++;prepared=null;retireContinuity('queue-source-revoked');}
  };
  const playable=id=>{const source=sources.get(id);return Boolean(sourceCurrent(source)&&source.readable!==false&&source.target&&TrackActionsRuntime.canPlay(source.target));};
  function sync() {
    const scope=TrackActionsRuntime.scope();
    if(scope.token!==scopeToken) {
      const retiring=prepared, wasExplicit=Boolean(planner?.getSnapshot().currentId), oldStart=pendingStart;
      refreshController?.abort();generation++;prepared=null;successorCache=null;pendingStart=null;sources.clear();scopeToken=scope.token;
      planner=createExplicitQueuePlanner({canPlay:playable});session++;snapshot=null;oldStart?.abort();
      if(retiring)retireContinuity('queue-session-changed');
      if(wasExplicit&&typeof stopStreamingPlayback==='function') {
        const stopped=stopStreamingPlayback('queue-session-changed');
        if(typeof observeStreamingFacadeCallback==='function')observeStreamingFacadeCallback(stopped,'queue-session-changed');else void Promise.resolve(stopped).catch(()=>{});
      }
    }
    return Boolean(scope.actor&&scope.library);
  }
  function retireContinuity(reason) {
    const engine=typeof streamingEngineState==='function'?streamingEngineState():null;
    if(!engine||state.player.loopActive)return;
    engine.pendingContinuityTrack=null;engine.pendingContinuityOptions=null;
    if(engine.roles?.continuity&&closeStreamingContinuityRole(reason)!==true&&typeof stopStreamingPlayback==='function') {
      const stopped=stopStreamingPlayback(reason);
      if(typeof observeStreamingFacadeCallback==='function')observeStreamingFacadeCallback(stopped,reason);else void Promise.resolve(stopped).catch(()=>{});
    }
  }
  const trackKey=track=>{if(!trackKeys.has(track))trackKeys.set(track,`ordinary-${++serial}`);return trackKeys.get(track);};
  function describe(queue=state.player.playbackQueue,current=state.player.current,indexOverride=null) {
    if(queue?.explicitQueue===true) return playback().ended ? Object.freeze({...queue.explicitContext,ended:true}) : queue.explicitContext;
    let tracks=queue?.tracks;
    if(!Array.isArray(tracks)||!tracks.length)tracks=current?[current]:[];
    let index=indexOverride;
    if(index===null) {
      if(queue?.playlistId)index=playlistQueueCurrentIndex(queue,String(current?.path||''),current?.playlistItemId);
      else {index=Number.isSafeInteger(queue?.currentIndex)&&tracks[queue.currentIndex]?.path===current?.path?queue.currentIndex:tracks.indexOf(current);
        if(index<0)index=tracks.findIndex(track=>track.path===current?.path);}
    }
    if(queue&&!queues.has(queue))queues.set(queue,++session);
    const source=queue?.playlistId?'playlist':queue?.albumRef?'album':'track';
    const fullAlbumPaths=source==='album'?(queue.albumSnapshot?.tracks||[]).map(track=>String(track.path||'')):[];
    const queuedPaths=tracks.map(track=>String(track.path||''));
    const albumComplete=source!=='album'||fullAlbumPaths.length>0&&fullAlbumPaths.every(Boolean)
      &&JSON.stringify([...fullAlbumPaths].sort())===JSON.stringify([...queuedPaths].sort());
    const ids=tracks.map(trackKey),albums=tracks.map(track=>source==='album'?String(queue.albumRef):String(track.albumRef||track.album_ref||''));
    return Object.freeze({session:queue?queues.get(queue):session,source,tracks:Object.freeze(ids),albums:Object.freeze(albums),
      index,albumComplete,repeat:queue?.repeatMode||'off',shuffle:queue?.shuffle===true,ended:index<0||index>=tracks.length||indexOverride===null&&playback().ended===true,
      nativeQueue:queue,nativeTracks:tracks});
  }
  function successor(before) {
    if(before.source==='explicit')return Object.freeze({...before,ended:true});
    const queue=before.nativeQueue;
    if(!queue)return Object.freeze({...before,ended:true});
    let index=before.index+1;
    if(queue.playlistId)index=playlistQueueNextIndex(queue,String(state.player.current?.path||''));
    if(index>=0&&index<queue.tracks.length)return describe(queue,queue.tracks[index],index);
    if(successorCache&&sameContext(successorCache.before,before)&&successorCache.playbackContext===queue.playbackContext)return successorCache.next;
    const next=queue.playlistId?null:resolveNextPlaybackContextQueue(queue);
    if(next)queues.set(next,before.session);
    const context=next?describe(next,next.tracks[0],0):Object.freeze({...before,ended:true});
    successorCache={before,playbackContext:queue.playbackContext,next:context};return context;
  }
  const stopPriority=()=>state.player.loopActive===true || typeof isPlaybackLockedByAnotherTab==='function'&&isPlaybackLockedByAnotherTab();
  function preview() {
    sync();const before=describe();planner.reconcile(before);
    return planner.preview(before,successor(before),{stopPriority:stopPriority()}).next;
  }
  function payload(context) {
    if(!context||context.ended)return null;
    if(context.source==='explicit') {
      const item=planner.getSnapshot().entries.find(entry=>entry.id===context.entryId),target=sources.get(item?.trackId)?.target;
      return target?{src:`/track?path=${encodeURIComponent(target.path)}`,path:target.path,title:target.title,
        artist:target.artist||target.secondary_artist,album:target.album_title,durationSeconds:target.duration_seconds,
        explicitEntryId:context.entryId,inventory_track_ref:target.inventory_track_ref}:null;
    }
    return context.nativeTracks?.[context.index]||null;
  }
  const sameContext=(a,b)=>a?.session===b?.session&&a?.source===b?.source&&a?.entryId===b?.entryId
    &&a?.index===b?.index&&a?.tracks?.[a.index]===b?.tracks?.[b.index]&&a?.ended===b?.ended
    &&a?.repeat===b?.repeat&&a?.shuffle===b?.shuffle&&a?.albumComplete===b?.albumComplete&&JSON.stringify(a?.tracks)===JSON.stringify(b?.tracks);
  function editable() {
    sync();const engine=typeof streamingEngineState==='function'?streamingEngineState():null;
    if(pendingStart||engine?.pendingPromotion||engine?.roles?.current?.boundaryNotified)throw new Error('Wait for the current track transition before editing the Queue.');
    if(!state.player.loopActive&&engine?.roles?.continuity
      && (typeof closeStreamingContinuityRole!=='function'||closeStreamingContinuityRole('explicit-queue-change')!==true))throw new Error('The Queue transition is already starting.');
    refreshController?.abort();generation++;prepared=null;
    if(engine&&!state.player.loopActive){engine.pendingContinuityTrack=null;engine.pendingContinuityOptions=null;}
  }
  async function resolve(source,signal) {
    if(signal.aborted||!sourceCurrent(source))throw aborted();
    const authorityEpoch=source.authorityEpoch,target=await source.capture.resolve({signal});
    if(signal.aborted||!sourceCurrent(source)||source.authorityEpoch!==authorityEpoch)throw aborted();
    if(target?.source_readable===false||target?.allowed_actions?.can_read===false)throw Object.assign(new Error('This queued source is unreadable.'),{status:403});
    if(!target||['missing','unknown','unresolved'].includes(target.availability)
      ||target.allowed_actions?.can_play===false||target.playback_state?.can_start_here!==true||!TrackActionsRuntime.canPlay(target))throw new Error('This queued track is unavailable.');
    return Object.freeze({...target});
  }
  async function refresh() {
    sync();if(stopPriority())return null;
    const engine=typeof streamingEngineState==='function'?streamingEngineState():null;
    if(!engine?.roles?.current||engine.pendingPromotion||engine.roles.current.boundaryNotified)return null;
    if(!planner.getSnapshot().entries.length&&!planner.getSnapshot().currentId) {
      const ordinary=peekNextOrdinaryQueuedTrack();if(ordinary)await scheduleStreamingContinuity(ordinary);return ordinary;
    }
    if(prepared&&engine.roles.continuity&&closeStreamingContinuityRole('explicit-queue-refresh')!==true)return null;
    prepared=null;engine.pendingContinuityTrack=null;engine.pendingContinuityOptions=null;
    refreshController?.abort();const controller=new AbortController();refreshController=controller;
    const token=++generation,before=describe();let candidate=preview();
    try {
      // Fresh authorization is required before handing media to native preload.
      while(candidate?.source==='explicit'&&!candidate.ended) {
        const entry=planner.getSnapshot().entries.find(value=>value.id===candidate.entryId),source=sources.get(entry?.trackId);
        try {source.target=await resolve(source,controller.signal);source.readable=true;}
        catch(error){if(controller.signal.aborted||token!==generation)throw aborted();if(source){source.target=null;if([401,403,404].includes(error.status))denySource(source);}notify();candidate=preview();continue;}
        break;
      }
      if(controller.signal.aborted||token!==generation||!sameContext(before,describe())||stopPriority())return null;
      let track=payload(candidate);
      if(track&&candidate.source!=='explicit') {
        try {track=await refreshExplicitQueueReturnTrack(candidate,track,{signal:controller.signal});}
        catch(error) {if(controller.signal.aborted||token!==generation)throw aborted();prepared=null;planner.halt();notify();return null;}
      }
      if(controller.signal.aborted||token!==generation||!sameContext(before,describe())||stopPriority())return null;
      if(!track){prepared=null;return null;}
      prepared={before,next:candidate,track,generation:token};
      await scheduleStreamingContinuity(track);
      return track;
    } finally {if(refreshController===controller)refreshController=null;}
  }
  function reschedule() {const pending=refresh();if(typeof observeStreamingFacadeCallback==='function')observeStreamingFacadeCallback(pending,'explicit-queue-refresh');else void pending.catch(()=>{});}
  function prune() {const retained=new Set(planner.getSnapshot().entries.map(entry=>entry.trackId));for(const key of sources.keys())if(!retained.has(key))sources.delete(key);}
  function changed() {prune();notify();reschedule();}
  function install(context) {
    if(context?.source==='explicit'&&!context.ended)state.player.playbackQueue={explicitQueue:true,explicitContext:context,
      tracks:[payload(context)],currentIndex:0};
    else if(context&&!context.ended){state.player.playbackQueue=context.nativeQueue;state.player.playbackQueue.currentIndex=context.index;}
    else state.player.playbackQueue=null;
  }
  function getSnapshot() {
    sync();let value=planner.getSnapshot();const context=describe();
    const preparedEntry=prepared?.next?.source==='explicit'&&value.entries.find(entry=>entry.id===prepared.next.entryId);
    if(preparedEntry&&!playable(preparedEntry.trackId)) {refreshController?.abort();generation++;prepared=null;retireContinuity('queue-source-revoked');value=planner.getSnapshot();}
    const facts=JSON.stringify([value.revision,context.session,context.index,context.source,context.entryId,playback().ended,
      Boolean(state.player.current),stopPriority(),value.entries.map(entry=>[playable(entry.trackId),sourceCurrent(sources.get(entry.trackId),false),sources.get(entry.trackId)?.readable])]);
    if(snapshot&&snapshotFacts===facts)return snapshot;
    snapshotFacts=facts;
    const entries=value.entries.map(entry=>{
      const source=sources.get(entry.trackId),available=playable(entry.trackId),current=entry.id===value.currentId;
      return Object.freeze({id:entry.id,blockId:entry.blockId,...(sourceCurrent(source,false)&&source?.readable!==false?source?.display:{title:'Unavailable track',artist:'',album:''}),timing:entry.timing,ready:entry.ready,current,sourceReadable:sourceCurrent(source,false)&&source?.readable!==false,
        canPlay:available&&!stopPriority()&&planner.canStart(entry.id,playback().ended||!state.player.current?null:context),
        status:!available?'Unavailable · source or local track':current?'Current queued track':entry.invalid?`Unavailable · ${entry.invalid}`
          :!value.enabled?'Paused · queue is deactivated':value.halted?'Paused · playback stopped'
          :entry.ready?'Ready':`Waiting · ${EXPLICIT_QUEUE_TIMINGS[entry.timing].toLowerCase()}`});
    });
    snapshot=Object.freeze({enabled:value.enabled,halted:value.halted,currentId:value.currentId,entries:Object.freeze(entries),revision:value.revision});
    return snapshot;
  }
  function playlistProvenance(value,trackRef) {
    const exact=(record,keys)=>record&&typeof record==='object'&&!Array.isArray(record)
      &&Object.keys(record).length===keys.length&&keys.every(key=>Object.hasOwn(record,key));
    const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
    if(value?.track_ref!==trackRef)throw new Error('This queued track has invalid source provenance.');
    if(value.kind==='inventory'&&exact(value,['kind','track_ref']))return Object.freeze({kind:'inventory',track_ref:trackRef});
    if(value.kind==='playlist'&&exact(value,['kind','track_ref','playlist_ref','revision','item_ref'])
      &&uuid(value.playlist_ref)&&uuid(value.item_ref)&&typeof value.revision==='string'&&/^[1-9]\d*$/.test(value.revision))
      return Object.freeze({kind:'playlist',track_ref:trackRef,playlist_ref:value.playlist_ref,revision:value.revision,item_ref:value.item_ref});
    const origin=value?.origin;
    if(value.kind==='activity'&&exact(value,['kind','track_ref','origin','row_ref'])
      &&exact(origin,['audience','subject_ref','kind','period','snapshot_ref'])
      &&(origin.audience==='own'?origin.subject_ref===null:origin.audience==='friend'&&uuid(origin.subject_ref))
      &&['tracks','listens'].includes(origin.kind)&&['week','month','six','year','all'].includes(origin.period)
      &&typeof origin.snapshot_ref==='string'&&/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(origin.snapshot_ref)
      &&typeof value.row_ref==='string'&&/^activity_[0-9a-f]{64}$/.test(value.row_ref))
      return Object.freeze({kind:'activity',track_ref:trackRef,row_ref:value.row_ref,origin:Object.freeze({
        audience:origin.audience,subject_ref:origin.subject_ref,kind:origin.kind,period:origin.period,snapshot_ref:origin.snapshot_ref})});
    throw new Error('This queued track has invalid source provenance.');
  }
  const api={getSnapshot,subscribe(listener){listeners.add(listener);return()=>listeners.delete(listener);},
    timingOptions(){sync();return Object.freeze(planner.timingOptions(describe()));},
    async enqueue(captures,timing='end',options={}) {
      if(!sync()||!Array.isArray(captures)||!captures.length)throw new Error('Queue sources are unavailable.');
      const actor=scopeToken,before=describe(),selection=playerTrackSelectionToken,controller=new AbortController();
      if(!planner.timingOptions(before).some(option=>option.value===timing&&option.enabled))return [];
      const cancel=()=>controller.abort();options.signal?.addEventListener('abort',cancel,{once:true});
      const active=()=>!controller.signal.aborted&&!options.signal?.aborted&&actor===TrackActionsRuntime.scope().token
        &&(!options.isCurrent||options.isCurrent()===true)&&selection===playerTrackSelectionToken&&sameContext(before,describe());
      const captured=[];
      try {
        if(!active())throw aborted();
        for(const capture of captures) {
          if(typeof capture?.resolve!=='function'||typeof capture.isCurrent!=='function')throw new Error('Queue source cannot be refreshed.');
          const targets={};
          for(const kind of ['album','artist']) {
            const projected=window.AlbumHavenResourceSelection?.projectTarget(capture.display?.[`${kind}Target`]);
            if(projected?.kind===kind) {const {native_actions,...publicTarget}=projected;targets[`${kind}Target`]=Object.freeze(publicTarget);}
          }
          const display=Object.freeze({title:String(capture.display?.title||''),artist:String(capture.display?.artist||''),album:String(capture.display?.album||''),...targets});
          const source={scope:actor,capture,display,target:null,readable:true,authorityEpoch:0};captured.push(source);
        }
        await Promise.all(captured.map(async source=>{source.target=await resolve(source,controller.signal);}));
        if(!active())throw aborted();editable();
        const keys=captured.map(source=>{const key=`request-${++serial}`;sources.set(key,source);return key;});
        const ids=planner.enqueue(keys,timing,before);if(!ids.length)keys.forEach(key=>sources.delete(key));changed();return ids;
      } finally {options.signal?.removeEventListener('abort',cancel);}
    },
    async refresh(options={}) {
      sync();const actor=scopeToken,token=generation,controller=new AbortController();
      const cancel=()=>controller.abort();options.signal?.addEventListener('abort',cancel,{once:true});
      const entries=[...sources.values()];
      if(!entries.length){options.signal?.removeEventListener('abort',cancel);return getSnapshot();}
      try {
        if(options.signal?.aborted)throw aborted();
        const updates=await Promise.all(entries.map(async source=>{try{return {target:await resolve(source,controller.signal),readable:true};}
          catch(error){if(controller.signal.aborted)throw error;return {target:null,readable:![401,403,404].includes(error.status)&&source.readable!==false};}}));
        if(controller.signal.aborted||actor!==TrackActionsRuntime.scope().token||token!==generation)throw aborted();
        editable();entries.forEach((source,index)=>{if(updates[index].readable===false)denySource(source);Object.assign(source,updates[index]);});changed();return getSnapshot();
      } finally {options.signal?.removeEventListener('abort',cancel);}
    },
    async playlistSelection(ids,options={}) {
      sync();const actor=scopeToken;
      if(!Array.isArray(ids)||!ids.length||ids.length>5000||new Set(ids).size!==ids.length)throw new Error('Select queued tracks first.');
      const captured=ids.map(id=>{const entry=planner.getSnapshot().entries.find(value=>value.id===id),source=sources.get(entry?.trackId);
        if(!sourceCurrent(source,false)||typeof source?.capture.resolvePlaylistItem!=='function')throw new Error('This Queue source cannot be added to a Playlist.');
        return {id,entry,source,epoch:source.authorityEpoch};});
      let retired=false;
      const current=()=>{try {if(!retired)retired=Boolean(options.signal?.aborted)||actor!==TrackActionsRuntime.scope().token
        ||Boolean(options.isCurrent&&options.isCurrent()!==true)||captured.some(({id,entry,source,epoch})=>
          !sourceCurrent(source,false)||source.authorityEpoch!==epoch||sources.get(entry.trackId)!==source
          ||!planner.getSnapshot().entries.some(value=>value.id===id&&value.trackId===entry.trackId));
        return !retired;}catch{retired=true;return false;}};
      if(!current())throw aborted();
      const rows=await Promise.all(captured.map(async ({id,source})=>{
        let item;
        try {item=await source.capture.resolvePlaylistItem({signal:options.signal});
          if(item?.source_readable===false||item?.allowed_actions?.can_read===false)throw Object.assign(new Error('This queued source is unreadable.'),{status:403});}
        catch(error){if(actor===TrackActionsRuntime.scope().token&&[401,403,404].includes(error.status)){denySource(source);notify();}throw error;}
        if(!/^inventory-track:[1-9]\d*:[1-9]\d*$/.test(item?.inventory_track_ref||''))throw new Error('This queued track has no current Playlist inventory identity.');
        return Object.freeze({rowKey:id,track_ref:item.inventory_track_ref,
          source_provenance:playlistProvenance(item.source_provenance,item.inventory_track_ref)});
      }));
      if(!current())throw aborted();
      captured.forEach(({source})=>{source.readable=true;});notify();
      return Object.freeze({rows:Object.freeze(rows),isCurrent:()=>current()&&captured.every(({source})=>source.readable!==false),
        rejectSourceRead(status) {
          if(![403,404].includes(status)||!current())return false;
          retired=true;captured.forEach(({source})=>denySource(source));notify();return true;
        }});
    },
    async details(id,kind,options={}) {
      sync();const entry=planner.getSnapshot().entries.find(value=>value.id===id),source=sources.get(entry?.trackId),actor=scopeToken,authorityEpoch=source?.authorityEpoch;
      if(!['album','artist'].includes(kind)||!sourceCurrent(source,false)||typeof source.capture.resolveDetails!=='function')throw new Error('Queued track details are unavailable.');
      let result;
      try {result=await source.capture.resolveDetails(kind,{signal:options.signal});}
      catch(error) {if(actor===TrackActionsRuntime.scope().token&&[401,403,404].includes(error.status)){denySource(source);notify();}throw error;}
      const current=()=>{try {return !options.signal?.aborted&&actor===TrackActionsRuntime.scope().token&&source.authorityEpoch===authorityEpoch&&sourceCurrent(source,false)
        &&sources.get(entry.trackId)===source&&planner.getSnapshot().entries.some(value=>value.id===id&&value.trackId===entry.trackId)
        &&(!options.isCurrent||options.isCurrent()===true)&&typeof result?.isCurrent==='function'&&result.isCurrent()===true;}catch{return false;}};
      if(!current())throw aborted();
      if(source.readable===false){source.readable=true;notify();}
      let retired=false;
      return Object.freeze({...result,isCurrent:()=>{if(!retired)retired=source.readable===false||!current();return !retired;}});
    },
    retime(id,timing){sync();if(!planner.getSnapshot().entries.some(entry=>entry.id===id&&entry.id!==planner.getSnapshot().currentId)
      ||!planner.timingOptions(describe()).some(option=>option.value===timing&&option.enabled))return false;editable();const result=planner.retime(id,timing,describe());changed();return result;},
    reorder(ids){sync();const pending=planner.getSnapshot().entries.filter(entry=>entry.id!==planner.getSnapshot().currentId);
      if(!Array.isArray(ids)||ids.length!==pending.length||new Set(ids).size!==ids.length||ids.some(id=>!pending.some(entry=>entry.id===id)))return false;editable();const result=planner.reorder(ids);changed();return result;},
    remove(id){sync();if(!planner.getSnapshot().entries.some(entry=>entry.id===id&&entry.id!==planner.getSnapshot().currentId))return false;editable();const result=planner.remove(id);changed();return result;},
    clear(ids){if(!Array.isArray(ids))return false;editable();const result=planner.clear(ids);changed();return result;},
    setEnabled(enabled){if(typeof enabled!=='boolean')return false;editable();const result=planner.setEnabled(enabled);changed();return result;},
    async play(id,options={}) {
      sync();const value=planner.getSnapshot(),entry=value.entries.find(item=>item.id===id),source=sources.get(entry?.trackId);
      const current=playback().ended||!state.player.current?null:describe();
      if(stopPriority()||!planner.canStart(id,current)||!source)throw new Error('This Queue entry is not ready to play.');
      editable();const controller=new AbortController(),token=++generation,actor=scopeToken;
      const previousQueue=state.player.playbackQueue;let installed=null,started=false,selectedToken=null;
      const cancel=()=>controller.abort();options.signal?.addEventListener('abort',cancel,{once:true});pendingStart=controller;
      try {
        try {source.target=await resolve(source,controller.signal);source.readable=true;}catch(error){source.target=null;if([401,403,404].includes(error.status))denySource(source);notify();throw error;}
        if(options.signal?.aborted||controller.signal.aborted||token!==generation||actor!==TrackActionsRuntime.scope().token
          ||options.isCurrent&&options.isCurrent()!==true||planner.getSnapshot()!==value)throw aborted();
        const context=planner.start(id,current),track=payload(context);if(!context||!track)throw aborted();
        install(context);installed=planner.getSnapshot();const authorityEpoch=source.authorityEpoch;notify();
        const starting=playTrackFromPayload(track,{explicitQueueTransition:true,signal:controller.signal,isCurrent:()=>
          actor===TrackActionsRuntime.scope().token&&pendingStart===controller&&sourceCurrent(source)&&source.readable!==false&&source.authorityEpoch===authorityEpoch
          &&planner.getSnapshot()===installed&&(!options.isCurrent||options.isCurrent()===true)});
        selectedToken=playerTrackSelectionToken;started=await starting;
        if(started!==true)throw new Error('Queue playback did not start.');return true;
      } finally {
        if(!started&&installed&&planner.getSnapshot().currentId===id&&playerTrackSelectionToken===selectedToken
          &&pendingStart===controller&&state.player.playbackQueue?.explicitContext?.entryId===id) {
          planner.restore(planner.getSnapshot(),{...value,halted:planner.getSnapshot().halted||value.halted});state.player.playbackQueue=previousQueue;notify();
        }
        if(pendingStart===controller)pendingStart=null;options.signal?.removeEventListener('abort',cancel);
      }
    },
  };
  TrackActionsRuntime.subscribePlayback?.(()=>notify());
  PrivateUITransport.subscribe?.(()=>{sync();notify();});
  window.AlbumHavenExplicitQueue=Object.freeze(api);
  return Object.freeze({
    currentChanged(){notify();},
    selectionStarted(){refreshController?.abort();generation++;prepared=null;successorCache=null;},
    hasNext(){sync();if(!planner.getSnapshot().entries.length&&!planner.getSnapshot().currentId)return false;return Boolean(payload(preview()));},
    async skip(offset) {
      sync();const before=describe();if(offset<0)return before.source==='explicit'?false:undefined;
      if(offset!==1||stopPriority()||pendingStart)return false;
      await refresh();const context=preview(),track=prepared&&sameContext(prepared.before,before)&&sameContext(prepared.next,context)?prepared.track:null;
      if(!track||pendingStart||!sameContext(before,describe()))return false;
      const previous=planner.getSnapshot(),previousQueue=state.player.playbackQueue,actor=scopeToken;
      const controller=new AbortController();pendingStart=controller;
      const next=planner.advance(before,successor(before)),selected=planner.getSnapshot();install(next);
      const selectedQueue=state.player.playbackQueue,previousIndex=before.index;
      const selectedEntry=selected.entries.find(entry=>entry.id===selected.currentId),selectedSource=sources.get(selectedEntry?.trackId),authorityEpoch=selectedSource?.authorityEpoch;
      notify();let started=false,selectedToken=null;
      try {const starting=playTrackFromPayload(track,{explicitQueueTransition:true,signal:controller.signal,isCurrent:()=>
        pendingStart===controller&&!controller.signal.aborted&&actor===TrackActionsRuntime.scope().token
        &&(!selectedSource||sourceCurrent(selectedSource)&&selectedSource.readable!==false&&selectedSource.authorityEpoch===authorityEpoch)
        &&planner.getSnapshot()===selected&&state.player.playbackQueue===selectedQueue});
        selectedToken=playerTrackSelectionToken;started=await starting;if(started)prune();return started===true;}
      finally {if(!started&&pendingStart===controller&&actor===TrackActionsRuntime.scope().token
        &&planner.getSnapshot().currentId===selected.currentId&&state.player.playbackQueue===selectedQueue&&playerTrackSelectionToken===selectedToken) {
        planner.restore(planner.getSnapshot(),{...previous,halted:planner.getSnapshot().halted||previous.halted});state.player.playbackQueue=previousQueue;if(previousQueue)previousQueue.currentIndex=previousIndex;notify();}
        if(pendingStart===controller)pendingStart=null;}
    },
    ownsProgression(){sync();return planner.getSnapshot().entries.length>0||Boolean(planner.getSnapshot().currentId);},
    peek(){sync();const next=preview();return prepared&&sameContext(prepared.before,describe())&&sameContext(prepared.next,next)?prepared.track:null;},
    consume(){sync();const before=describe(),next=preview();
      if(!prepared||!sameContext(prepared.before,before)||!sameContext(prepared.next,next))return null;
      const context=planner.advance(before,successor(before),{stopPriority:stopPriority()}),track=payload(context);
      const promoted=prepared&&sameContext(prepared.next,context)?prepared.track:track;
      install(context);prepared=null;prune();snapshot=null;return promoted;},
    prepareNext:refresh,
    replaced(){sync();refreshController?.abort();generation++;prepared=null;successorCache=null;session++;
      if(state.player.playbackQueue)queues.set(state.player.playbackQueue,session);planner.replaceContext();notify();},
    modeChanged(previous,next){sync();successorCache=null;
      const sameSource=previous?.playlistId===next?.playlistId&&previous?.playlistRevision===next?.playlistRevision
        &&(previous?.regularTracks||previous?.tracks)===(next?.regularTracks||next?.tracks);
      if(sameSource&&queues.has(previous))queues.set(next,queues.get(previous));
      else {queues.set(next,++session);planner.replaceContext();}
      planner.reconcile(describe(next));prepared=null;notify();reschedule();},
    ended(){sync();refreshController?.abort();generation++;const before=describe();
      planner.advance(before,{...before,ended:true},{stopPriority:true});prepared=null;prune();notify();},
    stopped(){sync();refreshController?.abort();generation++;prepared=null;planner.halt();notify();},
  });
})();
