import {detailSelection, detailSelectionKey} from './resource-target.mjs';
import {activityForQuery} from './history-presentation.mjs';

const reference = value => typeof value === 'string' && value.trim().length > 0
  && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
const ready = value => ['ready', 'empty'].includes(value?.status);
const position = value => Number.isFinite(value) && value >= 0 && value <= 10000000 ? value : 0;
const pane = value => ['recent', 'artist', 'album'].includes(value) ? value : 'recent';

export function selectionQuery(value) {
  if (!['recent', 'friends'].includes(value?.section)
    || !['albums', 'artists', 'tracks', 'listens'].includes(value.kind)
    || !['week', 'month', 'six', 'year', 'all'].includes(value.period)
    || (value.section === 'friends' ? !reference(value.account_ref) : value.account_ref != null)) return null;
  return {section: value.section, account_ref: value.account_ref ?? null, kind: value.kind, period: value.period};
}
export const selectionQueryKey = value => {const query = selectionQuery(value); return query ? JSON.stringify(query) : '';};

// Native history contains opaque identities and presentation only. Reopening
// an entry always resolves its row and grants from a current provider result.
export function selectionPresentation(value) {
  const result = [], keys = new Set();
  for (const entry of Array.isArray(value) ? value : []) {
    const query = selectionQuery(entry?.query), key = selectionQueryKey(query);
    if (!key || keys.has(key)) continue;
    const selected = entry.selected;
    const descriptor = reference(selected?.rowId) && reference(selected.targetRef)
      && ['album', 'artist'].includes(selected.targetKind)
      && (selected.snapshotRef == null || reference(selected.snapshotRef))
      ? {rowId: selected.rowId, targetKind: selected.targetKind, targetRef: selected.targetRef, snapshotRef: selected.snapshotRef ?? null} : null;
    const tracks = entry.tracks;
    const trackDescriptor = ['tracks', 'listens'].includes(query.kind) && Array.isArray(tracks?.rowIds)
      && tracks.rowIds.length > 0 && tracks.rowIds.length <= 5000 && tracks.rowIds.every(reference)
      && new Set(tracks.rowIds).size === tracks.rowIds.length
      && (tracks.snapshotRef == null || reference(tracks.snapshotRef))
      ? {rowIds: [...tracks.rowIds], snapshotRef: tracks.snapshotRef ?? null} : null;
    result.push({query, selected: trackDescriptor ? null : descriptor, tracks: trackDescriptor,
      childAlbumRef: (descriptor?.targetKind === 'artist' || trackDescriptor) && reference(entry.childAlbumRef) ? entry.childAlbumRef : null,
      pane: pane(entry.pane), expanded: ['recent', 'friends', 'artist', 'album'].includes(entry.expanded) ? entry.expanded : null,
      scroll: {source: position(entry.scroll?.source), artist: position(entry.scroll?.artist), album: position(entry.scroll?.album)}});
    keys.add(key);
    if (result.length === 6) break;
  }
  return result;
}

export function selectionEntry(entries, query) {
  const key = selectionQueryKey(query);
  return entries.find(entry => selectionQueryKey(entry.query) === key)
    || {query: selectionQuery(query), selected: null, tracks: null, childAlbumRef: null, pane: 'recent', expanded: null, scroll: {source: 0, artist: 0, album: 0}};
}
export function updateSelectionEntry(entries, query, patch) {
  if (!selectionQuery(query)) return entries;
  const key = selectionQueryKey(query), previous = selectionEntry(entries, query);
  const entry = {...previous, ...patch, query, scroll: {...previous.scroll, ...patch.scroll}};
  return selectionPresentation([entry, ...entries.filter(value => selectionQueryKey(value.query) !== key)]);
}

export function retireFriendSelections(entries, friends) {
  if (!['ready', 'empty', 'denied'].includes(friends?.status)) return entries;
  let changed = false;
  const next = entries.map(entry => {
    if (entry.query.section !== 'friends' || !entry.selected && !entry.tracks) return entry;
    const matches = ready(friends) ? friends.data?.friends.filter(person => person.account_ref === entry.query.account_ref) ?? [] : [];
    if (matches.length === 1 && matches[0].relationship === 'accepted' && matches[0].allowed_actions?.can_view_activity === true) return entry;
    changed = true;
    return {...entry, selected: null, tracks: null, childAlbumRef: null, pane: 'recent', expanded: null};
  });
  return changed ? next : entries;
}

export function selectionSource(snapshot, query) {
  if (!selectionQuery(query)) return {status: 'unavailable', data: null};
  if (query.section === 'friends') {
    if (!ready(snapshot.friends)) return {status: snapshot.friends?.status || 'unavailable', data: null};
    const owner = snapshot.friends.data?.friends.filter(person => person.account_ref === query.account_ref) ?? [];
    if (owner.length !== 1 || owner[0].relationship !== 'accepted' || owner[0].allowed_actions?.can_view_activity !== true) return {status: 'denied', data: null};
  }
  if (snapshot.selectedFriendRef !== query.account_ref) return {status: 'loading', data: null};
  return query.section === 'recent' && query.kind === 'albums' && query.period === 'week'
    ? snapshot.recent : activityForQuery(snapshot, query);
}

