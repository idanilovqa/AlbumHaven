/* Shared current-web Button primitive for dynamic surfaces. */
(function (scope) {
  'use strict';
  const variants = new Set(['primary', 'secondary', 'icon']);
  const sizes = new Set(['medium', 'small']);
  const types = new Set(['button', 'submit', 'reset']);
  const actionButtonShapes = new Set(['default', 'round']);
  const actionButtonSemantics = new Set(['default', 'destructive']);
  const actionButtonPresentations = new Set(['outlined', 'bare']);
  // Trusted decorative fragments; the fixed registry is mirrored by the Jinja ui_icon macro.
  const iconMarkup = Object.freeze({
    calendar: '<path d="M4 5h16v15H4V5ZM8 3v4M16 3v4M4 10h16"/>',
    copy: '<path d="M8 8h12v12H8V8ZM4 16H3V3h13v1M8 4H4v4"/>',
    cover: '<path d="M5 5h14v14H5V5Zm0 10 4-4 4 4 2-2 4 4M14.5 8.5h.01"/>',
    search: '<path d="M16 16l4 4M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z"/>',
    play: '<path d="M9 6.4v11.2l9-5.6-9-5.6Z"/>',
    pause: '<path d="M7.5 6.5h3.25v11H7.5v-11Zm5.75 0h3.25v11h-3.25v-11Z"/>',
    edit: '<path d="m6.5 16.6.55-3.15L15.9 4.6a1.65 1.65 0 0 1 2.35 0l1.15 1.15a1.65 1.65 0 0 1 0 2.35l-8.85 8.85-3.15.55-.9-.9Zm8.3-9.9 2.5 2.5"/>',
    close: '<path d="m7 7 10 10M17 7 7 17"/>',
    complete: '<path d="m5 12 4.5 4.5L19 7"/>',
    more: '<path d="M6.5 12h.01M12 12h.01M17.5 12h.01"/>',
    'more-vertical': '<path d="M12 6.5h.01M12 12h.01M12 17.5h.01"/>',
    delete: '<path d="M8 8.5v9M12 8.5v9M16 8.5v9M5.5 6h13M9 6V4.5h6V6M7 6l.75 14h8.5L17 6"/>',
    back: '<path d="M19 12H5m7-7-7 7 7 7"/>',
    previous: '<path d="m15 6-6 6 6 6"/>',
    next: '<path d="m9 6 6 6-6 6"/>',
    bolt: '<path d="m13 2-9 12h7l-1 8 10-13h-7z"/>',
    add: '<path d="m7 7 10 10M17 7 7 17" transform="rotate(45 12 12)"/>',
    compare: '<path d="M8 8h12v12H8V8ZM4 16H3V3h13v1M8 4H4v4"/>',
    undo: '<path d="M3 10h11a6 6 0 0 1 0 12h-3M3 10l6-6M3 10l6 6"/>',
    filters: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M6 14v6"/>',
    expand: '<path d="M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5M3 3l6 6M21 3l-6 6M3 21l6-6M21 21l-6-6"/>',
    collapse: '<path d="M3 9h6V3M21 9h-6V3M9 21v-6H3M15 21v-6h6M3 3l6 6M21 3l-6 6M3 21l6-6M21 21l-6-6"/>',
    ascending: '<path d="M12 19V5m-5 5 5-5 5 5"/>',
    descending: '<path d="M12 5v14m-5-5 5 5 5-5"/>',
    download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" stroke-width="1.7"/>',
    'export-text': '<path d="M14 3H5v18h14v-8M9 8h3M9 12h3M9 16h6M14 3v6h6M14 9l7-7m-5 0h5v5" stroke-width="1.7"/>',
    'album-top': '<path data-top-crown="" fill="currentColor" stroke="none" transform="translate(0 2.5)" d="M7.5 3.5L10.25 5L13.5 1.5L16.75 5L19.5 3.5L18.25 7.5H8.75Z"/><g fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path data-top-record="" d="M18.4 11.825A6.125 6.125 0 1 1 8.6 11.825"/><circle data-top-center="" cx="13.5" cy="15.5" r="1.75"/></g>',
    'create-top': '<path data-top-crown="" fill="currentColor" stroke="none" transform="translate(0 2.5)" d="M7.5 3.5L10.25 5L13.5 1.5L16.75 5L19.5 3.5L18.25 7.5H8.75Z"/><g fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path data-top-record="" d="M8.6 11.825A6.125 6.125 0 0 0 7.49628712871287 14.2871287128713M13.5 21.625A6.125 6.125 0 0 0 18.4 11.825"/><circle data-top-center="" cx="13.5" cy="15.5" r="1.75"/><path data-top-plus="" transform="translate(4 0.125)" d="M2.75 19H7.75M5.25 16.5V21.5"/></g>',
    'missing-playlist': '<path data-playlist-base="" d="M8 5h7M8 10h7M8 15h3M18 5v9a2.5 2.5 0 1 1-2.5-2.5H18M18 5l4 1v4l-4-1"/><path data-missing-warning="" d="M3.5 4.5v9.5"/><circle data-missing-warning-dot="" cx="3.5" cy="18" r=".8" fill="currentColor" stroke="none"/><path data-playlist-create="" d="M20 17v6M17 20h6"/>',
    share: '<path d="m8.5 10.6 7-4.2m-7 7.2 7 4.2" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="6" cy="12" r="2.8" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="18" cy="5" r="2.8" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="18" cy="19" r="2.8" fill="none" stroke="currentColor" stroke-width="1.6"/>',
    save: '<path d="M4 3h13l3 3v15H4V3Zm3 0v6h9V3M7 21v-8h10v8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
    friends: '<circle cx="8" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M3 19c.5-3.5 2.2-5.2 5-5.2s4.5 1.7 5 5.2M14 14.5c3.5-.8 5.8.8 6.5 4.5"/>',
    'love-off': '<path class="ui-love-heart ui-love-heart--off" d="M20.8 4.8a5.5 5.5 0 0 0-7.8 0L12 5.9l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.4a5.5 5.5 0 0 0 0-7.8Z"/>',
    'love-loved': '<path class="ui-love-heart ui-love-heart--loved" d="M20.8 4.8a5.5 5.5 0 0 0-7.8 0L12 5.9l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.4a5.5 5.5 0 0 0 0-7.8Z"/>',
    'love-obsessed': '<g transform="translate(-4 -10.666667) scale(1.333333)"><path class="ui-love-flame" d="M12 1c2 4 5 4 4 9 2-1 3-3 3-5 4 5 5 9 2 14-2 3-5 4-9 4S5 22 3 19C0 14 3 10 6 7c-1 3 0 5 2 6-1-5 4-6 4-12Z"/><path class="ui-love-flame-core" d="M12 5c1 4 5 5 3 10 2-1 3-3 3-5 4 6 1 11-6 11-6 0-9-5-5-10 0 3 1 4 3 5-1-4 2-6 2-11Z"/></g><path class="ui-love-heart ui-love-heart--obsessed" d="M20.8 4.8a5.5 5.5 0 0 0-7.8 0L12 5.9l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.4a5.5 5.5 0 0 0 0-7.8Z"/>',
  });
  const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const validAttribute = name => /^[a-zA-Z][a-zA-Z0-9_.:-]*$/.test(name);
  const validClassList = value => !value || String(value).trim().split(/\s+/).every(token => /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(token));

  function renderIconSvg(name, options = {}) {
    const markup = Object.prototype.hasOwnProperty.call(iconMarkup, name) ? iconMarkup[name] : null;
    if (!markup) throw new TypeError('Unknown icon.');
    if (!validClassList(options.className)) throw new TypeError('Invalid icon class.');
    const classes = ['ui-icon', options.className || ''].filter(Boolean).join(' ');
    return `<svg class="${escape(classes)}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${markup}</svg>`;
  }

  function renderButtonMarkup(options, contentHtml) {
    const variant = options.variant || 'secondary';
    const size = options.size || 'medium';
    const type = options.type || 'button';
    if (!variants.has(variant)) throw new TypeError('Unknown Button variant.');
    if (!sizes.has(size)) throw new TypeError('Unknown Button size.');
    if (!types.has(type)) throw new TypeError('Unknown Button type.');
    const classes = ['button', 'ui-button', `ui-button--${variant}`, `ui-button--${size}`];
    if (options.quiet === true) classes.push('ui-button--quiet');
    if (options.className) classes.push(...String(options.className).trim().split(/\s+/).filter(Boolean));
    const attributes = { ...(options.attributes || {}) };
    if (options.action) attributes['data-ui-button-action'] = options.action;
    if (options.ariaLabel) attributes['aria-label'] = options.ariaLabel;
    if (options.title) attributes.title = options.title;
    if (options.hidden) attributes.hidden = true;
    if (options.disabled) {
      attributes.disabled = true;
      attributes['aria-disabled'] = 'true';
    }
    const renderedAttributes = Object.entries(attributes).map(([name, value]) => {
      if (!validAttribute(name)) throw new TypeError('Invalid Button attribute.');
      if (value === false || value == null) return '';
      return value === true ? ` ${name}` : ` ${name}="${escape(value)}"`;
    }).join('');
    return `<button type="${type}" class="${escape(classes.join(' '))}"${renderedAttributes}>${contentHtml}</button>`;
  }

  function renderButton(options = {}) {
    return renderButtonMarkup(
      options,
      `<span class="ui-button__content">${escape(options.label || '')}</span>`,
    );
  }

  function renderActionButton(options = {}) {
    const ariaLabel = String(options.ariaLabel || '').trim();
    const shape = options.shape || 'default';
    const semantic = options.semantic || 'default';
    const presentation = options.presentation || 'outlined';
    const isToggle = typeof options.pressed === 'boolean';
    if (!ariaLabel) throw new TypeError('ActionButton requires an accessible label.');
    if (!actionButtonShapes.has(shape)) throw new TypeError('Unknown ActionButton shape.');
    if (!actionButtonSemantics.has(semantic)) throw new TypeError('Unknown ActionButton semantic.');
    if (!actionButtonPresentations.has(presentation)) throw new TypeError('Unknown ActionButton presentation.');
    if (!validClassList(options.iconClass)) throw new TypeError('Invalid ActionButton icon class.');
    const specializationClasses = [
      shape === 'default' ? '' : `action-button--${shape}`,
      semantic === 'default' ? '' : `action-button--${semantic}`,
      presentation === 'outlined' ? '' : `action-button--${presentation}`,
      isToggle ? 'action-button--toggle' : '',
    ].filter(Boolean);
    const actionOptions = {
      ...options,
      ariaLabel,
      variant: 'icon',
      size: 'medium',
      attributes: { ...options.attributes, ...(isToggle ? { 'aria-pressed': String(options.pressed) } : {}) },
      className: ['action-button', ...specializationClasses, options.className || ''].filter(Boolean).join(' '),
    };
    const iconClasses = ['action-button__icon', options.iconClass || ''].filter(Boolean).join(' ');
    const iconMarkup = options.icon
      ? renderIconSvg(options.icon, { className: `${iconClasses} ui-icon--${options.icon}` })
      : `<span class="${escape(iconClasses)}" aria-hidden="true"></span>`;
    return renderButtonMarkup(
      actionOptions,
      `<span class="ui-button__content action-button__content">${iconMarkup}</span>`,
    );
  }

  function setDisabled(element, disabled) {
    element.disabled = Boolean(disabled);
    element.setAttribute('aria-disabled', String(element.disabled));
  }

  const api = { renderButton, renderActionButton, renderIconSvg, setDisabled };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (scope) scope.ButtonComponent = api;
})(typeof window !== 'undefined' ? window : null);
