import {granted} from './model.mjs';

export function playlistDialogVisible(dialog, state) {
  if (!dialog || dialog.scopeKey !== state.scopeKey || dialog.playlistId !== state.selectedPlaylistId) return false;
  if (['create', 'missing'].includes(dialog.kind)) {
    if (state.resource.status === 'denied') return false;
    if (!['ready', 'empty'].includes(state.resource.status)) return true;
    const source = dialog.kind === 'missing' ? state.resource.data?.detail?.missing_playlist_creation_source : state.resource.data?.playlist_creation_source;
    return Boolean(source && granted(state.resource.data, 'can_create') && source.kind === dialog.source?.kind && source.ref === dialog.source?.ref);
  }
  const detail = state.resource.data?.detail;
  return dialog.kind === 'share' && state.resource.status !== 'denied' && Boolean(
    detail?.playlist_id === dialog.playlistId && dialog.sharingGranted === granted(detail, 'can_share')
    || !detail && dialog.sharingGranted && state.mutation.status === 'loading'
      && state.mutation.action === 'saveSharing' && state.mutation.playlist_id === dialog.playlistId);
}
export function restorePlaylistDialogFocus(root, action, document) {
  const active = document.activeElement;
  if (active && active !== document.body && active.isConnected) return false;
  const target = [...(root?.querySelectorAll('[data-playlists-action],[data-playlists-create]') || [])]
    .find(node => action === 'create' ? node.hasAttribute('data-playlists-create') : node.dataset.playlistsAction === action);
  if (!target || target.disabled || !target.isConnected) return false;
  target.focus({preventScroll: true}); return true;
}
export function playlistSharingCurrent(subject, state) {
  const detail = state.resource.data?.detail;
  const ownSave = state.mutation.status === 'loading' && state.mutation.action === 'saveSharing'
    && state.mutation.playlist_id === state.selectedPlaylistId;
  return Boolean(subject && subject.playlist_id === state.selectedPlaylistId
    && (subject === detail || ownSave && state.resource.status !== 'denied'
      && (!detail || granted(detail, 'can_share'))));
}
