import React, {useLayoutEffect, useRef} from 'react';
import {metric} from './model.mjs';
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
  const root = useRef(null), initial = useRef(html);
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
  return <span ref={root} className="home-friends__button" dangerouslySetInnerHTML={{__html: initial.current}} onClick={event => {
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
    tabs: items.map(([key, label, options]) => ({key, label, disabled: options?.disabled === true})), selectedKey: value});
  const initialHtml = useRef(html);
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
  return <div ref={root} className="home-friends__tabs" dangerouslySetInnerHTML={{__html: initialHtml.current}} onClick={sync} onKeyDown={sync}/>;
}
export function Period({runtime, value, onChange, total, range}) {
  return <>
    <span className="home-friends__listens">Listens: {metric(total)}</span>
    <NativeChoice runtime={runtime} className="home-friends__period" buttonClassName="ui-choice__trigger--header" showLabel={false} label="Period" value={value} onChange={onChange}
      options={ [['week', 'Last week'], ['month', 'Last month'], ['six', 'Last 6 months'], ['year', 'Last year'], ['all', 'All time']] }/>
    {range && <span className="home-friends__range">{range}</span>}
  </>;
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
