import React, {useLayoutEffect, useRef} from 'react';
import {NativeHtml} from './components.jsx';
import {safeServerArtworkUrl} from './model.mjs';
import {detailSelection} from './detail-projection.mjs';

const known = value => typeof value === 'string' && value.trim() ? value : 'Unknown artist';
const readable = row => row?.source_readable !== false
  && !(Object.hasOwn(row?.allowed_actions || {}, 'can_read') && row.allowed_actions.can_read !== true);
export function resourceArtwork(runtime, data, label) {
  const url = safeServerArtworkUrl(data.artwork_url);
  return runtime.artboxHtml({state: url ? 'ready' : 'empty', label,
    coverHtml: url ? `<img src="${runtime.escapeHtml(url)}" alt="" loading="lazy" decoding="async">` : ''});
}
function ArtistRow({runtime, row, selected, onSelect}) {
  const host = useRef(null);
  const allowed = readable(row), name = allowed ? known(row.title) : 'Unavailable artist';
  const html = runtime.navigationItemHtml({label: name, key: row.id, action: true, variant: 'wide',
    selected: allowed && selected, disabled: !allowed, count: allowed ? row.listen_count ?? null : null,
    artworkHtml: allowed ? resourceArtwork(runtime, row, `${name} artwork`) : '',
    attributes: {'data-home-artist-select': row.id}});
  const initial = useRef(html);
  useLayoutEffect(() => {
    const current = host.current.firstElementChild, holder = host.current.ownerDocument.createElement('div');
    holder.innerHTML = html;
    const next = holder.firstElementChild;
    if (!current) {host.current.appendChild(next); return;}
    for (const attribute of [...current.attributes]) if (!next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
    for (const attribute of [...next.attributes]) if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
    if (current.innerHTML !== next.innerHTML) current.innerHTML = next.innerHTML;
  }, [html]);
  return <div ref={host} className="home-artists__item" dangerouslySetInnerHTML={{__html: initial.current}} onClick={event => {
    const button = event.target.closest('[data-home-artist-select]');
    if (!button || !host.current.contains(button) || !allowed || button.disabled || event.defaultPrevented) return;
    event.preventDefault(); event.stopPropagation();
    onSelect?.(row);
  }}/>;
}

// Canonical Artist selection is supplied by the caller; names never become
// Gallery queries, profile identities or inferred album membership.
export function ArtistSelectionRows({runtime, rows = [], view = 'list', selectedId = null, onSelect}) {
  return <div className={`home-artists home-artists--${view === 'cards' ? 'circles' : 'rows'}`} aria-label="Artists">
    {rows.map(row => <ArtistRow key={row.id} runtime={runtime} row={row} selected={row.id === selectedId} onSelect={onSelect}/>)}
  </div>;
}

export function ListenedAlbums({runtime, albums, onSelect}) {
  if (albums == null) return <p className="home-friends__muted">Listened albums were not supplied for this period.</p>;
  if (albums.length === 0) return <p className="home-friends__muted">No albums listened to in this period.</p>;
  return <div className="home-detail__listened-albums">{albums.map(album => {
    const target = detailSelection(album.detail_target), canSelect = target?.allowed_actions.can_view_details === true && typeof onSelect === 'function';
    const html = runtime.galleryCardHtml({interaction: canSelect ? 'controlled' : 'none', identity: album.id, actionRef: album.id,
      displayMode: 'cards', title: album.title || 'Unknown album', year: album.year, listeningSummaryHtml: '',
      artboxHtml: resourceArtwork(runtime, album, `${album.title || 'Album'} artwork`), actions: {select: canSelect}});
    return <NativeHtml key={album.id} html={html} onClick={event => {
      const trigger = event.target.closest('[data-gallery-card-intent="select"]');
      if (!canSelect || !trigger || !event.currentTarget.contains(trigger) || trigger.disabled || event.defaultPrevented) return;
      event.preventDefault(); event.stopPropagation();
      onSelect(detailSelection({...target, native_actions: album.native_actions || target.native_actions}));
    }}/>;
  })}</div>;
}
