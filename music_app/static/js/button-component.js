/* Shared current-web Button primitive for dynamic surfaces. */
(function (scope) {
  'use strict';
  const variants = new Set(['primary', 'secondary', 'icon']);
  const sizes = new Set(['medium', 'small']);
  const types = new Set(['button', 'submit', 'reset']);
  const actionButtonShapes = new Set(['default', 'round']);
  const actionButtonSemantics = new Set(['default', 'destructive']);
  const actionButtonPresentations = new Set(['outlined', 'bare']);
  const iconPaths = Object.freeze({
    calendar: 'M4 5h16v15H4V5ZM8 3v4M16 3v4M4 10h16',
    copy: 'M8 8h12v12H8V8ZM4 16H3V3h13v1M8 4H4v4',
    cover: 'M5 5h14v14H5V5Zm0 10 4-4 4 4 2-2 4 4M14.5 8.5h.01',
    search: 'M16 16l4 4M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z',
    external: 'M14 5h5v5M11 13l8-8M19 13v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5',
    play: 'M9 6.4v11.2l9-5.6-9-5.6Z',
    pause: 'M7.5 6.5h3.25v11H7.5v-11Zm5.75 0h3.25v11h-3.25v-11Z',
    edit: 'm6.5 16.6.55-3.15L15.9 4.6a1.65 1.65 0 0 1 2.35 0l1.15 1.15a1.65 1.65 0 0 1 0 2.35l-8.85 8.85-3.15.55-.9-.9Zm8.3-9.9 2.5 2.5',
    close: 'm7 7 10 10M17 7 7 17',
    more: 'M6.5 12h.01M12 12h.01M17.5 12h.01',
    delete: 'M8 8.5v9M12 8.5v9M16 8.5v9M5.5 6h13M9 6V4.5h6V6M7 6l.75 14h8.5L17 6',
    back: 'M19 12H5m7-7-7 7 7 7',
    previous: 'm15 6-6 6 6 6',
    next: 'm9 6 6 6-6 6',
    refresh: 'M20 11a8 8 0 1 0-2.34 5.66M20 5v6h-6',
    bolt: 'm13 2-9 12h7l-1 8 10-13h-7z',
    folder: 'M5 19l2.76-7.35a1 1 0 0 1 .93-.65H21a1 1 0 0 1 .99 1.16l-1 5.21A2 2 0 0 1 19.03 19H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4l3 3h7a2 2 0 0 1 2 2v2',
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
    const presentation = options.presentation || 'outlined';
    if (!ariaLabel) throw new TypeError('ActionButton requires an accessible label.');
    if (!actionButtonShapes.has(shape)) throw new TypeError('Unknown ActionButton shape.');
    if (!actionButtonSemantics.has(semantic)) throw new TypeError('Unknown ActionButton semantic.');
    if (!actionButtonPresentations.has(presentation)) throw new TypeError('Unknown ActionButton presentation.');
    if (!validClassList(options.iconClass)) throw new TypeError('Invalid ActionButton icon class.');
    const specializationClasses = [
      shape === 'default' ? '' : `action-button--${shape}`,
      semantic === 'default' ? '' : `action-button--${semantic}`,
      presentation === 'outlined' ? '' : `action-button--${presentation}`,
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
    const badge = String(options.badge ?? '').trim();
    if (badge.length > 3) throw new TypeError('ActionButton badge must be at most three characters.');
    if (badge) actionOptions.className += ' action-button--badged';
    const badgeMarkup = badge ? `<span class="action-button__badge" aria-hidden="true">${escape(badge)}</span>` : '';
    return renderButtonMarkup(
      actionOptions,
      `<span class="ui-button__content action-button__content">${iconMarkup}${badgeMarkup}</span>`,
    );
  }

  // External services shown as an icon and plain text, like MusicBrainz's own links list.
  // Each accepts only its own public artist-page URL shape.
  const externalServices = Object.freeze({
    musicbrainz: { label: 'MusicBrainz', href: /^https:\/\/musicbrainz\.org\/artist\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/ },
    discogs: { label: 'Discogs', href: /^https:\/\/www\.discogs\.com\/artist\/[1-9][0-9]{0,11}$/ },
  });

  function renderExternalServiceLink(options = {}) {
    const service = externalServices[options.service];
    if (!service) throw new TypeError('Unknown external service.');
    const href = String(options.href || '');
    if (!service.href.test(href)) return '';
    const subject = String(options.subject || '').trim();
    const ariaLabel = subject ? `Open ${subject} on ${service.label}` : `Open on ${service.label}`;
    return `<a class="ui-external-link ui-external-link--${escape(options.service)}" href="${escape(href)}" target="_blank" rel="noopener noreferrer" aria-label="${escape(ariaLabel)}">`
      + '<span class="ui-external-link__icon" aria-hidden="true"></span>'
      + `<span class="ui-external-link__text">${escape(service.label)}</span></a>`;
  }

  function setDisabled(element, disabled) {
    element.disabled = Boolean(disabled);
    element.setAttribute('aria-disabled', String(element.disabled));
  }

  // A button running its action is disabled and marked busy, which the shared CSS shows as a spinner.
  function setBusy(element, busy) {
    setDisabled(element, busy);
    if (busy) element.setAttribute('aria-busy', 'true');
    else element.removeAttribute('aria-busy');
  }

  const api = { renderButton, renderActionButton, renderIconSvg, renderExternalServiceLink, setDisabled, setBusy };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (scope) scope.ButtonComponent = api;
})(typeof window !== 'undefined' ? window : null);
