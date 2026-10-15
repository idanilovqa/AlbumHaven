// Explicit native owners. Callers retain domain state and update their own hosts.
// HTML accepted here is produced only by the canonical native UI renderers.
function syncButton(host, html) {
  const holder = host.ownerDocument.createElement('span');
  holder.innerHTML = html;
  const next = holder.firstElementChild;
  if (!next || next.tagName !== 'BUTTON') throw new TypeError('Native button renderer must return a button.');
  const current = host.firstElementChild;
  if (!current || current.tagName !== next.tagName) {host.replaceChildren(next); return next;}
  for (const attr of [...current.attributes]) if (!next.hasAttribute(attr.name)) current.removeAttribute(attr.name);
  for (const attr of [...next.attributes]) if (current.getAttribute(attr.name) !== attr.value) current.setAttribute(attr.name, attr.value);
  if (current.innerHTML !== next.innerHTML) current.innerHTML = next.innerHTML;
  return current;
}

export function mountButton(host, runtime, initial) {
  host.classList.add('home-friends__button');
  let props, disposed = false;
  const click = event => {
    const button = event.target.closest?.('button');
    if (!disposed && button === host.firstElementChild && !button.disabled && button.getAttribute('aria-disabled') !== 'true') props.onClick?.(event);
  };
  const update = next => {
    if (disposed) return;
    const {label = '', onClick, icon, selected, ...options} = next;
    if (typeof label !== 'string' && typeof label !== 'number') throw new TypeError('Native Button expects text labels.');
    props = next;
    const config = {...options, label: String(label), disabled: options.disabled === true,
      attributes: {...options.attributes, ...(selected === undefined ? {} : {'aria-pressed': String(selected)})}};
    syncButton(host, icon ? runtime.actionHtml({...config, icon, pressed: selected,
      ariaLabel: options.ariaLabel || String(label), title: options.title || String(label), presentation: 'bare'}) : runtime.buttonHtml(config));
  };
  update(initial); host.addEventListener('click', click);
  return {element: host, update, dispose() {if (disposed) return; disposed = true; host.removeEventListener('click', click); host.replaceChildren(); props = null;}};
}

export function mountTabs(host, runtime, initial) {
  host.classList.add('home-friends__tabs');
  let props, previousHtml, disposed = false, tabsOwner = null, revision = 0, rendering = false, pending = null;
  const sync = () => {
    if (disposed) return;
    const next = host.querySelector('[aria-selected="true"]')?.dataset.inPageTab;
    if (next && next !== props.value) props.onChange?.(next);
  };
  const render = next => {
    if (disposed) return;
    const operation = ++revision;
    const current = () => !disposed && revision === operation;
    props = next;
    const html = runtime.tabsHtml({id: next.id, label: next.label, selectedKey: next.value,
      tabs: next.items.map(([key, label, options]) => ({key, label, disabled: options?.disabled === true, panelId: options?.panelId}))});
    if (!current() || html === previousHtml) return;
    const active = host.contains(host.ownerDocument.activeElement) ? host.ownerDocument.activeElement.dataset.inPageTab : null;
    const previousOwner = tabsOwner; tabsOwner = null;
    previousOwner?.dispose?.();
    if (!current()) return;
    host.innerHTML = html; previousHtml = html;
    const mounted = runtime.mountTabs(host.firstElementChild);
    if (!current()) {mounted?.dispose?.(); return;}
    tabsOwner = mounted;
    if (active) {
      const buttons = [...host.querySelectorAll('[data-in-page-tab]')];
      (buttons.find(node => node.dataset.inPageTab === active && !node.disabled)
        || buttons.find(node => node.getAttribute('aria-selected') === 'true'))?.focus({preventScroll: true});
    }
  };
  const update = next => {
    if (disposed) return;
    if (rendering) {pending = next; return;}
    rendering = true;
    try {
      let value = next;
      do {pending = null; render(value); value = pending;} while (value && !disposed);
    } finally {rendering = false;}
  };
  update(initial); host.addEventListener('click', sync); host.addEventListener('keydown', sync);
  return {element: host, update, dispose() {if (disposed) return; disposed = true; revision++; pending = null; host.removeEventListener('click', sync); host.removeEventListener('keydown', sync); const previousOwner = tabsOwner; tabsOwner = null; try {previousOwner?.dispose?.();} finally {host.replaceChildren(); props = null;}}};
}

