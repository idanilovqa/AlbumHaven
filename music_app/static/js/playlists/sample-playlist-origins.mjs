import {normalizeSampleOrigin, isSampleAlbumRef} from './sample-playlist-input.mjs';
// Selection is a declared origin, never permission or a persistent Top.
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const decimal = value => typeof value === 'string' && /^[1-9][0-9]*$/.test(value) && (value.length < 19 || value.length === 19 && value <= '9223372036854775807');
const busy = state => state?.mutation?.refreshing === true || ['loading','uncertain'].includes(state?.mutation?.status);
function selections(items, libraryRef) {
  if (!Array.isArray(items) || !items.length || items.length > 5000) return null;
  const result=[],seen=new Set();
  for (const row of items) {
    if (!row || typeof row !== 'object') return null;
    if (row.source_kind === 'remote_summary' || typeof row.source?.kind === 'string' && row.source.kind.startsWith('remote_') || row.source?.kind === 'unselected') {result.push({kind:'unavailable'});continue;}
    const selected = row.selected_source_ref != null || row.selected_local_album_id != null || row.selected_inventory_album_ref != null || row.source?.kind === 'local';
    const ref = selected ? row.selected_inventory_album_ref ?? row.source?.selected_inventory_album_ref : row.inventory_album_ref;
    if (ref == null && !selected && row.local_album_id == null && row.inventory_album_ref == null && uuid(row.album_ref)) {result.push({kind:'unavailable'});continue;}
    if (!isSampleAlbumRef(ref,libraryRef) || seen.has(ref)) return null;
    seen.add(ref);result.push({kind:'local',inventory_album_ref:ref});
  }
  return result;
}
export function captureAlbumTopSampleOrigin({controller,draft,libraryRef,isCurrent,returnToOrigin}) {
  if (!decimal(libraryRef) || typeof isCurrent !== 'function' || typeof returnToOrigin !== 'function') return null;
  const initial=controller?.getSnapshot(),scopeKey=initial?.scopeKey,detail=initial?.detail?.data;
  const usable=state=>state && state.scopeKey===scopeKey && !busy(state) && state.directory?.status==='ready';
  const readTop=state=>usable(state) && state.detail?.status==='ready' && state.detail.data===detail && detail?.allowed_actions?.['library.browse.read']===true
    && state.selectedTopRef===detail.top_ref && uuid(detail.top_ref) && decimal(detail.revision) && Array.isArray(detail.items) && detail.items.length>0;
  let origin,signature,topRef,revision;
  if (draft) {
    const value=draft.getSnapshot();
    if (!usable(initial) || value?.scopeKey!==scopeKey || value.busy || value.stale || value.denied || value.remote?.retired) return null;
    const selected=selections(value.items,libraryRef);if(!selected)return null;
    origin=normalizeSampleOrigin({kind:'album_set',selections:selected},libraryRef);if(!origin)return null;signature=JSON.stringify(value.items);
  } else {
    if(!readTop(initial))return null;
    topRef=detail.top_ref;revision=detail.revision;origin=normalizeSampleOrigin({kind:'album_top',top_ref:topRef,revision},libraryRef);if(!origin)return null;
  }
  let retired=false;
  const current=()=>{
    if(retired)return false;
    try {
      const state=controller.getSnapshot();
      let valid=isCurrent()===true && usable(state);
      if(draft){const value=draft.getSnapshot();valid=valid && value?.scopeKey===scopeKey && !value.busy && !value.stale && !value.denied && !value.remote?.retired && JSON.stringify(value.items)===signature;}
      else valid=valid && readTop(state) && detail.top_ref===topRef && detail.revision===revision;
      if(!valid)retired=true;
    }catch{retired=true;}
    return !retired;
  };
  if(!current())return null;
  return Object.freeze({scopeKey,origin,isCurrent:current,back(returnToParent){return current()?returnToOrigin(returnToParent):false;}});
}
