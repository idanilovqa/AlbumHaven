import React, {useLayoutEffect, useMemo, useRef, useState} from 'react';
import {Button, NativeHtml, Status} from './components.jsx';
import {NativeChoice} from './native-choice.jsx';
import {metric, safeServerArtworkUrl} from './model.mjs';

export const comparisonOrders = Object.freeze([
  ['general', 'General'], ['yours', 'Yours first'], ['friend', 'Friend first'],
]);
const kinds = {albums: 'album', tracks: 'track', artists: 'artist'};
const known = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const presentationRef = value => typeof value === 'string' && value.trim() && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value);

export function restoreComparisonPresentation(value, {friendRef = '', kind = 'tracks', period = 'week'} = {}) {
  const saved = value?.friendRef === friendRef && value?.kind === kind && value?.period === period ? value : null;
  return {friendRef, kind, period,
    commonOnly: typeof saved?.commonOnly === 'boolean' ? saved.commonOnly : true,
    order: comparisonOrders.some(([key]) => key === saved?.order) ? saved.order : 'general',
    ascending: saved?.ascending === true, view: saved?.view === 'covers' ? 'covers' : 'rows',
    selection: presentationRef(saved?.selection?.id) && saved.selection.kind === kinds[kind]
      ? {id: saved.selection.id, kind: saved.selection.kind} : null};
}

export function reconcileComparisonSelection(selection, status, rows = []) {
  // An unreadable projection cannot show details. Keep only the opaque identity
  // through initial loading/transient failures until an authorized result arrives.
  if (!selection || status === 'denied' || status === 'empty') return null;
  if (status === 'ready' && !rows.some(row => row.id === selection?.id && row.kind === selection.kind)) return null;
  return selection;
}

// The provider has already joined and authorized these rows. Presentation only
// filters and sorts this page; it never reconstructs a union or fills a missing side.
export function projectComparisonRows(rows, kind, {commonOnly = true, order = 'general', ascending = false} = {}) {
  const score = row => {
    const yours = row.yours?.listen_count, friend = row.friend?.listen_count;
    if (order === 'yours') return known(yours) ? yours : null;
    if (order === 'friend') return known(friend) ? friend : null;
    return known(yours) && known(friend) && Number.isFinite(yours + friend) ? yours + friend : null;
  };
  return rows.filter(row => row.kind === kinds[kind] && (!commonOnly
    || (known(row.yours?.listen_count) && row.yours.listen_count > 0
      && known(row.friend?.listen_count) && row.friend.listen_count > 0)))
    .sort((left, right) => {
      const a = score(left), b = score(right);
      // Unknown values stay last in both directions; zero is a known value.
      if ((a === null) !== (b === null)) return a === null ? 1 : -1;
      return (a === null ? 0 : (ascending ? 1 : -1) * (a - b))
        || compareText(left.title, right.title) || compareText(left.id, right.id);
    });
}

export function comparisonFacts(side, kind) {
  const facts = [['listen_count', kind === 'albums' ? 'Track listens' : 'Listens', metric(side?.listen_count)]];
  if (kind === 'albums') facts.push(['full_listen_count', 'Full listens', metric(side?.full_listen_count)]);
  facts.push(['play_count', 'PC', metric(side?.play_count)]);
  if (kind !== 'artists') facts.push(['rating', 'Rating', metric(side?.rating)],
    ['favorite', 'Favorite', side?.favorite === true ? 'Yes' : side?.favorite === false ? 'No' : '–']);
  return facts;
}

export function comparisonSelection(row) {
  // Identity for this DTO-only detail summary, never a native library action reference.
  return row ? {id: row.id, kind: row.kind} : null;
}

export function ComparisonControls({runtime, kind, commonOnly, onCommonOnly, order, onOrder, ascending, onDirection, view, onView}) {
  return <div className="home-comparison__controls" role="group" aria-label="Comparison filters and order">
    <label className="selection-accent-toggle home-comparison__common"><input type="checkbox" checked={commonOnly}
      onChange={event => onCommonOnly(event.target.checked)}/><span>Common only</span></label>
    <div className="home-comparison__order" role="group" aria-label="Comparison order">
      <NativeChoice runtime={runtime} label="Comparison order" showLabel={false} options={comparisonOrders} value={order} onChange={onOrder}/>
      <Button runtime={runtime} icon={ascending ? 'ascending' : 'descending'} onClick={onDirection}>
        {`Sort ${ascending ? 'descending' : 'ascending'} by listens on this page`}</Button>
    </div>
    {kind === 'albums' && <div className="home-comparison__views" role="group" aria-label="Comparison album view">
      <Button runtime={runtime} size="small" selected={view === 'rows'} onClick={() => onView('rows')}>Rows</Button>
      <Button runtime={runtime} size="small" selected={view === 'covers'} onClick={() => onView('covers')}>Small covers</Button>
    </div>}
  </div>;
}

