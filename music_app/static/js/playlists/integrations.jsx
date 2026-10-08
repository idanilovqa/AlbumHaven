import React from 'react';
import {Button, NativeHtml, Status} from '../home-friends/components.jsx';

function IntegrationMutation({runtime, value, matching = false}) {
  if (!value || value.status === 'idle') return null;
  const message = {loading: matching ? 'Accepting the selected match…' : 'Waiting for the native player…',
    ready: matching ? 'The matching provider confirmed the selection.' : 'The native player acknowledged the request.',
    error: 'The request was not confirmed.', denied: 'Access changed. Refresh this playlist before trying again.',
    unavailable: 'This integration is unavailable.'}[value.status];
  return <NativeHtml html={runtime.alertHtml({severity: ['error', 'denied'].includes(value.status) ? 'error' : 'info',
    role: ['error', 'denied'].includes(value.status) ? 'alert' : 'status', message})}/>;
}

export function PlaylistPlaybackControls({runtime, controller, state}) {
  const value = state.playback, playback = value.status === 'ready' ? value.data : null;
  const row = state.currentItemId && state.detail?.track_rows.find(item => item.playlist_item_id === state.currentItemId);
  const current = !playback ? null : playback.current_playlist_id === null ? 'The native player has no current playlist track.'
    : playback.current_playlist_id !== state.detail?.playlist_id ? 'The current track belongs to another playlist.'
      : row ? `Current: ${row.title || 'Untitled track'}` : 'The current queued track is outside this playlist projection.';
  return <section className="playlists__playback" aria-label="Playlist playback">
    <div className="playlists__actions" role="toolbar" aria-label="Playlist playback controls">
      <Button runtime={runtime} disabled={!state.available.shuffle} selected={playback ? playback.shuffle : undefined}
        onClick={() => controller.playbackIntent('shuffle')}>{playback ? `Shuffle ${playback.shuffle ? 'on' : 'off'}` : 'Shuffle unavailable'}</Button>
      <Button runtime={runtime} disabled={!state.available.repeat} selected={playback ? playback.repeat !== 'off' : undefined}
        onClick={() => controller.playbackIntent('repeat')}>{playback ? {off: 'Repeat off', all: 'Repeat playlist', one: 'Repeat one track'}[playback.repeat] : 'Repeat unavailable'}</Button>
      <Button runtime={runtime} disabled={!state.available.return_to_current}
        onClick={() => controller.playbackIntent('return_to_current')}>Return to current</Button>
    </div>
    {value.status === 'unavailable' ? <NativeHtml html={runtime.alertHtml({severity: 'info', role: 'status',
      message: 'Playlist queue controls are incomplete: no authorized queue provider is available. Track playback remains owned by the native player.'})}/>
      : <Status runtime={runtime} value={value} label="Playlist queue controls" retry={() => controller.loadPlayback()}/>}
    {current && <p className="playlists__note" role="status">{current}</p>}
    <IntegrationMutation runtime={runtime} value={state.playbackMutation}/>
  </section>;
}

export function PlaylistMatchReview({runtime, controller, state, onAccepted}) {
  if (!state.selectedItemId) return null;
  const source = state.detail?.track_rows.find(row => row.playlist_item_id === state.selectedItemId && row.source_readable !== false);
  if (!source || !['unresolved', 'missing'].includes(source.availability)) return null;
  const value = state.matches, data = ['ready', 'empty'].includes(value.status) ? value.data : null;
  return <section className="playlists__match-review" aria-label="Selected track match review">
    <h3>Review local match</h3><strong>{source.title || 'Untitled original'}</strong>
    <p className="playlists__note">{[source.artist || source.secondary_artist, source.album_title].filter(Boolean).join(' · ')}</p>
    <p>{source.availability === 'missing' ? 'This source track is confirmed missing.' : 'Local availability is unresolved. This original remains included for review.'} Choosing a candidate does not accept a match.</p>
    {value.status === 'unavailable' ? <NativeHtml html={runtime.alertHtml({severity: 'info', role: 'status',
      message: 'Local matching is incomplete: no authorized match provider is available for this track.'})}/>
      : value.status === 'empty' ? <NativeHtml html={runtime.alertHtml({severity: 'info', role: 'status', message: 'No possible local matches were supplied. The original track is unchanged.'})}/>
        : <Status runtime={runtime} value={value} label="Local match candidates" retry={() => controller.loadMatches()}/>}
    {data?.candidates.length > 0 && <div className="playlists__match-candidates" role="group" aria-label="Choose a possible local match">
      {data.candidates.map(candidate => <Button key={candidate.candidate_ref} runtime={runtime} selected={state.candidateRef === candidate.candidate_ref}
        disabled={state.matchMutation.status === 'loading'} onClick={() => controller.chooseCandidate(candidate.candidate_ref)}>
        {[candidate.title || 'Untitled candidate', candidate.artist, candidate.album_title, candidate.version_label].filter(Boolean).join(' · ')}
      </Button>)}
    </div>}
    <Button runtime={runtime} disabled={!state.available.acceptMatch} attributes={{'data-playlists-accept-match': '1'}}
      onClick={async () => {if (await controller.acceptMatch()) onAccepted?.();}}>Accept selected local match</Button>
    <IntegrationMutation runtime={runtime} value={state.matchMutation} matching/>
  </section>;
}
