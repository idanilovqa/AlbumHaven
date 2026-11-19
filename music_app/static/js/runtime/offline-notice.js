// OfflineNotice (owner-approved v003, unreachable server state): plain text with a muted crossed-out
// cloud, no box, border or tint. `block` puts a large cloud above one centered line (a view that
// cannot load), `line` a small cloud before the line (the end of a kept gallery, the kept-library
// notice), and `text` is the line alone beside an AlbumArtbox showing the same cloud. The Jinja
// renderer is components/offline-notice.html; both share css/runtime/offline-notice.css.
const OFFLINE_NOTICE_VARIANTS = new Set(['block', 'line', 'text']);

function buildOfflineCloudHtml() {
  return '<svg viewBox="0 0 96 96" aria-hidden="true"><path d="M30 66h38a14 14 0 0 0 2-27.9A20 20 0 0 0 31.4 36 15 15 0 0 0 30 66Z"></path><path d="M22 22 74 74"></path></svg>';
}

function buildOfflineNoticeHtml(config = {}) {
  const variant = OFFLINE_NOTICE_VARIANTS.has(config.variant) ? config.variant : 'line';
  const cloud = variant === 'text' ? '' : `<span class="offline-notice__cloud">${buildOfflineCloudHtml()}</span>`;
  return `<div class="offline-notice offline-notice--${variant}" role="status" data-offline-notice="${variant}">${cloud}<p class="offline-notice__text">${escapeHtml(String(config.message || ''))}</p></div>`;
}
