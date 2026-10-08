// Availability and musical identity are independent. Unknown canonical identity
// never erases a readable occurrence whose absence is explicitly confirmed.
export function confirmedMissingRow(row) {
  return Boolean(row && row.source_readable !== false && row.availability === 'missing'
    && !(Object.hasOwn(row.allowed_actions || {}, 'can_read') && row.allowed_actions.can_read !== true));
}
export function hasConfirmedMissingRows(rows) {
  return Array.isArray(rows) && rows.some(confirmedMissingRow);
}
