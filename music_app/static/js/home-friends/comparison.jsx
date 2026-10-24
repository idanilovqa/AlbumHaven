import React, {useLayoutEffect, useMemo, useRef, useState} from 'react';
import {createPortal} from 'react-dom';
import {Button, NativeHtml, Status} from './components.jsx';
import {NativeChoice} from './native-choice.jsx';
import {ViewControl} from './view-control.jsx';
import {metric, safeServerArtworkUrl} from './model.mjs';
import {cycleTableSort} from './table-order.mjs';
import {HOME_PHONE_QUERY} from './presentation.mjs';
import {comparisonOrders, comparisonFacts, comparisonSelection, comparisonRelation,
  projectComparisonRows, restoreComparisonPresentation, reconcileComparisonSelection} from './comparison-presentation.mjs';

// Preserve the original comparison entry point for existing consumers.
export {comparisonOrders, comparisonFacts, comparisonSelection, comparisonRelation,
  projectComparisonRows, restoreComparisonPresentation, reconcileComparisonSelection} from './comparison-presentation.mjs';
const EMPTY_ROWS = Object.freeze([]);
const metricColumns = kind => comparisonFacts(null, kind).filter(([key]) => key !== 'favorite');
const columnKey = (side, key) => `${side}:${key}`;
function tableSort({order = 'general', ascending = false, metricSort = null} = {}) {
  return metricSort ? {key: columnKey(metricSort.side, metricSort.key), direction: metricSort.direction === 'ascending' ? 'asc' : 'desc'}
    : {key: order === 'general' ? null : order, direction: ascending ? 'asc' : 'desc'};
}

export function ComparisonControls({runtime, commonOnly, onCommonOnly, order, onOrder}) {
  return <div className="home-comparison__controls" role="group" aria-label="Comparison filters and order">
    <label className="selection-accent-toggle home-comparison__common"><input type="checkbox" checked={commonOnly}
      onChange={event => onCommonOnly(event.target.checked)}/><span>Common only</span></label>
    <NativeChoice runtime={runtime} className="home-comparison__order" label="Comparison order" showLabel={false}
      options={comparisonOrders} value={order} onChange={onOrder}/>
  </div>;
}

function artworkHtml(runtime, row) {
  const url = safeServerArtworkUrl(row.artwork_url);
  return runtime.artboxHtml({state: url ? 'ready' : 'empty', label: `${row.title || row.kind} artwork`,
    coverHtml: url ? `<img src="${runtime.escapeHtml(url)}" alt="" loading="lazy" decoding="async" onerror="handleUtilityAlbumArtboxError(this)">` : ''});
}
function relationHtml(runtime, row, key, label, friendName) {
  const relation = comparisonRelation(row.yours?.[key], row.friend?.[key]);
  if (!relation) return '';
  const spoken = `${label}: Yours ${metric(row.yours[key])}, ${friendName} ${metric(row.friend[key])}; Yours is ${relation.spoken} ${friendName}`;
  return `<span class="home-comparison__relation" role="img" aria-label="${runtime.escapeHtml(spoken)}"><span aria-hidden="true">${runtime.escapeHtml(relation.symbol)}</span></span>`;
}
function numericHtml(runtime, row, side, key, label, friendName) {
  const value = metric(row[side]?.[key]), person = side === 'yours' ? 'Yours' : friendName;
  return `<span class="home-comparison__number" aria-label="${runtime.escapeHtml(`${person} ${label}: ${value === '–' ? 'unavailable' : value}`)}"><strong>${runtime.escapeHtml(value)}</strong></span>`;
}
function favoriteHtml(row, side, kind) {
  if (kind === 'artists') return '';
  const value = row[side]?.favorite;
  return `<span class="home-comparison__favorite">Favorite: ${value === true ? 'Yes' : value === false ? 'No' : '–'}</span>`;
}
function identityHtml(runtime, row, side, kind) {
  const escape = runtime.escapeHtml, label = row.title || `Untitled ${row.kind}`;
  const attributes = {'data-home-comparison-select': row.id, 'data-comparison-side': side, 'aria-pressed': 'false'};
  const title = runtime.buttonHtml({label: kind === 'albums' ? 'Details' : label, size: 'small', quiet: true,
    ariaLabel: `Show comparison details: ${label}`, attributes});
  let identity;
  if (kind === 'albums') {
    identity = `<div class="home-comparison__album-row">${runtime.galleryCardHtml({identity: `${side}:${row.id}`, interaction: 'none', displayMode: 'list',
      title: row.title, artist: row.artist, artboxHtml: artworkHtml(runtime, row), listeningSummaryHtml: ''})}${title}</div>`;
  } else if (kind === 'artists') {
    identity = runtime.navigationItemHtml({label, key: `${side}:${row.id}`, action: true, variant: 'wide',
      artworkHtml: artworkHtml(runtime, row), attributes});
  } else {
    identity = `<div class="home-comparison__identity"><span class="home-comparison__art">${artworkHtml(runtime, row)}</span><div class="home-comparison__copy">${title}${row.artist ? `<span class="home-comparison__artist">${escape(row.artist)}</span>` : ''}</div></div>`;
  }
  return `<div class="home-comparison__side-identity" data-comparison-side="${side}">${identity}</div>`;
}

