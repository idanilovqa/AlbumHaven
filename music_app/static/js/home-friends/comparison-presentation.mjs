import {metric} from './model.mjs';
import {sortTableRows} from './table-order.mjs';

export const comparisonOrders = Object.freeze([
  ['general', 'General'], ['yours', 'Yours first'], ['friend', 'Friend first'],
]);
const kinds = {albums: 'album', tracks: 'track', artists: 'artist'};
const known = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const presentationRef = value => typeof value === 'string' && value.trim() && value.length <= 512 && !/[\x00-\x1f\x7f]/.test(value);

function restoreMetricSort(value, kind) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(kinds, kind)
    || !['side', 'key', 'direction'].every(key => Object.hasOwn(value, key))
    || !['yours', 'friend'].includes(value.side) || !['ascending', 'descending'].includes(value.direction)
    || !(['listen_count', 'play_count'].includes(value.key)
      || value.key === 'full_listen_count' && kind === 'albums'
      || value.key === 'rating' && kind !== 'artists')) return null;
  return {side: value.side, key: value.key, direction: value.direction};
}

export function restoreComparisonPresentation(value, {friendRef = '', kind = 'tracks', period = 'week'} = {}) {
  const saved = value?.friendRef === friendRef && value?.kind === kind && value?.period === period ? value : null;
  return {friendRef, kind, period,
    commonOnly: typeof saved?.commonOnly === 'boolean' ? saved.commonOnly : true,
    order: comparisonOrders.some(([key]) => key === saved?.order) ? saved.order : 'general',
    ascending: saved?.ascending === true, view: saved?.view === 'covers' ? 'covers' : 'rows',
    ...(Object.hasOwn(value || {}, 'metricSort') ? {metricSort: restoreMetricSort(saved?.metricSort, kind)} : {}),
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
export function projectComparisonRows(rows, kind, {commonOnly = true, order = 'general', ascending = false, metricSort = null} = {}) {
  const sort = restoreMetricSort(metricSort, kind);
  const score = row => {
    const yours = row.yours?.listen_count, friend = row.friend?.listen_count;
    if (order === 'yours') return known(yours) ? yours : null;
    if (order === 'friend') return known(friend) ? friend : null;
    return known(yours) && known(friend) && Number.isFinite(yours + friend) ? yours + friend : null;
  };
  const baseline = rows.filter(row => row.kind === kinds[kind] && (!commonOnly
    || (known(row.yours?.listen_count) && row.yours.listen_count > 0
      && known(row.friend?.listen_count) && row.friend.listen_count > 0)))
    .sort((left, right) => {
      const a = score(left), b = score(right);
      // Unknown values stay last in both directions; zero is a known value.
      if ((a === null) !== (b === null)) return a === null ? 1 : -1;
      return (a === null ? 0 : (ascending ? 1 : -1) * (a - b))
        || compareText(left.title, right.title) || compareText(left.id, right.id);
    });
  if (!sort) return baseline;
  // The shared stable sort keeps the baseline for metric ties. Both passes move
  // complete joined pairs; the sides never receive independent row orders.
  return sortTableRows(baseline, {key: sort.key, direction: sort.direction === 'ascending' ? 'asc' : 'desc'}, {
    [sort.key]: {type: 'number', getValue: row => {
      const value = row[sort.side]?.[sort.key];
      return known(value) ? value : null;
    }},
  });
}

export function comparisonRelation(left, right) {
  if (!known(left) || !known(right)) return null;
  return left < right ? {symbol: '<', spoken: 'less than'}
    : left > right ? {symbol: '>', spoken: 'greater than'} : {symbol: '=', spoken: 'equal to'};
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
