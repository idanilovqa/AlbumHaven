/* Shared current-web Button primitive for dynamic surfaces. */
(function (scope) {
  'use strict';
  const variants = new Set(['primary', 'secondary', 'icon']);
  const sizes = new Set(['medium', 'small']);
  const types = new Set(['button', 'submit', 'reset']);
  const actionButtonShapes = new Set(['default', 'round']);
  const actionButtonSemantics = new Set(['default', 'destructive']);
  const iconPaths = Object.freeze({
    play: 'M9 6.4v11.2l9-5.6-9-5.6Z',
    pause: 'M7.5 6.5h3.25v11H7.5v-11Zm5.75 0h3.25v11h-3.25v-11Z',
    edit: 'm6.5 16.6.55-3.15L15.9 4.6a1.65 1.65 0 0 1 2.35 0l1.15 1.15a1.65 1.65 0 0 1 0 2.35l-8.85 8.85-3.15.55-.9-.9Zm8.3-9.9 2.5 2.5',
    close: 'm7 7 10 10M17 7 7 17',
    more: 'M6.5 12h.01M12 12h.01M17.5 12h.01',
    delete: 'M8 8.5v9M12 8.5v9M16 8.5v9M5.5 6h13M9 6V4.5h6V6M7 6l.75 14h8.5L17 6',
    previous: 'm15 6-6 6 6 6',
    next: 'm9 6 6 6-6 6',
  });
  const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const validAttribute = name => /^[a-zA-Z][a-zA-Z0-9_.:-]*$/.test(name);
  const validClassList = value => !value || String(value).trim().split(/\s+/).every(token => /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(token));

  function renderIconSvg(name, options = {}) {
    const path = iconPaths[name];
    if (!path) throw new TypeError('Unknown icon.');
    if (!validClassList(options.className)) throw new TypeError('Invalid icon class.');
    const classes = ['ui-icon', options.className || ''].filter(Boolean).join(' ');
    return `<svg class="${escape(classes)}" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${path}"/></svg>`;
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
    if (!ariaLabel) throw new TypeError('ActionButton requires an accessible label.');
    if (!actionButtonShapes.has(shape)) throw new TypeError('Unknown ActionButton shape.');
    if (!actionButtonSemantics.has(semantic)) throw new TypeError('Unknown ActionButton semantic.');
    if (!validClassList(options.iconClass)) throw new TypeError('Invalid ActionButton icon class.');
    const specializationClasses = [
      shape === 'default' ? '' : `action-button--${shape}`,
      semantic === 'default' ? '' : `action-button--${semantic}`,
    ].filter(Boolean);
    const actionOptions = {
      ...options,
      ariaLabel,
      variant: 'icon',
      size: 'medium',
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

  const api = { renderButton, renderActionButton, renderIconSvg };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (scope) scope.ButtonComponent = api;
})(typeof window !== 'undefined' ? window : null);