// A single native table owns the joined rows and every sortable heading. Grid
// placement pairs the desktop identities and shares the identity on phones.
export function comparisonTableHtml(runtime, rows, kind, friendName, settings = {}) {
  const metrics = metricColumns(kind), count = metrics.length;
  const columns = ['yours', 'friend'].flatMap(side => [
    {key: side, label: side === 'yours' ? 'Yours' : friendName, sortable: true},
    ...metrics.map(([key, label]) => ({key: columnKey(side, key), label, sortable: true})),
    ...(kind === 'artists' ? [] : [{key: columnKey(side, 'favorite'), label: `${side === 'yours' ? 'Yours' : friendName} Favorite`, header: 'screen-reader'}]),
  ]);
  return runtime.tableHtml({id: `home-comparison-${kind}`, ariaLabel: `Your ${kind} compared with ${friendName}`,
    columns: `repeat(${count * 2},minmax(0,1fr))`, columnsConfig: columns, sort: tableSort(settings),
    density: 'compact', frame: 'none', overflow: 'none', mobile: 'preserve', selection: 'single',
    rows: rows.map(row => ({key: row.id, dataAttributes: {'comparison-id': row.id},
      cells: Object.fromEntries(['yours', 'friend'].flatMap(side => [
        [side, settings.phone && side === 'friend' ? '' : identityHtml(runtime, row, side, kind)],
        ...metrics.map(([key, label]) => [columnKey(side, key), `<div class="home-comparison__metric" data-comparison-side="${side}" data-comparison-metric="${key}"><span class="home-comparison__metric-label">${runtime.escapeHtml(label)}</span>${numericHtml(runtime, row, side, key, label, friendName)}${side === 'yours' ? relationHtml(runtime, row, key, label, friendName) : ''}</div>`]),
        ...(kind === 'artists' ? [] : [[columnKey(side, 'favorite'), favoriteHtml(row, side, kind)]]),
      ]))}))});
}

