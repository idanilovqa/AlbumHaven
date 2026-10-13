import React, {useId, useLayoutEffect, useRef} from 'react';
import {NativeChoice} from './native-choice.jsx';

export function NativeHtml({html, className = '', onClick}) {
  return <div className={className} dangerouslySetInnerHTML={{__html: html}} onClick={onClick}/>;
}
export function Button({runtime, children, onClick, disabled = false, selected, icon, ...options}) {
  const label = React.Children.toArray(children).map(value => {
    if (typeof value !== 'string' && typeof value !== 'number') throw new TypeError('Native Button expects text children.');
    return String(value);
  }).join('');
  const config = {...options, label, disabled,
    attributes: {...options.attributes, ...(selected === undefined ? {} : {'aria-pressed': String(selected)})}};
  const html = icon ? runtime.actionHtml({...config, icon, pressed: selected, ariaLabel: options.ariaLabel || label, title: options.title || label,
    presentation: 'bare'}) : runtime.buttonHtml(config);
  // React compares this prop by object identity. Keep the initial markup object
  // stable so only the native reconciliation below updates the live button.
  const root = useRef(null), initial = useRef({__html: html});
  useLayoutEffect(() => {
    const host = root.current, current = host.firstElementChild;
    const holder = host.ownerDocument.createElement('div'); holder.innerHTML = html;
    const next = holder.firstElementChild;
    if (!current || current.tagName !== next.tagName) {host.replaceChildren(next); return;}
    // Preserve the native button itself when its rendered attributes change.
    for (const attribute of [...current.attributes]) if (!next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
    for (const attribute of [...next.attributes]) if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
    if (current.innerHTML !== next.innerHTML) current.innerHTML = next.innerHTML;
  }, [html]);
  return <span ref={root} className="home-friends__button" dangerouslySetInnerHTML={initial.current} onClick={event => {
    const button = event.target.closest('button');
    if (button && !button.disabled) onClick?.(event);
  }}/>;
}
export function Status({runtime, value, label, retry}) {
  if (value?.status === 'ready') return null;
  const status = value?.status || 'unavailable';
  const message = {loading: `Loading ${label}…`, empty: `No ${label} yet.`, denied: `You don't have access to ${label}.`,
    error: `${label} could not be loaded.`, unavailable: `${label} are not available on this server yet.`}[status] || `${label} are unavailable.`;
  return <div className="home-friends__status" aria-busy={status === 'loading'}>
    <NativeHtml html={runtime.alertHtml({severity: status === 'error' ? 'error' : 'info', role: status === 'error' ? 'alert' : 'status', message})}/>
    {status === 'error' && retry && <Button runtime={runtime} onClick={retry}>Retry</Button>}
  </div>;
}
export function Tabs({runtime, id, label, items, value, onChange}) {
  const root = useRef(null), html = runtime.tabsHtml({id, label,
    tabs: items.map(([key, label, options]) => ({key, label, disabled: options?.disabled === true,
      panelId: options?.panelId})), selectedKey: value});
  const initialHtml = useRef({__html: html});
  useLayoutEffect(() => {
    const host = root.current, active = host.contains(document.activeElement) ? document.activeElement.dataset.inPageTab : null;
    if (host.innerHTML !== html) host.innerHTML = html;
    runtime.mountTabs(host.firstElementChild);
    if (active) [...host.querySelectorAll('[data-in-page-tab]')].find(node => node.dataset.inPageTab === active)?.focus({preventScroll: true});
  }, [runtime, html]);
  const sync = () => {
    const next = root.current.querySelector('[aria-selected="true"]')?.dataset.inPageTab;
    if (next && next !== value) onChange(next);
  };
  return <div ref={root} className="home-friends__tabs" dangerouslySetInnerHTML={initialHtml.current} onClick={sync} onKeyDown={sync}/>;
}
export function Period({runtime, value, onChange, range}) {
  return <NativeChoice runtime={runtime} icon="calendar" className="home-friends__period" showLabel={false} label="Period" menuWidth="content" value={value} onChange={onChange}
    title={range} options={ [['week', 'Last week'], ['month', 'Last month'], ['six', 'Last 6 months'], ['year', 'Last year'], ['all', 'All time']] }/>;
}
export function RecentAlbums({runtime, value, retry, selected, onSelect, onError, selectionMode = 'native'}) {
  const root = useRef(null), owner = useRef(null), latest = useRef({retry, onSelect, onError});
  latest.current = {retry, onSelect, onError};
  useLayoutEffect(() => {
    let disposed = false;
    const intent = (kind, ref) => Promise.resolve(runtime.albumIntent(kind, ref)).catch(error => {
      if (!disposed && error?.name !== 'AbortError') latest.current.onError(kind === 'play'
        ? 'This album could not be played. Please try again.' : 'This album could not be opened. Please try again.');
    });
    owner.current = runtime.mountRecent(root.current, {
      onSelectAlbum: ref => latest.current.onSelect(ref), onOpenAlbum: ref => intent('open', ref),
      onPlayAlbum: ref => intent('play', ref), onRetry: () => latest.current.retry(),
    });
    return () => {disposed = true; owner.current?.dispose(); owner.current = null; root.current?.replaceChildren();};
  }, [runtime]);
  useLayoutEffect(() => {
    const status = value.status === 'empty' ? 'ready' : value.status;
    owner.current?.update({status, payload: value.data || {recent_local_albums: [], recent_not_local_albums: []},
      selectedAlbumRef: selected, displayMode: 'cards', selectionMode});
  }, [runtime, value, selected, selectionMode]);
  return <section ref={root} className="home-friends__native-recent" aria-label="Recent albums"/>;
}

// Shared Artist content renders supplied projections through the native owners.
export function ArtistInfo({runtime, artist, summary, metadata, imageUrl, sourceLabel}) {
  return <NativeHtml className="artist-info" html={runtime.artistInfoHtml({
    presentation: 'embedded', artist, summary, metadata, imageUrl, sourceLabel,
  })}/>;
}
export function ArtistFamily({runtime, title, members, currentArtist, onNavigate}) {
  return <NativeHtml className="artist-family" html={runtime.artistFamilyHtml({
    presentation: 'navigation', title, members, currentArtist,
  })} onClick={event => {
    const row = event.target.closest('[data-artist-page-family]');
    if (row && !event.defaultPrevented && event.currentTarget.contains(row) && !row.disabled && row.getAttribute('aria-disabled') !== 'true') {
      onNavigate?.(row.getAttribute('data-artist-page-family'));
    }
  }}/>;
}
export function IntrinsicDisclosure({runtime, id, memberKey, label, count, collapsed = false, enabled = true, onToggle, actions, children}) {
  const generatedId = useId(), panelId = `${id || `intrinsic-disclosure-${generatedId}`}-panel`;
  const header = useRef(null), panel = useRef(null), control = useRef(null), owner = useRef(null);
  const latest = useRef(onToggle); latest.current = onToggle;
  // Server markup reflects the initial state. Keep visibility props fixed after
  // that render: the native owner must move focus before changing hidden/inert.
  const toggleHtml = runtime.actionHtml({icon: 'next', presentation: 'bare', ariaLabel: label, title: label, disabled: !enabled,
    attributes: enabled ? {'aria-controls': panelId, 'aria-expanded': String(!collapsed)} : {}});
  const initial = useRef({closed: Boolean(enabled && collapsed), toggleHtml: {__html: toggleHtml}});
  useLayoutEffect(() => {
    const toggle = control.current.firstElementChild;
    // These are this wrapper's server-rendered attributes, not consumer DOM.
    // Its unowned baseline is visible content with no disclosure relationship.
    panel.current.removeAttribute('hidden'); panel.current.removeAttribute('inert');
    toggle.removeAttribute('aria-controls'); toggle.removeAttribute('aria-expanded');
    const instance = runtime.createIntrinsicDisclosure({members: [], enabled: false,
      onToggle: (key, value) => latest.current?.(key, value)});
    owner.current = instance;
    return () => {instance.dispose(); if (owner.current === instance) owner.current = null;};
  }, [runtime]);
  useLayoutEffect(() => {
    const toggle = control.current.firstElementChild;
    // This retained native ActionButton has no copied markup/style/click logic.
    // The wrapper owns its label and availability; the native disclosure owns
    // controls/expanded and all panel visibility after provisional SSR markup.
    for (const [name, value] of [['aria-label', String(label)], ['title', String(label)],
      ['disabled', enabled ? null : ''], ['aria-disabled', enabled ? null : 'true']]) {
      if (toggle.getAttribute(name) === value) continue;
      if (value === null) toggle.removeAttribute(name); else toggle.setAttribute(name, value);
    }
    owner.current?.update({members: [{key: memberKey, panel: panel.current, header: header.current, toggle}],
      collapsed: {[memberKey]: Boolean(collapsed)}, enabled});
  });
  return <section className="intrinsic-disclosure" data-disclosure-key={memberKey}>
    <header ref={header} className="intrinsic-disclosure__header">
      <span ref={control} className="intrinsic-disclosure__toggle" dangerouslySetInnerHTML={initial.current.toggleHtml}/>
      <h2 className="intrinsic-disclosure__label">{label}</h2>
      {count !== undefined && count !== null && <span className="intrinsic-disclosure__count">{count}</span>}
      {actions && <div className="intrinsic-disclosure__actions">{actions}</div>}
    </header>
    <div ref={panel} id={panelId} className="intrinsic-disclosure__panel" data-disclosure-panel=""
      hidden={initial.current.closed} inert={initial.current.closed}>{children}</div>
  </section>;
}
