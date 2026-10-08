import {createPlaylistCreationController} from './creation.mjs';
import {playlistCreationContext, samePlaylistCreationContext} from './creation-session.mjs';
import {confirmedMissingRow, hasConfirmedMissingRows} from './missing-source.mjs';

function inspectionTitle(sourceTitle) {
  const text = `Missing tracks · ${typeof sourceTitle === 'string' && sourceTitle.trim() ? sourceTitle.trim() : 'Playlist'}`;
  let title = '';
  for (const character of text) {if (title.length + character.length > 100) break; title += character;}
  return title;
}

/** Read and prepare the existing full Playlist draft directly. There is no
 * intermediate form and no persistence; the destination's Save owns writing. */
export async function inspectMissingPlaylist({playlists, providers, onPrepareDraft, signal, isCurrent = () => true}) {
  if (signal?.aborted || !isCurrent()) return {status: 'retired'};
  const origin = playlists.getSnapshot(), context = playlistCreationContext(origin, 'missing');
  if (origin.resource.status === 'denied') return {status: 'denied'};
  if (!context.canCreate || typeof providers?.readPlaylistCreationSource !== 'function' || typeof onPrepareDraft !== 'function') return {status: 'unavailable'};
  if (!hasConfirmedMissingRows(origin.resource.data?.detail?.track_rows)) return {status: 'empty'};
  const version = playlists.getLifecycleVersion(), reader = providers.readPlaylistCreationSource;
  const creation = createPlaylistCreationController({providers: {readPlaylistCreationSource: reader}});
  let retired = false;
  const current = () => !retired && !signal?.aborted && isCurrent() && reader === providers.readPlaylistCreationSource
    && playlists.getLifecycleVersion() === version
    && samePlaylistCreationContext(context, playlistCreationContext(playlists.getSnapshot(), 'missing'));
  const retire = () => {retired = true; creation.dispose();};
  const unsubscribe = playlists.subscribe(() => {if (!current()) retire();});
  signal?.addEventListener('abort', retire, {once: true});
  try {
    if (!current()) return {status: 'retired'};
    creation.setContext(context);
    if (!await creation.load()) return {status: current() ? creation.getSnapshot().sourceResource.status : 'retired'};
    if (!current()) return {status: 'retired'};
    const missing = creation.getSnapshot().sourceResource.data.entries.filter(confirmedMissingRow);
    if (!missing.length) return {status: 'empty'};
    // Do not silently prepare only the mappable/allowed subset of an inspection.
    if (missing.some(row => !row.entry_ref)) return {status: 'unavailable'};
    if (missing.some(row => row.allowed_actions.can_select !== true)) return {status: 'denied'};
    creation.setContext(playlistCreationContext(playlists.getSnapshot(), 'missing'));
    creation.edit({title: inspectionTitle(origin.resource.data.detail.title), description: ''});
    const packet = creation.prepareDraft();
    if (!packet || !current()) return {status: current() ? 'unavailable' : 'retired'};
    // The native destination checks the current source once more and takes its
    // own lifetime. Its successful transfer intentionally retires the old UI.
    return {status: await onPrepareDraft(packet) === true ? 'ready' : 'unavailable'};
  } finally {unsubscribe(); signal?.removeEventListener('abort', retire); creation.dispose();}
}
