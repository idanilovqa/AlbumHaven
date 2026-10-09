export const HOME_PHONE_QUERY = '(max-width: 900px)';

// A saved automatic default is not a deliberate tab choice. Older history
// entries predate this distinction and retain their valid saved selection.
export function initialHomeKind(presentation, phone = false) {
  const kindExplicit = ['albums', 'tracks', 'artists'].includes(presentation?.kind)
    && presentation.kindExplicit !== false;
  return {kind: kindExplicit ? presentation.kind : phone ? 'tracks' : 'albums', kindExplicit};
}
