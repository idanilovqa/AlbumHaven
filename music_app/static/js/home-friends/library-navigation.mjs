import {createNativeLifetime} from './native-lifetime.mjs';
import {mountChoice, mountButton, mountStatus} from './native-controls.mjs';
import {createPlaylistController} from '../playlists/model.mjs';
import {mountPlaylistGroupedDirectory} from '../playlists/native-directory-filters.mjs';

// The native drawer keeps visibility/mode authority. This owner only populates
// the two supplied content hosts and releases every subscription on retirement.
export function mountLibraryNavigation({host, playlistHost, runtime, playlistRuntime}) {
  const scope=createNativeLifetime();
  const playlists = scope.own(createPlaylistController({readPlaylists: playlistRuntime.readSidebarDirectory}));
  let disposed = false, choice, directory, button, status, error = false, enabledBefore, scopeBefore, payloadBefore, rendering = false, pending = false;
  const choiceHost = host.ownerDocument.createElement('div'), artistHost = host.ownerDocument.createElement('div'); host.append(choiceHost, artistHost);
  const sidebar = playlistHost?.ownerDocument.createElement('nav'); if (sidebar) {sidebar.className = 'collection-sidebar'; sidebar.setAttribute('aria-label', 'Playlists'); playlistHost.append(sidebar);}
  const child = () => {const element = host.ownerDocument.createElement('div'); sidebar?.append(element); return element;};
  const allHost = child(), statusHost = child(), errorHost = child(), directoryHost = child();
  const retired=Symbol('retired library navigation');
  function checkpoint(){if(disposed)throw retired;}
  function accept(owner){if(disposed){try{owner?.dispose();}catch(_cleanupError){}throw retired;}return owner;}
  function dispose(){if(disposed)return;disposed=true;pending=false;const children=[directory,choice,button,status];directory=choice=button=status=null;for(const child of children){try{child?.dispose();}catch(_cleanupError){}}scope.dispose();choiceHost.remove();artistHost.remove();sidebar?.remove();}
  async function open(playlist_id) {
    const shell = runtime.snapshot(), nativePlaylist = playlistRuntime.snapshot(), state = playlists.getSnapshot();
    const enabled = shell.authenticated && shell.inLibrary && shell.sidebarMode === 'playlists', scopeKey = nativePlaylist.scopeKey;
    if (disposed || !enabled || (playlist_id && !state.resource.data?.items.some(item => item.playlist_id === playlist_id && item.allowed_actions?.can_open === true))) return false;
    try {await playlistRuntime.navigate({playlist_id}); if (!disposed) {error = false; render();}}
    catch (failure) {if (!disposed && failure?.name !== 'AbortError' && runtime.snapshot().scopeKey === shell.scopeKey && playlistRuntime.snapshot().scopeKey === scopeKey) {error = true; render();}}
  }
  function render() {
    if (disposed) return; if (rendering) {pending = true; return;} rendering = true;
    try {
      const shell = runtime.snapshot(), nativePlaylist = playlistRuntime.snapshot(), enabled = shell.authenticated && shell.inLibrary && shell.sidebarMode === 'playlists';
      checkpoint();if (enabledBefore !== enabled || scopeBefore !== nativePlaylist.scopeKey || payloadBefore !== nativePlaylist.payload) {
        enabledBefore = enabled; scopeBefore = nativePlaylist.scopeKey; payloadBefore = nativePlaylist.payload; error = false;
        playlists.setScope(enabled ? nativePlaylist.scopeKey : null);checkpoint();if(enabled)playlists.load();checkpoint();
      }
      const visible = shell.authenticated && shell.inLibrary; choiceHost.hidden = !visible;
      if (visible) {const options = {label: 'Library navigation', value: shell.sidebarMode, options: [['albums','Albums'],['playlists','Playlists'],['album_tops','Album Tops']], onChange: runtime.selectSidebar, showLabel: false}; if (choice) choice.update(options); else choice = accept(mountChoice(choiceHost, runtime, options));}
      else {choice?.dispose(); choice = null;}
      checkpoint();artistHost.hidden = !(visible && shell.sidebarMode === 'albums' && (shell.active || nativePlaylist.visible));
      const html = artistHost.hidden ? '' : runtime.navigationItemHtml({label: 'All artists', href: '/?surface=albums', key: 'all-artists', attributes: {'data-nav': '1'}}); if (artistHost.innerHTML !== html) artistHost.innerHTML = html;
      checkpoint();if (!sidebar) return;
      const state = playlists.getSnapshot(); sidebar.hidden = !(enabled && state.scopeKey === nativePlaylist.scopeKey);
      if (sidebar.hidden) return;
      const buttonOptions = {label: 'All Playlists', onClick: () => open(null)}; if (button) button.update(buttonOptions); else button = accept(mountButton(allHost, runtime, buttonOptions));checkpoint();
      const statusOptions = {value: state.resource, label: 'Playlists', retry: () => playlists.load()}; if (status) status.update(statusOptions); else status = accept(mountStatus(statusHost, runtime, statusOptions));checkpoint();
      errorHost.innerHTML = error ? runtime.alertHtml({severity: 'error', role: 'alert', message: 'This Playlist could not be opened. Try again.'}) : '';
      const directoryOptions = {items: state.resource.data?.items || [], selectedPlaylistId: nativePlaylist.visible ? nativePlaylist.playlistId : null, onSelect: open};
      if (directory) directory.update(directoryOptions); else directory = accept(mountPlaylistGroupedDirectory(directoryHost, playlistRuntime, directoryOptions));checkpoint();
    } catch(error){dispose();if(error!==retired)throw error;} finally {rendering = false; if (!disposed&&pending) {pending = false; queueMicrotask(render);}}
  }
  try {
    scope.defer(runtime.subscribe(render));checkpoint();
    scope.defer(playlistRuntime.subscribe(render));checkpoint();
    scope.defer(playlists.subscribe(render));checkpoint();
    render();return Object.freeze({dispose});
  }catch(error){dispose();if(error!==retired)throw error;return Object.freeze({dispose});}
}
