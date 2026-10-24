import React, {useLayoutEffect, useRef, useSyncExternalStore} from 'react';
import {Button, NativeHtml} from '../home-friends/components.jsx';
import {NativeDialog} from '../home-friends/native-dialog.jsx';
import {NativeChoice} from '../home-friends/native-choice.jsx';
import {detailDuration} from '../home-friends/detail-projection.jsx';

export function DraftLocalMatchContent({runtime, controller, state, row, close}) {
  const blocked = ['loading', 'accepting'].includes(state.status), uncertain = state.status === 'uncertain';
  const message = {
    idle: 'Choose a local version, then accept the match.', loading: 'Checking possible local matches…',
    accepting: 'Checking and accepting this local match…',
    accepted: 'Matched locally. It remains in your draft until you remove it; TXT excludes it.',
    error: 'Local matches could not be checked. The original information is preserved.',
    uncertain: 'The match was not confirmed. Check the result before continuing; the same chosen match will be retried.',
    conflict: 'This source or match changed. Review the current choices.',
    denied: 'You no longer have permission to match this source track.',
    unavailable: 'Local matching is unavailable for this source track.',
  }[state.status] || (state.candidates.length ? 'Choose a local version, then accept the match.'
    : 'No suggested local match was found in the checked tracks. The original remains in the draft and TXT.');
  const current = () => controller.getSnapshot() === state;
  return <div aria-busy={blocked}>
    <p className="playlists__note">{[row.title, row.artist, row.album_title].filter(Boolean).join(' · ')}</p>
    <NativeHtml html={runtime.alertHtml({severity: ['error', 'uncertain', 'conflict', 'denied'].includes(state.status) ? 'error' : 'info', role: 'status', message})}/>
    {state.status === 'ready' && !state.suggestionsComplete && <p className="playlists__note">Suggestions cover a limited set of local tracks.</p>}
    {state.candidates.length > 0 && <NativeChoice runtime={runtime} label="Possible local matches" value={state.selectedKey}
      disabled={blocked || uncertain} options={[
        ['', 'Choose local match', true],
        ...state.candidates.map(candidate => [candidate.key, [candidate.title, candidate.artist, candidate.album_title,
          candidate.duration_seconds === null ? '' : detailDuration(candidate.duration_seconds)].filter(Boolean).join(' · ')]),
      ]} onChange={key => {if (current()) controller.select(key);}}/>}
    {['error', 'conflict', 'unavailable'].includes(state.status) && <Button runtime={runtime}
      onClick={() => {if (current()) controller.load();}}>Review current choices</Button>}
    <div className="playlists__actions">
      {state.status !== 'accepted' && <Button runtime={runtime} disabled={blocked || !state.selectedKey || !['ready', 'uncertain'].includes(state.status)}
        onClick={async () => {if (current() && await controller.accept()) await close({force: true});}}>
        {uncertain ? 'Check match result' : 'Accept match'}
      </Button>}
      <Button runtime={runtime} disabled={controller.blocking()} onClick={() => {if (current()) close();}}>
        {state.status === 'accepted' ? 'Close' : 'Cancel'}
      </Button>
    </div>
  </div>;
}

export function MissingPlaylistLocalMatch({runtime, controller: draft, row, disabled = false}) {
  const controller = draft.localMatch, state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const trigger = useRef(null), latest = useRef(null); latest.current = {row, disabled};
  const opened = state.rowKey === row.row_key && state.status !== 'closed';
  useLayoutEffect(() => () => {if (controller.getSnapshot().rowKey === row.row_key) controller.close();}, [controller, row.row_key]);
  useLayoutEffect(() => {if (disabled && controller.getSnapshot().rowKey === row.row_key) controller.close();}, [controller, disabled, row.row_key]);
  const available = controller.available();
  return <div ref={trigger} className="playlists__match-review" aria-label="Local match availability">
    <Button runtime={runtime} disabled={disabled || !available} onClick={() => {
      if (latest.current.row !== row || latest.current.disabled || disabled) return;
      if (controller.open(row.row_key)) controller.load();
    }}>{available ? 'Review local match' : 'Local matching unavailable'}</Button>
    {!available && <p className="playlists__note">Local matching is unavailable for this source track. Its original information is preserved.</p>}
    {row.match_state === 'accepted' && <p className="playlists__note" role="status">Matched locally. Original information is preserved; TXT excludes this track.</p>}
    {opened && <NativeDialog runtime={runtime} title="Review local match" pageId="playlist-local-match"
      beforeDismiss={() => !controller.blocking()} returnFocus={() => trigger.current?.querySelector('button:not(:disabled)')}
      onClose={() => controller.close()}>{close => <DraftLocalMatchContent runtime={runtime} controller={controller}
        state={state} row={row} close={close}/>}</NativeDialog>}
  </div>;
}
