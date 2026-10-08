import {normalizeCreationDescriptor} from './creation.mjs';
import {granted} from './model.mjs';

export function playlistCreationContext(state, mode = 'ordinary') {
  const data = state.resource?.data;
  const source = normalizeCreationDescriptor(mode === 'missing' ? data?.detail?.missing_playlist_creation_source : data?.playlist_creation_source);
  return Object.freeze({scopeKey: state.scopeKey, playlistId: state.selectedPlaylistId,
    mode, source, canCreateAlbumTop: mode === 'missing' && granted(data?.detail, 'can_create_album_top'),
    canCreate: ['ordinary', 'missing'].includes(mode) && ['ready', 'empty'].includes(state.resource?.status) && granted(data, 'can_create')
      && Boolean(source && source.kind === (mode === 'missing' ? 'playlist' : 'library'))});
}
export function samePlaylistCreationContext(left, right) {
  return Boolean(left && right && left.scopeKey === right.scopeKey && left.playlistId === right.playlistId && left.mode === right.mode
    && left.canCreate === true && right.canCreate === true && left.source?.kind === right.source?.kind
    && left.source?.ref === right.source?.ref && left.source?.revision === right.source?.revision);
}
export function canOpenPlaylistCreation(state, providers, mode = 'ordinary') {
  return playlistCreationContext(state, mode).canCreate && typeof providers?.readPlaylistCreationSource === 'function'
    && (mode === 'missing' || typeof providers?.createPlaylistFromSelection === 'function');
}
// Creation is already acknowledged. Refresh and navigation never retry it or
// insert a fabricated item. Every continuation checks the live owner.
export async function completePlaylistCreation({ack, context, controller, isCurrent, close, navigate, notify}) {
  if (!isCurrent() || ack?.scopeKey !== context.scopeKey) return false;
  const lifecycleVersion = controller.getLifecycleVersion();
  const refreshed = await controller.load();
  if (!isCurrent()) return false;
  const current = controller.getSnapshot();
  if (!refreshed || !['ready', 'empty'].includes(current.resource.status)) throw new Error('Created playlist refresh failed.');
  if (!samePlaylistCreationContext(context, playlistCreationContext(current, context.mode))) return false;
  const target = current.resource.data?.items.find(item => item.playlist_id === ack.playlist_id && granted(item, 'can_open'));
  if (await close({force: true, restoreFocus: !target}) !== true) return false;
  // Closing is expected to retire the form; current native scope still owns navigation.
  const afterClose = controller.getSnapshot();
  if (controller.getLifecycleVersion() !== lifecycleVersion) return false;
  if (!samePlaylistCreationContext(context, playlistCreationContext(afterClose, context.mode))) return false;
  const currentTarget = afterClose.resource.data?.items.find(item => item.playlist_id === ack.playlist_id && granted(item, 'can_open'));
  if (target && currentTarget) await navigate(ack.playlist_id);
  else notify?.('Playlist created. Opening it is not available yet.');
  return true;
}