function artworkHtml(runtime, row) {
  const url = safeServerArtworkUrl(row.artwork_url);
  return runtime.artboxHtml({state: url ? 'ready' : 'empty', label: `${row.title || row.kind} artwork`,
    coverHtml: url ? `<img src="${runtime.escapeHtml(url)}" alt="" loading="lazy" decoding="async">` : ''});
}
function factsHtml(runtime, row, side, kind, label) {
  const escape = runtime.escapeHtml;
  return `<div class="home-comparison__facts" aria-label="${escape(`${label} statistics`)}">${comparisonFacts(row[side], kind).map(([key, name, value]) =>
    `<div class="home-comparison__fact" data-comparison-metric="${key}"><span${key === 'play_count' ? ' title="Personal play count, supplied by the server"' : ''}>${name}</span><strong>${escape(value)}</strong></div>`).join('')}</div>`;
}
function identityHtml(runtime, row, side, kind) {
  const escape = runtime.escapeHtml;
  const art = artworkHtml(runtime, row);
  const title = runtime.buttonHtml({label: kind === 'albums' ? 'Details' : row.title || `Untitled ${row.kind}`, size: 'small', quiet: true,
    ariaLabel: `Show comparison details: ${row.title || row.kind}`,
    attributes: {'data-home-comparison-select': row.id, 'data-comparison-side': side, 'aria-pressed': 'false'}});
  if (kind === 'albums') {
    return `<div class="home-comparison__album-row">${runtime.galleryCardHtml({identity: row.id, interaction: 'none', displayMode: 'list',
      title: row.title, artist: row.artist, artboxHtml: art, listeningSummaryHtml: ''})}${title}</div>`;
  }
  return `<div class="home-comparison__identity"><span class="home-comparison__art">${art}</span><div class="home-comparison__copy">${title}${kind === 'tracks' && row.artist ? `<span class="home-comparison__artist">${escape(row.artist)}</span>` : ''}</div></div>`;
}

export function comparisonTableHtml(runtime, rows, kind, friendName) {
  const album = kind === 'albums', label = kind === 'artists' ? 'Artist' : kind === 'tracks' ? 'Track' : 'Album';
  return runtime.tableHtml({id: `home-comparison-${kind}`, ariaLabel: `Your ${kind} compared with ${friendName}`,
    columns: album ? 'minmax(160px,1.4fr) minmax(95px,1fr) minmax(95px,1fr)' : 'minmax(150px,1.4fr) minmax(90px,1fr) minmax(90px,1fr) minmax(150px,1.4fr)',
    columnsConfig: [{key: 'identity', label}, {key: 'yours', label: 'Yours'}, {key: 'friend', label: friendName},
      ...(!album ? [{key: 'friendIdentity', label}] : [])],
    density: 'compact', frame: 'none', overflow: 'local', mobile: 'preserve', selection: 'single',
    rows: rows.map(row => ({key: row.id, dataAttributes: {'comparison-id': row.id},
      cells: {identity: identityHtml(runtime, row, 'yours', kind),
        yours: factsHtml(runtime, row, 'yours', kind, 'Yours'), friend: factsHtml(runtime, row, 'friend', kind, friendName),
        ...(!album ? {friendIdentity: identityHtml(runtime, row, 'friend', kind)} : {})}}))});
}

export function ComparisonCards({runtime, rows, kind = 'albums', friendName = 'Friend', onSelect}) {
  const [hovered, setHovered] = useState(null), [focused, setFocused] = useState(null);
  const active = focused || hovered;
  useLayoutEffect(() => {setHovered(null); setFocused(null);}, [rows]);
  return <div className="home-comparison__cards">
    {rows.map(row => <div className="home-comparison__pair" key={row.id} data-comparison-id={row.id}>
      {['yours', 'friend'].map(side => <section key={side} className="home-comparison__card-side" data-comparison-side={side}
        data-comparison-highlighted={active?.id === row.id && active.side !== side ? 'true' : undefined}
        aria-label={`${side === 'yours' ? 'Yours' : friendName}: ${row.title || 'Untitled album'}`}
        onMouseEnter={() => setHovered({id: row.id, side})} onMouseLeave={() => setHovered(null)}
        onFocusCapture={() => setFocused({id: row.id, side})}
        onBlurCapture={event => {if (!event.currentTarget.contains(event.relatedTarget)) setFocused(null);}}>
        <h3 className="home-comparison__person">{side === 'yours' ? 'Yours' : friendName}</h3>
        <NativeHtml html={runtime.galleryCardHtml({identity: `${side}:${row.id}`, interaction: 'none', displayMode: 'cards', title: row.title,
          artist: row.artist, artboxHtml: artworkHtml(runtime, row), listeningSummaryHtml: factsHtml(runtime, row, side, kind, side === 'yours' ? 'Yours' : friendName)})}/>
        <Button runtime={runtime} size="small" ariaLabel={`Show comparison details: ${row.title || row.kind}`}
          attributes={{'data-home-comparison-select': row.id, 'data-comparison-side': side, 'aria-pressed': 'false'}} onClick={() => onSelect(row)}>Details</Button>
      </section>)}
    </div>)}
  </div>;
}

