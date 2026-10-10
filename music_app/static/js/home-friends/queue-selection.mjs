// Presentation descriptors contain occurrence IDs only; the native Queue owner
// separately refreshes every selected source before admitting resource details.
const reference = value => typeof value === 'string' && value.trim().length > 0
  && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
export function queueSelectionIds(ids, snapshot) {
  if (!Array.isArray(ids) || ids.length > 5000 || !ids.every(reference) || new Set(ids).size !== ids.length) return [];
  const rows = snapshot?.entries;
  if (!Array.isArray(rows) || !rows.every(row => reference(row?.id))) return [];
  const counts = new Map();
  for (const row of rows) counts.set(row.id, (counts.get(row.id) || 0) + 1);
  if (ids.some(id => counts.get(id) !== 1)) return [];
  const selected = new Set(ids);
  return rows.filter(row => selected.has(row.id)).map(row => row.id);
}
