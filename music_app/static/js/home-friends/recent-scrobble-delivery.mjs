// Snapshot presentation is advisory. Only the server can authorize a send.
const stepsByState = Object.freeze({
  not_eligible: ['none'],
  unknown: ['none'],
  accepted: ['none'],
  delivery_unconfirmed: ['none', 'check_delivery', 'check_connection'],
  not_sent: ['none', 'retry_check', 'check_connection'],
  reauthentication_required: ['none', 'reauthenticate', 'check_connection'],
  rejected: ['none', 'review_failure', 'check_connection'],
  retry_exhausted: ['none', 'review_failure', 'check_connection'],
});
export function normalizeRecentScrobbleDelivery(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 3
    || !['state', 'next_step', 'show_status'].every(key => Object.hasOwn(value, key))
    || typeof value.state !== 'string' || !Object.hasOwn(stepsByState, value.state)
    || !stepsByState[value.state].includes(value.next_step)
    || typeof value.show_status !== 'boolean'
    || value.show_status === false && value.next_step !== 'none') return null;
  return Object.freeze({state: value.state, next_step: value.next_step, show_status: value.show_status});
}
const labels = Object.freeze({
  not_eligible: ['close', 'This play is not eligible for Last.fm scrobbling.'],
  unknown: ['more', 'Last.fm delivery status is unknown.'],
  accepted: ['complete', 'Last.fm accepted this play.'],
  delivery_unconfirmed: ['more', 'Last.fm delivery is unconfirmed. This does not mean the play was not sent.'],
  not_sent: ['close', 'This play was not sent to Last.fm.'],
  reauthentication_required: ['tools', 'This play was not sent to Last.fm; sign-in is required.'],
  rejected: ['close', 'This play was not sent to Last.fm; retry is not permitted by the stored result.'],
  retry_exhausted: ['close', 'This play was not sent to Last.fm; the retry limit was reached.'],
});
const hints = Object.freeze({
  none: '',
  check_delivery: ' Check delivery before considering another submission.',
  reauthenticate: ' Reconnect Last.fm before checking retry eligibility.',
  retry_check: ' Retry eligibility needs a fresh check.',
  review_failure: ' Review the failure before considering another submission.',
  check_connection: ' Last.fm connection readiness could not be established for this snapshot.',
});
export function recentScrobbleDeliveryHtml(runtime, row, context) {
  if (context?.account_ref !== null || context.kind !== 'listens'
    || row?.kind !== 'listen' || row.source_readable !== true) return '';
  const delivery = normalizeRecentScrobbleDelivery(row.scrobble_delivery);
  if (!delivery?.show_status) return '';
  const [icon, description] = labels[delivery.state];
  const label = runtime.escapeHtml('At this history snapshot: ' + description + hints[delivery.next_step]);
  return `<span data-recent-scrobble-delivery="${delivery.state}" role="img" aria-label="${label}" title="${label}">${runtime.iconHtml(icon)}</span>`;
}

export function canOfferRecentScrobbleRetry(runtime, row, context) {
  const delivery = normalizeRecentScrobbleDelivery(row?.scrobble_delivery);
  if (context?.account_ref !== null || context.kind !== 'listens' || row?.kind !== 'listen'
    || row.source_readable !== true || delivery?.show_status !== true
    || delivery.state !== 'not_sent' || delivery.next_step !== 'retry_check'
    || typeof runtime.retryRecentScrobble !== 'function' || typeof runtime.canRetryRecentScrobble !== 'function') return false;
  try {return runtime.canRetryRecentScrobble(row, context) === true;} catch {return false;}
}
export function recentScrobbleRetryHtml(runtime, row, context) {
  if (!canOfferRecentScrobbleRetry(runtime, row, context)) return '';
  return runtime.actionHtml({icon: 'tools', ariaLabel: 'Send this play to Last.fm',
    title: 'Check current eligibility and send this play to Last.fm', presentation: 'bare',
    attributes: {'data-recent-scrobble-retry': 'true'}});
}
