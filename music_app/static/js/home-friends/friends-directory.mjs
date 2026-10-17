import {mountButton, mountStatus, mountTabs} from './native-controls.mjs';
import {profilePerson, safeAvatarUrl, validMemberQuery} from './model.mjs';


// Teardown is best effort: one native cleanup must not strand later owners.
function releaseAll(releases) {for (const release of releases) {try {release();} catch (_error) {}}}

let nextDirectoryId = 0;
const readable = value => ['ready', 'empty'].includes(value?.status);
const relationshipLabels = {none: 'Not connected', incoming_pending: 'Incoming request', outgoing_pending: 'Request pending', accepted: 'Friend', blocked: 'Blocked', self: 'You'};
function node(host, tag, className, text) {const element = host.ownerDocument.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = text; host.append(element); return element;}
function alert(host, runtime, message, error = false) {host.hidden = !message; const html = message ? runtime.alertHtml({severity: error ? 'error' : 'info', role: error ? 'alert' : 'status', message}) : ''; if (host.innerHTML !== html) host.innerHTML = html;}
function artwork(runtime, person) {
  const url = safeAvatarUrl(person.avatar_url);
  return runtime.artboxHtml({state: url ? 'ready' : 'empty', label: `${person.display_name} profile image`, coverHtml: url ? `<img src="${runtime.escapeHtml(url)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''});
}

export function mountPersonNavigation(host, runtime, initial) {
  const root = node(host, 'div', 'home-friends__person-navigation'); let props = initial, disposed = false, frames = [];
  const view = root.ownerDocument.defaultView;
  function cancelFrames() {for (const id of frames) view?.cancelAnimationFrame(id); frames = [];}
  function click(event) {
    const button = event.target.closest?.('[data-navigation-tree-item]');
    if (disposed || props.disabled || !button || !root.contains(button) || button.disabled) return;
    props.onSelect?.(); cancelFrames();
    const activate = () => {frames = []; if (!disposed && !props.disabled && button.isConnected && !button.disabled && !button.closest('[hidden], [inert]')) props.onActivate?.(button);};
    if (view?.requestAnimationFrame) frames = [view.requestAnimationFrame(() => {if (!disposed) frames = [view.requestAnimationFrame(activate)];})]; else activate();
  }
  root.addEventListener('click', click);
  function update(next) {
    if (disposed) return; props = next;
    const {person, rowKey, subtitle, selected, disabled} = props;
    const holder = root.ownerDocument.createElement('div');
    holder.innerHTML = runtime.navigationItemHtml({key: rowKey, label: person.display_name || 'Member', subtitle: [person.handle ? `@${person.handle}` : '', subtitle].filter(Boolean).join(' · '),
      variant: 'wide', action: true, selected, disabled, className: 'home-friends__person', attributes: {'data-home-person-ref': person.account_ref || '', 'data-home-person-row': rowKey}, artworkHtml: artwork(runtime, person)});
    const button = root.firstElementChild, replacement = holder.firstElementChild;
    if (!replacement) {root.replaceChildren(); return;}
    if (!button || button.tagName !== replacement.tagName) {root.replaceChildren(replacement); return;}
    // Retain the actual focused native row when selection or grants change.
    for (const attribute of [...button.attributes]) if (!replacement.hasAttribute(attribute.name)) button.removeAttribute(attribute.name);
    for (const attribute of [...replacement.attributes]) if (button.getAttribute(attribute.name) !== attribute.value) button.setAttribute(attribute.name, attribute.value);
    if (button.innerHTML !== replacement.innerHTML) button.innerHTML = replacement.innerHTML;
  }
  function dispose() {if (!disposed) {disposed = true; releaseAll([cancelFrames, () => root.removeEventListener('click', click), () => root.remove()]);}}
  try {update(initial); return {element: host, update, dispose};}
  catch (error) {dispose(); throw error;}
}

export function mountMemberResults(host, runtime, initial) {
  const root = node(host, 'div', 'home-friends__people'); root.setAttribute('aria-label', 'People search results');
  let props = initial, disposed = false, selected = null, scope;
  const rows = new Map();
  function releaseRow(row) {releaseAll([() => row.navigation?.dispose(), () => row.button?.dispose(), () => row.element.remove()]);}
  function dispose() {if (!disposed) {disposed = true; const previous = [...rows.values()]; rows.clear(); releaseAll([...previous.map(row => () => releaseRow(row)), () => root.remove()]);}}
  function render(next) {
    if (disposed) return; props = next;
    const currentScope = props.controller.getSnapshot().scopeKey;
    if (!Object.is(scope, currentScope)) {scope = currentScope; selected = null;}
    const people = readable(props.value) ? props.value.data?.members || [] : [], keep = new Set(people.map(person => person.account_ref));
    for (const [key, row] of rows) if (!keep.has(key)) {rows.delete(key); releaseRow(row);}
    for (const person of people) {
      const key = person.account_ref; let row = rows.get(key);
      if (!row) {
        const element = node(root, 'div', 'home-friends__person-row'), navigationHost = node(element, 'div'), buttonHost = node(element, 'span');
        // Record the row before either factory: a later renderer can fail after
        // navigation has already acquired its listener and scheduled work.
        row = {element, buttonHost, navigation: null, button: null}; rows.set(key, row);
        row.navigation = mountPersonNavigation(navigationHost, runtime, {person, rowKey: `member:${key}`});
        row.button = mountButton(buttonHost, runtime, {label: 'Send request'});
      }
      row.navigation.update({person, rowKey: `member:${key}`, subtitle: relationshipLabels[person.relationship], selected: selected === key,
        disabled: !props.onProfile || person.allowed_actions.can_view_profile !== true,
        onSelect: () => {selected = key; update(props);}, onActivate: trigger => {
          const latest = props.controller.getSnapshot(); if (!disposed && selected === key && Object.is(scope, latest.scopeKey) && profilePerson(latest, key)) props.onProfile?.(key, trigger);
        }});
      row.buttonHost.hidden = !(person.relationship === 'none' && person.allowed_actions.can_request === true);
      row.button.update({label: 'Send request', disabled: props.busy, onClick: () => {
        const latest = props.controller.getSnapshot(), current = readable(latest.members) ? latest.members.data?.members.find(candidate => candidate.account_ref === key) : null;
        if (!disposed && Object.is(scope, latest.scopeKey) && latest.mutation.status !== 'loading' && readable(latest.friends) && latest.friends.data?.allowed_actions.can_discover_members === true
          && current?.relationship === 'none' && current.allowed_actions.can_request === true) props.controller.mutate('requestMember', key);
      }});
      // Insert only out-of-order rows, preserving focus on an unchanged row.
      const index = people.indexOf(person), at = root.children[index]; if (at !== row.element) root.insertBefore(row.element, at || null);
    }
  }
  function update(next) {try {render(next);} catch (error) {dispose(); throw error;}}
  try {scope = initial.controller.getSnapshot().scopeKey; update(initial); return {element: host, update, dispose};}
  catch (error) {dispose(); throw error;}
}

export function mountMemberSearch(host, runtime, initial) {
  const id = `home-member-search-${++nextDirectoryId}`, root = node(host, 'section'); root.setAttribute('aria-label', 'People');
  const form = node(root, 'form', 'home-friends__request-form'); form.setAttribute('aria-label', 'Search people');
  const label = node(form, 'label', '', 'Search by name or handle'); label.htmlFor = id;
  const input = node(form, 'input'); input.id = id; input.type = 'search'; input.maxLength = 100; input.setAttribute('autocapitalize', 'none'); input.autocomplete = 'off'; input.spellcheck = false; input.setAttribute('aria-describedby', `${id}-help`);
  const buttonHost = node(form, 'span'), help = node(root, 'p', 'home-friends__muted', 'Enter a name or handle, then choose Search. Up to 100 characters.'); help.id = `${id}-help`;
  const resultLabel = node(root, 'p', 'home-friends__muted'), emptyHost = node(root, 'div'), statusHost = node(root, 'div'), resultsHost = node(root, 'div'), nextHost = node(root, 'span');
  let props = initial, disposed = false, query = initial.state.memberQuery || '', previousScope, previousQuery, previousData;
  const owners = [], own = owner => {owners.push(owner); return owner;};
  function dispose() {if (!disposed) {disposed = true; releaseAll([() => form.removeEventListener('submit', search), () => input.removeEventListener('input', change), ...owners.splice(0).reverse().map(owner => () => owner.dispose()), () => root.remove()]);}}
  let searchButton, status, nextButton, results;
  function canDiscover(state) {return readable(state.friends) && state.friends.data?.allowed_actions.can_discover_members === true;}
  function search(event) {
    event.preventDefault(); if (disposed) return;
    const latest = props.controller.getSnapshot(), pendingSame = latest.members.status === 'loading' && query.trim() === latest.memberQuery;
    if (canDiscover(latest) && latest.mutation.status !== 'loading' && !pendingSame && validMemberQuery(query)) props.controller.loadMembers({query});
  }
  function change(event) {if (!disposed) {query = event.target.value; render();}}
  function renderCurrent() {
    if (disposed) return;
    const state = props.state, discover = canDiscover(state), busy = state.mutation.status === 'loading', value = state.members;
    if ((!Object.is(previousScope, state.scopeKey) || previousQuery !== state.memberQuery || previousData !== state.friends.data) && !state.memberQuery) query = '';
    previousScope = state.scopeKey; previousQuery = state.memberQuery; previousData = state.friends.data;
    const pendingSame = value.status === 'loading' && query.trim() === state.memberQuery;
    const visible = discover ? value : {status: state.friends.data || state.friends.status === 'denied' ? 'denied' : ['loading', 'error'].includes(state.friends.status) ? state.friends.status : 'unavailable'};
    if (input.value !== query) input.value = query; input.disabled = !discover || busy;
    searchButton.update({label: 'Search', type: 'submit', disabled: !discover || busy || pendingSame || !validMemberQuery(query)});
    resultLabel.hidden = !(discover && state.memberQuery); resultLabel.textContent = state.memberQuery ? `Results for “${state.memberQuery}”` : '';
    const showStatus = !discover || state.memberQuery;
    alert(emptyHost, runtime, showStatus && visible.status === 'empty' ? 'No people match this search.' : '');
    status.update({value: visible, label: 'People', retry: state.memberQuery ? () => {
      const latest = props.controller.getSnapshot(); if (!disposed && canDiscover(latest) && latest.memberQuery) props.controller.loadMembers({query: latest.memberQuery});
    } : undefined});
    statusHost.hidden = !showStatus || readable(visible);
    resultsHost.hidden = !discover; results.update({value: discover ? value : {status: 'denied'}, busy, controller: props.controller, onProfile: props.onProfile});
    nextHost.hidden = !(discover && value.data?.next_cursor);
    nextButton.update({label: 'Next page', disabled: busy, onClick: () => {
      const latest = props.controller.getSnapshot(); if (!disposed && canDiscover(latest) && readable(latest.members) && latest.mutation.status !== 'loading' && latest.members.data?.next_cursor)
        props.controller.loadMembers({query: latest.memberQuery, cursor: latest.members.data.next_cursor});
    }});
  }
  function render() {try {renderCurrent();} catch (error) {dispose(); throw error;}}
  function update(next) {if (!disposed) {props = next; render();}}
  try {
    searchButton = own(mountButton(buttonHost, runtime, {label: 'Search'}));
    status = own(mountStatus(statusHost, runtime, {label: 'People'}));
    nextButton = own(mountButton(nextHost, runtime, {label: 'Next page'}));
    results = own(mountMemberResults(resultsHost, runtime, {value: initial.state.members, busy: initial.state.mutation.status === 'loading', controller: props.controller, onProfile: props.onProfile}));
    form.addEventListener('submit', search); input.addEventListener('input', change);
    render(); return {element: host, update, dispose};
  } catch (error) {dispose(); throw error;}
}

function mountFriendsPanel(host, runtime, initial) {
  let props = initial, disposed = false;
  const root = node(host, 'section'); root.setAttribute('aria-label', 'Friends');
  let status; const friendsRows = new Map(), requestRows = new Map();
  function dispose() {if (!disposed) {disposed = true; const rows = [...friendsRows.values(), ...requestRows.values()]; friendsRows.clear(); requestRows.clear(); releaseAll([() => status?.dispose(), ...rows.flatMap(row => [() => row.navigation?.dispose(), () => row.button?.dispose()]), () => root.remove()]);}}
  try {
  const statusHost = node(root, 'div'), accepted = node(root, 'div', 'home-friends__people'); accepted.setAttribute('aria-label', 'Accepted friends');
  const none = node(root, 'p', 'home-friends__muted', 'No friends yet.'), requests = node(root, 'section', 'home-friends__requests'); requests.setAttribute('aria-label', 'Friend requests'); node(requests, 'h3', '', 'Requests');
  status = mountStatus(statusHost, runtime, {label: 'Friends'});
  function update(next) {
    if (disposed) return; props = next; const {state, controller, selected, selectedRow, busy} = props, value = state.friends, data = readable(value) ? value.data : null;
    status.update({value, label: 'Friends', retry: () => {if (!disposed) props.controller.loadFriends();}});
    accepted.hidden = !data; none.hidden = !data || data.friends.length !== 0 || value.status === 'empty'; requests.hidden = !data?.requests.length;
    const friends = data?.friends || [], pending = data?.requests || [];
    const friendKeys = new Set(friends.map(person => person.account_ref)), requestKeys = new Set(pending.map(request => request.request_ref));
    for (const [key, row] of friendsRows) if (!friendKeys.has(key)) {row.navigation.dispose(); row.button.dispose(); row.element.remove(); friendsRows.delete(key);}
    for (const [key, row] of requestRows) if (!requestKeys.has(key)) {row.navigation.dispose(); row.button.dispose(); row.element.remove(); requestRows.delete(key);}
    for (const [index, person] of friends.entries()) {
      const key = person.account_ref, rowKey = `friend:${key}`; let row = friendsRows.get(key);
      if (!row) {
        const element = node(accepted, 'div', 'home-friends__person-row'), navHost = node(element, 'div'), buttonHost = node(element, 'span');
        row = {element, buttonHost, navigation: null, button: null}; friendsRows.set(key, row);
        row.navigation = mountPersonNavigation(navHost, runtime, {person, rowKey}); row.button = mountButton(buttonHost, runtime, {label: 'Unfriend'});
      }
      row.navigation.update({person, rowKey, subtitle: 'Friend', selected: selectedRow === rowKey || !selectedRow && selected === key,
        disabled: !(props.onProfile && person.allowed_actions.can_view_profile === true) && !(props.onSelect && person.allowed_actions.can_view_activity === true),
        onSelect: () => props.selectRow(rowKey), onActivate: trigger => {
          if (disposed || !props.isSelected(rowKey)) return;
          const latest = props.controller.getSnapshot();
          if (props.onProfile && profilePerson(latest, key)) props.onProfile(key, trigger);
          else if (readable(latest.friends) && latest.friends.data?.friends.some(friend => friend.account_ref === key && friend.relationship === 'accepted' && friend.allowed_actions.can_view_activity === true)) props.onSelect?.(key);
        }});
      row.buttonHost.hidden = person.allowed_actions.can_remove !== true;
      row.button.update({label: 'Unfriend', disabled: busy || state.mutation.status === 'ready' && state.mutation.action === 'removeFriend' && state.mutation.target === key, onClick: event => props.unfriend(key, event.target.closest('button'))});
      const at = accepted.children[index]; if (at !== row.element) accepted.insertBefore(row.element, at || null);
    }
    for (const [index, request] of pending.entries()) {
      const key = request.request_ref, rowKey = `request:${key}`; let row = requestRows.get(key);
      if (!row) {
        const element = node(requests, 'div', 'home-friends__person-row'), navHost = node(element, 'div'), buttonHost = node(element, 'span');
        row = {element, buttonHost, navigation: null, button: null}; requestRows.set(key, row);
        row.navigation = mountPersonNavigation(navHost, runtime, {person: request, rowKey}); row.button = mountButton(buttonHost, runtime, {label: 'Cancel request'});
      }
      row.navigation.update({person: request, rowKey, subtitle: request.direction === 'incoming' ? 'Incoming request' : 'Pending', selected: selectedRow === rowKey, disabled: !props.onRequest,
        onSelect: () => props.selectRow(rowKey), onActivate: trigger => {
          if (disposed || !props.isSelected(rowKey)) return;
          const latest = props.controller.getSnapshot(); if (readable(latest.friends) && latest.friends.data?.requests.some(candidate => candidate.request_ref === key)) props.onRequest?.(key, trigger);
        }});
      row.buttonHost.hidden = !(request.direction === 'outgoing' && request.allowed_actions.can_cancel === true);
      row.button.update({label: 'Cancel request', disabled: busy || state.mutation.status === 'ready' && state.mutation.target === key, onClick: () => {
        const latest = props.controller.getSnapshot(), current = readable(latest.friends) ? latest.friends.data?.requests.find(candidate => candidate.request_ref === key) : null;
        if (!disposed && !props.busy && latest.mutation.status !== 'loading' && !(latest.mutation.status === 'ready' && latest.mutation.target === key)
          && current?.direction === 'outgoing' && current.allowed_actions.can_cancel === true) props.controller.mutate('cancelRequest', key);
      }});
      const at = requests.children[index + 1]; if (at !== row.element) requests.insertBefore(row.element, at || null);
    }
  }
  update(initial); return {element: host, update, dispose};
  } catch (error) {dispose(); throw error;}
}

export function mountFriendsDirectory(host, runtime, initial) {
  let props = initial, disposed = false, section = 'friends', selectedRow = null, confirming = false, error = '', unsubscribe;
  let scope = initial.controller.getSnapshot().scopeKey, panel = null, panelKind = null, confirmation = false, pendingFrame = null, generation = 0, renderRevision = 0;
  const root = node(host, 'section', 'home-friends__directory'); root.setAttribute('data-home-friends-directory', ''); root.tabIndex = -1; root.setAttribute('aria-label', 'Friends directory');
  const owners = [], own = owner => {owners.push(owner); return owner;};
  function dispose() {if (!disposed) {disposed = true; generation++; const release = unsubscribe, previousPanel = panel, frame = pendingFrame; unsubscribe = panel = pendingFrame = null; releaseAll([() => release?.(), () => {if (frame !== null) root.ownerDocument.defaultView?.cancelAnimationFrame(frame);}, () => previousPanel?.dispose(), ...owners.splice(0).reverse().map(owner => () => owner.dispose()), () => root.remove()]);}}
  try {
  const tabsHost = node(root, 'div'), panelHost = node(root, 'div'), mutationHost = node(root, 'div'), acknowledgedHost = node(root, 'div'), unresolvedHost = node(root, 'div'), refreshHost = node(root, 'span'), errorHost = node(root, 'div');
  const id = `home-friends-directory-${++nextDirectoryId}`, tabs = own(mountTabs(tabsHost, runtime, {id, label: 'Friends directory', items: [['friends', 'Friends'], ['people', 'People']], value: section}));
  const mutationStatus = own(mountStatus(mutationHost, runtime, {label: 'Friend changes'})), refreshButton = own(mountButton(refreshHost, runtime, {label: 'Refresh Friends'}));
  const connected = () => !disposed && root.isConnected && !root.closest('[hidden], [inert]');
  function selectRow(key) {if (!disposed) {selectedRow = key; render();}}
  async function unfriend(accountRef, trigger) {
    const controller = props.controller, before = controller.getSnapshot(), friend = before.friends.data?.friends.find(person => person.account_ref === accountRef);
    if (!connected() || confirmation || before.mutation.status === 'loading' || before.mutation.status === 'ready' && before.mutation.action === 'removeFriend' && before.mutation.target === accountRef
      || friend?.relationship !== 'accepted' || friend.allowed_actions.can_remove !== true || !readable(before.friends)) return;
    const token = generation; confirmation = true; confirming = true; error = ''; render();
    try {
      const accepted = await runtime.confirm(`Unfriend ${friend.display_name || 'this person'}? Their shared listening activity will no longer be visible to you.`, {title: 'Unfriend', acceptLabel: 'Unfriend', danger: true});
      const latest = controller.getSnapshot(), current = latest.friends.data?.friends.find(person => person.account_ref === accountRef);
      if (!connected() || token !== generation || controller !== props.controller || !Object.is(before.scopeKey, latest.scopeKey) || !accepted) return;
      if (!readable(latest.friends) || current !== friend || current?.allowed_actions.can_remove !== true || latest.mutation.status === 'loading') {error = 'This friendship has changed. Check its current status before trying again.'; render(); return;}
      const result = await controller.mutate('removeFriend', accountRef);
      if (!connected() || token !== generation || !Object.is(before.scopeKey, controller.getSnapshot().scopeKey)) return;
      const refreshed = controller.getSnapshot();
      if (result.status === 'ready' && readable(refreshed.friends) && !refreshed.friends.data?.friends.some(person => person.account_ref === accountRef)) {
        const restore = () => {pendingFrame = null; if (!connected() || token !== generation || !Object.is(before.scopeKey, controller.getSnapshot().scopeKey)) return;
          const row = [...root.querySelectorAll('[data-home-person-ref]')].find(element => element.dataset.homePersonRef === accountRef && !element.disabled);
          const target = trigger?.isConnected && !trigger.disabled ? trigger : row || root; if (!target.closest('[hidden], [inert]')) target.focus({preventScroll: true});};
        const view = root.ownerDocument.defaultView; if (view?.requestAnimationFrame) pendingFrame = view.requestAnimationFrame(restore); else restore();
      }
    } catch (_error) {if (connected() && token === generation && Object.is(before.scopeKey, controller.getSnapshot().scopeKey)) {error = 'This friendship could not be changed. Please try again.'; render();}}
    finally {if (!disposed && token === generation) {confirmation = false; confirming = false; render();}}
  }
  function renderCurrent() {
    if (disposed) return;
    const revision = ++renderRevision, current = () => !disposed && renderRevision === revision;
    const state = props.controller.getSnapshot();
    if (!current()) return;
    if (!Object.is(scope, state.scopeKey)) {scope = state.scopeKey; generation++; section = 'friends'; selectedRow = null; error = ''; confirming = confirmation = false; const previous = panel; panel = null; panelKind = null; previous?.dispose();
      if (!current()) return;
      if (pendingFrame !== null) {root.ownerDocument.defaultView?.cancelAnimationFrame(pendingFrame); pendingFrame = null;}}
    const value = state.friends, refreshed = readable(value), data = refreshed ? value.data : null, busy = confirming || state.mutation.status === 'loading';
    const unresolved = state.mutation.status === 'ready' && (!refreshed || state.mutation.action === 'cancelRequest' && data?.requests.some(request => request.request_ref === state.mutation.target) || state.mutation.action === 'removeFriend' && data?.friends.some(person => person.account_ref === state.mutation.target));
    const acknowledged = state.mutation.status !== 'ready' || !refreshed ? '' : state.mutation.action === 'requestMember' ? 'Friend request sent. Search again to see updated relationships.' : state.mutation.action === 'cancelRequest' && !unresolved ? 'Friend request cancelled.' : '';
    tabs.update({id, label: 'Friends directory', items: [['friends', 'Friends'], ['people', 'People']], value: section, onChange: value => {if (!disposed && ['friends', 'people'].includes(value)) {section = value; render();}}});
    if (!current()) return;
    const panelProps = section === 'people' ? {controller: props.controller, state, onProfile: props.onProfile} : {...props, state, busy, selectedRow, selectRow, isSelected: key => selectedRow === key, unfriend};
    if (!panel || panelKind !== section) {
      const previous = panel; panel = null; panelKind = null; previous?.dispose();
      if (!current()) return;
      const kind = section, acquired = kind === 'people' ? mountMemberSearch(panelHost, runtime, panelProps) : mountFriendsPanel(panelHost, runtime, panelProps);
      if (!current()) {acquired.dispose(); return;}
      panel = acquired; panelKind = kind;
    } else panel.update(panelProps);
    if (!current()) return;
    mutationStatus.update({value: state.mutation, label: 'Friend changes'}); if (!current()) return;
    mutationHost.hidden = !['loading', 'error', 'denied', 'unavailable'].includes(state.mutation.status);
    alert(acknowledgedHost, runtime, acknowledged); if (!current()) return;
    alert(unresolvedHost, runtime, unresolved ? 'Your change was sent, but the updated relationship has not been confirmed. Refresh Friends to check its current status.' : ''); if (!current()) return;
    refreshHost.hidden = !unresolved; refreshButton.update({label: 'Refresh Friends', disabled: busy || value.status === 'loading', onClick: () => {if (!disposed && !confirming && props.controller.getSnapshot().mutation.status !== 'loading') props.controller.loadFriends();}});
    if (!current()) return;
    alert(errorHost, runtime, error, true);
  }
  // This catch also owns the first People-tab render, which happens after the
  // directory constructor has returned and cannot use its constructor catch.
  function render() {try {renderCurrent();} catch (error) {dispose(); throw error;}}
  function subscribe() {unsubscribe = props.controller.subscribe(render);}
  function update(next) {
    if (disposed) return; const replaced = next.controller !== props.controller;
    if (replaced) {unsubscribe?.(); generation++; confirmation = confirming = false; section = 'friends'; selectedRow = null; error = ''; panel?.dispose(); panel = null; panelKind = null;}
    props = next; if (replaced) {scope = props.controller.getSnapshot().scopeKey; subscribe();} render();
  }
  subscribe(); render(); return {element: host, update, dispose};
  } catch (error) {dispose(); throw error;}
}