function cardFactsHtml(runtime, row, side, kind, friendName) {
  return `<div class="home-comparison__facts" aria-label="${runtime.escapeHtml(`${side === 'yours' ? 'Yours' : friendName} statistics`)}">${metricColumns(kind).map(([key, label]) =>
    `<div class="home-comparison__metric" data-comparison-metric="${key}"><span class="home-comparison__metric-label">${runtime.escapeHtml(label)}</span>${numericHtml(runtime, row, side, key, label, friendName)}${side === 'yours' ? relationHtml(runtime, row, key, label, friendName) : ''}</div>`).join('')}${favoriteHtml(row, side, kind)}</div>`;
}
export function ComparisonCards({runtime, rows, kind = 'albums', friendName = 'Friend', onSelect}) {
  const [hovered, setHovered] = useState(null), [focused, setFocused] = useState(null);
  const active = focused || hovered;
  useLayoutEffect(() => {setHovered(null); setFocused(null);}, [rows]);
  const focusedRow = rows.find(row => row.id === focused?.id);
  const counterpart = focused?.side === 'yours' ? 'friend' : 'yours';
  const announcement = focusedRow ? `${counterpart === 'yours' ? 'Yours' : friendName}, matching album: ${focusedRow.title}. ${comparisonFacts(focusedRow[counterpart], kind).map(([, label, value]) => `${label}: ${value === '–' ? 'unavailable' : value}`).join('. ')}` : '';
  return <div className="home-comparison__cards">
    <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
    {rows.map(row => <div className="home-comparison__pair" key={row.id} data-comparison-id={row.id}>
      {['yours', 'friend'].map(side => <section key={side} className="home-comparison__card-side" data-comparison-side={side}
        data-comparison-highlighted={active?.id === row.id && active.side !== side ? 'true' : undefined}
        aria-label={`${side === 'yours' ? 'Yours' : friendName}: ${row.title || 'Untitled album'}`}
        onMouseEnter={() => setHovered({id: row.id, side})} onMouseLeave={() => setHovered(null)}
        onFocusCapture={() => setFocused({id: row.id, side})}
        onBlurCapture={event => {if (!event.currentTarget.contains(event.relatedTarget)) setFocused(null);}}>
        <h3 className="home-comparison__person">{side === 'yours' ? 'Yours' : friendName}</h3>
        <NativeHtml html={runtime.galleryCardHtml({identity: `${side}:${row.id}`, interaction: 'none', displayMode: 'cards', title: row.title,
          artist: row.artist, artboxHtml: artworkHtml(runtime, row), listeningSummaryHtml: cardFactsHtml(runtime, row, side, kind, friendName)})}/>
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
  presentation, onPresentationChange, onSelection, headerControls, viewControlsHost, retry, onUserIntent}) {
  const [stored, setSettings] = useState(() => restoreComparisonPresentation(presentation, {friendRef, kind, period}));
  const [phone, setPhone] = useState(() => typeof window !== 'undefined' && window.matchMedia?.(HOME_PHONE_QUERY).matches === true);
  const context = useMemo(() => ({runtime, value, friendRef, kind, period}), [runtime, value, friendRef, kind, period]);
  const owner = useRef({context, epoch: 0}), latest = useRef(context), root = useRef(null), sortFocus = useRef(null);
  if (owner.current.context !== context) owner.current = {context, epoch: owner.current.epoch + 1};
  latest.current = context;
  const settings = useMemo(() => stored.friendRef === friendRef && stored.kind === kind && stored.period === period
    ? stored : restoreComparisonPresentation(presentation, {friendRef, kind, period}), [stored, presentation, friendRef, kind, period]);
  const {commonOnly, order, ascending, view, metricSort, selection: selected} = settings;
  const sourceRows = value?.status === 'ready' ? value.data?.rows || EMPTY_ROWS : EMPTY_ROWS;
  const rows = useMemo(() => projectComparisonRows(sourceRows, kind, {commonOnly, order, ascending, metricSort}), [sourceRows, kind, commonOnly, order, ascending, metricSort]);
  const nextSelection = reconcileComparisonSelection(selected, value?.status, rows);
  const selectedRow = rows.find(row => row.id === nextSelection?.id && row.kind === nextSelection.kind) || null;
  const covers = kind === 'albums' && view === 'covers' && !phone;
  const html = useMemo(() => comparisonTableHtml(runtime, covers ? EMPTY_ROWS : rows, kind, friendName, {order, ascending, metricSort, phone}), [runtime, rows, kind, friendName, order, ascending, metricSort, covers, phone]);
  const current = () => latest.current === context && root.current?.isConnected;
  function change(values) {
    if (!current()) return;
    onUserIntent?.();
    if (!current()) return;
    setSettings(previous => ({...(previous.friendRef === friendRef && previous.kind === kind && previous.period === period ? previous : settings), ...values}));
  }
  function select(row) {
    if (!current() || value?.status !== 'ready' || !rows.includes(row)) return;
    const selection = comparisonSelection(row); change({selection}); if (current()) onSelection?.(selection);
  }
  function activate(event) {
    if (!current() || event.defaultPrevented || !event.currentTarget.contains(event.target)) return;
    const heading = event.target.closest('[data-cdt-sort]');
    if (heading && !heading.disabled) {
      const key = heading.dataset.cdtSort;
      const side = ['yours', 'friend'].find(side => key === side || metricColumns(kind).some(([field]) => key === columnKey(side, field)));
      if (!side) return;
      event.preventDefault(); event.stopPropagation(); sortFocus.current = {key, context};
      if (key === side) change({order: side, ascending: !metricSort && order === side ? !ascending : false, metricSort: null});
      else {
        const next = cycleTableSort(tableSort(settings), key);
        change({metricSort: next.direction === 'default' ? null : {side, key: key.slice(side.length + 1), direction: next.direction === 'asc' ? 'ascending' : 'descending'}});
      }
      return;
    }
    const button = event.target.closest('[data-home-comparison-select]');
    if (!button || button.disabled) return;
    const matches = rows.filter(item => item.id === button.dataset.homeComparisonSelect);
    if (matches.length === 1) select(matches[0]);
  }
  useLayoutEffect(() => () => {latest.current = null;}, [context]);
  useLayoutEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(HOME_PHONE_QUERY), resize = () => setPhone(media.matches);
    resize(); media.addEventListener?.('change', resize);
    return () => media.removeEventListener?.('change', resize);
  }, []);
  useLayoutEffect(() => {
    latest.current = context;
    if (settings !== stored || nextSelection !== selected) {
      setSettings({...settings, selection: nextSelection});
      if (nextSelection !== selected || settings !== stored && stored.selection) onSelection?.(nextSelection);
      return;
    }
    onPresentationChange?.(settings);
  }, [context, settings, stored, selected, nextSelection, onSelection, onPresentationChange]);
  useLayoutEffect(() => {
    for (const row of root.current.querySelectorAll('[data-comparison-id]')) {
      const active = row.dataset.comparisonId === selectedRow?.id;
      row.dataset.comparisonSelected = String(active);
      if (row.getAttribute('role') === 'row') row.setAttribute('aria-selected', String(active));
      for (const button of row.querySelectorAll('[data-home-comparison-select]')) button.setAttribute('aria-pressed', String(active));
    }
    for (const button of root.current.querySelectorAll('[data-cdt-sort]')) {
      const [side, field] = button.dataset.cdtSort.split(':');
      if (!field) {
        const active = !metricSort && order === side, person = side === 'yours' ? 'Yours' : friendName;
        button.setAttribute('aria-label', `Sort by ${person} listens: ${active ? ascending ? 'ascending' : 'descending' : 'default order'}. Activate for ${active && !ascending ? 'ascending' : 'descending'} order.`);
        continue;
      }
      const label = metricColumns(kind).find(([key]) => key === field)?.[1];
      const person = side === 'yours' ? 'Yours' : friendName;
      button.setAttribute('aria-label', button.getAttribute('aria-label').replace(`Sort by ${label}:`, `Sort by ${person} ${label}:`));
      button.title = `${person}: ${label}`;
    }
    const pending = sortFocus.current; sortFocus.current = null;
    if (pending?.context !== context) return;
    const document = root.current.ownerDocument, focused = document.activeElement;
    if (focused && focused !== document.body && focused.isConnected) return;
    [...root.current.querySelectorAll('[data-cdt-sort]')].find(button => button.dataset.cdtSort === pending.key)?.focus({preventScroll: true});
  }, [selectedRow, rows, view, html, context, friendName, kind]);
  const ready = value?.status === 'ready' || value?.status === 'empty';
  const viewControl = kind === 'albums' && <ViewControl key={owner.current.epoch} runtime={runtime} kind="albums" context="comparison" value={view} onChange={value => change({view: value})}/>;
  return <section ref={root} className="home-comparison" data-comparison-kind={kind} data-comparison-view={view}
    style={{'--comparison-metric-count': metricColumns(kind).length, '--comparison-play-column': metricColumns(kind).findIndex(([key]) => key === 'play_count') + 1}} aria-label={`Your listening compared with ${friendName}`}>
    <header className="gallery-bar home-comparison__header" aria-label="Comparison controls">
      <ComparisonControls key={owner.current.epoch} runtime={runtime} commonOnly={commonOnly} onCommonOnly={value => change({commonOnly: value})}
        order={order} onOrder={value => change({order: value, ascending: false, metricSort: null})}/>
      {viewControl && !viewControlsHost && <div className="home-comparison__view">{viewControl}</div>}
      {headerControls}
    </header>
    {viewControl && viewControlsHost && createPortal(viewControl, viewControlsHost)}
    {ready && <p className="home-comparison__scope">Filtering and ordering this page only. Common only shows known listens on both sides. PC is personal play count; – means unavailable.</p>}
    {!ready ? <Status runtime={runtime} value={value} label="Taste comparisons" retry={retry}/> : !rows.length
      ? <p className="home-comparison__empty" role="status">{commonOnly ? 'No confirmed shared listens on this page.' : 'No listening activity on this page.'}</p>
      : <><NativeHtml className={`home-comparison__table${covers ? ' home-comparison__table--covers' : ''}`} html={html} onClick={activate}/>
        {covers && <ComparisonCards runtime={runtime} rows={rows} kind={kind} friendName={friendName} onSelect={select}/>}</>}
    <DetailSummary row={selectedRow} kind={kind} friendName={friendName}/>
  </section>;
}