const chevron = '<svg class="ui-choice__chevron" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m6 9 6 6 6-6"/></svg>';
export function mountChoice(host, runtime, initial) {
  const doc = host.ownerDocument, labelNode = doc.createElement('span'), control = doc.createElement('span');
  labelNode.className = 'ui-choice__label'; control.className = 'ui-choice__control';
  host.replaceChildren(labelNode, control);
  let props, choices, selected, unavailable, owner, previousKey, disposed = false, menuEpoch = 0, revision = 0;
  const open = initialFocus => {
    if (disposed || unavailable || control.firstElementChild?.disabled) return;
    const epoch = ++menuEpoch, operation = revision;
    const nextOwner = runtime.openChoice(control.firstElementChild, {formats: choices, selected, label: props.label,
      matchTriggerWidth: props.matchTriggerWidth !== false, menuWidth: props.menuWidth, density: 'compact', initialFocus, updateTriggerLabel: false,
      onSelect: next => {if (!disposed && epoch === menuEpoch && !unavailable && choices.some(option => option.value === next && !option.disabled)) props.onChange?.(next);}});
    if (disposed || operation !== revision || epoch !== menuEpoch) {
      nextOwner?.close({restoreFocus: false});
      return;
    }
    owner = nextOwner;
  };
  const click = event => {if (event.target.closest?.('button') === control.firstElementChild) {event.preventDefault(); open('selected');}};
  const keydown = event => {
    if (unavailable || !['ArrowDown', 'ArrowUp'].includes(event.key) || event.target.closest?.('button') !== control.firstElementChild) return;
    event.preventDefault(); event.stopPropagation();
    if (!owner?.isOpen) open(event.key === 'ArrowUp' ? 'last' : 'selected');
  };
  const update = next => {
    if (disposed) return;
    const operation = ++revision;
    props = next;
    choices = (next.options || []).map(option => Array.isArray(option)
      ? {value: String(option[0]), label: String(option[1]), disabled: option[2] === true}
      : {value: String(option.value), label: String(option.label), disabled: option.disabled === true});
    selected = String(next.value ?? '');
    unavailable = next.disabled === true || typeof runtime.openChoice !== 'function' || !choices.some(option => !option.disabled);
    const selectedLabel = choices.find(option => option.value === selected)?.label || '';
    const config = {label: next.controlLabelPrefix && selectedLabel ? `${next.controlLabelPrefix}: ${selectedLabel}` : selectedLabel,
      size: 'small', disabled: unavailable, className: ['ui-choice__trigger', next.buttonClassName].filter(Boolean).join(' '),
      ariaLabel: selectedLabel ? `${next.label}: ${selectedLabel}` : next.label,
      title: next.title || (selectedLabel ? `${next.label}: ${selectedLabel}` : next.label),
      attributes: {'aria-haspopup': 'menu', 'aria-expanded': 'false'}};
    const html = next.icon ? runtime.actionHtml({...config, icon: next.icon, presentation: 'bare'})
      : runtime.buttonHtml(config).replace('</button>', `${chevron}</button>`);
    const key = JSON.stringify([html, choices, selected, next.matchTriggerWidth, next.menuWidth]);
    host.className = ['ui-choice', next.className].filter(Boolean).join(' ');
    labelNode.hidden = next.showLabel === false; labelNode.textContent = next.label;
    if (key !== previousKey) {
      menuEpoch++;
      const previousOwner = owner; owner = null;
      previousOwner?.close({restoreFocus: !unavailable});
      if (disposed || operation !== revision) return;
      syncButton(control, html); previousKey = key;
    }
  };
  update(initial); control.addEventListener('click', click); control.addEventListener('keydown', keydown);
  return {element: host, update, dispose() {if (disposed) return; disposed = true; revision++; menuEpoch++; control.removeEventListener('click', click); control.removeEventListener('keydown', keydown); const previousOwner = owner; owner = null; previousOwner?.close({restoreFocus: false}); host.replaceChildren(); props = null;}};
}

export function mountStatus(host, runtime, initial) {
  const messageHost = host.ownerDocument.createElement('div'), retryHost = host.ownerDocument.createElement('span');
  host.classList.add('home-friends__status'); host.replaceChildren(messageHost, retryHost);
  let retryOwner, disposed = false;
  const update = props => {
    if (disposed) return;
    const status = props.value?.status || 'unavailable', label = props.label;
    host.hidden = status === 'ready'; host.setAttribute('aria-busy', String(status === 'loading'));
    const message = {loading: `Loading ${label}…`, empty: `No ${label} yet.`, denied: `You don't have access to ${label}.`,
      error: `${label} could not be loaded.`, unavailable: `${label} are not available on this server yet.`}[status] || `${label} are unavailable.`;
    messageHost.innerHTML = status === 'ready' ? '' : runtime.alertHtml({severity: status === 'error' ? 'error' : 'info', role: status === 'error' ? 'alert' : 'status', message});
    if (status === 'error' && props.retry) {
      const button = {label: 'Retry', onClick: props.retry};
      if (retryOwner) retryOwner.update(button); else retryOwner = mountButton(retryHost, runtime, button);
    } else {retryOwner?.dispose(); retryOwner = null;}
  };
  update(initial);
  return {element: host, update, dispose() {if (disposed) return; disposed = true; retryOwner?.dispose(); retryOwner = null; host.replaceChildren();}};
}

