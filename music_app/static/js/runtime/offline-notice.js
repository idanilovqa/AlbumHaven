// OfflineNotice (owner-approved v004, unreachable server state): plain text with a muted crossed-out
// cloud, no box, border or tint. `line` is one line with the small cloud before it, both on one
// centerline (the end of a kept gallery, the kept-library notice). `message` is centered: the small
// cloud and a bold, larger title on one centerline, then the detail in muted text (Album Details and
// a gallery view that cannot load). The Jinja renderer is components/offline-notice.html; both share
// css/runtime/offline-notice.css.
const OFFLINE_NOTICE_VARIANTS = new Set(['line', 'message']);

function buildOfflineCloudHtml() {
  return '<svg viewBox="0 0 96 96" aria-hidden="true"><path d="M30 66h38a14 14 0 0 0 2-27.9A20 20 0 0 0 31.4 36 15 15 0 0 0 30 66Z"></path><path d="M22 22 74 74"></path></svg>';
}

// [message] is the line, or the detail under [title] for `message`.
function buildOfflineNoticeHtml(config = {}) {
  const variant = OFFLINE_NOTICE_VARIANTS.has(config.variant) ? config.variant : 'line';
  const cloud = `<span class="offline-notice__cloud">${buildOfflineCloudHtml()}</span>`;
  const text = `<p class="offline-notice__text">${escapeHtml(String(config.message || ''))}</p>`;
  const body = variant === 'message'
    ? `<p class="offline-notice__title">${cloud}${escapeHtml(String(config.title || ''))}</p>${text}`
    : `${cloud}${text}`;
  return `<div class="offline-notice offline-notice--${variant}" role="status" data-offline-notice="${variant}">${body}</div>`;
}
