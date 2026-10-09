import React, {useEffect, useLayoutEffect, useRef, useState} from 'react';
import {Button, Status} from '../home-friends/components.jsx';
import {NativeDialog} from '../home-friends/native-dialog.jsx';
import {SharingVisibility, SharingMember, SharingReaderAccess, SharingRequestDecision} from '../home-friends/resource-sharing.jsx';
import {CreationSearch} from '../playlists/creation.jsx';
import {MutationStatus} from '../playlists/mutation-status.jsx';
import {albumTopActionAllowed} from './model.mjs';

// Each server directory has its own cursor and response owner. A new resource
// revision or query starts again; stale pages cannot supply access controls.
function useSharingPage(controller, detail, method, enabled, query = '') {
  const [navigation, setNavigation] = useState(null), [result, setResult] = useState(null), [retry, setRetry] = useState(0);
  const currentNavigation = navigation?.detail === detail && navigation.query === query ? navigation : null;
  const cursor = currentNavigation?.cursor || null;
  const seen = currentNavigation?.seen || [];
  useEffect(() => {
    if (!enabled || !detail) return;
    const request = new AbortController();
    setResult(null);
    controller[method]({signal: request.signal, cursor, q: query}).then(value => {
      if (!request.signal.aborted && controller.getSnapshot().detail.data === detail) setResult({detail, query, cursor, value});
    });
    return () => request.abort();
  }, [controller, detail, method, enabled, query, cursor, retry]);
  const value = enabled && result?.detail === detail && result.query === query && result.cursor === cursor
    ? result.value : {status: 'loading', data: null};
  return {value, cursor, retry: () => setRetry(value => value + 1),
    canNext: next => Boolean(next && next !== cursor && !seen.includes(next) && seen.length < 100),
    next(next) {if (next && next !== cursor && !seen.includes(next) && seen.length < 100) setNavigation({detail, query, cursor: next, seen: [...seen, next]});},
    first() {setNavigation(null);}};
}
function SharingPages({runtime, page, next, disabled, label, current}) {
  return <>{page.cursor && <Button runtime={runtime} disabled={disabled} onClick={() => {if (current()) page.first();}}>First {label} page</Button>}
    {next && <Button runtime={runtime} disabled={disabled || !page.canNext(next)} onClick={() => {if (current()) page.next(next);}}>More {label}</Button>}</>;
}
export function ShareAlbumTop({runtime, controller, state, onClose, returnFocus}) {
  const detail = state.detail.data;
  const [visibility, setVisibility] = useState(null), [query, setQuery] = useState(''), [decisionDraft, setDecisions] = useState(null);
  const live = useRef(null);
  const busy = state.mutation.refreshing === true || ['loading', 'uncertain'].includes(state.mutation.status);
  const allowed = albumTopActionAllowed(state, 'view_sharing');
  const sharing = useSharingPage(controller, detail, 'readSharing', allowed);
  const data = sharing.value.data;
  const manage = allowed && data?.can_manage === true && albumTopActionAllowed(state, 'visibility');
  const grants = useSharingPage(controller, detail, 'readAccessGrants', manage);
  const candidates = useSharingPage(controller, detail, 'readAccessCandidates', manage, query);
  const conflict = [data, grants.value.data, candidates.value.data].some(value => value && value.revision !== detail?.revision);
  const frame = {controller, detail, scopeKey: state.scopeKey}; live.current = frame;
  useLayoutEffect(() => () => {live.current = null;}, []);
  const decisions = decisionDraft?.detail === detail ? decisionDraft.values : {};
  const active = () => live.current === frame && controller.getSnapshot().scopeKey === state.scopeKey
    && controller.getSnapshot().detail.data === detail && !['loading', 'uncertain'].includes(controller.getSnapshot().mutation.status)
    && controller.getSnapshot().mutation.refreshing !== true;
  const writable = action => active() && !conflict && albumTopActionAllowed(controller.getSnapshot(), action);
  const mutate = (action, value) => {if (writable(action)) return controller.mutate(action, value);};
  const selectedVisibility = visibility?.detail === detail ? visibility.value : data?.visibility;
  const canDismiss = () => {
    const mutation = controller.getSnapshot().mutation;
    return mutation.refreshing !== true && mutation.status !== 'loading'
      && (mutation.status !== 'uncertain' || !controller.canRetryMutation());
  };
  const dismissalBlocked = !canDismiss();
  return <NativeDialog runtime={runtime} title="Share Album Top" pageId="share-album-top" showCloseButton
    returnFocus={returnFocus} dismissDisabled={dismissalBlocked} onClose={onClose} beforeDismiss={canDismiss}>
    {close => <div className="playlists__form tag-editor-form">
      <Status runtime={runtime} value={sharing.value} label="Album Top sharing" retry={sharing.retry}/>
      {conflict && <><p className="playlists__note" role="alert">This Album Top changed. Refresh it before editing access.</p>
        <Button runtime={runtime} disabled={busy} onClick={() => {if (active()) controller.open(detail.top_ref);}}>Refresh Album Top</Button></>}
      {data && !data.can_manage && <SharingReaderAccess runtime={runtime} value={data}
        disabled={busy || conflict || !albumTopActionAllowed(state, 'request_edit')}
        onRequest={() => {if (data.request_status !== 'pending') mutate('request_edit');}}/>}
      {manage && <>
        <SharingVisibility runtime={runtime} label="Album Top visibility" visibility={selectedVisibility} disabled={busy || conflict}
          onChange={value => {if (writable('visibility')) setVisibility({detail, value});}}>
          Private Album Tops are visible to their owner and explicit editors. Server-shared Album Tops are visible to authorized members of this library.
        </SharingVisibility>
        {data.pending_requests.map(request => <SharingRequestDecision key={request.request_ref} runtime={runtime} request={request}
          role={decisions[request.request_ref] || 'viewer'} disabled={busy || conflict}
          onRole={role => {if (writable('decide_edit_request')) setDecisions({detail, values: {...decisions, [request.request_ref]: role}});}}
          onDecision={decision => {if (decision === 'decline' || decisions[request.request_ref] === 'editor') mutate('decide_edit_request', {request_ref: request.request_ref, decision});}}/>)}
        <SharingPages runtime={runtime} page={sharing} next={data.next_pending_cursor} disabled={busy} label="edit requests" current={active}/>
        <fieldset disabled={busy || conflict}><legend>Editors</legend>
          <Status runtime={runtime} value={grants.value} label="Album Top editors" retry={grants.retry}/>
          {grants.value.data?.grants.map(person => <SharingMember key={person.grant_ref} person={person}>
            <Button runtime={runtime} disabled={busy || conflict} onClick={() => mutate('revoke_editor', {grant_ref: person.grant_ref})}>Remove editor</Button>
          </SharingMember>)}
          {grants.value.data?.grants.length === 0 && <p>No explicit editors.</p>}
        </fieldset>
        <SharingPages runtime={runtime} page={grants} next={grants.value.data?.next_cursor} disabled={busy} label="editors" current={active}/>
        <CreationSearch runtime={runtime} id="album-top-sharing-search" label="Find library members" value={query} maxLength={100} disabled={busy}
          onChange={value => {if (active()) setQuery(value.slice(0, 100));}}/>
        <Status runtime={runtime} value={candidates.value} label="Eligible library members" retry={candidates.retry}/>
        {candidates.value.data?.candidates.map(person => <SharingMember key={person.account_ref} person={person}>
          <Button runtime={runtime} disabled={busy || conflict || person.allowed_actions.can_grant_editor !== true}
            onClick={() => {if (person.allowed_actions.can_grant_editor === true) mutate('grant_editor', {account_id: person.account_id, role: 'editor'});}}>
            {person.grant_ref ? 'Editor' : 'Add editor'}
          </Button>
        </SharingMember>)}
        {candidates.value.data?.candidates.length === 0 && <p>No matching eligible library members.</p>}
        <SharingPages runtime={runtime} page={candidates} next={candidates.value.data?.next_cursor} disabled={busy} label="library members" current={active}/>
        <p className="playlists__note">Each editor change is saved separately. Personal ratings and listening progress stay private.</p>
      </>}
      <MutationStatus runtime={runtime} value={{...state.mutation, status: state.mutation.status === 'uncertain' ? 'error' : state.mutation.status}} controller={controller}/>
      {state.mutation.status === 'uncertain' && !dismissalBlocked && <p className="playlists__note" role="status">
        Access changed. You can close this dialog and refresh the Album Top before retrying the original request.
      </p>}
      <div className="playlists__actions">{manage && <Button runtime={runtime} disabled={busy || conflict || selectedVisibility === data.visibility}
        onClick={() => mutate('visibility', {visibility: selectedVisibility})}>Save visibility</Button>}
        <Button runtime={runtime} disabled={dismissalBlocked} onClick={() => {if (canDismiss()) return close();}}>Close</Button></div>
    </div>}
  </NativeDialog>;
}
