// Native data seeds the route; a configured authenticated reader extends it.
export function applyPlaylistShell(controller, shell, customReader = false) {
  controller.setScope(shell.scopeKey);
  if (!shell.visible) {controller.suspend(); return false;}
  const playlistId = shell.playlistId || null;
  if (shell.payload) controller.accept(shell.payload, playlistId);
  else controller.select(playlistId, {load: false, fromNavigation: true});
  return !shell.payload || customReader ? controller.load() : true;
}
