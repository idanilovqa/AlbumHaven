/* Flat navigation presentation shared by Artists and Settings. */
(() => {
  'use strict';
  if (window.NavigationTree) return;
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  function renderItem({ label, href = '#', key = '', selected = false, icon = '', count = null, variant = 'artists', attributes = {}, action = false } = {}) {
    const template = document.getElementById('navigation-tree-item-template')?.textContent;
    if (!template) throw new Error('NavigationTreeItem template is missing.');
    const settings = variant === 'settings';
    const panel = variant === 'panel';
    const legacy = settings ? 'settings-nav-item' : 'artist-link';
    const tag = action ? 'button' : 'a';
    const values = {
      class: legacy + (selected ? (settings ? ' is-active' : ' active') : '') + ' navigation-tree-item' + (selected ? ' is-selected' : ''),
      'data-navigation-tree-item': panel ? 'panel' : (settings ? 'settings' : 'artists'),
      'data-navigation-tree-key': key,
    };
    if (action) values.type = panel ? 'button' : 'submit';
    else values.href = /^(?:\/(?!\/)|#)/.test(String(href)) ? href : '#';
    for (const [name, value] of Object.entries(attributes)) {
      if (/^data-[a-z0-9-]+$/.test(name) && !name.startsWith('data-navigation-tree-')) values[name] = value;
    }
    if (selected) values['aria-current'] = settings ? 'page' : 'true';
    const attrs = Object.entries(values).map(([name, value]) => name + '="' + escape(value) + '"').join(' ');
    const slots = [tag, attrs, icon ? '<span class="navigation-tree-icon" aria-hidden="true">' + escape(icon) + '</span>' : '', escape(label),
      count === null ? '' : '<span class="navigation-tree-count artist-count">' + escape(count) + '</span>', tag];
    let index = 0;
    return template.replace(/%s/g, () => slots[index++]);
  }
  function setItemSelected(item, selected) {
    if (!item?.classList) return;
    const settings = item.getAttribute('data-navigation-tree-item') === 'settings' || item.classList.contains('settings-nav-item');
    item.classList.toggle(settings ? 'is-active' : 'active', Boolean(selected));
    item.classList.toggle('is-selected', Boolean(selected));
    if (selected) item.setAttribute('aria-current', settings ? 'page' : 'true');
    else item.removeAttribute('aria-current');
  }
  function setSelection(root, key) {
    root?.querySelectorAll('[data-navigation-tree-item]').forEach(item => {
      const selected = String(item.getAttribute('data-navigation-tree-key') || '') === String(key);
      if (item.classList.contains('is-selected') !== selected) setItemSelected(item, selected);
    });
  }
  window.NavigationTree = { renderItem, renderItems: items => items.map(renderItem).join(''), setItemSelected, setSelection };
})();
