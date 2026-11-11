function escapeAlertHtml(value) {
  if (typeof escapeHtml === 'function') return escapeHtml(value);
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

function normalizeAlertSeverity(value) {
  const severity = String(value || '').trim().toLowerCase();
  return ['error', 'warning', 'info', 'success'].includes(severity) ? severity : 'info';
}

function buildAlertIconHtml(severity) {
  const normalized = normalizeAlertSeverity(severity);
  if (normalized === 'info') {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 10.5v6"></path><path d="M12 7.5h.01"></path></svg>';
  }
  if (normalized === 'success') {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="m7 12 3 3 7-7"></path></svg>';
  }
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.3 3.8 2.4 17.5A2 2 0 0 0 4.1 20h15.8a2 2 0 0 0 1.7-2.5L13.7 3.8a2 2 0 0 0-3.4 0Z"></path><path d="M12 9v4"></path><path d="M12 16.5h.01"></path></svg>';
}

function buildSmallAlertAttributes(attributes = {}) {
  if (!attributes || typeof attributes !== 'object') return '';
  return Object.entries(attributes).map(([name, value]) => {
    const allowed = /^(?:aria-label|data-open-musicbrainz-artist-problem)$/.test(name);
    if (!allowed || value == null || value === false) return '';
    return ` ${name}="${escapeAlertHtml(value)}"`;
  }).join('');
}

function buildSmallAlertHtml(config = {}) {
  const severity = normalizeAlertSeverity(config.severity);
  const message = String(config.message || '').trim();
  const className = String(config.className || '').trim();
  const interactive = config.interactive === true;
  // A tone recolors the edge for a domain meaning while preserving the shared alert behavior.
  const tone = ['hoard', 'new_arrivals'].includes(String(config.tone || '')) ? String(config.tone) : '';
  const toneClass = `${tone ? ` small-alert--tone-${tone}` : ''}${config.presentation === 'badge' ? ' small-alert--badge' : ''}`;
  const classes = `small-alert small-alert--${severity}${toneClass}${className ? ` ${escapeAlertHtml(className)}` : ''}`;
  const attributes = buildSmallAlertAttributes(config.attributes);
  const iconHtml = String(config.iconHtml || '') || buildAlertIconHtml(severity);
  const content = `<span class="small-alert__icon">${iconHtml}</span><span class="small-alert__text">${escapeAlertHtml(message)}</span>`;
  if (interactive) {
    return `<button class="${classes}" type="button"${attributes} data-small-alert="${severity}">${content}</button>`;
  }
  const focusable = config.focusable === true ? ' tabindex="0"' : '';
  return `<span class="${classes}" role="status" aria-label="${escapeAlertHtml(message)}" data-small-alert="${severity}"${focusable}>${content}</span>`;
}

function buildAlertLabelAttributes(attributes = {}) {
  if (!attributes || typeof attributes !== 'object') return '';
  return Object.entries(attributes).map(([name, value]) => {
    const allowed = /^(?:id|title|aria-label|data-album-problem-type|data-problem-suggestion-id|data-label-intent|data-problem-exclusion-(?:scope|row-key|reason|row-index))$/.test(name);
    if (!allowed || value == null || value === false) return '';
    return ` ${name}="${escapeAlertHtml(value)}"`;
  }).join('');
}

function buildAlertLabelHtml(config = {}) {
  const severity = normalizeAlertSeverity(config.severity);
  const message = String(config.message || '').trim();
  const interactive = Boolean(config.interactive);
  const pressed = Boolean(config.pressed);
  const disabled = Boolean(config.disabled);
  const className = String(config.className || '').trim();
  const classes = [
    'alert-label',
    `alert-label--${severity}`,
    className,
    interactive && pressed ? 'is-active' : '',
  ].filter(Boolean).join(' ');
  const attributes = buildAlertLabelAttributes(config.attributes);
  if (!interactive) {
    return `<span class="${escapeAlertHtml(classes)}" data-alert-label="${severity}"${attributes}>${escapeAlertHtml(message)}</span>`;
  }
  return `<button class="${escapeAlertHtml(classes)}" data-alert-label="${severity}" type="button"${attributes} aria-pressed="${pressed ? 'true' : 'false'}"${disabled ? ' aria-disabled="true" disabled' : ''}>${escapeAlertHtml(message)}</button>`;
}

// Optional determinate progress below the actions: `{ value: 0-100, label }`.
function buildAlertProgressHtml(progress) {
  if (!progress) return '';
  const value = Math.max(0, Math.min(100, Math.round(Number(progress.value) || 0)));
  const label = escapeAlertHtml(String(progress.label || ''));
  return `<label class="on-page-alert__progress">${label}<progress max="100" value="${value}" aria-label="${label}"></progress></label>`;
}

function buildOnPageAlertHtml(config = {}) {
  const severity = normalizeAlertSeverity(config.severity);
  const title = String(config.title || '').trim();
  const message = String(config.message || '').trim();
  const className = [config.actionsPlacement === 'inline' ? 'on-page-alert--inline-actions' : '', String(config.className || '').trim()]
    .filter(Boolean).join(' ');
  const actionsHtml = String(config.actionsHtml || '');
  const role = config.role === 'status' ? 'status' : 'alert';
  const messageId = config.messageId ? ` id="${escapeAlertHtml(String(config.messageId))}"` : '';
  return `<section class="on-page-alert on-page-alert--${severity}${className ? ` ${escapeAlertHtml(className)}` : ''}" role="${role}" data-on-page-alert="${severity}"><span class="on-page-alert__icon">${buildAlertIconHtml(severity)}</span><div class="on-page-alert__content">${title ? `<strong class="on-page-alert__title">${escapeAlertHtml(title)}</strong>` : ''}<p class="on-page-alert__message"${messageId}>${escapeAlertHtml(message)}</p>${actionsHtml ? `<div class="on-page-alert__actions">${actionsHtml}</div>` : ''}${buildAlertProgressHtml(config.progress)}</div></section>`;
}

// StatusBadge: short, non-interactive state text. Consumers choose only its label and variant;
// anything actionable is a Button or FilterPill instead. This file also loads standalone beside
// the bundle, so it declares functions only.
function buildStatusBadgeHtml(config = {}) {
  const variant = config.variant || 'neutral';
  if (!['neutral', 'info', 'warning'].includes(variant)) throw new TypeError('Unknown StatusBadge variant.');
  return `<span class="ui-status-badge ui-status-badge--${variant}">${escapeAlertHtml(config.label)}</span>`;
}

if (typeof window !== 'undefined') {
  window.AlertComponent = { normalizeAlertSeverity, buildSmallAlertHtml, buildAlertLabelHtml, buildOnPageAlertHtml, buildStatusBadgeHtml };
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { normalizeAlertSeverity, buildSmallAlertHtml, buildAlertLabelHtml, buildOnPageAlertHtml, buildStatusBadgeHtml };
}

function toggleSmallAlertBadge(event) {
  if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
  const badge = event.target?.closest?.('.small-alert--badge');
  document.querySelectorAll('.small-alert--badge.is-expanded').forEach((node) => { if (node !== badge) node.classList.remove('is-expanded'); });
  if (!badge || badge.closest('[data-badges-fixed]')) return;
  if (event.type === 'keydown') event.preventDefault();
  badge.classList.toggle('is-expanded');
}
if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('click', toggleSmallAlertBadge);
  document.addEventListener('keydown', toggleSmallAlertBadge);
}
