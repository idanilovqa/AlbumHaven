import React, {useId, useState} from 'react';
import {Button, NativeHtml, Status, Tabs} from '../home-friends/components.jsx';
import {DetailProjectionPanel, detailDuration} from '../home-friends/detail-projection.jsx';
import {ResourceDetail} from '../home-friends/resource-detail.jsx';
import {playlistAlbumSelection, playlistArtistSelection, playlistSourceReadable, playlistTrackSummary} from './selection.mjs';

const known = value => typeof value === 'string' && value.trim() ? value : 'Unknown';

export function PlaylistTrackSummary({runtime, row}) {
  const id = `playlist-track-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const value = playlistTrackSummary(row), data = value.data;
  if (!data) return <Status runtime={runtime} value={value} label="this track's information"/>;
  const metadata = {current: 'Current metadata', last_known: 'Last-known metadata', unknown: 'Metadata freshness unknown'}[data.metadata_state];
  const facts = [
    ['Artist', known(data.artist || data.secondary_artist)], ['Album', known(data.album_title)],
    ['Track', data.track_number ?? 'Unknown'], ['Disc', data.disc_number ?? 'Unknown'],
    ['Length', data.duration_seconds === null ? known(data.duration_display) : detailDuration(data.duration_seconds)],
    ['Source', known(data.source_label)], ['Source type', known(data.source_kind)],
    ['Availability', {local: 'Confirmed local', missing: 'Confirmed missing', unresolved: 'Unresolved'}[data.availability]],
  ];
  return <section className="home-detail" aria-label="Track information">
    <div className="home-detail__overview">
      <NativeHtml className="home-detail__artwork" html={runtime.artboxHtml({state: data.artwork_url ? 'ready' : 'empty',
        label: `${known(data.title)} artwork`, coverHtml: data.artwork_url
          ? `<img src="${runtime.escapeHtml(data.artwork_url)}" alt="" loading="lazy" decoding="async">` : ''})}/>
      <div className="home-detail__identity"><NativeHtml html={runtime.detailHeaderHtml({variant: 'copy',
        titleId: `${id}-title`, subtitleId: `${id}-subtitle`, title: known(data.title),
        eyebrow: data.artist || data.secondary_artist, subtitle: metadata})}/>
      </div>
    </div>
    <dl className="home-detail__facts">{facts.map(([label, content]) => <React.Fragment key={label}><dt>{label}</dt><dd>{content}</dd></React.Fragment>)}</dl>
  </section>;
}

const unavailableDetail = () => ({status: 'unavailable'});
function PlaylistResourceDetails({runtime, scopeKey, row, readDetail, kind = 'album', onError}) {
  if (row && !playlistSourceReadable(row)) {
    return <Status runtime={runtime} value={{status: 'denied'}} label={`this ${kind}'s information`}/>;
  }
  const selection = kind === 'artist' ? playlistArtistSelection(row) : playlistAlbumSelection(row);
  if (!selection?.allowed_actions.can_view_details) {
    return <DetailProjectionPanel runtime={runtime} selection={selection} value={{status: 'unavailable', data: null}}/>;
  }
  // An absent configured reader stays unavailable. The shared native owner may
  // independently resolve an explicitly granted viewer-local catalog target.
  return <ResourceDetail runtime={runtime} scopeKey={scopeKey} selection={selection}
    readDetail={typeof readDetail === 'function' ? readDetail : unavailableDetail} onError={onError}/>;
}
export function PlaylistAlbumDetails(props) {return <PlaylistResourceDetails {...props} kind="album"/>;}
export function PlaylistArtistDetails(props) {return <PlaylistResourceDetails {...props} kind="artist"/>;}

// Parent owns current-row resolution, invalidation and native return focus. This
// panel uses the shared guarded resource owner for deliberate native actions.
export function PlaylistSelectionPanel({runtime, scopeKey, row, readDetail, onClose}) {
  const id = `playlist-selection-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const [choice, setChoice] = useState(null), [actionError, setActionError] = useState(null);
  if (!row) return null;
  const artist = playlistArtistSelection(row);
  const chosen = choice?.rowKey === row.row_key ? choice.tab : 'track';
  const tab = chosen === 'artist' && !artist ? 'track' : chosen;
  const close = () => onClose?.({rowKey: row.row_key, restoreFocusRequested: true});
  return <aside className="playlists__selection" aria-label="Selected playlist item" onKeyDown={event => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault(); event.stopPropagation(); close();
  }}>
    <header className="gallery-bar playlists__selection-header"><div className="gallery-bar__context"><h2>Selected item</h2></div>
      <div className="gallery-bar__actions"><Button runtime={runtime} icon="close" onClick={close}>Close selection</Button></div>
    </header>
    <Tabs runtime={runtime} id={id} label="Selected item information" items={[['track', 'Track'], ['album', 'Album'], ...(artist ? [['artist', 'Artist']] : [])]}
      value={tab} onChange={next => {if (next === 'track' || next === 'album' || next === 'artist' && artist) setChoice({rowKey: row.row_key, tab: next});}}/>
    <div className="playlists__selection-body gallery-scrollbar" role="tabpanel" aria-labelledby={`${id}-${tab}`}>
      {actionError?.row === row && <NativeHtml html={runtime.alertHtml({severity: 'error', role: 'alert', message: actionError.message})}/>}
      {tab === 'artist' ? <PlaylistArtistDetails runtime={runtime} scopeKey={scopeKey} row={row} readDetail={readDetail} onError={message => setActionError({row, message})}/>
        : tab === 'album' ? <PlaylistAlbumDetails runtime={runtime} scopeKey={scopeKey} row={row} readDetail={readDetail} onError={message => setActionError({row, message})}/>
        : <PlaylistTrackSummary runtime={runtime} row={row}/>}
    </div>
  </aside>;
}
