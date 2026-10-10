import React, {useEffect, useLayoutEffect, useRef, useState} from 'react';
import {Button, Status} from '../home-friends/components.jsx';
import {SharingVisibility, SharingMember, SharingReaderAccess, SharingRequestDecision} from '../home-friends/resource-sharing.jsx';
import {NativeDialog} from '../home-friends/native-dialog.jsx';
import {CreationSearch} from './creation.jsx';
import {MutationStatus} from './mutation-status.jsx';
import {draftDirty, playlistDraft} from './model.mjs';

export function SharingFields({runtime, value, busy, onChange, onEditor}) {
  return <div className="playlists__sharing tag-editor-form">
    <SharingVisibility runtime={runtime} label="Playlist visibility" visibility={value.visibility} disabled={busy || !value.can_manage}
      publicUnavailable onChange={visibility => onChange({...value, visibility})}>
      Private playlists are visible to their owner and explicit editors. Server-shared playlists are visible to authorized members of this library. Public links are unavailable.
    </SharingVisibility>
    <fieldset disabled={busy || !value.can_manage}><legend>Editors</legend>
      {value.people.map(person => <SharingMember key={person.account_ref} person={person}>
        <Button runtime={runtime} disabled={busy || !value.can_manage || !person.can_edit}
          onClick={() => onEditor?.({account_ref: person.account_ref, selected: !person.selected})}>
          {person.selected ? 'Remove editor' : 'Add editor'}
        </Button>
      </SharingMember>)}
      {!value.people.length && <p>No matching library members.</p>}
    </fieldset>
    <p className="playlists__note">Each editor change is saved separately. Personal ratings and listening progress are not shared here.</p>
  </div>;
}

export function SharePlaylist({runtime, controller, state, onClose}) {
  const detail = state.resource.data?.detail;
  const [sharing, setSharing] = useState({subject: null, value: {status: 'loading', data: null}});
  const [visibility, setVisibility] = useState(null), [query, setQuery] = useState(''), [cursor, setCursor] = useState(null);
  const [decisions, setDecisions] = useState({});
  const [retry, setRetry] = useState(0), live = useRef(null), seen = useRef(new Set());
  const busy = state.mutation.status === 'loading';
  const current = Boolean(detail && sharing.subject === detail);
  const data = current ? sharing.value.data : null;
  const revisionConflict = Boolean(data && data.revision !== detail.revision);
  const metadataDirty = draftDirty(detail, playlistDraft(state));
  const frame = {controller, detail, sharing, busy}; live.current = frame;
  useLayoutEffect(() => () => {live.current = null;}, []);
  useEffect(() => {setVisibility(null); setCursor(null); seen.current.clear();}, [controller, detail, state.scopeKey]);
  useEffect(() => {
    if (!detail) return;
    const request = new AbortController(), subject = detail;
    setSharing({subject, value: {status: 'loading', data: null}});
    controller.readSharing({signal: request.signal, q: query, cursor}).then(value => {
      if (!request.signal.aborted && live.current?.controller === controller && controller.getSnapshot().resource.data?.detail === subject) {
        setSharing({subject, value});
      }
    });
    return () => request.abort();
  }, [controller, detail, state.scopeKey, query, cursor, retry]);
  const active = () => current && live.current === frame && live.current.controller === controller
    && controller.getSnapshot().resource.data?.detail === detail && controller.getSnapshot().mutation.status !== 'loading';
  const writable = () => !revisionConflict && active() && !draftDirty(detail, playlistDraft(controller.getSnapshot()));
  const display = data && {...data, visibility: visibility ?? data.visibility};
  return <NativeDialog runtime={runtime} showCloseButton dismissDisabled={busy} title="Share playlist" onClose={onClose} beforeDismiss={() => controller.getSnapshot().mutation.status !== 'loading'}>{close =>
    <div className="playlists__form tag-editor-form">
      {data?.can_manage && <CreationSearch runtime={runtime} id="playlist-sharing-search" label="Find library members" maxLength={100} value={query} disabled={busy}
        onChange={value => {if (!busy && live.current?.controller === controller) {setQuery(value.slice(0, 100)); setCursor(null); seen.current.clear();}}}/>}
      <Status runtime={runtime} value={current ? sharing.value : {status: 'loading'}} label="Playlist sharing" retry={() => setRetry(value => value + 1)}/>
      {metadataDirty && <p className="playlists__note">Save or discard the playlist's unsaved changes before updating sharing.</p>}
      {revisionConflict && <><p className="playlists__note" role="alert">This playlist changed. Refresh it before editing access.</p>
        <Button runtime={runtime} disabled={busy} onClick={async () => {
          if (!active()) return;
          const scopeKey = state.scopeKey, playlistId = state.selectedPlaylistId, version = controller.getLifecycleVersion();
          if (await close({force: true, restoreFocus: false}) !== true) return;
          const latest = controller.getSnapshot();
          if (latest.scopeKey === scopeKey && latest.selectedPlaylistId === playlistId && controller.getLifecycleVersion() === version) await controller.load();
        }}>Refresh playlist</Button></>}
      {data && !data.can_manage && <SharingReaderAccess runtime={runtime} value={data}
        disabled={busy || revisionConflict || !controller.available('requestEditAccess')}
        onRequest={() => {if (writable()) controller.mutate('requestEditAccess');}}/>}
      {data?.can_manage && data.pending_requests.map(request => <SharingRequestDecision key={request.request_ref}
        runtime={runtime} request={request} role={decisions[request.request_ref] || 'viewer'} disabled={busy || metadataDirty || revisionConflict}
        onRole={role => {if (writable()) setDecisions(value => ({...value, [request.request_ref]: role}));}}
        onDecision={decision => {if (writable() && (decision === 'decline' || decisions[request.request_ref] === 'editor')) {
          controller.mutate('decideEditRequest', {request_ref: request.request_ref, decision});
        }}}/>)}
      {display?.can_manage && <SharingFields runtime={runtime} value={display} busy={busy || metadataDirty || revisionConflict} onChange={value => {if (writable()) setVisibility(value.visibility);}}
        onEditor={value => {if (writable()) controller.mutate('setPlaylistEditor', value);}}/>}
      {cursor && <Button runtime={runtime} disabled={busy} onClick={() => {if (active()) {setCursor(null); seen.current.clear();}}}>First page</Button>}
      {data?.next_cursor && <Button runtime={runtime} disabled={busy || seen.current.has(data.next_cursor)} onClick={() => {
        if (!active() || seen.current.has(data.next_cursor)) return;
        seen.current.add(data.next_cursor); setCursor(data.next_cursor);
      }}>More library members</Button>}
      <MutationStatus runtime={runtime} value={state.mutation} controller={controller}/>
      <div className="playlists__actions">{data?.can_manage && <Button runtime={runtime} disabled={busy || metadataDirty || revisionConflict || !data?.can_manage || !controller.available('saveSharing') || display.visibility === data.visibility}
        onClick={() => {if (writable()) controller.mutate('saveSharing', {visibility: display.visibility});}}>Save visibility</Button>}
        <Button runtime={runtime} disabled={busy} onClick={() => close()}>Close</Button></div>
    </div>}
  </NativeDialog>;
}
