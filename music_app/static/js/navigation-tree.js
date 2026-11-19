/* Flat navigation presentation shared by Artists and Settings. */
(() => {
  'use strict';
  if (window.NavigationTree) return;
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  // HTML slots contain component-rendered markup; resource text uses escaped fields.
  function renderItem({ label, labelHtml = '', href = '#', key = '', selected = false, icon = '', count = null, variant = 'artists', attributes = {}, action = false, artworkHtml = '', subtitle = '', year = '', countHidden = false, trailingHtml = '', draggable = false, className = '' } = {}) {
    const template = document.getElementById('navigation-tree-item-template')?.textContent;
    if (!template) throw new Error('NavigationTreeItem template is missing.');
    const settings = variant === 'settings';
    const wide = variant === 'wide';
    const panel = variant === 'panel' || wide;
    const legacy = settings ? 'settings-nav-item' : 'artist-link';
    const tag = action ? 'button' : 'a';
    const values = {
      class: legacy + (selected ? (settings ? ' is-active' : ' active') : '') + ' navigation-tree-item' + (wide ? ' navigation-tree-item--wide utility-list-item' : '') + (selected ? ' is-selected' + (wide ? ' is-active' : '') : '') + (className ? ' ' + className : ''),
      'data-navigation-tree-item': wide ? 'wide' : panel ? 'panel' : (settings ? 'settings' : 'artists'),
      'data-navigation-tree-key': key,
    };
    if (action) values.type = panel ? 'button' : 'submit';
    else values.href = /^(?:\/(?!\/)|#)/.test(String(href)) ? href : '#';
    if (draggable) values.draggable = 'true';
    for (const [name, value] of Object.entries(attributes)) {
      if (/^data-[a-z0-9-]+$/.test(name) && !name.startsWith('data-navigation-tree-')) values[name] = value;
    }
    if (selected) values['aria-current'] = settings ? 'page' : 'true';
    // Rows keep one line and truncate (owner 2026-11-18); the full name shows on hover.
    if (!wide && String(label || '').trim()) values.title = String(label);
    const attrs = Object.entries(values).map(([name, value]) => name + '="' + escape(value) + '"').join(' ');
    // labelHtml: the label already escaped by its caller, e.g. with search highlights (owner 2026-11-18).
    const labelMarkup = labelHtml || escape(label);
    const identity = wide || (panel && (subtitle || year)) ? '<span class="utility-list-item-title">' + labelMarkup + '</span><span class="utility-list-item-meta">' + (subtitle ? '<span class="utility-list-item-subtitle">' + escape(subtitle) + '</span>' : '') + (year ? '<span class="utility-list-item-year">' + escape(year) + '</span>' : '') + '</span>' : labelMarkup;
    const slots = [tag, attrs, wide ? '<span class="navigation-tree-artwork">' + artworkHtml + '</span>' : icon ? '<span class="navigation-tree-icon" aria-hidden="true">' + escape(icon) + '</span>' : '', identity,
      (count === null ? '' : '<span class="navigation-tree-count artist-count"' + (countHidden ? ' hidden' : '') + '>' + escape(count) + '</span>') + (wide ? trailingHtml : ''), tag];
    let index = 0;
    return template.replace(/%s/g, () => slots[index++]);
  }
  function renderSeparator({ label } = {}) {
    return '<div class="navigation-tree-separator" role="separator" aria-label="' + escape(label) + '"></div>';
  }
  // Placeholder rows where items will appear while a tree's catalog is still loading.
  function renderSkeleton({ count = 4 } = {}) {
    const row = '<div class="navigation-tree-skeleton" data-navigation-tree-skeleton aria-hidden="true">'
      + '<span class="navigation-tree-skeleton__label"></span><span class="navigation-tree-skeleton__count"></span></div>';
    return '<div class="navigation-tree-skeletons" role="status" aria-label="Loading">' + row.repeat(Math.max(1, count)) + '</div>';
  }
  function setItemSelected(item, selected) {
    if (!item?.classList) return;
    const settings = item.getAttribute('data-navigation-tree-item') === 'settings' || item.classList.contains('settings-nav-item');
    const wide = item.getAttribute('data-navigation-tree-item') === 'wide';
    item.classList.toggle(settings ? 'is-active' : 'active', Boolean(selected));
    if (wide) item.classList.toggle('is-active', Boolean(selected));
    item.classList.toggle('is-selected', Boolean(selected));
    const current = selected ? (settings ? 'page' : 'true') : null;
    if (item.getAttribute('aria-current') !== current) {
      if (current === null) item.removeAttribute('aria-current');
      else item.setAttribute('aria-current', current);
    }
  }
  function updateItem(item, { label = '', subtitle = '', year = '', count = null, artworkHtml, artworkLabel } = {}) {
    for (const [selector, value] of [
      ['.utility-list-item-title', label],
      ['.navigation-tree-count', count === null ? '' : count],
    ]) {
      const field = item.querySelector?.(selector);
      if (field && field.textContent !== String(value)) field.textContent = String(value);
    }
    const meta = item.querySelector?.('.utility-list-item-meta');
    if (meta) {
      for (const [className, value] of [['utility-list-item-subtitle', subtitle], ['utility-list-item-year', year]]) {
        let field = meta.querySelector(`.${className}`);
        if (!value) {
          field?.remove();
          continue;
        }
        if (!field) {
          field = document.createElement('span');
          field.className = className;
          meta.insertBefore(field, className === 'utility-list-item-subtitle' ? meta.firstChild : null);
        }
        if (field.textContent !== String(value)) field.textContent = String(value);
      }
    }
    const artwork = item.querySelector?.('.navigation-tree-artwork');
    if (artwork && artworkHtml !== undefined) artwork.innerHTML = artworkHtml;
    if (artwork && artworkLabel !== undefined) {
      const label = String(artworkLabel);
      for (const [selector, attribute] of [['img', 'alt'], ['.album-artbox', 'aria-label']]) {
        const element = artwork.querySelector?.(selector);
        if (element && element.getAttribute(attribute) !== label) {
          element.setAttribute(attribute, label);
        }
      }
    }
  }
  function setSelection(root, key) {
    root?.querySelectorAll('[data-navigation-tree-item]').forEach(item => {
      const selected = String(item.getAttribute('data-navigation-tree-key') || '') === String(key);
      if (item.classList.contains('is-selected') !== selected) setItemSelected(item, selected);
    });
  }
  window.NavigationTree = { renderItem, renderItems: items => items.map(renderItem).join(''), renderSeparator, renderSkeleton, updateItem, setItemSelected, setSelection };
})();
