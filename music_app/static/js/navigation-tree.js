/* Flat navigation presentation shared by Artists and Settings. */
(() => {
  'use strict';
  if (window.NavigationTree) return;
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  // HTML slots contain component-rendered markup; resource text uses escaped fields.
  function renderItem({ label, href = '#', key = '', selected = false, icon = '', count = null, variant = 'artists', attributes = {}, action = false, artworkHtml = '', subtitle = '', year = '', countHidden = false, trailingHtml = '', draggable = false, className = '' } = {}) {
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
    const attrs = Object.entries(values).map(([name, value]) => name + '="' + escape(value) + '"').join(' ');
    const identity = wide || (panel && (subtitle || year)) ? '<span class="utility-list-item-title">' + escape(label) + '</span><span class="utility-list-item-meta">' + escape(subtitle) + (year ? (subtitle ? ' · ' : '') + escape(year) : '') + '</span>' : escape(label);
    const slots = [tag, attrs, wide ? '<span class="navigation-tree-artwork">' + artworkHtml + '</span>' : icon ? '<span class="navigation-tree-icon" aria-hidden="true">' + escape(icon) + '</span>' : '', identity,
      (count === null ? '' : '<span class="navigation-tree-count artist-count"' + (countHidden ? ' hidden' : '') + '>' + escape(count) + '</span>') + (wide ? trailingHtml : ''), tag];
    let index = 0;
    return template.replace(/%s/g, () => slots[index++]);
  }
  function setItemSelected(item, selected) {
    if (!item?.classList) return;
    const settings = item.getAttribute('data-navigation-tree-item') === 'settings' || item.classList.contains('settings-nav-item');
    const wide = item.getAttribute('data-navigation-tree-item') === 'wide';
    item.classList.toggle(settings ? 'is-active' : 'active', Boolean(selected));
    if (wide) item.classList.toggle('is-active', Boolean(selected));
    item.classList.toggle('is-selected', Boolean(selected));
    if (selected) item.setAttribute('aria-current', settings ? 'page' : 'true');
    else item.removeAttribute('aria-current');
  }
  function updateItem(item, { label = '', subtitle = '', year = '', count = null, artworkHtml, artworkLabel } = {}) {
    for (const [selector, value] of [
      ['.utility-list-item-title', label],
      ['.utility-list-item-meta', subtitle + (year ? ' · ' + year : '')],
      ['.navigation-tree-count', count === null ? '' : count],
    ]) {
      const field = item.querySelector?.(selector);
      if (field && field.textContent !== String(value)) field.textContent = String(value);
    }
    const artwork = item.querySelector?.('.navigation-tree-artwork');
    if (artwork && artworkHtml !== undefined) artwork.innerHTML = artworkHtml;
    if (artwork && artworkLabel !== undefined) {
      artwork.querySelector?.('img')?.setAttribute?.('alt', artworkLabel);
      artwork.querySelector?.('.album-artbox')?.setAttribute?.('aria-label', artworkLabel);
    }
  }
  function setSelection(root, key) {
    root?.querySelectorAll('[data-navigation-tree-item]').forEach(item => {
      const selected = String(item.getAttribute('data-navigation-tree-key') || '') === String(key);
      if (item.classList.contains('is-selected') !== selected) setItemSelected(item, selected);
    });
  }
  window.NavigationTree = { renderItem, renderItems: items => items.map(renderItem).join(''), updateItem, setItemSelected, setSelection };
})();