export function mountRecentAlbums(host, runtime, initial) {
  host.classList.add('home-friends__native-recent');
  host.setAttribute('aria-label', 'Recent albums');
  if (host.tagName !== 'SECTION') host.setAttribute('role', 'region');
  let props = initial, disposed = false;
  const intent = async (kind, ref) => {
    if (disposed) return;
    try {await runtime.albumIntent(kind, ref);} catch (error) {
      if (!disposed && error?.name !== 'AbortError') props.onError?.(kind === 'play'
        ? 'This album could not be played. Please try again.' : 'This album could not be opened. Please try again.');
    }
  };
  const owner = runtime.mountRecent(host, {onSelectAlbum: ref => {if (!disposed) props.onSelect?.(ref);},
    onOpenAlbum: ref => intent('open', ref), onPlayAlbum: ref => intent('play', ref), onRetry: () => {if (!disposed) props.retry?.();}});
  const update = next => {
    if (disposed) return; props = next;
    owner.update({status: next.value.status === 'empty' ? 'ready' : next.value.status,
      payload: next.value.data || {recent_local_albums: [], recent_not_local_albums: []}, selectedAlbumRef: next.selected,
      displayMode: 'cards', selectionMode: next.selectionMode || 'native'});
  };
  update(initial);
  return {element: host, update, dispose() {if (disposed) return; disposed = true; owner.dispose(); host.replaceChildren(); props = null;}};
}

// Stable disclosure slots keep focused consumer descendants in place. Visibility
// and focus-before-collapse remain owned by the existing intrinsic controller.
export function mountIntrinsicDisclosure(host, runtime, initial) {
  const doc = host.ownerDocument, header = doc.createElement('header'), toggleHost = doc.createElement('span'),
    label = doc.createElement('h2'), count = doc.createElement('span'), actions = doc.createElement('div'), panel = doc.createElement('div');
  host.classList.add('intrinsic-disclosure'); header.className = 'intrinsic-disclosure__header';
  toggleHost.className = 'intrinsic-disclosure__toggle'; label.className = 'intrinsic-disclosure__label';
  count.className = 'intrinsic-disclosure__count'; actions.className = 'intrinsic-disclosure__actions';
  panel.className = 'intrinsic-disclosure__panel'; panel.setAttribute('data-disclosure-panel', '');
  if (!initial.id) throw new TypeError('Native disclosure requires a stable unique id.');
  panel.id = `${initial.id}-panel`; header.append(toggleHost, label, count, actions); host.replaceChildren(header, panel);
  let props = initial, disposed = false;
  const button = mountButton(toggleHost, runtime, {icon: 'next', label: initial.label, disabled: initial.enabled === false});
  const owner = runtime.createIntrinsicDisclosure({members: [], enabled: false,
    onToggle: (key, value) => {if (!disposed) props.onToggle?.(key, value);}});
  const update = next => {
    if (disposed) return; props = next;
    host.setAttribute('data-disclosure-key', next.memberKey); label.textContent = next.label;
    count.hidden = next.count === undefined || next.count === null; count.textContent = next.count ?? '';
    // Preserve attributes owned by the native disclosure while refreshing the button.
    const toggle = toggleHost.firstElementChild;
    const attributes = {};
    for (const name of ['aria-controls', 'aria-expanded']) if (toggle.hasAttribute(name)) attributes[name] = toggle.getAttribute(name);
    button.update({icon: 'next', label: next.label, disabled: next.enabled === false, attributes});
    owner.update({members: [{key: next.memberKey, panel, header, toggle}],
      collapsed: {[next.memberKey]: Boolean(next.collapsed)}, enabled: next.enabled !== false});
  };
  update(initial);
  return {element: host, slots: {actions, panel}, update,
    dispose() {if (disposed) return; disposed = true; owner.dispose(); button.dispose(); host.replaceChildren(); props = null;}};
}
