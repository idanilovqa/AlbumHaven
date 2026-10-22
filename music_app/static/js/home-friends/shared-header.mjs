import {mountButton} from './native-controls.mjs';
import {metric} from './model.mjs';
import {headerActionsFit} from './header-layout.mjs';

export function mountListensBadge(host, runtime, initial) {
  const icon = host.ownerDocument.createElement('span'), value = host.ownerDocument.createElement('span');
  icon.innerHTML = runtime.iconHtml('megaphone'); host.classList.add('home-header__listens'); host.replaceChildren(icon, value);
  let disposed = false;
  const update = props => {if (disposed) return; host.title = props.range || 'Listens'; host.setAttribute('aria-label', `Listens: ${metric(props.total)}`); value.textContent = metric(props.total);};
  update(initial);
  return {element: host, update, dispose() {if (disposed) return; disposed = true; host.replaceChildren();}};
}

const adoptedHeaderRoots = new WeakMap();

// Consumer-owned children stay in stable slots through compact/expanded layout.
// This is the native port of the shared header's placement/focus policy only.
export function mountSharedHeader(host, runtime, initial) {
  const adopted = initial.adoptRoot === true, lease = {};
  if (adopted && adoptedHeaderRoots.has(host)) throw new TypeError('The native header root already has an owner.');
  if (adopted) adoptedHeaderRoots.set(host, lease);
  let cleanup = () => {};
  try {
  const doc = host.ownerDocument, win = doc.defaultView;
  const make = (tag, name) => {const node = doc.createElement(tag); node.className = name; return node;};
  const root = adopted ? host : make('header', 'gallery-bar home-header'), leading = make('span', 'home-header__leading'),
    identity = make('div', 'home-header__identity'), content = make('div', 'home-header__content'),
    controls = make('div', 'home-header__controls'), triggerHost = make('span', 'home-header__tools'),
    capsule = make('div', 'home-header__capsule'), outsideActions = make('span', 'home-header__outside'),
    actions = make('span', 'home-header__actions'), primaryActions = make('span', 'home-header__primary-actions'), finalAction = make('span', 'home-header__final-action');
  // finalAction is a sibling inside the measured actions slot, always ordered last.
  primaryActions.style.display = 'contents'; finalAction.style.display = 'contents';
  actions.append(primaryActions, finalAction); capsule.append(outsideActions, actions); controls.append(triggerHost, capsule);
  // Install owned nodes only after the cleanup owner has been established.
  const resourceControls = make('div', 'home-header__resource-controls'),
    resourcePlayback = make('span', 'home-header__resource-playback'), resourceProgress = make('span', 'home-header__resource-progress');
  resourceControls.append(resourcePlayback, resourceProgress);
  const slots = {leading, identity, content, actions: primaryActions, outsideActions, finalAction, resourcePlayback, resourceProgress};
  let button = null, resize = null, mutation = null, activeRef = null;
  const attributes = new Map(), classes = new Map();
  const writeAttribute = (name, value) => {
    if (adopted && !attributes.has(name)) attributes.set(name, {before: root.getAttribute(name), last: null});
    if (value === null) root.removeAttribute(name); else root.setAttribute(name, String(value));
    if (adopted) attributes.get(name).last = root.getAttribute(name);
  };
  const writeClasses = value => {
    if (!adopted) {root.className = value; return;}
    const wanted = new Set(value.split(/\s+/).filter(Boolean));
    for (const [token, record] of classes) if (!wanted.has(token) && record.last && !record.before) {
      if (root.classList.contains(token)) root.classList.remove(token); record.last = false;
    }
    for (const token of wanted) {
      if (!classes.has(token)) classes.set(token, {before: root.classList.contains(token), last: true});
      root.classList.add(token); classes.get(token).last = true;
    }
  };
  let props = initial, compact = false, outside = false, open = false, disposed = false, frame = 0, lastFocus = null, refCleanup, revision = 0;
  const trigger = () => triggerHost.firstElementChild;
  const focusable = node => node?.isConnected && !node.disabled && node.getAttribute('aria-disabled') !== 'true'
    && !node.closest('[hidden],[inert],[aria-hidden="true"]') && node.getClientRects().length > 0;
  const collapsedFocusTarget = () => focusable(trigger()) ? trigger()
    : root.hasAttribute('tabindex') && focusable(root) ? root
      : [...leading.querySelectorAll('button')].find(focusable);
  const childMenu = target => Boolean(root.querySelector('[aria-expanded="true"]:not([data-header-tools])')
    && target?.closest?.('[role="menu"], [role="dialog"]'));
  const buttonProps = () => ({icon: 'tools', label: 'Tools', attributes: {'data-header-tools': 'true',
    'aria-expanded': String(open), 'aria-controls': `${props.id}-tools`}, onClick: () => {open = !open; apply(); if (!open && focusable(trigger())) trigger().focus({preventScroll: true}); schedule();}});
  const conceal = (node, value) => {
    if (value) {node.setAttribute('inert', ''); node.setAttribute('aria-hidden', 'true');}
    else {node.removeAttribute('inert'); node.removeAttribute('aria-hidden');}
  };
  const hasActions = () => primaryActions.childNodes.length > 0 || finalAction.childNodes.length > 0 || outsideActions.childNodes.length > 0;
  const apply = () => {
    if (disposed) return;
    const operation = revision;
    // Playback composition is admitted only for an actual saved Top header.
    // Goals and ordinary headers keep their existing DOM and ordering.
    if (props.resourceKind === 'album_top') {
      if (resourceControls.parentNode !== root) root.append(resourceControls);
    } else resourceControls.remove();
    writeAttribute('data-header-compact', String(compact)); writeAttribute('data-header-outside', String(outside)); writeAttribute('data-header-open', String(open));
    triggerHost.hidden = !hasActions() || !compact;
    button.update(buttonProps());
    if (disposed || operation !== revision) return;
    const floating = compact && open ? ' gallery-anchored-menu home-header__floating-panel' : '';
    capsule.className = `home-header__capsule${!outside ? floating : ''}`;
    actions.className = `home-header__actions${outside ? floating : ''}`;
    if (!floating || outside) capsule.removeAttribute('style');
    if (!floating || !outside) actions.removeAttribute('style');
    conceal(outsideActions, compact && !open && !outside); conceal(actions, compact && !open);
  };
  const close = restore => {if (!open) return; open = false; apply(); if (restore && focusable(trigger())) trigger().focus({preventScroll: true}); schedule();};
  const width = node => Math.max(node.scrollWidth, node.getBoundingClientRect().width);
  const naturalWidth = node => {
    const items = [...node.children].flatMap(child => child === finalAction || child === primaryActions ? [...child.children] : [child])
      .filter(child => !child.hidden && win.getComputedStyle(child).display !== 'none');
    return items.reduce((sum, child) => sum + width(child), 0) + Math.max(0, items.length - 1) * (parseFloat(win.getComputedStyle(node).columnGap) || 0);
  };
  const measure = () => {
    frame = 0; if (disposed) return;
    if (root.hidden) {if (adopted && open) {open = false; apply();} return;}
    const operation = revision;
    const available = root.getBoundingClientRect().width; if (!available) return;
    const gap = parseFloat(win.getComputedStyle(root).columnGap) || 8;
    const leadingWidth = width(leading), bodyWidth = width(content);
    const identityWidth = width(identity) + (leadingWidth ? leadingWidth + gap : 0) + (bodyWidth ? bodyWidth + gap : 0);
    const actionsWidth = naturalWidth(actions), outsideWidth = naturalWidth(outsideActions);
    const nextCompact = (actionsWidth > 0 || outsideWidth > 0) && !headerActionsFit({availableWidth: available, identityWidth, actionsWidth, outsideWidth, gap});
    const nextOutside = nextCompact && outsideWidth > 0 && headerActionsFit({availableWidth: available, identityWidth, actionsWidth: width(triggerHost) || 34, outsideWidth, gap});
    const active = doc.activeElement;
    const focusTools = nextCompact && !open && (childMenu(active) || actions.contains(active) || !nextOutside && outsideActions.contains(active));
    const focusInline = !nextCompact && active === trigger();
    if (compact !== nextCompact || outside !== nextOutside) {
      compact = nextCompact; outside = nextOutside; if (!compact) open = false;
      // Reveal the trigger before moving focus and concealing consumer controls.
      triggerHost.hidden = !hasActions() || !compact;
      if (focusTools) collapsedFocusTarget()?.focus({preventScroll: true});
      if (disposed || operation !== revision) return;
      apply();
    }
    if (focusInline) [...actions.querySelectorAll('button'), ...outsideActions.querySelectorAll('button'), ...root.querySelectorAll('button')].find(focusable)?.focus({preventScroll: true});
    if (disposed || operation !== revision) return;
    if (compact && !open && root.contains(doc.activeElement) && doc.activeElement.closest('[inert]')) collapsedFocusTarget()?.focus({preventScroll: true});
    if (disposed || operation !== revision) return;
    const rect = root.getBoundingClientRect(), viewport = win.visualViewport;
    const viewportTop = (viewport?.offsetTop || 0) + 8, viewportBottom = (viewport?.offsetTop || 0) + (viewport?.height || win.innerHeight) - 8;
    const layoutWidth = doc.documentElement.clientWidth || win.innerWidth;
    const viewportLeft = (viewport?.offsetLeft || 0) + 8, viewportRight = Math.min(layoutWidth, (viewport?.offsetLeft || 0) + (viewport?.width || layoutWidth)) - 8;
    const player = doc.querySelector('.global-player')?.getBoundingClientRect();
    const bottom = player?.height > 0 && player.top > viewportTop && player.top < viewportBottom ? player.top - 8 : viewportBottom;
    const below = Math.max(0, bottom - rect.bottom - 4), above = Math.max(0, Math.min(rect.top, bottom) - viewportTop - 4);
    const panel = root.querySelector('.home-header__floating-panel');
    const height = panel ? panel.scrollHeight + panel.offsetHeight - panel.clientHeight : Math.max(actions.scrollHeight, outsideActions.scrollHeight);
    const flip = below < Math.min(80, height) && above > below;
    const maxWidth = Math.max(0, Math.min(available, viewportRight - viewportLeft)), panelWidth = Math.min(maxWidth, panel?.getBoundingClientRect().width || maxWidth);
    if (panel) Object.assign(panel.style, {top: `${flip ? Math.max(viewportTop, Math.min(rect.top, bottom) - 4 - Math.min(height, above)) : Math.max(viewportTop, Math.min(rect.bottom + 4, bottom))}px`,
      left: `${Math.max(viewportLeft, Math.min(rect.right - panelWidth, viewportRight - panelWidth))}px`, maxWidth: `${maxWidth}px`, maxHeight: `${flip ? above : below}px`});
    if (lastFocus && (!lastFocus.isConnected || lastFocus.disabled) && (doc.activeElement === doc.body || doc.activeElement === lastFocus)) {
      const replacement = [...root.querySelectorAll('button')].find(node => (node.getAttribute('aria-label') || node.textContent) === (lastFocus.getAttribute('aria-label') || lastFocus.textContent) && focusable(node));
      const target = replacement || (compact ? trigger() : [...root.querySelectorAll('button')].find(focusable));
      if (focusable(target)) {target.focus({preventScroll: true}); lastFocus = target;}
    }
  };
  function schedule() {if (!disposed && !frame) frame = win.requestAnimationFrame(measure);}
  const pointer = event => {if (open && !root.contains(event.target) && !childMenu(event.target)) close(false);};
  const key = event => {if (event.key === 'Escape' && open && !event.defaultPrevented && !childMenu(event.target)) {event.preventDefault(); event.stopPropagation(); close(true);}};
  const focus = event => {lastFocus = event.target;};
  const clearRef = () => {
    const ref = activeRef, release = refCleanup;
    activeRef = null; refCleanup = null;
    if (typeof release === 'function') release();
    else if (typeof ref === 'function') ref(null);
    else if (ref && (!adopted || ref.current === root)) ref.current = null;
  };
  const setRef = ref => {
    activeRef = ref;
    if (typeof ref === 'function') {
      const operation = revision, release = ref(root);
      if (disposed || operation !== revision || activeRef !== ref) {if (typeof release === 'function') release(); return;}
      refCleanup = release;
    } else if (ref) ref.current = root;
  };
  cleanup = () => {
    if (disposed) return;
    disposed = true; revision++;
    if (frame) win.cancelAnimationFrame(frame); frame = 0;
    resize?.disconnect(); mutation?.disconnect(); root.removeEventListener('focusin', focus);
    doc.removeEventListener('pointerdown', pointer); doc.removeEventListener('keydown', key);
    win.removeEventListener('resize', schedule); win.removeEventListener('scroll', schedule, true);
    win.visualViewport?.removeEventListener('resize', schedule); win.visualViewport?.removeEventListener('scroll', schedule);
    try {clearRef();} finally {
      try {button?.dispose();} finally {
        if (adopted) {
          for (const node of [leading, identity, content, controls, resourceControls]) if (node.parentNode === root) node.remove();
          for (const [name, record] of attributes) if (root.getAttribute(name) === record.last) {
            if (record.before === null) root.removeAttribute(name); else root.setAttribute(name, record.before);
          }
          for (const [token, record] of classes) if (root.classList.contains(token) === record.last) {
            if (record.before) root.classList.add(token); else root.classList.remove(token);
          }
          if (adoptedHeaderRoots.get(root) === lease) adoptedHeaderRoots.delete(root);
        } else root.remove();
      }
    }
  };
  const update = next => {
    if (disposed) return;
    if (Object.hasOwn(next, 'adoptRoot') && next.adoptRoot !== adopted) throw new TypeError('Native header adoption is fixed at mount.');
    const operation = ++revision;
    if (!next.id) throw new TypeError('Native shared header requires a stable unique id.');
    if (activeRef !== next.headerRef) {clearRef(); if (disposed || operation !== revision) return; setRef(next.headerRef);}
    if (disposed || operation !== revision) return;
    props = next; writeClasses(`gallery-bar home-header ${next.className || ''}`);
    if (!adopted) root.hidden = Boolean(next.hidden); if (root.hidden) open = false;
    writeAttribute('data-shared-header', next.id); capsule.id = `${next.id}-tools`; capsule.setAttribute('data-header-action-capsule', 'true');
    writeAttribute('tabindex', next.tabIndex !== undefined ? next.tabIndex : null);
    writeAttribute('aria-label', next.ariaLabel || null);
    apply(); schedule();
  };
  root.append(leading, identity, content, controls); if (!adopted) host.replaceChildren(root);
  button = mountButton(triggerHost, runtime, buttonProps());
  resize = win.ResizeObserver ? new win.ResizeObserver(schedule) : null;
  [root, identity, content, actions, outsideActions, doc.querySelector('.global-player')].filter(Boolean).forEach(node => resize?.observe(node));
  mutation = new win.MutationObserver(schedule);
  mutation.observe(root, {subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'aria-disabled', 'hidden']});
  root.addEventListener('focusin', focus); doc.addEventListener('pointerdown', pointer); doc.addEventListener('keydown', key);
  win.addEventListener('resize', schedule); win.addEventListener('scroll', schedule, true);
  win.visualViewport?.addEventListener('resize', schedule); win.visualViewport?.addEventListener('scroll', schedule);
  setRef(initial.headerRef); update(initial);
  return {element: root, slots, update, refresh: schedule, dispose: cleanup};
  } catch (error) {
    try {cleanup();} finally {if (adoptedHeaderRoots.get(host) === lease) adoptedHeaderRoots.delete(host);}
    throw error;
  }
}
