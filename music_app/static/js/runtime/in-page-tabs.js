/* Lightweight, keyboard-operable tabs. Tokens come from the containing surface. */
function buildInPageTabsHtml({ id, label, tabs = [], selectedKey } = {}) {
  const selected = tabs.find(tab => !tab.disabled && tab.key === selectedKey)
    || tabs.find(tab => !tab.disabled);
  return `<div class="in-page-tabs" id="${escapeHtml(id)}" role="tablist" aria-label="${escapeHtml(label)}">${tabs.map(tab => {
    const active = tab === selected;
    return `<button type="button" role="tab" id="${escapeHtml(id)}-${escapeHtml(tab.key)}" data-in-page-tab="${escapeHtml(tab.key)}" data-tab-label="${escapeHtml(tab.label)}" aria-selected="${active}" tabindex="${active ? 0 : -1}"${tab.panelId ? ` aria-controls="${escapeHtml(tab.panelId)}"` : ''}${tab.disabled ? ' disabled aria-disabled="true"' : ''}>${escapeHtml(tab.label)}<span class="in-page-tabs__attention" aria-hidden="true" hidden></span></button>`;
  }).join('')}</div>`;
}
const mountedInPageTabs = new WeakMap();
function mountInPageTabs(tablist) {
  if (!tablist) return;
  if (mountedInPageTabs.has(tablist)) return mountedInPageTabs.get(tablist);
  let disposed = false;
  const buttons = () => [...tablist.querySelectorAll('[data-in-page-tab]')];
  const select = target => {
    if (disposed || !target || target.disabled || !buttons().includes(target)) return;
    for (const button of buttons()) {
      const active = button === target;
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
      const panelId = button.getAttribute('aria-controls');
      const panel = panelId ? tablist.ownerDocument.getElementById(panelId) : null;
      if (panel) panel.hidden = !active;
    }
  };
  const click = event => select(event.target.closest('[data-in-page-tab]'));
  const keydown = event => {
    if (disposed) return;
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const enabled = buttons().filter(button => !button.disabled);
    const index = enabled.indexOf(event.target);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : -1) + enabled.length) % enabled.length;
    select(enabled[next]);
    enabled[next].focus();
  };
  const owner = {setAttention(key, value) {
    if (disposed) return;
    const button = buttons().find(node => node.dataset.inPageTab === key);
    if (!button) return;
    const attention = value === 'red' || value === 'blue' ? value : 'none';
    const marker = button.querySelector('.in-page-tabs__attention');
    if (marker) {marker.hidden = attention === 'none'; marker.dataset.attention = attention;}
    if (attention === 'none') button.removeAttribute('aria-label');
    else button.setAttribute('aria-label', `${button.dataset.tabLabel}, ${attention === 'red' ? 'reset needed' : 'new weekly goals'}`);
  }, dispose() {
    if (disposed) return;
    disposed = true;
    tablist.removeEventListener('click', click);
    tablist.removeEventListener('keydown', keydown);
    if (mountedInPageTabs.get(tablist) === owner) mountedInPageTabs.delete(tablist);
  }};
  tablist.addEventListener('click', click);
  tablist.addEventListener('keydown', keydown);
  mountedInPageTabs.set(tablist, owner);
  return owner;
}
