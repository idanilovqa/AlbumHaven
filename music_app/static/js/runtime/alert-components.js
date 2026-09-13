function normalizeAlertSeverity(value) {
  const severity = String(value || '').trim().toLowerCase();
  return ['error', 'warning', 'info'].includes(severity) ? severity : 'info';
}

function buildAlertIconHtml(severity) {
  const normalized = normalizeAlertSeverity(severity);
  if (normalized === 'info') {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 10.5v6"></path><path d="M12 7.5h.01"></path></svg>';
  }
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10.3 3.8 2.4 17.5A2 2 0 0 0 4.1 20h15.8a2 2 0 0 0 1.7-2.5L13.7 3.8a2 2 0 0 0-3.4 0Z"></path><path d="M12 9v4"></path><path d="M12 16.5h.01"></path></svg>';
}

function buildSmallAlertHtml(config = {}) {
  const severity = normalizeAlertSeverity(config.severity);
  const message = String(config.message || '').trim();
  const className = String(config.className || '').trim();
  return `<span class="small-alert small-alert--${severity}${className ? ` ${escapeHtml(className)}` : ''}" role="status" aria-label="${escapeHtml(message)}" data-small-alert="${severity}"><span class="small-alert__icon">${buildAlertIconHtml(severity)}</span><span class="small-alert__text">${escapeHtml(message)}</span></span>`;
}

function buildAlertLabelAttributes(attributes = {}) {
  if (!attributes || typeof attributes !== 'object') return '';
  return Object.entries(attributes).map(([name, value]) => {
    const allowed = /^(?:id|title|aria-label|data-problem-exclusion-(?:scope|row-key|reason|row-index))$/.test(name);
    if (!allowed || value == null || value === false) return '';
    return ` ${name}="${escapeHtml(value)}"`;
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
    return `<span class="${escapeHtml(classes)}" data-alert-label="${severity}"${attributes}>${escapeHtml(message)}</span>`;
  }
  return `<button class="${escapeHtml(classes)}" data-alert-label="${severity}" type="button"${attributes} aria-pressed="${pressed ? 'true' : 'false'}"${disabled ? ' aria-disabled="true" disabled' : ''}>${escapeHtml(message)}</button>`;
}

function buildOnPageAlertHtml(config = {}) {
  const severity = normalizeAlertSeverity(config.severity);
  const title = String(config.title || '').trim();
  const message = String(config.message || '').trim();
  const actionsHtml = String(config.actionsHtml || '');
  return `<section class="on-page-alert on-page-alert--${severity}" role="alert" data-on-page-alert="${severity}"><span class="on-page-alert__icon">${buildAlertIconHtml(severity)}</span><div class="on-page-alert__content"><strong class="on-page-alert__title">${escapeHtml(title)}</strong><p class="on-page-alert__message">${escapeHtml(message)}</p>${actionsHtml ? `<div class="on-page-alert__actions">${actionsHtml}</div>` : ''}</div></section>`;
}
