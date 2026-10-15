import {mountButton, mountChoice, mountStatus} from './native-controls.mjs';
import {mountViewControl} from './view-control.mjs';
import {metric, ratingMetricHtml, safeServerArtworkUrl} from './model.mjs';
import {cycleTableSort} from './table-order.mjs';
import {HOME_PHONE_QUERY} from './presentation.mjs';
import {comparisonOrders, comparisonFacts, comparisonSelection, comparisonRelation,
  projectComparisonRows, restoreComparisonPresentation, reconcileComparisonSelection} from './comparison-presentation.mjs';
export {comparisonOrders, comparisonFacts, comparisonSelection, comparisonRelation,
  projectComparisonRows, restoreComparisonPresentation, reconcileComparisonSelection} from './comparison-presentation.mjs';
const EMPTY_ROWS = Object.freeze([]);
const metricColumns = kind => comparisonFacts(null, kind).filter(([key]) => key !== 'favorite');
const columnKey = (side, key) => `${side}:${key}`;
function tableSort({order = 'general', ascending = false, metricSort = null} = {}) {
  return metricSort ? {key: columnKey(metricSort.side, metricSort.key), direction: metricSort.direction === 'ascending' ? 'asc' : 'desc'}
    : {key: order === 'general' ? null : order, direction: ascending ? 'asc' : 'desc'};
}
function node(host, tag, className, text) {const element = host.ownerDocument.createElement(tag); if (className) element.className = className; if (text !== undefined) element.textContent = text; host.append(element); return element;}

