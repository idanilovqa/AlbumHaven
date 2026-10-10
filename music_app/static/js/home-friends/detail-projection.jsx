import React, {useId} from 'react';
import {createPortal} from 'react-dom';
import {Button, NativeHtml} from './components.jsx';
import {metric} from './model.mjs';
import {detailSelection, matchingDetail} from './detail-projection.mjs';
import {ListenedAlbums, resourceArtwork as artwork} from './artist-selection.jsx';

export function detailDuration(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 'Unknown';
  const seconds = Math.floor(value);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
const knownText = value => typeof value === 'string' && value.trim() ? value : 'Unknown';
const metadataLabel = value => value === 'last_known' ? 'Last-known metadata'
  : value === 'current' ? 'Current metadata' : 'Metadata freshness unknown';
function DetailStatus({runtime, status, kind, onRetry}) {
  const label = kind === 'artist' ? 'Artist information' : 'Album details';
  const message = {loading: `Loading ${label.toLowerCase()}…`, empty: `No ${label.toLowerCase()} ${kind === 'artist' ? 'was' : 'were'} returned.`,
    denied: `You don't have access to these ${kind === 'artist' ? 'artist details' : 'album details'}.`,
    unavailable: `${label} ${kind === 'artist' ? 'is' : 'are'} unavailable from this provider.`, error: `${label} could not be loaded.`}[status]
    || `${label} ${kind === 'artist' ? 'is' : 'are'} unavailable.`;
  return <div aria-busy={status === 'loading'}>
    <NativeHtml html={runtime.alertHtml({severity: status === 'error' ? 'error' : 'info', role: status === 'error' ? 'alert' : 'status', message})}/>
    {status === 'error' && onRetry && <Button runtime={runtime} onClick={onRetry}>Retry details</Button>}
  </div>;
}

function Tracks({runtime, data, id}) {
  if (data.tracks === null) return <p className="home-friends__muted">Track information is unknown.</p>;
  const escape = runtime.escapeHtml, hasDiscs = data.tracks.some(track => track.disc_number !== null);
  const columns = [...(hasDiscs ? [{key: 'disc', label: 'Disc'}] : []),
    {key: 'number', label: '#'}, {key: 'title', label: 'Track'}, {key: 'duration', label: 'Length'}];
  return <NativeHtml html={runtime.tableHtml({id: `${id}-tracks`, ariaLabel: 'Album tracks',
    columns: `${hasDiscs ? 'minmax(40px,auto) ' : ''}minmax(32px,auto) minmax(0,1fr) minmax(60px,auto)`,
    columnsConfig: columns, density: 'compact', frame: 'outline', mobile: 'preserve', overflow: 'local',
    emptyHtml: '<p>No tracks were returned.</p>', rows: data.tracks.map(track => ({key: track.id, cells: {
      disc: escape(track.disc_number === null ? 'Unknown' : metric(track.disc_number)), number: escape(track.track_number === null ? 'Unknown' : metric(track.track_number)),
      title: `${escape(knownText(track.title))}${track.artist ? `<br><small class="home-friends__muted">${escape(track.artist)}</small>` : ''}`,
      duration: escape(detailDuration(track.duration_seconds)),
    }}))})}/>;
}
function Discography({runtime, data, id}) {
  if (data.discography === null) return <p className="home-friends__muted">Discography information is unknown.</p>;
  const escape = runtime.escapeHtml;
  return <NativeHtml html={runtime.tableHtml({id: `${id}-discography`, ariaLabel: 'Artist discography',
    columns: 'minmax(0,1fr) minmax(48px,auto) minmax(80px,auto)', density: 'compact', frame: 'outline', mobile: 'preserve', overflow: 'local',
    columnsConfig: [{key: 'release', label: 'Release'}, {key: 'year', label: 'Year'}, {key: 'type', label: 'Type'}],
    emptyHtml: '<p>No releases were returned.</p>', rows: data.discography.map(release => ({key: release.id, cells: {
      release: `<span class="home-detail__release">${artwork(runtime, release, `${knownText(release.title)} artwork`)}<span>${escape(knownText(release.title))}<br><small class="home-friends__muted">${escape(metadataLabel(release.metadata_state))}</small></span></span>`,
      year: escape(knownText(release.year)), type: escape(knownText(release.release_type)),
    }}))})}/>;
}

// Value must come from normalizeDetailResult/controller. Recheck selection here
// so a parent navigation render cannot briefly show another resource's details.
export function DetailProjectionPanel({runtime, value, selection, onRetry, onIntent, canIntent, onSelectAlbum, listenedAlbumsHost}) {
  const id = `home-detail-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const target = detailSelection(selection), kind = target?.kind === 'artist' ? 'artist' : 'album';
  const granted = target?.allowed_actions.can_view_details === true;
  const matching = matchingDetail(value?.data, target);
  const status = !target ? 'unavailable' : !granted ? 'denied'
    : value?.status === 'ready' && !matching ? 'unavailable' : value?.status || 'unavailable';
  const data = status === 'ready' && matching ? value.data : null;
  const actionTarget = data ? detailSelection({...target, native_actions: data.native_actions || target.native_actions}) : target;
  const permitted = intent => !!data && typeof onIntent === 'function' && canIntent?.(intent, actionTarget) === true;
  const invoke = intent => {if (permitted(intent)) onIntent(intent, actionTarget);};
  const listened = data && kind === 'artist' ? <section className="home-detail__collection" aria-label="Listened albums">
    <h4>Albums from the artist you've listened to</h4>
    <ListenedAlbums runtime={runtime} albums={data.listened_albums} onSelect={onSelectAlbum}/>
  </section> : null;
  return <section className="home-detail" aria-label={kind === 'artist' ? 'Artist information' : 'Album details'} data-detail-kind={kind}>
    {data ? <>
      {kind === 'artist' && typeof runtime.artistInfoHtml === 'function' ? <NativeHtml html={runtime.artistInfoHtml({
        presentation: 'embedded', artist: data.title, imageUrl: data.artwork_url, summary: data.summary,
        metadata: [metadataLabel(data.metadata_state), data.release_count === null ? '' : `${metric(data.release_count)} releases`].filter(Boolean).join(' · '),
        sourceLabel: data.source_label})}/> : <>
      <div className="home-detail__overview">
        <div className="home-detail__artwork">{permitted('artwork') ?
          <button type="button" className="utility-artbox-trigger" aria-label={`Enlarge ${knownText(data.title)} artwork`}
            onClick={() => invoke('artwork')}><NativeHtml html={artwork(runtime, data, `${knownText(data.title)} artwork`)}/></button>
          : <NativeHtml html={artwork(runtime, data, `${knownText(data.title)} artwork`)}/>}</div>
        <div className="home-detail__identity"><NativeHtml html={runtime.detailHeaderHtml({variant: 'copy',
          titleId: `${id}-title`, subtitleId: `${id}-subtitle`, title: knownText(data.title),
          eyebrow: kind === 'album' ? data.artist : '', subtitle: metadataLabel(data.metadata_state)})}/>
          {permitted('open') && <Button runtime={runtime} onClick={() => invoke('open')}>{data.title || 'Open album'}</Button>}
          {permitted('page') && <Button runtime={runtime} icon="expand" onClick={() => invoke('page')}>Full size</Button>}
          {permitted('artist_gallery') && <Button runtime={runtime} onClick={() => invoke('artist_gallery')}>View Artist Gallery</Button>}
          <dl className="home-detail__facts">{kind === 'album' ? <>
            <dt>Year</dt><dd>{knownText(data.year)}</dd><dt>Release type</dt><dd>{knownText(data.release_type)}</dd>
            <dt>Tracks</dt><dd>{data.track_count === null ? 'Unknown' : metric(data.track_count)}</dd>
            <dt>Length</dt><dd>{detailDuration(data.duration_seconds)}</dd>
          </> : <><dt>Releases</dt><dd>{data.release_count === null ? 'Unknown' : metric(data.release_count)}</dd></>}</dl>
        </div>
      </div>
      <div className="home-detail__information"><h4>Information</h4><p className="home-detail__summary">{data.summary || 'No information was supplied.'}</p>
        {data.source_label && <p className="home-friends__muted">Source: {data.source_label}</p>}</div>
      </>}
      {kind === 'artist' && typeof runtime.artistInfoHtml === 'function' && permitted('artist_gallery')
        && <Button runtime={runtime} onClick={() => invoke('artist_gallery')}>View Artist Gallery</Button>}
      {listened && (listenedAlbumsHost?.nodeType === 1 && listenedAlbumsHost.isConnected
        ? createPortal(listened, listenedAlbumsHost) : listened)}
      <div className="home-detail__collection"><h4>{kind === 'album' ? 'Tracks' : 'Discography'}</h4>
        {kind === 'album' ? <Tracks runtime={runtime} data={data} id={id}/> : <Discography runtime={runtime} data={data} id={id}/>}</div>
    </> : <DetailStatus runtime={runtime} status={status} kind={kind} onRetry={onRetry}/>}</section>;
}
