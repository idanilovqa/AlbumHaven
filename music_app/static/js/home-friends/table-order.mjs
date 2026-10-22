/** View ordering only. Callers keep the authoritative rows and action identities. */
export function cycleTableSort(current, key) {
  if (current?.key !== key || !['asc', 'desc'].includes(current?.direction)) return {key, direction: 'asc'};
  return current.direction === 'asc' ? {key, direction: 'desc'} : {key: null, direction: 'default'};
}

const textOrder = new Intl.Collator(undefined, {numeric: true, sensitivity: 'base'});
function sortValue(value, type) {
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value) ? value : null;
  if (type === 'boolean') return typeof value === 'boolean' ? Number(value) : null;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Columns explicitly declare {getValue, type: 'number' | 'text' | 'boolean'}. */
export function sortTableRows(rows, sort, columns) {
  const copy = Array.from(rows || []);
  if (!['asc', 'desc'].includes(sort?.direction)) return copy;
  const column = Object.hasOwn(columns || {}, sort.key) ? columns[sort.key] : null;
  if (!column || typeof column.getValue !== 'function'
    || !['number', 'text', 'boolean'].includes(column.type)) return copy;
  const direction = sort.direction === 'desc' ? -1 : 1;
  return copy.map((row, index) => ({row, index, value: sortValue(column.getValue(row), column.type)}))
    .sort((left, right) => {
      // Unknown stays last in either direction. Zero and false remain known values.
      if (left.value === null || right.value === null) {
        return left.value === right.value ? left.index - right.index : left.value === null ? 1 : -1;
      }
      const compared = column.type === 'text' ? textOrder.compare(left.value, right.value)
        : left.value < right.value ? -1 : left.value > right.value ? 1 : 0;
      return compared * direction || left.index - right.index;
    }).map(({row}) => row);
}
