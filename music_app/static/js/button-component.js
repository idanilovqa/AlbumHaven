/* Shared current-web Button primitive for dynamic surfaces. */
(function (scope) {
  'use strict';
  const variants = new Set(['primary', 'secondary', 'icon']);
  const sizes = new Set(['medium', 'small']);
  const types = new Set(['button', 'submit', 'reset']);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const validAttribute = name => /^[a-zA-Z][a-zA-Z0-9_.:-]*$/.test(name);
  const validClassList = value => !value || String(value).trim().split(/\s+/).every(token => /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(token));

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
    if (!ariaLabel) throw new TypeError('ActionButton requires an accessible label.');
    if (!validClassList(options.iconClass)) throw new TypeError('Invalid ActionButton icon class.');
    const actionOptions = {
      ...options,
      ariaLabel,
      variant: 'icon',
      size: 'medium',
      className: ['action-button', options.className || ''].filter(Boolean).join(' '),
    };
    const iconClasses = ['action-button__icon', options.iconClass || ''].filter(Boolean).join(' ');
    return renderButtonMarkup(
      actionOptions,
      `<span class="ui-button__content action-button__content"><span class="${escape(iconClasses)}" aria-hidden="true"></span></span>`,
    );
  }

  const api = { renderButton, renderActionButton };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (scope) scope.ButtonComponent = api;
})(typeof window !== 'undefined' ? window : null);
