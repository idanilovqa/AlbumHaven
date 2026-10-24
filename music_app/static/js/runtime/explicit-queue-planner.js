/* Deliberate requests only. Pure scheduling never owns audio, media references,
   authorization, persistence, the ordinary queue, or a playback clock. */
const EXPLICIT_QUEUE_TIMINGS = Object.freeze({next: 'Play next', end: 'At end of queue',
  album: 'After current album', playlist: 'After current playlist'});
function createExplicitQueuePlanner({canPlay = () => false} = {}) {
  let serial = 0;
  let state = Object.freeze({enabled: true, halted: false, entries: Object.freeze([]), currentId: null,
    returnContext: null, revision: 0});
  const live = q => Boolean(q && !q.ended && q.tracks?.[q.index]);
  const order = q => JSON.stringify(q?.tracks || []);
  const freezeState = value => Object.freeze({...value,
    entries: Object.freeze(value.entries.map(entry => Object.freeze(entry)))});
  const commit = patch => {state = freezeState({...state, ...patch, revision: state.revision + 1});};
  function timingOptions(q) {
    const active = live(q), album = active && q.albums?.[q.index], tail = active ? q.albums?.slice(q.index) || [] : [];
    const other = tail.findIndex(value => value !== album);
    const uninterrupted = other < 0 || !tail.slice(other).includes(album);
    return Object.entries(EXPLICIT_QUEUE_TIMINGS).map(([value,label]) => Object.freeze({value,label,enabled:
      value === 'album' ? Boolean(active && ['album','playlist','album-top'].includes(q.source) && !q.shuffle && album && tail.every(Boolean) && tail.length === q.tracks.length - q.index && uninterrupted && q.albumComplete !== false)
        : value === 'playlist' ? active && q.source === 'playlist' : true,
      ...(value === 'album' && q?.albumComplete === false ? {reason:'The active queue contains only part of the album.'} : {})}));
  }
  function capture(timing,q) {
    if (!timingOptions(q).some(option => option.value === timing && option.enabled)) return null;
    if (!live(q)) return {ready: true, anchor: null};
    let boundary = q.index;
    if (timing === 'album') while (boundary + 1 < q.tracks.length && q.albums[boundary+1] === q.albums[q.index]) boundary++;
    if (timing === 'playlist') boundary = q.tracks.length-1;
    return {ready: timing === 'end' && Boolean(state.currentId), anchor: Object.freeze({session:q.session,
      entryId:q.source === 'explicit' ? q.entryId : null, index:q.index, track:q.tracks[q.index],
      boundary, boundaryTrack:q.tracks[boundary], order:order(q)})};
  }
  function stale(entry,q) {
    const a=entry.anchor;
    if (!a) return false;
    if (q?.source === 'explicit' && !a.entryId && state.returnContext) q=state.returnContext;
    if (a.session !== q?.session) return true;
    if (entry.ready || a.entryId) return false;
    if(entry.timing==='album'&&q?.albumComplete===false)return true;
    return ['album','playlist'].includes(entry.timing) ? a.order !== order(q)
      : a.track === q?.tracks?.[q.index] && a.index !== q?.index;
  }
  const selected = (entry,context) => Object.freeze({session:entry.anchor?.session ?? context?.session,
    source:'explicit', tracks:Object.freeze([entry.trackId]), albums:Object.freeze([]), index:0,
    entryId:entry.id, repeat:'off', shuffle:false, ended:false});
  function plan(before,after,{direction=1,stopPriority=false}={}) {
    if (!before) return {state,next:after};
    if (direction < 0) return {state,next:before.source === 'explicit' ? before : after};
    let entries=state.entries.map(entry => {
      const a=entry.anchor;
      if (entry.id === state.currentId || entry.ready || entry.invalid || !a) return entry;
      if (a.session !== before.session) return {...entry,invalid:'Playback context was replaced'};
      if (a.entryId ? a.entryId !== before.entryId : before.source === 'explicit') return entry;
      const reached=['next','end'].includes(entry.timing)
        ? a.index === before.index && a.track === before.tracks[before.index]
        : before.repeat !== 'one' && a.boundary === before.index && a.boundaryTrack === before.tracks[before.index];
      return reached ? {...entry,ready:true} : entry;
    });
    let currentId=state.currentId, returnContext=state.returnContext;
    const finishing=before.source === 'explicit' && before.entryId === currentId;
    if (finishing) {entries=entries.filter(entry=>entry.id!==currentId);currentId=null;}
    if (stopPriority) return {state:freezeState({...state,entries,currentId,returnContext:null,halted:true}),next:after};
    const ready=state.enabled && !state.halted && entries.find(entry=>entry.id!==currentId && entry.ready && !entry.invalid && canPlay(entry.trackId));
    if (ready) {
      if (!finishing) returnContext=after;
      currentId=ready.id;
      return {state:freezeState({...state,entries,currentId,returnContext}),next:selected(ready,returnContext)};
    }
    if (finishing) {const resume=returnContext;returnContext=null;
      return {state:freezeState({...state,entries,currentId,returnContext}),next:resume || after};}
    return {state:freezeState({...state,entries,currentId,returnContext}),next:after};
  }
  return Object.freeze({
    getSnapshot:()=>state, timingOptions,
    restore(expected, previous) {if(state!==expected)return false;commit(previous);return true;},
    enqueue(trackIds,timing='end',q=null) {
      const captured=capture(timing,q); if (!captured || !Array.isArray(trackIds)) return [];
      const blockId=`queue-block-${++serial}`;
      const entries=trackIds.filter(id=>typeof id==='string' && id).map(trackId=>({id:`queue-entry-${++serial}`,blockId,trackId,timing,...captured,invalid:null}));
      if (!entries.length) return [];
      const current=state.entries.filter(entry=>entry.id===state.currentId),pending=state.entries.filter(entry=>entry.id!==state.currentId);
      commit({entries:[...current,...(timing==='next'?[...entries,...pending]:[...pending,...entries])]});
      return entries.map(entry=>entry.id);
    },
    retime(id,timing,q) {
      const old=state.entries.find(entry=>entry.id===id),captured=capture(timing,q);
      if (!old || id===state.currentId || !captured) return false;
      const entry={...old,timing,...captured,invalid:null};
      let entries=state.entries.map(value=>value.id===id?entry:value);
      if (['next','end'].includes(timing)) {
        const current=entries.filter(value=>value.id===state.currentId),pending=entries.filter(value=>value.id!==state.currentId&&value.id!==id);
        entries=[...current,...(timing==='next'?[entry,...pending]:[...pending,entry])];
      }
      commit({entries});return true;
    },
    reorder(ids) {
      const pending=state.entries.filter(entry=>entry.id!==state.currentId),byId=new Map(pending.map(entry=>[entry.id,entry]));
      if (!Array.isArray(ids) || ids.length!==pending.length || new Set(ids).size!==ids.length || ids.some(id=>!byId.has(id))) return false;
      commit({entries:[...state.entries.filter(entry=>entry.id===state.currentId),...ids.map(id=>byId.get(id))]});return true;
    },
    remove(id) {if(id===state.currentId || !state.entries.some(entry=>entry.id===id))return false;
      commit({entries:state.entries.filter(entry=>entry.id!==id)});return true;},
    clear(ids) {if(!Array.isArray(ids))return false;const captured=new Set(ids);
      commit({entries:state.entries.filter(entry=>entry.id===state.currentId||!captured.has(entry.id))});return true;},
    setEnabled(enabled) {if(typeof enabled!=='boolean')return false;commit({enabled,halted:enabled?false:state.halted});return true;},
    reconcile(q) {const entries=state.entries.map(entry=>entry.id!==state.currentId&&!entry.invalid&&stale(entry,q)
      ? {...entry,invalid:'Playback context or order changed'}:entry);
      if(entries.some((entry,index)=>entry!==state.entries[index]))commit({entries});},
    replaceContext() {commit({currentId:null,returnContext:null,halted:false,entries:state.entries.map(entry=>entry.anchor||entry.id===state.currentId
      ? {...entry,invalid:'Playback context was replaced'}:entry)});},
    canStart(id,q) {const entry=state.entries.find(value=>value.id===id);
      return Boolean(entry&&state.enabled&&!state.currentId&&!live(q)&&entry.ready&&!entry.invalid&&canPlay(entry.trackId));},
    start(id,q) {if(!this.canStart(id,q))return null;const entry=state.entries.find(value=>value.id===id);
      commit({currentId:id,returnContext:q,halted:false});return selected(entry,q);},
    preview:plan,
    advance(before,after,options) {const result=plan(before,after,options);commit(result.state);return result.next;},
    halt() {commit({halted:true,returnContext:null});},
  });
}
