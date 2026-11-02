/* One session-local planner around the existing native queue and streaming
   facade. Source callbacks hold private authority; public snapshots never do. */
const ExplicitQueueRuntime = (() => {
  let scopeToken=null, planner=null, serial=0, session=0, generation=0, snapshot=null, ownershipEpoch=0;
  let prepared=null, refreshController=null, pendingStart=null, snapshotFacts='', successorCache=null, metadataRequest=0;
  const sources=new Map(), listeners=new Set(), trackKeys=new WeakMap(), queues=new WeakMap(), startRollbacks=new WeakMap();
  const aborted=()=>Object.assign(new Error('Queue action was superseded.'),{name:'AbortError'});
  const notify=()=>{snapshot=null;for(const listener of [...listeners])try{listener();}catch{/* Paint cannot change playback. */}};
  const playback=()=>typeof getPlayerPlaybackSnapshot==='function'?getPlayerPlaybackSnapshot():{};
  const permitted=()=>!window.AlbumHavenCapabilities || window.AlbumHavenCapabilities.allows?.('library.media.read')===true;
  const sourceCurrent=(source,media=true)=>{try{return source?.scope===scopeToken&&source.capture.isCurrent()===true&&(!media||permitted());}catch{return false;}};
  const denySource=source=>{
    source.readable=false;source.metadataTarget=null;source.target=null;source.playFailed=true;source.authorityEpoch=(source.authorityEpoch||0)+1;
    const entry=prepared?.next?.source==='explicit'&&planner?.getSnapshot().entries.find(value=>value.id===prepared.next.entryId);
    if(entry&&sources.get(entry.trackId)===source){refreshController?.abort();generation++;prepared=null;retireContinuity('queue-source-revoked');}
  };
  const playable=id=>{const source=sources.get(id),target=source?.metadataTarget;
    return Boolean(sourceCurrent(source)&&source.readable!==false&&!source.playFailed&&target?.availability==='local'
      &&target.allowed_actions?.can_play!==false&&target.playback_state?.can_start_here===true);};
  const sourcePreference=source=>sourceCurrent(source,false)&&source.readable!==false&&!source.metadataTarget?.read_only_subject
    ?TrackActionsRuntime.preference(source.metadataTarget):null;
  function bindIdentity(source,target) {
    if(!target||source.inventory&&target.inventory_track_ref!==source.inventory
      ||source.canonical&&target.canonical_track_ref&&target.canonical_track_ref!==source.canonical)
      throw Object.assign(new Error('This queued track identity changed.'),{status:409});
    source.inventory ||= target.inventory_track_ref||null;
    source.canonical ||= target.canonical_track_ref||null;
  }
  async function readMetadata(source,signal) {
    if(signal.aborted||!sourceCurrent(source,false))throw aborted();
    const authorityEpoch=source.authorityEpoch,target=await source.capture.resolveMetadata({signal});
    if(signal.aborted||!sourceCurrent(source,false)||source.authorityEpoch!==authorityEpoch)throw aborted();
    if(!target||target.source_readable===false||target.allowed_actions?.can_read===false)
      throw Object.assign(new Error('This queued source is unreadable.'),{status:403});
    const retained={...target};
    if(target.albumListeningIntent&&typeof bindAlbumListeningIntent==='function')bindAlbumListeningIntent(retained,target.albumListeningIntent);
    return Object.freeze(retained);
  }
  function acceptMetadata(source,target,batch,freshPlayTarget=null) {
    bindIdentity(source,target);
    source.readable=true;source.playFailed=false;
    source.display=Object.freeze({...source.display,title:String(target.title||''),artist:String(target.artist||target.secondary_artist||''),album:String(target.album_title||'')});
    // Admit canonical and supported path alias together, before any denial can
    // advance the read epoch. A rejected read cannot grant Queue preference UI.
    const admission=freshPlayTarget?.track_ref&&freshPlayTarget.inventory_track_ref===target.inventory_track_ref
      ?{...target,track_ref:freshPlayTarget.track_ref}:target;
    const epoch=batch.epoch,accepted=batch.accept(admission)===true;
    const previous=source.metadataTarget;
    const retained=!accepted&&epoch!==TrackActionsRuntime.readEpoch()&&TrackActionsRuntime.overlay(target.track_preference)?.allowed_actions.can_set_love_tier===true&&previous
      &&previous.track_ref===target.track_ref&&previous.inventory_track_ref===target.inventory_track_ref
      &&previous.canonical_track_ref===target.canonical_track_ref?previous.track_preference:null;
    source.metadataTarget=accepted?target:Object.freeze({...target,track_preference:retained});
    if(target.availability!=='local'||target.playback_state?.can_start_here!==true)source.target=null;
    return accepted;
  }
  // A terminal receipt retains the native context, never a second queue history.
  let completedContext = null;
  const completionCandidates = new WeakMap();
  const selectionEpoch = () => typeof topPlaybackStartEpoch === 'undefined' ? null : topPlaybackStartEpoch;
  const sameScope = (scope, expected) => Boolean(scope?.actor && scope?.library
    && scope.token === expected.token && scope.actor === expected.actor && scope.library === expected.library);
  const queueStamp = queue => ({tracks: queue.tracks, first: queue.tracks?.[0], length: queue.tracks?.length,
    firstPath: queue.tracks?.[0]?.path, firstItem: queue.tracks?.[0]?.playlistItemId,
    revision: queue.playlistRevision, contextGeneration: queue.contextGeneration,
    playlistId: queue.playlistId, albumRef: queue.albumRef, albumSnapshot: queue.albumSnapshot,
    mix: queue.libraryMixRef, protocol: queue.libraryMixProtocol, sourceKind: queue.libraryMixSourceKind,
    entries: queue.sourceEntryRefs, displayed: queue.displayedItemIds,
    repeat: queue.repeatMode, shuffle: queue.shuffle, playbackContext: queue.playbackContext});
  function sameQueueStamp(queue, stamp) {
    const next = queueStamp(queue);
    return Object.keys(stamp).every(key => next[key] === stamp[key]);
  }
  function completedOwnerCurrent(record) {
    const pure = () => record.owner === planner && record.epoch === ownershipEpoch
      && record.generation === generation && record.session === session
      && record.plannerState === planner.getSnapshot() && state.player.playbackQueue === record.publishedQueue
      && !pendingStart && !state.player.loopActive;
    if (!pure()) return false;
    const scope = TrackActionsRuntime.scope();
    if (!pure() || !sameScope(scope, record.scope) || scope.token !== scopeToken) return false;
    if (record.isCurrent() !== true || !pure()) return false;
    if (record.top ? !TopPlaybackRuntime.isRestartCurrent(record.top) : !sameQueueStamp(record.queue, record.stamp)) return false;
    return pure() && sameScope(TrackActionsRuntime.scope(), record.scope) && pure();
  }
  function captureCompletedContext({isCurrent}) {
    if (typeof isCurrent !== 'function' || !isCurrent() || !sync() || !isCurrent()
      || pendingStart || state.player.loopActive || isPlaybackLockedByAnotherTab()) return null;
    const entryQueue = state.player.playbackQueue;
    if (entryQueue && !entryQueue.explicitQueue && !TopPlaybackRuntime.hasQueue(entryQueue) && !queues.has(entryQueue)) {
      describe(entryQueue, state.player.current, entryQueue.currentIndex);
      if (!isCurrent() || state.player.playbackQueue !== entryQueue) return null;
    }
    const owner = planner, plannerState = planner.getSnapshot(), epoch = ownershipEpoch;
    const capturedGeneration = generation, capturedSession = session, nativeQueue = state.player.playbackQueue;
    const pure = () => owner === planner && planner.getSnapshot() === plannerState && epoch === ownershipEpoch
      && generation === capturedGeneration && session === capturedSession && !pendingStart
      && state.player.playbackQueue === nativeQueue && !state.player.loopActive;
    const scope = TrackActionsRuntime.scope();
    if (!pure() || !scope.actor || !scope.library || scope.token !== scopeToken || !isCurrent() || !pure()) return null;
    let before;
    if (nativeQueue?.explicitQueue) before = {...nativeQueue.explicitContext, ended: false};
    else {
      const index = nativeQueue?.playlistId
        ? playlistQueueCurrentIndex(nativeQueue, String(state.player.current?.path || ''), state.player.current?.playlistItemId)
        : typeof TopPlaybackRuntime !== 'undefined' && TopPlaybackRuntime.hasQueue(nativeQueue)
          ? TopPlaybackRuntime.currentIndex(nativeQueue) : nativeQueue?.currentIndex;
      if (!Number.isSafeInteger(index) || index < 0) return null;
      before = describe(nativeQueue, state.player.current, index);
    }
    if (!before || !pure() || !isCurrent() || !pure()) return null;
    const after = successor(before, true);
    const next = planner.preview(before, after, {stopPriority: stopPriority(before, true)}).next;
    if (!pure() || !isCurrent() || !pure() || next && !next.ended && next.tracks?.[next.index]) return null;
    const context = before.source === 'explicit' ? plannerState.returnContext : before;
    if (!context || before.source === 'explicit' && !context.ended) return null;
    const queue = context.nativeQueue;
    if (!queue || !Array.isArray(queue.tracks) || !queue.tracks.length) return null;
    let top = null;
    if (typeof TopPlaybackRuntime !== 'undefined' && TopPlaybackRuntime.hasQueue(queue)) {
      top = TopPlaybackRuntime.captureRestart(queue);
      if (!top) return null;
    } else {
      const playlist = queue.playlistId && queue.playlistRevision && queue.contextGeneration != null
        && queue.tracks.every(track => track.playlistItemId)
        && new Set(queue.tracks.map(track => track.playlistItemId)).size === queue.tracks.length;
      const generated = queue.libraryMixRef && queue.playlistRevision && queue.contextGeneration != null
        && ['library_mix_selection_v1','artist_popular_selection_v1','artist_loved_selection_v1','sample_playlist_selection_v1'].includes(queue.libraryMixProtocol)
        && Array.isArray(queue.sourceEntryRefs) && Array.isArray(queue.displayedItemIds)
        && queue.tracks.every(track => track.playlistItemId);
      if (!(playlist || generated || queue.albumRef && queue.albumSnapshot)
        || queue.repeatMode === 'one' || queue.repeatMode === 'all' || !queue.tracks[0]?.path) return null;
    }
    if (!pure() || !isCurrent() || !pure()) return null;
    const record = {owner, plannerState, epoch, generation, session, scope, queue, top,
      stamp: top ? null : queueStamp(queue), isCurrent, publishedQueue: nativeQueue};
    const candidate = Object.freeze({});
    completionCandidates.set(candidate, record);
    return candidate;
  }
  function replayRecord(token) {
    const record = pendingStart && startRollbacks.get(pendingStart);
    return record?.kind === 'completed-context' && record.token === token ? record : null;
  }
  function replayOwnerCurrent(record) {
    const pure = () => pendingStart === record.controller && startRollbacks.get(record.controller) === record
      && !record.controller.signal.aborted && record.owner === planner && record.epoch === ownershipEpoch
      && record.generation === generation && record.session === session && record.installed === planner.getSnapshot()
      && state.player.playbackQueue === record.selectedQueue && playerTrackSelectionToken === record.selectionToken
      && !state.player.loopActive;
    if (!pure()) return false;
    const scope = TrackActionsRuntime.scope();
    return pure() && sameScope(scope, record.scope) && scope.token === scopeToken && pure();
  }
  function replayCurrent(record) {
    if (!replayOwnerCurrent(record)) return false;
    const completion = record.completion;
    if (completion.top ? !TopPlaybackRuntime.isRestartCurrent(completion.top)
      : !sameQueueStamp(completion.queue, completion.stamp)) return false;
    return replayOwnerCurrent(record);
  }
  function acceptedReplayCurrent(accepted) {
    const engine = streamingEngineState(), role = engine.roles.current, track = state.player.current;
    const pure = () => engine === accepted.engine && engine === streamingEngineState()
      && engine.generation === accepted.generation && playerTrackSelectionToken === accepted.selectionToken
      && isStreamingPlaybackAttemptCurrent(accepted.attempt) && engine.roles.current === role
      && state.player.current === track && role?.track?.path === track?.path;
    if (!pure() || !sameScope(TrackActionsRuntime.scope(), accepted.scope) || !pure()) return false;
    return isNativePlayerSourceCurrent(track) && pure()
      && sameScope(TrackActionsRuntime.scope(), accepted.scope) && pure();
  }
  function invalidateCompletedContext() {
    completedContext = null;
    const start = pendingStart, record = start && startRollbacks.get(start);
    if (record?.kind !== 'completed-context') return;
    pendingStart = null;
    startRollbacks.delete(start);
    generation++;
    start.abort();
  }
  function restartCompletedContext() {
    const running = pendingStart && startRollbacks.get(pendingStart);
    if (running?.kind === 'completed-context') return running.promise;
    const completion = completedContext;
    if (!completion) return null;
    if (pendingStart || !completedOwnerCurrent(completion)) {
      if (completedContext === completion) completedContext = null;
      return Promise.resolve(false);
    }
    const controller = new AbortController(), token = Object.freeze({});
    const record = {kind: 'completed-context', token, controller, completion, scope: completion.scope,
      owner: planner, epoch: ownershipEpoch, generation, session, previous: planner.getSnapshot(), installed: planner.getSnapshot(),
      previousQueue: state.player.playbackQueue, previousIndex: state.player.playbackQueue?.currentIndex,
      previousCurrent: state.player.current, selectedQueue: state.player.playbackQueue,
      selectionToken: playerTrackSelectionToken, staged: false};
    let guardState = record;
    const ownerCurrent = () => guardState.kind === 'accepted' ? acceptedReplayCurrent(guardState) : replayOwnerCurrent(guardState);
    const isCurrent = () => guardState.kind === 'accepted' ? acceptedReplayCurrent(guardState) : replayCurrent(guardState);
    let resolvePromise, rejectPromise;
    record.promise = new Promise((resolve,reject) => {resolvePromise=resolve;rejectPromise=reject;});
    pendingStart = controller;startRollbacks.set(controller, record);
    const run = async () => {
      let started = false;
      try {
        let track = completion.top ? TopPlaybackRuntime.restartCarrier(completion.top)
          : await refreshExplicitQueueReturnTrack({nativeQueue: completion.queue}, completion.stamp.first, {signal: controller.signal});
        if (!track || !isCurrent()) return false;
        record.selectedQueue = completion.queue;record.staged = true;
        state.player.playbackQueue = completion.queue;
        if (!completion.top) completion.queue.currentIndex = 0;
        started = await playTrackFromPayload(track, {resetTime: true, signal: controller.signal,
          contextReplay: token, topRestart: completion.top, replayOwnerCurrent: ownerCurrent, isCurrent,
          onSelectionAdmitted: value => {if (guardState.kind === 'completed-context') guardState.selectionToken=value;}});
        if (!started || !isCurrent()) return false;
        const engine = streamingEngineState(), attempt = captureStreamingPlaybackAttempt();
        if (!attempt || !isStreamingPlaybackAttemptCurrent(attempt)
          || engine.roles.current?.track?.path !== state.player.current?.path || !isCurrent()) return false;
        guardState = {kind: 'accepted', scope: record.scope, engine, generation: engine.generation,
          attempt, selectionToken: record.selectionToken};
        completedContext = null;
        startRollbacks.delete(controller);pendingStart = null;
        return true;
      } finally {
        if (pendingStart === controller && startRollbacks.get(controller) === record) {
          const owned = replayOwnerCurrent(record);
          if (pendingStart !== controller || startRollbacks.get(controller) !== record) return false;
          if (!started && owned && record.staged && state.player.current === record.previousCurrent) {
            state.player.playbackQueue = record.previousQueue;
            if (record.previousQueue) record.previousQueue.currentIndex = record.previousIndex;
          }
          startRollbacks.delete(controller);pendingStart = null;
          const expected = {epoch:ownershipEpoch,generation,session,plannerState:planner.getSnapshot(),publishedQueue:state.player.playbackQueue};
          const retryCurrent = () => !pendingStart && planner===record.owner && ownershipEpoch===expected.epoch
            && generation===expected.generation && session===expected.session && planner.getSnapshot()===expected.plannerState
            && state.player.playbackQueue===expected.publishedQueue && playerTrackSelectionToken===record.selectionToken;
          if (!started && owned && retryCurrent() && completion.isCurrent() && retryCurrent()
            && (completion.top ? TopPlaybackRuntime.isRestartCurrent(completion.top) : sameQueueStamp(completion.queue,completion.stamp))
            && retryCurrent()) {
            Object.assign(completion,expected);completedContext=completion;
          } else if (completedContext === completion) completedContext=null;
        }
      }
    };
    void run().then(resolvePromise,rejectPromise);
    return record.promise;
  }
  function captureStop() {
    const epoch=ownershipEpoch, owner=planner, refresh=refreshController, start=pendingStart;
    let scope;
    try {scope=TrackActionsRuntime.scope();} catch {scope={token:scopeToken,actor:null,library:null};}
    return {epoch,owner,refresh,start,scope,generation,session};
  }
  function isStopCurrent(capture) {
    return capture.epoch===ownershipEpoch&&capture.owner===planner&&capture.refresh===refreshController
      &&capture.start===pendingStart&&capture.generation===generation&&capture.session===session;
  }
  function commitStop(capture) {
    if(!isStopCurrent(capture))return null;
    const refresh=refreshController,start=pendingStart;
    completedContext=null;
    const rollback=start&&startRollbacks.get(start);
    // Undo only this captured, not-yet-audible selection before abort dispatch.
    // A changed scope, planner, selection, native queue or current media belongs
    // to another owner and must never be restored by this retired attempt.
    if(capture.scope.token===scopeToken&&rollback&&(rollback.kind!=='completed-context'||rollback.staged)&&rollback.owner===planner
      &&planner.getSnapshot()===rollback.installed&&state.player.playbackQueue===rollback.selectedQueue
      &&state.player.current===rollback.previousCurrent&&playerTrackSelectionToken===rollback.selectionToken) {
      planner.restore(rollback.installed,{...rollback.previous,halted:rollback.installed.halted||rollback.previous.halted});
      state.player.playbackQueue=rollback.previousQueue;
      if(rollback.previousQueue&&rollback.previousIndex!==undefined)rollback.previousQueue.currentIndex=rollback.previousIndex;
    }
    if(start)startRollbacks.delete(start);
    refreshController=null;pendingStart=null;prepared=null;successorCache=null;generation++;
    if(capture.scope.token!==scopeToken) {
      sources.clear();scopeToken=capture.scope.token;
      planner=createExplicitQueuePlanner({canPlay:playable});session++;
    }
    planner.halt();snapshot=null;
    const epoch=++ownershipEpoch,owner=planner,committedGeneration=generation,committedSession=session;
    return ()=>{
      const errors=[];
      try {refresh?.abort();} catch(error) {errors.push(error);}
      try {start?.abort();} catch(error) {errors.push(error);}
      if(epoch===ownershipEpoch&&owner===planner&&committedGeneration===generation&&committedSession===session
        &&refreshController===null&&pendingStart===null)notify();
      if(errors.length)throw new AggregateError(errors,'Queue retirement failed');
    };
  }
  function retirePendingStartForSelection(incomingSignal=null,incomingReplay=null) {
    const old=pendingStart,rollback=old&&startRollbacks.get(old);
    if(old&&incomingSignal===old.signal
      &&(rollback?.kind!=='completed-context'||rollback.token===incomingReplay))return false;
    if(!old){completedContext=null;return false;}
    const generationBeforeScope=generation,sessionBeforeScope=session;
    const capture=captureStop();
    const capturedCurrent=()=>generation===generationBeforeScope&&session===sessionBeforeScope
      &&isStopCurrent(capture)&&capture.start===old&&pendingStart===old&&startRollbacks.get(old)===rollback;
    if(!capturedCurrent())return false;
    const canRollback=Boolean(capture.scope.actor&&capture.scope.library&&capture.scope.token===scopeToken
      &&rollback&&(rollback.kind!=='completed-context'||rollback.staged)&&rollback.owner===planner&&planner.getSnapshot()===rollback.installed
      &&state.player.playbackQueue===rollback.selectedQueue&&state.player.current===rollback.previousCurrent
      &&playerTrackSelectionToken===rollback.selectionToken);
    if(!capturedCurrent())return false;
    completedContext=null;pendingStart=null;startRollbacks.delete(old);generation++;
    if(canRollback) {
      planner.restore(rollback.installed,{...rollback.previous,halted:rollback.installed.halted||rollback.previous.halted});
      state.player.playbackQueue=rollback.previousQueue;
      if(rollback.previousQueue&&rollback.previousIndex!==undefined)rollback.previousQueue.currentIndex=rollback.previousIndex;
    }
    const epoch=ownershipEpoch,owner=planner,committedGeneration=generation,committedSession=session;
    const restored=canRollback?planner.getSnapshot():null;
    const committedCurrent=()=>epoch===ownershipEpoch&&owner===planner&&committedGeneration===generation
      &&committedSession===session&&pendingStart===null&&refreshController===capture.refresh
      &&planner.getSnapshot()===restored&&state.player.playbackQueue===rollback.previousQueue
      &&state.player.current===rollback.previousCurrent&&playerTrackSelectionToken===rollback.selectionToken
      &&(rollback.previousIndex===undefined||rollback.previousQueue?.currentIndex===rollback.previousIndex);
    old.abort();
    if(canRollback&&committedCurrent()) {
      let scope;
      try {scope=TrackActionsRuntime.scope();} catch {return true;}
      if(committedCurrent()&&scope.actor&&scope.library&&scope.token===capture.scope.token&&scope.token===scopeToken)notify();
    }
    return true;
  }
  function sync() {
    const epoch=ownershipEpoch,scope=TrackActionsRuntime.scope();
    if(epoch!==ownershipEpoch)return Boolean(scope.actor&&scope.library);
    if(scope.token!==scopeToken) {
      const wasExplicit=Boolean(planner?.getSnapshot().currentId),wasPrepared=Boolean(prepared);
      const attempt=typeof streamingEngineState==='function'?streamingEngineState().playbackAttempt:null;
      const oldRefresh=refreshController,oldStart=pendingStart;
      // Commit the new scope before abort callbacks can register a successor.
      completedContext=null;refreshController=null;pendingStart=null;generation++;prepared=null;successorCache=null;
      sources.clear();scopeToken=scope.token;planner=createExplicitQueuePlanner({canPlay:playable});session++;snapshot=null;
      const committedEpoch=++ownershipEpoch;
      // Retire the captured engine before dispatch; never recapture after abort.
      if((wasExplicit||wasPrepared)&&attempt&&typeof stopStreamingPlayback==='function') {
        const stopped=stopStreamingPlayback('queue-session-changed',{expectedAttempt:attempt,notifyQueue:false});
        void stopped.catch(error=>console.error('Queue retirement failed',error));
      }
      oldRefresh?.abort();oldStart?.abort();
      if(committedEpoch!==ownershipEpoch)return Boolean(scope.actor&&scope.library);
    }
    return Boolean(scope.actor&&scope.library);
  }
  function retireContinuity(reason) {
    const engine=typeof streamingEngineState==='function'?streamingEngineState():null;
    if(!engine||state.player.loopActive||engine.stopPromise)return;
    const attempt=engine.playbackAttempt;
    engine.pendingContinuityTrack=null;engine.pendingContinuityOptions=null;
    if(engine.roles?.continuity&&closeStreamingContinuityRole(reason)!==true&&attempt&&typeof stopStreamingPlayback==='function') {
      const stopped=stopStreamingPlayback(reason,{expectedAttempt:attempt});
      void stopped.catch(error=>console.error('Queue retirement failed',error));
    }
  }
  const trackKey=track=>{if(!trackKeys.has(track))trackKeys.set(track,`ordinary-${++serial}`);return trackKeys.get(track);};
  function describe(queue=state.player.playbackQueue,current=state.player.current,indexOverride=null) {
    // A cached, unadmitted publication is display state, not a queue anchor.
    if(indexOverride===null&&queue===state.player.playbackQueue&&current===state.player.current
      &&typeof getUnadmittedPlayerRestorePreview==='function'&&getUnadmittedPlayerRestorePreview()?.track===current) {
      queue=null;current=null;
    }
    if(queue?.explicitQueue===true) return playback().ended ? Object.freeze({...queue.explicitContext,ended:true}) : queue.explicitContext;
    if(typeof TopPlaybackRuntime!=='undefined'&&TopPlaybackRuntime.hasQueue(queue)) {
      const context=TopPlaybackRuntime.describe(queue,indexOverride);
      return context&&indexOverride===null&&playback().ended?Object.freeze({...context,ended:true}):context;
    }
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
  function successor(before,automatic=true) {
    if(before?.source==='album-top')return TopPlaybackRuntime.successor(before,automatic);
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
  const stopPriority=(before=null,automatic=true)=>state.player.loopActive===true || typeof isPlaybackLockedByAnotherTab==='function'&&isPlaybackLockedByAnotherTab()
    || automatic&&(before?.source==='album-top'||before?.source==='explicit'&&planner?.getSnapshot().returnContext?.source==='album-top')
      &&TopPlaybackRuntime.shouldStop(before.source==='album-top'?before.nativeQueue:planner.getSnapshot().returnContext.nativeQueue);
  function preview(automatic=true) {
    sync();const before=describe();planner.reconcile(before);
    return planner.preview(before,successor(before,automatic),{stopPriority:stopPriority(before,automatic)}).next;
  }
  function payload(context) {
    if(!context||context.ended)return null;
    if(context.source==='explicit') {
      const item=planner.getSnapshot().entries.find(entry=>entry.id===context.entryId),target=sources.get(item?.trackId)?.target;
      const result=target?{src:`/track?path=${encodeURIComponent(target.path)}`,path:target.path,title:target.title,
        artist:target.artist||target.secondary_artist,album:target.album_title,durationSeconds:target.duration_seconds,
        explicitEntryId:context.entryId,inventory_track_ref:target.inventory_track_ref}:null;
      return result&&target.albumListeningIntent&&typeof bindAlbumListeningIntent==='function'
        ?bindAlbumListeningIntent(result,target.albumListeningIntent):result;
    }
    return context.nativeTracks?.[context.index]||null;
  }
  const sameContext=(a,b)=>a?.session===b?.session&&a?.source===b?.source&&a?.entryId===b?.entryId
    &&a?.index===b?.index&&a?.tracks?.[a.index]===b?.tracks?.[b.index]&&a?.ended===b?.ended
    &&a?.repeat===b?.repeat&&a?.shuffle===b?.shuffle&&(a?.source==='album-top'||a?.albumComplete===b?.albumComplete)
    &&JSON.stringify(a?.tracks)===JSON.stringify(b?.tracks);
  function editable() {
    sync();const engine=typeof streamingEngineState==='function'?streamingEngineState():null;
    const topProgression=typeof TopPlaybackRuntime!=='undefined'
      &&(TopPlaybackRuntime.hasQueue(state.player.playbackQueue)||planner.getSnapshot().returnContext?.source==='album-top');
    if(pendingStart||engine?.pendingPromotion||topProgression&&engine?.pendingSeek||engine?.roles?.current?.boundaryNotified&&!topProgression)throw new Error('Wait for the current track transition before editing the Queue.');
    if(!state.player.loopActive&&engine?.roles?.continuity
      && (typeof closeStreamingContinuityRole!=='function'||closeStreamingContinuityRole('explicit-queue-change')!==true))throw new Error('The Queue transition is already starting.');
    refreshController?.abort();generation++;prepared=null;
    if(engine&&!state.player.loopActive){engine.pendingContinuityTrack=null;engine.pendingContinuityOptions=null;}
  }
  async function resolve(source,signal,isCurrent=null) {
    if(signal.aborted||!sourceCurrent(source))throw aborted();
    const authorityEpoch=source.authorityEpoch,target=await source.capture.resolve({signal});
    if(signal.aborted||!sourceCurrent(source)||source.authorityEpoch!==authorityEpoch)throw aborted();
    if(target?.source_readable===false||target?.allowed_actions?.can_read===false)throw Object.assign(new Error('This queued source is unreadable.'),{status:403});
    if(!target||['missing','unknown','unresolved'].includes(target.availability)
      ||target.allowed_actions?.can_play===false||target.playback_state?.can_start_here!==true||!TrackActionsRuntime.canPlay(target))throw new Error('This queued track is unavailable.');
    if(signal.aborted||source.authorityEpoch!==authorityEpoch||isCurrent&&!isCurrent())throw aborted();
    bindIdentity(source,target);
    return Object.freeze({...target});
  }
  async function refresh({automatic=true}={}) {
    sync();if(stopPriority())return null;
    if(typeof getUnadmittedPlayerRestorePreview==='function'&&getUnadmittedPlayerRestorePreview())return null;
    if(typeof TopPlaybackRuntime!=='undefined'&&TopPlaybackRuntime.isStarting(state.player.playbackQueue))return null;
    const engine=typeof streamingEngineState==='function'?streamingEngineState():null;
    const topProgression=typeof TopPlaybackRuntime!=='undefined'
      &&(TopPlaybackRuntime.hasQueue(state.player.playbackQueue)||planner.getSnapshot().returnContext?.source==='album-top');
    if(!engine?.roles?.current||topProgression&&engine.pendingSeek||(engine.pendingPromotion||engine.roles.current.boundaryNotified)&&!topProgression)return null;
    if(!planner.getSnapshot().entries.length&&!planner.getSnapshot().currentId) {
      if(typeof TopPlaybackRuntime!=='undefined'&&TopPlaybackRuntime.hasQueue(state.player.playbackQueue))return TopPlaybackRuntime.prepareNext();
      const ordinary=peekNextOrdinaryQueuedTrack();if(ordinary)await scheduleStreamingContinuity(ordinary);return ordinary;
    }
    if(prepared&&engine.roles.continuity&&closeStreamingContinuityRole('explicit-queue-refresh')!==true)return null;
    prepared=null;engine.pendingContinuityTrack=null;engine.pendingContinuityOptions=null;
    refreshController?.abort();const controller=new AbortController();refreshController=controller;
    const token=++generation,before=describe(),outgoing=engine.roles.current;let candidate,topTrack=null;
    const topCurrent=()=>!controller.signal.aborted&&token===generation&&sameContext(before,describe())
      &&(engine.roles.current===outgoing||engine.roles.current?.track===topTrack);
    try {
      if(before?.source==='album-top') {
        const ordinary=successor(before,automatic);
        if(!ordinary.ended)topTrack=await TopPlaybackRuntime.prepareContext(ordinary,{automatic,signal:controller.signal,isCurrent:topCurrent});
      }
      if(!topCurrent())return null;
      candidate=preview(automatic);
      // Fresh authorization is required before handing media to native preload.
      while(candidate?.source==='explicit'&&!candidate.ended) {
        const entry=planner.getSnapshot().entries.find(value=>value.id===candidate.entryId),source=sources.get(entry?.trackId);
        try {source.target=await resolve(source,controller.signal);source.playFailed=false;}
        catch(error){if(controller.signal.aborted||token!==generation)throw aborted();if(source){source.target=null;source.playFailed=true;}notify();candidate=preview(automatic);continue;}
        break;
      }
      if(controller.signal.aborted||token!==generation||!sameContext(before,describe())||stopPriority(before,automatic))return null;
      let track=payload(candidate);
      if(track&&candidate.source==='album-top') {
        if(!topTrack)topTrack=await TopPlaybackRuntime.prepareContext(candidate,{automatic,signal:controller.signal,isCurrent:topCurrent});
        track=topTrack;
        if(track) {
          const fresh=TopPlaybackRuntime.contextForTrack(track);
          if(before.source==='explicit') {
            const value=planner.getSnapshot();
            if(!sameContext(value.returnContext,candidate)||!planner.restore(value,{...value,returnContext:fresh}))return null;
          }
          candidate=fresh;
        }
      } else if(track&&candidate.source!=='explicit') {
        try {track=await refreshExplicitQueueReturnTrack(candidate,track,{signal:controller.signal});}
        catch(error) {if(controller.signal.aborted||token!==generation)throw aborted();prepared=null;planner.halt();notify();return null;}
      }
      if(controller.signal.aborted||token!==generation||!sameContext(before,describe())||stopPriority(before,automatic))return null;
      if(!track){prepared=null;return null;}
      prepared={before,next:candidate,track,generation:token};
      await scheduleStreamingContinuity(track,{isCurrent:()=>!controller.signal.aborted&&token===generation&&sameContext(before,describe())});
      return track;
    } finally {if(refreshController===controller)refreshController=null;}
  }
  function reschedule() {const pending=refresh();if(typeof observeStreamingFacadeCallback==='function')observeStreamingFacadeCallback(pending,'explicit-queue-refresh');else void pending.catch(()=>{});}
  function prune() {const retained=new Set(planner.getSnapshot().entries.map(entry=>entry.trackId));for(const key of sources.keys())if(!retained.has(key))sources.delete(key);}
  function changed() {
    const owner=planner,epoch=ownershipEpoch,reservation=selectionEpoch();
    invalidateCompletedContext();
    if(planner!==owner||ownershipEpoch!==epoch||selectionEpoch()!==reservation)return;
    prune();notify();
    if(planner===owner&&ownershipEpoch===epoch&&selectionEpoch()===reservation)reschedule();
  }
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
      const readable=sourceCurrent(source,false)&&source?.readable!==false,target=readable?source?.metadataTarget:null;
      const duration=target?.duration_seconds;
      return Object.freeze({duration_seconds:typeof duration==='number'&&Number.isFinite(duration)&&duration>=0?duration:null,
        availability:readable&&['local','missing','unresolved','unknown'].includes(target?.availability)?target.availability:'unknown',
        track_preference:readable?sourcePreference(source):null,id:entry.id,blockId:entry.blockId,...(sourceCurrent(source,false)&&source?.readable!==false?source?.display:{title:'Unavailable track',artist:'',album:''}),timing:entry.timing,ready:entry.ready,current,sourceReadable:sourceCurrent(source,false)&&source?.readable!==false,
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
          if(typeof capture?.resolve!=='function'||typeof capture.resolveMetadata!=='function'||typeof capture.isCurrent!=='function')throw new Error('Queue source cannot be refreshed.');
          const targets={};
          for(const kind of ['album','artist']) {
            const projected=window.AlbumHavenResourceSelection?.projectTarget(capture.display?.[`${kind}Target`]);
            if(projected?.kind===kind) {const {native_actions,...publicTarget}=projected;targets[`${kind}Target`]=Object.freeze(publicTarget);}
          }
          const display=Object.freeze({title:String(capture.display?.title||''),artist:String(capture.display?.artist||''),album:String(capture.display?.album||''),...targets});
          const source={scope:actor,capture,display,target:null,metadataTarget:null,readable:true,playFailed:false,authorityEpoch:0,inventory:null,canonical:null};captured.push(source);
        }
        const preferenceEpoch=TrackActionsRuntime.readEpoch();
        const metadata=await Promise.all(captured.map(async source=>{
          const target=await readMetadata(source,controller.signal);bindIdentity(source,target);
          source.target=await resolve(source,controller.signal);return target;
        }));
        if(!active())throw aborted();
        const batch=TrackActionsRuntime.readBatch(preferenceEpoch);
        // These already-completed reads are admitted synchronously as one batch.
        // Advance only after our own accepted read changes the shared epoch.
        captured.forEach((source,index)=>{
          if(!active()||!sourceCurrent(source))throw aborted();
          acceptMetadata(source,metadata[index],batch,source.target);
        });
        // Preference subscribers may retire the request or any captured source.
        if(!active()||captured.some(source=>!sourceCurrent(source)))throw aborted();
        editable();
        if(!active()||captured.some(source=>!sourceCurrent(source)))throw aborted();
        const keys=captured.map(source=>{const key=`request-${++serial}`;sources.set(key,source);return key;});
        const ids=planner.enqueue(keys,timing,before);if(!ids.length)keys.forEach(key=>sources.delete(key));changed();return ids;
      } finally {options.signal?.removeEventListener('abort',cancel);}
    },
    async refresh(options={}) {
      sync();const actor=scopeToken,token=generation,read=++metadataRequest,controller=new AbortController();
      const preferenceEpoch=TrackActionsRuntime.readEpoch();
      const cancel=()=>controller.abort();options.signal?.addEventListener('abort',cancel,{once:true});
      const entries=[...sources.values()],eligibility=[...sources.keys()].map(playable);
      try {
        if(options.signal?.aborted)throw aborted();
        const updates=await Promise.all(entries.map(async source=>{
          try {return {target:await readMetadata(source,controller.signal)};}
          catch(error){if(controller.signal.aborted||error.name==='AbortError')throw error;return {error};}
        }));
        const retained=new Set(sources.values());
        if(controller.signal.aborted||actor!==TrackActionsRuntime.scope().token||token!==generation||read!==metadataRequest
          ||entries.some(source=>!sourceCurrent(source,false)||!retained.has(source)))throw aborted();
        const batch=TrackActionsRuntime.readBatch(preferenceEpoch);
        entries.forEach((source,index)=>{
          const update=updates[index];
          try {
            if(update.error)throw update.error;
            acceptMetadata(source,update.target,batch);
          } catch(error) {
            source.metadataTarget=null;source.target=null;source.playFailed=true;
            if([401,403,404,409].includes(error.status))denySource(source);
          }
        });
        notify();const result=getSnapshot();
        if([...sources.keys()].some((key,index)=>playable(key)!==eligibility[index]))reschedule();
        return result;
      } finally {options.signal?.removeEventListener('abort',cancel);}
    },
    trackPreference(row) {
      sync();const entry=planner.getSnapshot().entries.find(value=>value.id===row?.id);
      return sourcePreference(sources.get(entry?.trackId));
    },
    subscribeTrackPreferences(listener) {return TrackActionsRuntime.subscribePreferences(listener);},
    async setTrackLove({row,love_tier,signal,isCurrent}={}) {
      sync();const entry=planner.getSnapshot().entries.find(value=>value.id===row?.id),source=sources.get(entry?.trackId);
      const actor=scopeToken,authorityEpoch=source?.authorityEpoch,preference=sourcePreference(source),target=source?.metadataTarget;
      if(!preference||!target)throw Object.assign(new Error('Track love editing is unavailable.'),{status:403});
      return TrackActionsRuntime.setLove({source:target,love_tier,signal,isCurrent:()=>{
        try {return actor===TrackActionsRuntime.scope().token&&sourceCurrent(source,false)&&source.readable!==false
          &&source.authorityEpoch===authorityEpoch&&sources.get(entry.trackId)===source
          &&planner.getSnapshot().entries.some(value=>value.id===row.id&&value.trackId===entry.trackId)
          &&sourcePreference(source)?.identity===preference.identity&&sourcePreference(source)?.allowed_actions.can_set_love_tier===true
          &&(!isCurrent||isCurrent()===true);}catch{return false;}
      }});
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
      editable();const controller=new AbortController(),token=++generation,actor=scopeToken,owner=planner,authorityEpoch=source.authorityEpoch;
      const previousQueue=state.player.playbackQueue;let installed=null,started=false,selectedToken=null;
      const cancel=()=>controller.abort();options.signal?.addEventListener('abort',cancel,{once:true});pendingStart=controller;
      const requestOwned=()=>pendingStart===controller&&!controller.signal.aborted
        &&token===generation&&planner===owner&&planner.getSnapshot()===value
        &&sources.get(entry.trackId)===source&&source.authorityEpoch===authorityEpoch;
      const requestCurrent=()=>{
        try {return requestOwned()&&!options.signal?.aborted&&actor===TrackActionsRuntime.scope().token&&sourceCurrent(source)
          &&(!options.isCurrent||options.isCurrent()===true)&&requestOwned();}catch{return false;}
      };
      try {
        let target;
        try {target=await resolve(source,controller.signal,requestCurrent);}catch(error){
          if(!requestCurrent())throw aborted();
          source.target=null;source.playFailed=true;notify();throw error;
        }
        if(!requestCurrent())throw aborted();
        source.target=target;source.playFailed=false;
        const context=planner.start(id,current),track=payload(context);if(!context||!track)throw aborted();
        const previousCurrent=state.player.current;
        install(context);installed=planner.getSnapshot();
        const rollback={owner:planner,previous:value,installed,previousQueue,previousCurrent,
          selectedQueue:state.player.playbackQueue,selectionToken:playerTrackSelectionToken};
        startRollbacks.set(controller,rollback);notify();
        selectedToken=playerTrackSelectionToken;
        const starting=playTrackFromPayload(track,{explicitQueueTransition:true,signal:controller.signal,onSelectionAdmitted:token=>{selectedToken=token;rollback.selectionToken=token;},isCurrent:()=>
          actor===TrackActionsRuntime.scope().token&&pendingStart===controller&&sourceCurrent(source)&&source.readable!==false&&source.authorityEpoch===authorityEpoch
          &&planner.getSnapshot()===installed&&(!options.isCurrent||options.isCurrent()===true)});
        started=await starting;
        if(started!==true)throw new Error('Queue playback did not start.');return true;
      } finally {
        if(!started&&installed&&planner.getSnapshot().currentId===id&&playerTrackSelectionToken===selectedToken
          &&pendingStart===controller&&state.player.playbackQueue?.explicitContext?.entryId===id) {
          planner.restore(planner.getSnapshot(),{...value,halted:planner.getSnapshot().halted||value.halted});state.player.playbackQueue=previousQueue;notify();
        }
        startRollbacks.delete(controller);
        if(pendingStart===controller)pendingStart=null;options.signal?.removeEventListener('abort',cancel);
      }
    },
  };
  TrackActionsRuntime.subscribePreferences(()=>notify());
  TrackActionsRuntime.subscribePlayback?.(()=>notify());
  PrivateUITransport.subscribe?.(()=>{sync();notify();});
  window.AlbumHavenExplicitQueue=Object.freeze(api);
  return Object.freeze({
    referencesOrdinaryQueue(queue){return planner?.getSnapshot().returnContext?.nativeQueue===queue;},
    currentChanged(){notify();},
    hasPendingStart(){return pendingStart !== null;},
    retirePendingStartForSelection, captureCompletedContext, restartCompletedContext, invalidateCompletedContext,
    selectionStarted(token){
      const replay=replayRecord(token);
      if(token&&(!replay||!replayOwnerCurrent(replay)))return false;
      if(!replay)completedContext=null;
      const old=refreshController;refreshController=null;ownershipEpoch++;generation++;prepared=null;successorCache=null;
      if(replay)Object.assign(replay,{epoch:ownershipEpoch,generation,session,installed:planner.getSnapshot()});
      old?.abort();
      return !replay||replayOwnerCurrent(replay);
    },
    hasNext(){sync();if(!planner.getSnapshot().entries.length&&!planner.getSnapshot().currentId)return false;return Boolean(payload(preview(false)));},
    async skip(offset) {
      sync();const before=describe();if(offset<0)return before.source==='explicit'?false:undefined;
      if(offset!==1||stopPriority()||pendingStart)return false;
      if((before.source==='album-top'||planner.getSnapshot().returnContext?.source==='album-top')&&streamingEngineState().pendingPromotion)return false;
      if(before.source==='album-top'&&planner.getSnapshot().halted) {
        const value=planner.getSnapshot();planner.restore(value,{...value,halted:false});
      }
      await refresh({automatic:false});const context=preview(false),track=prepared&&sameContext(prepared.before,before)&&sameContext(prepared.next,context)?prepared.track:null;
      if(!track||pendingStart||!sameContext(before,describe()))return false;
      const previous=planner.getSnapshot(),previousQueue=state.player.playbackQueue,actor=scopeToken;
      const controller=new AbortController();pendingStart=controller;
      const next=planner.advance(before,successor(before,false)),selected=planner.getSnapshot();install(next);
      const selectedQueue=state.player.playbackQueue,previousIndex=before.index;
      const selectedEntry=selected.entries.find(entry=>entry.id===selected.currentId),selectedSource=sources.get(selectedEntry?.trackId),authorityEpoch=selectedSource?.authorityEpoch;
      const rollback={owner:planner,previous,installed:selected,previousQueue,previousIndex,previousCurrent:state.player.current,
        selectedQueue,selectionToken:playerTrackSelectionToken};
      startRollbacks.set(controller,rollback);
      notify();let started=false,selectedToken=null;
      try {selectedToken=playerTrackSelectionToken;const starting=playTrackFromPayload(track,{explicitQueueTransition:true,signal:controller.signal,onSelectionAdmitted:token=>{selectedToken=token;rollback.selectionToken=token;},isCurrent:()=>
        pendingStart===controller&&!controller.signal.aborted&&actor===TrackActionsRuntime.scope().token
        &&(!selectedSource||sourceCurrent(selectedSource)&&selectedSource.readable!==false&&selectedSource.authorityEpoch===authorityEpoch)
        &&planner.getSnapshot()===selected&&state.player.playbackQueue===selectedQueue});
        started=await starting;if(started)prune();return started===true;}
      finally {if(!started&&pendingStart===controller&&actor===TrackActionsRuntime.scope().token
        &&planner.getSnapshot().currentId===selected.currentId&&state.player.playbackQueue===selectedQueue&&playerTrackSelectionToken===selectedToken) {
        planner.restore(planner.getSnapshot(),{...previous,halted:planner.getSnapshot().halted||previous.halted});state.player.playbackQueue=previousQueue;if(previousQueue)previousQueue.currentIndex=previousIndex;notify();}
        startRollbacks.delete(controller);if(pendingStart===controller)pendingStart=null;}
    },
    ownsProgression(){sync();return planner.getSnapshot().entries.length>0||Boolean(planner.getSnapshot().currentId);},
    peek(){sync();const next=preview();return prepared&&sameContext(prepared.before,describe())&&sameContext(prepared.next,next)?prepared.track:null;},
    consume(){sync();const before=describe(),next=preview();
      if(!prepared||!sameContext(prepared.before,before)||!sameContext(prepared.next,next))return null;
      const after=successor(before),stopping=stopPriority(before);
      if(prepared.next.source==='album-top'&&(!TopPlaybackRuntime.receiptCurrent(prepared.track)
        ||streamingEngineState().roles?.current?.track!==prepared.track||!TopPlaybackRuntime.commit(prepared.track)))return null;
      const context=planner.advance(before,after,{stopPriority:stopping}),track=payload(context);
      const promoted=prepared&&sameContext(prepared.next,context)?prepared.track:track;
      install(context);prepared=null;prune();snapshot=null;return promoted;},
    prepareNext:refresh,
    replaced(token){
      const replay=replayRecord(token);
      if(token&&(!replay||!replayOwnerCurrent(replay)))return false;
      sync();if(replay&&!replayOwnerCurrent(replay))return false;
      if(!replay)completedContext=null;
      const old=refreshController;refreshController=null;generation++;prepared=null;successorCache=null;session++;
      if(state.player.playbackQueue)queues.set(state.player.playbackQueue,session);planner.replaceContext();
      if(replay)Object.assign(replay,{epoch:ownershipEpoch,generation,session,installed:planner.getSnapshot()});
      old?.abort();if(replay&&!replayOwnerCurrent(replay))return false;
      notify();return !replay||replayOwnerCurrent(replay);
    },
    modeChanged(previous,next){
      const queue=state.player.playbackQueue,reservation=selectionEpoch();
      invalidateCompletedContext();
      if(state.player.playbackQueue!==queue||selectionEpoch()!==reservation)return;
      sync();successorCache=null;
      if(typeof TopPlaybackRuntime!=='undefined'&&TopPlaybackRuntime.hasQueue(next)&&previous===next) {
        const value=planner.getSnapshot();
        if(value.returnContext?.nativeQueue===previous) {
          const context=TopPlaybackRuntime.describe(next);
          planner.restore(value,{...value,returnContext:TopPlaybackRuntime.successor(context,false)});
        }
        planner.reconcile(describe());prepared=null;notify();reschedule();return;
      }
      const sameSource=previous?.playlistId===next?.playlistId&&previous?.playlistRevision===next?.playlistRevision
        &&(previous?.regularTracks||previous?.tracks)===(next?.regularTracks||next?.tracks);
      if(sameSource&&queues.has(previous))queues.set(next,queues.get(previous));
      else {queues.set(next,++session);planner.replaceContext();}
      planner.reconcile(describe(next));prepared=null;notify();reschedule();},
    ended(candidate=null){
      const initial={owner:planner,epoch:ownershipEpoch,generation,session,queue:state.player.playbackQueue,token:playerTrackSelectionToken};
      const unchanged=()=>planner===initial.owner&&ownershipEpoch===initial.epoch&&generation===initial.generation
        &&session===initial.session&&state.player.playbackQueue===initial.queue&&playerTrackSelectionToken===initial.token;
      sync();if(!unchanged())return;
      const completion=candidate&&completionCandidates.get(candidate);
      const publish=completion&&completedOwnerCurrent(completion);
      if(!unchanged())return;
      const before=describe();if(!unchanged())return;
      const old=refreshController;refreshController=null;generation++;
      const retained=planner.getSnapshot().returnContext;
      planner.advance(before,{...before,ended:true},{stopPriority:true});
      if(before.source==='explicit'&&retained?.source==='album-top')state.player.playbackQueue=retained.nativeQueue;
      prepared=null;prune();completedContext=null;
      if(publish){
        Object.assign(completion,{epoch:ownershipEpoch,generation,session,plannerState:planner.getSnapshot(),publishedQueue:state.player.playbackQueue});
        completedContext=completion;
      }
      const owner=planner,epoch=ownershipEpoch,endedGeneration=generation;
      old?.abort();
      if(owner===planner&&epoch===ownershipEpoch&&endedGeneration===generation)notify();
    },
    captureStop,isStopCurrent,commitStop,
    stopped(){const captured=captureStop(),dispatch=commitStop(captured);if(dispatch)dispatch();},
  });
})();
