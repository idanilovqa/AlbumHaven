import React, {useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore} from 'react';
import {Button, NativeHtml, Status, Tabs} from './components.jsx';
import {profilePerson, safeAvatarUrl, validMemberQuery} from './model.mjs';

function artwork(runtime, person) {
  const url = safeAvatarUrl(person.avatar_url);
  return runtime.artboxHtml({state: url ? 'ready' : 'empty', label: `${person.display_name} profile image`,
    coverHtml: url ? `<img src="${runtime.escapeHtml(url)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''});
}

const relationshipLabels = {none: 'Not connected', incoming_pending: 'Incoming request',
  outgoing_pending: 'Request pending', accepted: 'Friend', blocked: 'Blocked', self: 'You'};

export function PersonNavigation({runtime, person, rowKey, subtitle, selected, disabled, onSelect, onActivate}) {
  const host = useRef(null), frames = useRef([]), latest = useRef(onActivate); latest.current = onActivate;
  const html = runtime.navigationItemHtml({key: rowKey, label: person.display_name || 'Member',
    subtitle: [person.handle ? `@${person.handle}` : '', subtitle].filter(Boolean).join(' · '),
    variant: 'wide', action: true, selected, disabled, className: 'home-friends__person',
    attributes: {'data-home-person-ref': person.account_ref || '', 'data-home-person-row': rowKey}, artworkHtml: artwork(runtime, person)});
  const initial = useRef(html);
  useLayoutEffect(() => {
    const root = host.current, holder = root.ownerDocument.createElement('div'); holder.innerHTML = html;
    const button = root.firstElementChild, next = holder.firstElementChild;
    if (!button) {root.replaceChildren(next); return;}
    // Retain the actual focused native row when current grants or selection
    // change; replacing the wrapper's HTML would strand keyboard focus.
    for (const attribute of [...button.attributes]) if (!next.hasAttribute(attribute.name)) button.removeAttribute(attribute.name);
    for (const attribute of [...next.attributes]) if (button.getAttribute(attribute.name) !== attribute.value) button.setAttribute(attribute.name, attribute.value);
    if (button.innerHTML !== next.innerHTML) button.innerHTML = next.innerHTML;
  }, [html]);
  useEffect(() => {
    const view = host.current?.ownerDocument.defaultView;
    return () => {for (const id of frames.current) view?.cancelAnimationFrame(id); frames.current = [];};
  }, []);
  return <div ref={host} className="home-friends__person-navigation" dangerouslySetInnerHTML={{__html: initial.current}} onClick={event => {
    const button = event.target.closest('[data-navigation-tree-item]');
    if (disabled || !button || button.disabled) return;
    onSelect?.();
    const view = button.ownerDocument.defaultView;
    for (const id of frames.current) view?.cancelAnimationFrame(id);
    const activate = () => {frames.current = []; if (button.isConnected && !button.disabled && !button.closest('[hidden], [inert]')) latest.current?.(button);};
    // Keep the native filled selection visible for a paint before navigating.
    if (view?.requestAnimationFrame) frames.current = [view.requestAnimationFrame(() => {
      frames.current = [view.requestAnimationFrame(activate)];
    })];
    else activate();
  }}/>;
}

export function MemberResults({runtime, value, busy, controller, onProfile}) {
  const [selected, setSelected] = useState(null);
  const selection = useRef(null);
  return <div className="home-friends__people" aria-label="People search results">
    {value.data?.members.map(person => <div className="home-friends__person-row" key={person.account_ref}>
      <PersonNavigation runtime={runtime} person={person} rowKey={`member:${person.account_ref}`} subtitle={relationshipLabels[person.relationship]}
        selected={selected === person.account_ref} disabled={!onProfile || person.allowed_actions.can_view_profile !== true}
        onSelect={() => {selection.current = person.account_ref; setSelected(person.account_ref);}} onActivate={trigger => {
          if (selection.current === person.account_ref && profilePerson(controller.getSnapshot(), person.account_ref)) onProfile?.(person.account_ref, trigger);
        }}/>
      {person.relationship === 'none' && person.allowed_actions.can_request === true
        && <Button runtime={runtime} disabled={busy} onClick={() => controller.mutate('requestMember', person.account_ref)}>Send request</Button>}
    </div>)}
  </div>;
}

export function MemberSearch({runtime, controller, state, onProfile}) {
  const [query, setQuery] = useState(state.memberQuery || '');
  const inputId = useId(), helpId = useId();
  const canDiscover = state.friends.data?.allowed_actions.can_discover_members === true;
  const busy = state.mutation.status === 'loading', value = state.members;
  // Account/provider replacement and relationship refresh erase old queries and
  // rows. Merely editing a field never starts a read or changes its result label.
  useEffect(() => {if (!state.memberQuery) setQuery('');}, [state.scopeKey, state.memberQuery, state.friends.data]);
  const pendingSameQuery = value.status === 'loading' && query.trim() === state.memberQuery;
  const search = event => {
    event.preventDefault();
    if (canDiscover && !busy && !pendingSameQuery && validMemberQuery(query)) controller.loadMembers({query});
  };
  const visible = canDiscover ? value : {status: state.friends.data || state.friends.status === 'denied' ? 'denied'
    : ['loading', 'error'].includes(state.friends.status) ? state.friends.status : 'unavailable'};
  return <section aria-label="People">
    <form className="home-friends__request-form" onSubmit={search} aria-label="Search people">
      <label htmlFor={inputId}>Search by name or handle</label>
      <input id={inputId} type="search" value={query} onChange={event => setQuery(event.target.value)} maxLength={100}
        autoCapitalize="none" autoComplete="off" spellCheck={false} aria-describedby={helpId} disabled={!canDiscover || busy}/>
      <Button runtime={runtime} type="submit" disabled={!canDiscover || busy || pendingSameQuery || !validMemberQuery(query)}>Search</Button>
    </form>
    <p id={helpId} className="home-friends__muted">Enter a name or handle, then choose Search. Up to 100 characters.</p>
    {canDiscover && state.memberQuery && <p className="home-friends__muted">Results for “{state.memberQuery}”</p>}
    {(!canDiscover || state.memberQuery) && (visible.status === 'empty'
      ? <NativeHtml html={runtime.alertHtml({severity: 'info', role: 'status', message: 'No people match this search.'})}/>
      : <Status runtime={runtime} value={visible} label="People" retry={state.memberQuery ? () => controller.loadMembers({query: state.memberQuery}) : undefined}/>)}
    {canDiscover && <MemberResults runtime={runtime} value={value} busy={busy} controller={controller} onProfile={onProfile}/>}
    {canDiscover && value.data?.next_cursor && <Button runtime={runtime} disabled={busy}
      onClick={() => controller.loadMembers({query: state.memberQuery, cursor: value.data.next_cursor})}>Next page</Button>}
  </section>;
}

export function FriendsDirectory({runtime, selected, onSelect, controller, onProfile, onRequest}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [section, setSection] = useState('friends'), tabsId = useId();
  const [selectedRow, setSelectedRow] = useState(null), [confirming, setConfirming] = useState(false), [error, setError] = useState('');
  const root = useRef(null), confirmation = useRef(false), selection = useRef(null);
  const value = state.friends, refreshed = ['ready', 'empty'].includes(value.status), data = refreshed ? value.data : null;
  const busy = confirming || state.mutation.status === 'loading';
  const unresolved = state.mutation.status === 'ready' && (!refreshed
    || state.mutation.action === 'cancelRequest' && data?.requests.some(request => request.request_ref === state.mutation.target)
    || state.mutation.action === 'removeFriend' && data?.friends.some(person => person.account_ref === state.mutation.target));
  const acknowledged = state.mutation.status !== 'ready' || !refreshed ? '' : state.mutation.action === 'requestMember'
    ? 'Friend request sent. Search again to see updated relationships.'
    : state.mutation.action === 'cancelRequest' && !unresolved ? 'Friend request cancelled.' : '';
  useEffect(() => {setSection('friends'); selection.current = null; setSelectedRow(null); setError('');}, [state.scopeKey]);
  function selectRow(key) {selection.current = key; setSelectedRow(key);}
  async function unfriend(accountRef, trigger) {
    const before = controller.getSnapshot(), friend = before.friends.data?.friends.find(person => person.account_ref === accountRef);
    if (!root.current?.isConnected || root.current.closest('[hidden], [inert]') || confirmation.current || before.mutation.status === 'loading'
      || before.mutation.status === 'ready' && before.mutation.action === 'removeFriend' && before.mutation.target === accountRef
      || friend?.relationship !== 'accepted'
      || friend.allowed_actions.can_remove !== true || !['ready', 'empty'].includes(before.friends.status)) return;
    confirmation.current = true; setConfirming(true); setError('');
    try {
      const accepted = await runtime.confirm(`Unfriend ${friend.display_name || 'this person'}? Their shared listening activity will no longer be visible to you.`,
        {title: 'Unfriend', acceptLabel: 'Unfriend', danger: true});
      const latest = controller.getSnapshot(), current = latest.friends.data?.friends.find(person => person.account_ref === accountRef);
      if (!root.current?.isConnected || root.current.closest('[hidden], [inert]') || !Object.is(before.scopeKey, latest.scopeKey) || !accepted) return;
      if (current !== friend || current?.allowed_actions.can_remove !== true || latest.mutation.status === 'loading') {
        setError('This friendship has changed. Check its current status before trying again.'); return;
      }
      const result = await controller.mutate('removeFriend', accountRef);
      if (!root.current?.isConnected || !Object.is(before.scopeKey, controller.getSnapshot().scopeKey)) return;
      const refreshed = controller.getSnapshot();
      if (result.status === 'ready' && ['ready', 'empty'].includes(refreshed.friends.status)
        && !refreshed.friends.data?.friends.some(person => person.account_ref === accountRef)) {
        const restore = () => {
          const directory = root.current;
          if (!directory?.isConnected || !Object.is(before.scopeKey, controller.getSnapshot().scopeKey)) return;
          const row = [...directory.querySelectorAll('[data-home-person-ref]')].find(element => element.dataset.homePersonRef === accountRef && !element.disabled);
          const target = trigger?.isConnected && !trigger.disabled ? trigger : row || directory;
          if (!target.closest('[hidden], [inert]')) target.focus({preventScroll: true});
        };
        const view = root.current.ownerDocument.defaultView;
        if (view?.requestAnimationFrame) view.requestAnimationFrame(restore); else restore();
      }
    } catch (_error) {if (root.current?.isConnected) setError('This friendship could not be changed. Please try again.');}
    finally {confirmation.current = false; if (root.current?.isConnected) setConfirming(false);}
  }
  return <section ref={root} className="home-friends__directory" data-home-friends-directory tabIndex={-1} aria-label="Friends directory">
    <Tabs runtime={runtime} id={tabsId} label="Friends directory" items={[["friends", "Friends"], ["people", "People"]]}
      value={section} onChange={setSection}/>
    {section === 'people' ? <MemberSearch runtime={runtime} controller={controller} state={state} onProfile={onProfile}/> : <section aria-label="Friends">
      <Status runtime={runtime} value={value} label="Friends" retry={() => controller.loadFriends()}/>
      {data && <>
        <div className="home-friends__people" aria-label="Accepted friends">
          {data.friends.map(person => <div className="home-friends__person-row" key={person.account_ref}>
            <PersonNavigation runtime={runtime} person={person} rowKey={`friend:${person.account_ref}`} subtitle="Friend"
              selected={selectedRow === `friend:${person.account_ref}` || !selectedRow && selected === person.account_ref}
              disabled={!(onProfile && person.allowed_actions.can_view_profile === true) && !(onSelect && person.allowed_actions.can_view_activity === true)}
              onSelect={() => selectRow(`friend:${person.account_ref}`)} onActivate={trigger => {
                if (selection.current !== `friend:${person.account_ref}`) return;
                const latest = controller.getSnapshot();
                if (onProfile && profilePerson(latest, person.account_ref)) onProfile(person.account_ref, trigger);
                else if (latest.friends.data?.friends.some(row => row.account_ref === person.account_ref && row.relationship === 'accepted'
                  && row.allowed_actions.can_view_activity === true)) onSelect?.(person.account_ref);
              }}/>
            {person.allowed_actions.can_remove === true && <Button runtime={runtime}
              disabled={busy || state.mutation.status === 'ready' && state.mutation.action === 'removeFriend' && state.mutation.target === person.account_ref}
              onClick={event => unfriend(person.account_ref, event.target.closest('button'))}>Unfriend</Button>}
          </div>)}
        </div>
        {data.friends.length === 0 && value.status !== 'empty' && <p className="home-friends__muted">No friends yet.</p>}
        {data.requests.length > 0 && <section className="home-friends__requests" aria-label="Friend requests"><h3>Requests</h3>{data.requests.map(request => <div className="home-friends__person-row" key={request.request_ref}>
          <PersonNavigation runtime={runtime} person={request} rowKey={`request:${request.request_ref}`}
            subtitle={request.direction === 'incoming' ? 'Incoming request' : 'Pending'} selected={selectedRow === `request:${request.request_ref}`}
            disabled={!onRequest} onSelect={() => selectRow(`request:${request.request_ref}`)} onActivate={trigger => {
              if (selection.current !== `request:${request.request_ref}`) return;
              const latest = controller.getSnapshot();
              if (['ready', 'empty'].includes(latest.friends.status) && latest.friends.data?.requests.some(row => row.request_ref === request.request_ref)) onRequest?.(request.request_ref, trigger);
            }}/>
          {request.direction === 'outgoing' && request.allowed_actions.can_cancel === true && <Button runtime={runtime}
              disabled={busy || state.mutation.status === 'ready' && state.mutation.target === request.request_ref}
              onClick={() => controller.mutate('cancelRequest', request.request_ref)}>Cancel request</Button>}
        </div>)}</section>}
      </>}
    </section>}
    {['loading', 'error', 'denied', 'unavailable'].includes(state.mutation.status)
      && <Status runtime={runtime} value={state.mutation} label="Friend changes"/>}
    {acknowledged && <NativeHtml html={runtime.alertHtml({severity: 'info', role: 'status', message: acknowledged})}/>}
    {unresolved && <><NativeHtml html={runtime.alertHtml({severity: 'info', role: 'status',
      message: 'Your change was sent, but the updated relationship has not been confirmed. Refresh Friends to check its current status.'})}/>
      <Button runtime={runtime} disabled={busy || value.status === 'loading'} onClick={() => controller.loadFriends()}>Refresh Friends</Button></>}
    {error && <NativeHtml html={runtime.alertHtml({severity: 'error', role: 'alert', message: error})}/>}
  </section>;
}
