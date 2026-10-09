// Native data seeds the route; a configured authenticated reader extends it.
export function applyPlaylistShell(controller, shell, customReader = false) {
  controller.setScope(shell.scopeKey);
  if (!shell.visible) {controller.suspend(); return false;}
  const playlistId = shell.playlistId || null;
  if (shell.payload) controller.accept(shell.payload, playlistId);
  else controller.select(playlistId, {load: false, fromNavigation: true});
  return !shell.payload || customReader ? controller.load() : true;
}

// Both an immediate Delete acknowledgement and exact-key recovery leave the
// same controller state. The shell owns native history completion once.
export function completeDeletedPlaylistNavigation(controller, runtime, mutation) {
  const before = controller.getSnapshot(), scopeKey = before.scopeKey;
  const current = () => {
    const state = controller.getSnapshot(), shell = runtime.snapshot();
    return state.scopeKey === scopeKey && shell.scopeKey === scopeKey && shell.visible
      && state.mutation === mutation && mutation.action === 'deletePlaylist' && mutation.status === 'ready'
      && state.selectedPlaylistId === null && shell.playlistId === mutation.playlist_id;
  };
  if (!current()) return Promise.resolve(false);
  const open = () => current() ? runtime.navigate({playlist_id: null}) : false;
  return runtime.deferFormNavigation?.(open) || open();
}
