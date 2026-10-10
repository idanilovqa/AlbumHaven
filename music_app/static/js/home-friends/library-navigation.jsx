import React, {useEffect, useState, useSyncExternalStore} from 'react';
import {createRoot} from 'react-dom/client';
import {createPortal} from 'react-dom';
import {NativeChoice} from './native-choice.jsx';
import {Button, NativeHtml, Status} from './components.jsx';
import {createPlaylistController} from '../playlists/model.mjs';
import {PlaylistGroupedDirectory} from '../playlists/directory-filters.jsx';

// The native drawer owns visibility and mode; these portals provide content.
export function mountLibraryNavigation({host, playlistHost, runtime, playlistRuntime}) {
  const root = createRoot(host), playlists = createPlaylistController({readPlaylists: playlistRuntime.readSidebarDirectory});
  let disposed = false;
  function Navigation() {
    const shell = useSyncExternalStore(runtime.subscribe, runtime.snapshot, runtime.snapshot);
    const nativePlaylist = useSyncExternalStore(playlistRuntime.subscribe, playlistRuntime.snapshot, playlistRuntime.snapshot);
    const state = useSyncExternalStore(playlists.subscribe, playlists.getSnapshot, playlists.getSnapshot);
    const [error, setError] = useState(false);
    const enabled = shell.authenticated && shell.inLibrary && shell.sidebarMode === 'playlists';
    useEffect(() => {
      playlists.setScope(enabled ? nativePlaylist.scopeKey : null);
      setError(false);
      if (enabled) playlists.load();
    }, [enabled, nativePlaylist.scopeKey, nativePlaylist.payload]);
    const open = async playlist_id => {
      const before = runtime.snapshot(), scopeKey = nativePlaylist.scopeKey;
      if (!enabled || (playlist_id && !state.resource.data?.items.some(item => item.playlist_id === playlist_id && item.allowed_actions?.can_open === true))) return false;
      try {
        await playlistRuntime.navigate({playlist_id});
        if (!disposed) setError(false);
      } catch (failure) {
        if (!disposed && failure?.name !== 'AbortError' && runtime.snapshot().scopeKey === before.scopeKey
          && playlistRuntime.snapshot().scopeKey === scopeKey) setError(true);
      }
    };
    const sidebar = enabled && state.scopeKey === nativePlaylist.scopeKey && <nav className="collection-sidebar" aria-label="Playlists">
      <Button runtime={runtime} onClick={() => open(null)}>All Playlists</Button>
      <Status runtime={runtime} value={state.resource} label="Playlists" retry={() => playlists.load()}/>
      {error && <NativeHtml html={runtime.alertHtml({severity: 'error', role: 'alert', message: 'This Playlist could not be opened. Try again.'})}/>}
      <PlaylistGroupedDirectory runtime={playlistRuntime} items={state.resource.data?.items || []}
        selectedPlaylistId={nativePlaylist.visible ? nativePlaylist.playlistId : null} onSelect={open}/>
    </nav>;
    return <>{shell.authenticated && shell.inLibrary && <NativeChoice runtime={runtime} label="Library navigation"
      value={shell.sidebarMode} options={ [['albums', 'Albums'], ['playlists', 'Playlists'], ['album_tops', 'Album Tops']] }
      onChange={runtime.selectSidebar} showLabel={false}/>}
      {shell.authenticated && shell.inLibrary && shell.sidebarMode === 'albums' && (shell.active || nativePlaylist.visible)
        && <NativeHtml html={runtime.navigationItemHtml({label: 'All artists', href: '/?surface=albums', key: 'all-artists', attributes: {'data-nav': '1'}})}/>}
      {playlistHost && createPortal(sidebar, playlistHost)}
    </>;
  }
  root.render(<Navigation/>);
  return Object.freeze({dispose() {if (!disposed) {disposed = true; playlists.dispose(); root.unmount();}}});
}