export function mountComparisonControls(host, runtime, initial) {
  let props = initial, disposed = false, choice;
  const root = node(host, 'div', 'home-comparison__controls'); root.setAttribute('role', 'group'); root.setAttribute('aria-label', 'Comparison filters and order');
  const label = node(root, 'label', 'selection-accent-toggle home-comparison__common'), input = node(label, 'input'); input.type = 'checkbox'; node(label, 'span', '', 'Common only');
  const choiceHost = node(root, 'span');
  const change = () => {if (!disposed) props.onCommonOnly?.(input.checked);};
  function choiceProps() {return {className: 'home-comparison__order', label: 'Comparison order', showLabel: false, options: comparisonOrders, value: props.order, onChange: value => {if (!disposed) props.onOrder?.(value);}};}
  function dispose() {
    if (disposed) return; disposed = true; input.removeEventListener('change', change);
    try {choice?.dispose();} finally {root.remove();}
  }
  function update(next) {if (!disposed) {try {props = next; input.checked = !!props.commonOnly; choice.update(choiceProps());} catch (error) {try {dispose();} catch {} throw error;}}}
  try {choice = mountChoice(choiceHost, runtime, choiceProps()); input.addEventListener('change', change); update(initial);}
  catch (error) {try {dispose();} catch {} throw error;}
  return {element: host, update, dispose};
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
  if (key === 'rating' && row[side]?.rating === null && row[side]?.taste_state === 'available') {
    return ratingMetricHtml(runtime, row[side], row.kind);
  }
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
export function mountComparisonCards(host, runtime, initial) {
  let props = initial, disposed = false, hovered = null, focused = null, previousRows = null;
  const root = node(host, 'div', 'home-comparison__cards'), announcement = node(root, 'span', 'sr-only');
  announcement.setAttribute('role', 'status'); announcement.setAttribute('aria-live', 'polite'); announcement.setAttribute('aria-atomic', 'true');
  const pairs = new Map();
  function highlight() {
    if (disposed) return;
    const active = focused || hovered, row = props.rows.find(row => row.id === focused?.id), counterpart = focused?.side === 'yours' ? 'friend' : 'yours';
    announcement.textContent = row ? `${counterpart === 'yours' ? 'Yours' : props.friendName || 'Friend'}, matching album: ${row.title}. ${comparisonFacts(row[counterpart], props.kind || 'albums').map(([, label, value]) => `${label}: ${value === '–' ? 'unavailable' : value}`).join('. ')}` : '';
    for (const [id, pair] of pairs) for (const [side, owner] of pair.sides) {
      if (active?.id === id && active.side !== side) owner.element.setAttribute('data-comparison-highlighted', 'true'); else owner.element.removeAttribute('data-comparison-highlighted');
    }
  }
  function release(pair) {
    const owners = [...pair.sides.values()]; pair.sides.clear(); let failure;
    const clean = callback => {try {callback();} catch (error) {failure ??= error;}};
    for (const owner of owners) {for (const [type, callback, capture] of owner.listeners) clean(() => owner.element.removeEventListener(type, callback, capture)); clean(() => owner.button?.dispose());}
    clean(() => pair.element.remove()); if (failure) throw failure;
  }
  function dispose() {
    if (disposed) return; disposed = true; const previous = [...pairs.values()]; pairs.clear(); let failure;
    for (const pair of previous) {try {release(pair);} catch (error) {failure ??= error;}} root.remove(); if (failure) throw failure;
  }
  function update(next) {
    if (disposed) return; props = next;
    try {
    const {rows, kind = 'albums', friendName = 'Friend'} = props;
    if (rows !== previousRows) {hovered = focused = null; previousRows = rows;}
    const keep = new Set(rows.map(row => row.id)); for (const [id, pair] of pairs) if (!keep.has(id)) {pairs.delete(id); release(pair); if (disposed) return;}
    for (const [index, row] of rows.entries()) {
      let pair = pairs.get(row.id);
      if (!pair) {
        const element = node(root, 'div', 'home-comparison__pair'); element.dataset.comparisonId = row.id; pair = {element, sides: new Map()}; pairs.set(row.id, pair);
        for (const side of ['yours', 'friend']) {
          const section = node(element, 'section', 'home-comparison__card-side'); section.dataset.comparisonSide = side;
          const title = node(section, 'h3', 'home-comparison__person'), artwork = node(section, 'div'), buttonHost = node(section, 'span');
          const listeners = [['mouseenter', () => {hovered = {id: row.id, side}; highlight();}, false], ['mouseleave', () => {hovered = null; highlight();}, false],
            ['focus', () => {focused = {id: row.id, side}; highlight();}, true], ['blur', event => {if (!section.contains(event.relatedTarget)) {focused = null; highlight();}}, true]];
          const owner = {element: section, title, artwork, button: null, listeners}; pair.sides.set(side, owner);
          for (const [type, callback, capture] of listeners) section.addEventListener(type, callback, capture);
          const button = mountButton(buttonHost, runtime, {label: 'Details'});
          if (disposed) {button.dispose(); return;} owner.button = button;
        }
      }
      for (const [side, owner] of pair.sides) {
        owner.element.setAttribute('aria-label', `${side === 'yours' ? 'Yours' : friendName}: ${row.title || 'Untitled album'}`); owner.title.textContent = side === 'yours' ? 'Yours' : friendName;
        const html = runtime.galleryCardHtml({identity: `${side}:${row.id}`, interaction: 'none', displayMode: 'cards', title: row.title, artist: row.artist, artboxHtml: artworkHtml(runtime, row), listeningSummaryHtml: cardFactsHtml(runtime, row, side, kind, friendName)});
        if (disposed) return; if (owner.artwork.innerHTML !== html) owner.artwork.innerHTML = html;
        owner.button.update({label: 'Details', size: 'small', ariaLabel: `Show comparison details: ${row.title || row.kind}`, attributes: {'data-home-comparison-select': row.id, 'data-comparison-side': side, 'aria-pressed': 'false'}, onClick: () => {
          if (!disposed) {const current = props.rows.find(candidate => candidate.id === row.id && candidate.kind === row.kind); if (current) props.onSelect?.(current);}
        }}); if (disposed) return;
      }
      const at = root.children[index + 1]; if (at !== pair.element) root.insertBefore(pair.element, at || null);
    }
    highlight();
    } catch (error) {try {dispose();} catch {} throw error;}
  }
  update(initial); return {element: host, update, dispose};
}

function mountDetailSummary(host, runtime, initial) {
  const root = node(host, 'section', 'home-comparison__details'); root.setAttribute('aria-label', 'Selected comparison details'); root.setAttribute('aria-live', 'polite');
  let disposed = false, previousRow, previousKind, previousName;
  const last = side => typeof side?.last_listened_at === 'string' && Number.isFinite(Date.parse(side.last_listened_at)) ? new Date(side.last_listened_at).toLocaleString() : '–';
  function update({row, kind, friendName}) {
    if (disposed) return; root.hidden = !row;
    if (row === previousRow && kind === previousKind && friendName === previousName) return;
    previousRow = row; previousKind = kind; previousName = friendName; root.replaceChildren(); if (!row) return;
    node(root, 'h3', '', row.title || `Untitled ${row.kind}`); if (row.artist && kind !== 'artists') node(root, 'p', '', row.artist);
    const pair = node(root, 'div', 'home-comparison__detail-pair');
    for (const side of ['yours', 'friend']) {
      const person = node(pair, 'div'); node(person, 'h4', '', side === 'yours' ? 'Yours' : friendName); const facts = node(person, 'dl');
      for (const [key, name, value] of comparisonFacts(row[side], kind)) {
        const fact = node(facts, 'div'); node(fact, 'dt', '', name === 'PC' ? 'Personal play count' : name); const detail = node(fact, 'dd');
        if (key === 'rating') {const html = ratingMetricHtml(runtime, row[side], row.kind); if (disposed) return; node(detail, 'div').innerHTML = html;} else detail.textContent = value;
      }
      const recent = node(facts, 'div'); node(recent, 'dt', '', 'Last listened'); node(recent, 'dd', '', last(row[side]));
    }
  }
  function dispose() {if (!disposed) {disposed = true; root.remove();}}
  try {update(initial);} catch (error) {dispose(); throw error;}
  return {element: host, update, dispose};
}

export function mountComparisonPanel(host, runtime, initial) {
  const normalize = value => ({friendName: 'Friend', friendRef: '', kind: 'tracks', period: 'week', ...value});
  let props = normalize(initial), disposed = false, epoch = 0, rendering = false, pending = false;
  let settings = restoreComparisonPresentation(props.presentation, props), published = null, publishedEpoch = -1, projected = null, rows = EMPTY_ROWS;
  let controls = null, controlsEpoch = -1, viewControl = null, viewEpoch = -1, viewHost = null, cards = null, sortFocus = null, headerNode = null;
  const root = node(host, 'section', 'home-comparison'), header = node(root, 'header', 'gallery-bar home-comparison__header'); header.setAttribute('aria-label', 'Comparison controls');
  const controlsHost = node(header, 'div'), localViewHost = node(header, 'div', 'home-comparison__view'), headerControlsHost = node(header, 'div');
  const scopeNote = node(root, 'p', 'home-comparison__scope', 'Filtering and ordering this page only. Common only shows known listens on both sides. PC is personal play count; – means unavailable.');
  const statusHost = node(root, 'div'), empty = node(root, 'p', 'home-comparison__empty'); empty.setAttribute('role', 'status');
  const tableHost = node(root, 'div', 'home-comparison__table'), cardsHost = node(root, 'div'), detailHost = node(root, 'div');
  let status, detail;
  const media = host.ownerDocument.defaultView?.matchMedia?.(HOME_PHONE_QUERY); let phone = media?.matches === true;
  const resize = () => {if (!disposed) {phone = media.matches; render();}};
  const acquired = new Set(), retired = Symbol('retired comparison');
  const check = token => {if (disposed || token !== epoch) throw retired;};
  function acquire(owner, token = epoch) {if (disposed || token !== epoch) {try {owner?.dispose();} finally {throw retired;}} acquired.add(owner); return owner;}
  function release(owner) {if (owner && acquired.delete(owner)) owner.dispose();}
  function dispose() {
    if (disposed) return; disposed = true; epoch++; pending = false;
    let failure; const clean = callback => {try {callback();} catch (error) {failure ??= error;}};
    clean(() => media?.removeEventListener?.('change', resize)); clean(() => tableHost.removeEventListener('click', activate));
    for (const owner of [...acquired].reverse()) clean(() => release(owner));
    clean(() => {if (headerNode?.parentNode === headerControlsHost) headerNode.remove();}); clean(() => root.remove());
    if (failure) throw failure;
  }
  const current = token => !disposed && token === epoch && root.isConnected;
  function change(values, token = epoch) {
    if (!current(token)) return false;
    props.onUserIntent?.(); if (!current(token)) return false;
    settings = {...settings, ...values}; render(); return current(token);
  }
  function select(row, token = epoch) {
    if (!current(token) || props.value?.status !== 'ready' || !rows.includes(row)) return;
    const selection = comparisonSelection(row); if (change({selection}, token) && current(token)) props.onSelection?.(selection);
  }
  function activate(event) {
    const token = epoch;
    if (!current(token) || event.defaultPrevented || !tableHost.contains(event.target)) return;
    const heading = event.target.closest?.('[data-cdt-sort]');
    if (heading && !heading.disabled) {
      const key = heading.dataset.cdtSort, side = ['yours', 'friend'].find(side => key === side || metricColumns(props.kind).some(([field]) => key === columnKey(side, field)));
      if (!side) return; event.preventDefault(); event.stopPropagation(); sortFocus = {key, epoch: token};
      if (key === side) change({order: side, ascending: !settings.metricSort && settings.order === side ? !settings.ascending : false, metricSort: null}, token);
      else {const next = cycleTableSort(tableSort(settings), key); change({metricSort: next.direction === 'default' ? null : {side, key: key.slice(side.length + 1), direction: next.direction === 'asc' ? 'ascending' : 'descending'}}, token);}
      return;
    }
    const button = event.target.closest?.('[data-home-comparison-select]'); if (!button || button.disabled) return;
    const matches = rows.filter(row => row.id === button.dataset.homeComparisonSelect); if (matches.length === 1) select(matches[0], token);
  }
  function project() {
    const source = props.value?.status === 'ready' ? props.value.data?.rows || EMPTY_ROWS : EMPTY_ROWS;
    const key = [source, props.kind, settings.commonOnly, settings.order, settings.ascending, settings.metricSort];
    if (!projected || key.some((value, index) => projected[index] !== value)) {projected = key; rows = projectComparisonRows(source, props.kind, settings);}
  }
  function render() {
    if (disposed) return; if (rendering) {pending = true; return;} rendering = true;
    try {do {
      pending = false; const token = epoch, {friendName, kind} = props;
      let selectionChanged = false;
      if (settings.friendRef !== props.friendRef || settings.kind !== kind || settings.period !== props.period) {
        const hadSelection = settings.selection; settings = restoreComparisonPresentation(props.presentation, props); selectionChanged = !!hadSelection;
      }
      project(); const reconciled = reconcileComparisonSelection(settings.selection, props.value?.status, rows);
      if (reconciled !== settings.selection) {settings = {...settings, selection: reconciled}; selectionChanged = true;}
      const selectedRow = rows.find(row => row.id === settings.selection?.id && row.kind === settings.selection.kind) || null;
      const {commonOnly, order, ascending, view, metricSort} = settings, covers = kind === 'albums' && view === 'covers' && !phone;
      root.dataset.comparisonKind = kind; root.dataset.comparisonView = view; root.setAttribute('aria-label', `Your listening compared with ${friendName}`);
      root.style.setProperty('--comparison-metric-count', String(metricColumns(kind).length)); root.style.setProperty('--comparison-play-column', String(metricColumns(kind).findIndex(([key]) => key === 'play_count') + 1));
      const controlProps = {commonOnly, order, onCommonOnly: value => change({commonOnly: value}, token), onOrder: value => change({order: value, ascending: false, metricSort: null}, token)};
      if (!controls || controlsEpoch !== token) {release(controls); controls = null; check(token); controls = acquire(mountComparisonControls(controlsHost, runtime, controlProps), token); controlsEpoch = token;} else controls.update(controlProps); check(token);
      const desiredViewHost = kind === 'albums' ? props.viewControlsHost || localViewHost : null;
      if (desiredViewHost !== viewHost || viewEpoch !== token) {release(viewControl); viewControl = null; check(token); viewHost = desiredViewHost; viewEpoch = token;}
      localViewHost.hidden = kind !== 'albums' || Boolean(props.viewControlsHost);
      if (viewHost) {
        const viewProps = {kind: 'albums', context: 'comparison', value: view, isCurrent: () => current(token), onChange: value => change({view: value}, token)};
        if (!viewControl) viewControl = acquire(mountViewControl(viewHost, runtime, viewProps), token); else viewControl.update(viewProps); check(token);
      }
      if (headerNode !== props.headerControls) {if (headerNode?.parentNode === headerControlsHost) headerNode.remove(); headerNode = props.headerControls || null;}
      if (headerNode && headerNode.parentNode !== headerControlsHost) headerControlsHost.append(headerNode); headerControlsHost.hidden = !headerNode;
      const ready = props.value?.status === 'ready' || props.value?.status === 'empty'; scopeNote.hidden = !ready;
      status.update({value: props.value, label: 'Taste comparisons', retry: props.retry}); check(token); statusHost.hidden = ready; empty.hidden = !ready || rows.length !== 0; empty.textContent = commonOnly ? 'No confirmed shared listens on this page.' : 'No listening activity on this page.';
      tableHost.hidden = !ready || !rows.length; tableHost.className = `home-comparison__table${covers ? ' home-comparison__table--covers' : ''}`;
      const html = tableHost.hidden ? '' : comparisonTableHtml(runtime, covers ? EMPTY_ROWS : rows, kind, friendName, {order, ascending, metricSort, phone});
      check(token); if (tableHost.innerHTML !== html) tableHost.innerHTML = html;
      if (ready && rows.length && covers) {
        const cardProps = {rows, kind, friendName, onSelect: row => select(row, token)}; if (!cards) cards = acquire(mountComparisonCards(cardsHost, runtime, cardProps), token); else cards.update(cardProps); check(token);
      } else {release(cards); cards = null;}
      check(token); detail.update({row: selectedRow, kind, friendName}); check(token);
      for (const row of root.querySelectorAll('[data-comparison-id]')) {
        const active = row.dataset.comparisonId === selectedRow?.id; row.dataset.comparisonSelected = String(active); if (row.getAttribute('role') === 'row') row.setAttribute('aria-selected', String(active));
        for (const button of row.querySelectorAll('[data-home-comparison-select]')) button.setAttribute('aria-pressed', String(active));
      }
      for (const button of root.querySelectorAll('[data-cdt-sort]')) {
        const [side, field] = button.dataset.cdtSort.split(':'), person = side === 'yours' ? 'Yours' : friendName;
        if (!field) {const active = !metricSort && order === side; button.setAttribute('aria-label', `Sort by ${person} listens: ${active ? ascending ? 'ascending' : 'descending' : 'default order'}. Activate for ${active && !ascending ? 'ascending' : 'descending'} order.`);}
        else {const label = metricColumns(kind).find(([key]) => key === field)?.[1]; button.setAttribute('aria-label', (button.getAttribute('aria-label') || '').replace(`Sort by ${label}:`, `Sort by ${person} ${label}:`)); button.title = `${person}: ${label}`;}
      }
      const focus = sortFocus; sortFocus = null;
      if (focus?.epoch === token) {const document = root.ownerDocument, focused = document.activeElement;
        if (!focused || focused === document.body || !focused.isConnected) [...root.querySelectorAll('[data-cdt-sort]')].find(button => button.dataset.cdtSort === focus.key)?.focus({preventScroll: true});}
      check(token); if (selectionChanged) {props.onSelection?.(settings.selection); check(token);}
      if (!disposed && token === epoch && (published !== settings || publishedEpoch !== token)) {published = settings; publishedEpoch = token; props.onPresentationChange?.(settings);}
    } while (!disposed && pending);} catch (error) {if (error !== retired) {try {dispose();} catch {} throw error;}} finally {rendering = false; if (!disposed && pending) queueMicrotask(render);}
  }
  function update(next) {
    if (disposed) return; const incoming = normalize(next);
    if (['value', 'friendRef', 'kind', 'period'].some(key => props[key] !== incoming[key])) epoch++;
    props = incoming; render();
  }
  try {
    status = acquire(mountStatus(statusHost, runtime, {label: 'Taste comparisons'})); detail = acquire(mountDetailSummary(detailHost, runtime, {}));
    media?.addEventListener?.('change', resize); tableHost.addEventListener('click', activate); render();
  } catch (error) {try {dispose();} catch {} if (error !== retired) throw error;}
  return {element: host, update, dispose};
}