export function recentSelectionRow(value, ref, {customDetail = false} = {}) {
  if (value?.status !== 'ready' || !reference(ref)) return null;
  const matches = value.data?.recent_local_albums?.filter(row => row.album_ref === ref) ?? [];
  const row = matches.length === 1 ? matches[0] : null;
  // Native browsing and a supplied detail reader have separate grants. A
  // custom reader can retain its explicitly readable row after native browse
  // access is removed, but native open permission never becomes a detail grant.
  return row?.row_kind === 'local_album' && row.local_match_state === 'matched_local'
    && (Object.hasOwn(row.allowed_actions || {}, 'can_open_album') && row.allowed_actions.can_open_album === true
      || customDetail === true && Object.hasOwn(row.allowed_actions || {}, 'can_view_details')
        && row.allowed_actions.can_view_details === true) ? row : null;
}

export function activitySelectionTarget(row, targetKind, query, source) {
  if (!row || row.source_readable === false || !['album', 'artist'].includes(targetKind)) return null;
  const supplied = row[`${targetKind}_target`];
  const target = detailSelection(supplied ?? (row.kind === targetKind && reference(row.detail_ref)
    ? {kind: targetKind, ref: row.detail_ref, allowed_actions: row.allowed_actions,
      origin: {source: 'activity', account_ref: query.account_ref, kind: query.kind, period: query.period,
        ...(source?.data?.snapshot_ref ? {snapshot_ref: source.data.snapshot_ref} : {})}} : null));
  if (!target || target.kind !== targetKind || target.allowed_actions.can_view_details !== true) return null;
  const origin = target.origin;
  if (origin && (origin.source !== 'activity' || origin.account_ref !== query.account_ref
    || origin.kind !== query.kind || origin.period !== query.period
    || (origin.snapshot_ref ?? null) !== (source?.data?.snapshot_ref ?? null))) return null;
  return target;
}

export function selectionDescriptor(row, target, source) {
  return {rowId: row.id, targetKind: target.kind, targetRef: target.ref,
    snapshotRef: target.origin?.snapshot_ref ?? source?.data?.snapshot_ref ?? null};
}

export function resolveActivitySelection(snapshot, query, descriptor) {
  const source = selectionSource(snapshot, query);
  if (!descriptor || source?.status !== 'ready') return null;
  const rows = source.data?.rows?.filter(row => row.id === descriptor.rowId) ?? [];
  if (rows.length !== 1) return null;
  const target = activitySelectionTarget(rows[0], descriptor.targetKind, query, source);
  return target && target.ref === descriptor.targetRef
    && (target.origin?.snapshot_ref ?? source.data?.snapshot_ref ?? null) === (descriptor.snapshotRef ?? null)
    ? {row: rows[0], target, source} : null;
}

// A stored descriptor may be restored when entering a query. Once displayed,
// however, replacement of its live source/target retires that activation. A
// recreated row needs a fresh deliberate selection, including for Track links.
export function reconcileSelectionLease(previous, {scopeKey, queryKey, descriptor, source, target, runtime, provider}) {
  const identity = descriptor ? JSON.stringify(descriptor) : '';
  if (!identity || !queryKey) return null;
  const targetKey = detailSelectionKey(target);
  if (!previous || previous.queryKey !== queryKey || previous.identity !== identity) {
    return {scopeKey, queryKey, identity, source: source?.status === 'ready' ? source : null, targetKey,
      runtime, provider, retired: false};
  }
  if (previous.retired) return previous;
  if (previous.scopeKey !== scopeKey || previous.runtime !== runtime || previous.provider !== provider
    || previous.source && (previous.source !== source || previous.targetKey !== targetKey)) return {...previous, retired: true};
  return !previous.source && source?.status === 'ready' ? {...previous, source, targetKey} : previous;
}

export function resolveListenedAlbum(value, artistTarget, albumRef) {
  if (!albumRef || artistTarget?.kind !== 'artist' || value?.status !== 'ready'
    || value.data?.kind !== 'artist' || value.data.ref !== artistTarget.ref
    || (artistTarget.origin && JSON.stringify(value.data.origin) !== JSON.stringify(artistTarget.origin))) return null;
  const matches = (value.data.listened_albums ?? []).map(row => detailSelection({...row.detail_target,
    native_actions: row.native_actions || row.detail_target?.native_actions})).filter(target => target?.kind === 'album'
      && target.ref === albumRef && target.allowed_actions.can_view_details === true);
  return matches.length === 1 ? matches[0] : null;
}

export function sameSelectionTarget(left, right) {
  return Boolean(left && right && detailSelectionKey(left) === detailSelectionKey(right));
}


// Identity and detail authority are separate. Each consensus target retains one
// current receipt; public names and local file paths never identify resources.
export function resolveActivityTrackSelection(snapshot, query, descriptor) {
  if (!['tracks', 'listens'].includes(query?.kind) || !Array.isArray(descriptor?.rowIds)
    || !descriptor.rowIds.length || descriptor.rowIds.length > 5000
    || new Set(descriptor.rowIds).size !== descriptor.rowIds.length) return null;
  const source = selectionSource(snapshot, query);
  if (source.status !== 'ready' || (source.data?.snapshot_ref ?? null) !== (descriptor.snapshotRef ?? null)) return null;
  const selected = new Set(descriptor.rowIds);
  const rows = (source.data?.rows || []).filter(row => selected.has(row.id));
  if (rows.length !== selected.size || new Set(rows.map(row => row.id)).size !== selected.size
    || rows.some(row => !['track', 'listen'].includes(row.kind) || row.source_readable === false)) return null;
  const common = kind => {
    const targets = rows.map(row => activitySelectionTarget(row, kind, query, source));
    const first = targets[0], identity = first?.identity_ref || first?.ref;
    return identity && targets.every(target => target && (target.identity_ref || target.ref) === identity) ? first : null;
  };
  return {rows, album: common('album'), artist: common('artist'), source};
}
