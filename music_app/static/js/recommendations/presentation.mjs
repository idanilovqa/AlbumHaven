// Attribution is display metadata, never a grant to a profile or music resource.
const accountRef = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
export function normalizeRecommenders(value) {
  if (!Array.isArray(value) || value.length > 1000) return [];
  const seen = new Set();
  return value.flatMap(person => {
    if (!person || typeof person.display_name !== 'string' || !person.display_name.trim()
      || person.display_name.length > 200 || /[\x00-\x1f\x7f]/.test(person.display_name)) return [];
    const ref = accountRef(person.account_ref) ? person.account_ref : null;
    const name = person.display_name.trim(), key = ref ? `account:${ref}` : `name:${name.normalize('NFC').toLocaleLowerCase('en-US')}`;
    if (seen.has(key)) return [];
    seen.add(key); return [{display_name: name, account_ref: ref}];
  });
}
export function recommendationSummary(value) {
  const people = normalizeRecommenders(value);
  return !people.length ? '' : `Recommended by: ${people.length === 1 ? people[0].display_name : people.length < 4 ? 'a few' : 'many'}`;
}
export function recommenderListHtml(value, escape) {
  return normalizeRecommenders(value).map(person => person.account_ref
    ? `<a href="/?surface=home&amp;home_section=friends&amp;home_profile=${person.account_ref}">${escape(person.display_name)}</a>`
    : escape(person.display_name)).join(', ');
}
const revisionRef = value => typeof value === 'string' && /^[1-9]\d{0,18}$/.test(value)
  && (value.length < 19 || value <= '9223372036854775807');
export function recommendationResource(kind, resourceRef, source) {
  if (kind === 'track' && typeof resourceRef === 'string' && resourceRef.startsWith('playlist-item:')
    && accountRef(resourceRef.slice(14)) && accountRef(source?.playlist_ref) && revisionRef(source?.revision))
    return {kind, resource_ref: resourceRef, source: {playlist_ref: source.playlist_ref, revision: source.revision}};
  if (kind === 'album' && typeof resourceRef === 'string' && resourceRef.startsWith('catalog-album:')
    && accountRef(resourceRef.slice(14)) && accountRef(source?.top_ref) && accountRef(source?.item_ref)
    && typeof source?.revision === 'string' && /^[1-9]\d{0,18}$/.test(source.revision))
    return {kind,resource_ref:resourceRef,source:{top_ref:source.top_ref,item_ref:source.item_ref,revision:source.revision}};
  if (!['track', 'album'].includes(kind) || typeof resourceRef !== 'string') return null;
  const match = /^inventory-(track|album):([1-9]\d{0,18}):([1-9]\d{0,18})$/.exec(resourceRef);
  if (!match || match[1] !== kind || match.slice(2).some(part => part.length === 19 && part > '9223372036854775807')) return null;
  return {kind, resource_ref: resourceRef};
}
export function sameRecommendationResource(left, right) {
  const normalize = value => value && recommendationResource(value.kind, value.resource_ref, value.source);
  const first = normalize(left), second = normalize(right);
  return Boolean(first && second && JSON.stringify(first) === JSON.stringify(second));
}
export function singleRecommendedTrack(packet, lifetime, adapter) {
  if (!lifetime?.isCurrent?.() || packet?.row_keys?.length !== 1) return null;
  const before = adapter?.snapshot?.();
  if (!before || before.scopeKey !== packet.scopeKey) return null;
  const dedicated = typeof adapter.resolveRecommendationRows === 'function';
  const selected = dedicated ? adapter.resolveRecommendationRows(packet.row_keys) : adapter.resolveRows?.(packet.row_keys);
  const after = adapter.snapshot?.();
  if (!lifetime.isCurrent() || selected?.rows?.length !== 1 || !after
    || after.scopeKey !== before.scopeKey || after.instance !== before.instance || after.revision !== before.revision) return null;
  const row = selected.rows[0];
  return dedicated ? row?.kind === 'track' ? recommendationResource(row.kind, row.resource_ref, row.source) : null
    : recommendationResource('track', row.track_ref);
}

export function manualRecommenderName(value) {
  if (typeof value !== 'string') return null;
  const name=value.trim().normalize('NFC');
  return name && [...name].length <= 100 && !/[\p{Cc}\p{Cs}\u202a-\u202e\u2066-\u2069]/u.test(name) ? name : null;
}