function DetailSummary({row, kind, friendName}) {
  if (!row) return null;
  const last = side => typeof side?.last_listened_at === 'string' && Number.isFinite(Date.parse(side.last_listened_at))
    ? new Date(side.last_listened_at).toLocaleString() : '–';
  return <section className="home-comparison__details" aria-label="Selected comparison details" aria-live="polite">
    <h3>{row.title || `Untitled ${row.kind}`}</h3>{row.artist && kind !== 'artists' && <p>{row.artist}</p>}
    <div className="home-comparison__detail-pair">{['yours', 'friend'].map(side => <div key={side}>
      <h4>{side === 'yours' ? 'Yours' : friendName}</h4>
      <dl>{comparisonFacts(row[side], kind).map(([key, name, value]) => <div key={key}><dt>{name === 'PC' ? 'Personal play count' : name}</dt><dd>{value}</dd></div>)}
        <div><dt>Last listened</dt><dd>{last(row[side])}</dd></div></dl>
    </div>)}</div>
  </section>;
}

export function ComparisonPanel({runtime, value, friendName = 'Friend', friendRef = '', kind = 'tracks', period = 'week',
  presentation, onPresentationChange, onSelection, headerControls, retry, onUserIntent}) {
  const [settings, setSettings] = useState(() => restoreComparisonPresentation(presentation, {friendRef, kind, period}));
  const {commonOnly, order, ascending, view, selection: selected} = settings;
  const root = useRef(null);
  const sourceRows = value?.status === 'ready' ? value.data?.rows : null;
  const rows = useMemo(() => projectComparisonRows(sourceRows || [], kind, {commonOnly, order, ascending}), [sourceRows, kind, commonOnly, order, ascending]);
  const nextSelection = reconcileComparisonSelection(selected, value?.status, rows);
  const selectedRow = rows.find(row => row.id === selected?.id && row.kind === selected.kind) || null;
  const tableHtml = useMemo(() => comparisonTableHtml(runtime, rows, kind, friendName), [runtime, rows, kind, friendName]);
  function change(values) {onUserIntent?.(); setSettings(current => ({...current, ...values}));}
  function select(row) {const selection = comparisonSelection(row); change({selection}); onSelection?.(selection);}
  useLayoutEffect(() => {
    if (nextSelection !== selected) {
      setSettings(current => ({...current, selection: nextSelection})); onSelection?.(nextSelection);
      return;
    }
    onPresentationChange?.(settings);
  }, [settings, selected, nextSelection, onSelection, onPresentationChange]);
  useLayoutEffect(() => {
    for (const row of root.current.querySelectorAll('[data-comparison-id]')) {
      const active = row.dataset.comparisonId === selectedRow?.id;
      row.dataset.comparisonSelected = String(active);
      if (row.getAttribute('role') === 'row') row.setAttribute('aria-selected', String(active));
      for (const button of row.querySelectorAll('[data-home-comparison-select]')) button.setAttribute('aria-pressed', String(active));
    }
  }, [selectedRow, rows, view, tableHtml]);
  const ready = value?.status === 'ready' || value?.status === 'empty';
  return <section ref={root} className="home-comparison" data-comparison-kind={kind} data-comparison-view={view}
    aria-label={`Your listening compared with ${friendName}`}>
    <ComparisonControls runtime={runtime} kind={kind} commonOnly={commonOnly} onCommonOnly={value => change({commonOnly: value})}
      order={order} onOrder={value => change({order: value})} ascending={ascending} onDirection={() => change({ascending: !ascending})} view={view} onView={value => change({view: value})}/>
    {headerControls}
    {ready && <p className="home-comparison__scope">Filtering and ordering this page only. Common only shows known listens on both sides. PC is personal play count; – means unavailable.</p>}
    {!ready ? <Status runtime={runtime} value={value} label="Taste comparisons" retry={retry}/> : !rows.length
      ? <p className="home-comparison__empty" role="status">{commonOnly ? 'No confirmed shared listens on this page.' : 'No listening activity on this page.'}</p>
      : kind === 'albums' && view === 'covers' ? <ComparisonCards runtime={runtime} rows={rows} kind={kind} friendName={friendName} onSelect={select}/>
        : <NativeHtml className="home-comparison__table" html={tableHtml} onClick={event => {
          const button = event.target.closest('[data-home-comparison-select]');
          if (!button || !event.currentTarget.contains(button) || button.disabled) return;
          const row = rows.find(item => item.id === button.dataset.homeComparisonSelect);
          if (row) select(row);
        }}/>}
    <DetailSummary row={selectedRow} kind={kind} friendName={friendName}/>
  </section>;
}
