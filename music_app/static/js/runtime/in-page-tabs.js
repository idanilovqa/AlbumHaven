/* Lightweight, keyboard-operable tabs. Tokens come from the containing surface. */
function buildInPageTabsHtml({ id, label, tabs = [], selectedKey } = {}) {
  const selected = tabs.find(tab => !tab.disabled && tab.key === selectedKey)
    || tabs.find(tab => !tab.disabled);
  return `<div class="in-page-tabs" id="${escapeHtml(id)}" role="tablist" aria-label="${escapeHtml(label)}">${tabs.map(tab => {
    const active = tab === selected;
    return `<button type="button" role="tab" id="${escapeHtml(id)}-${escapeHtml(tab.key)}" data-in-page-tab="${escapeHtml(tab.key)}" aria-selected="${active}" tabindex="${active ? 0 : -1}"${tab.panelId ? ` aria-controls="${escapeHtml(tab.panelId)}"` : ''}${tab.disabled ? ' disabled aria-disabled="true"' : ''}>${escapeHtml(tab.label)}</button>`;
  }).join('')}</div>`;
}
const mountedInPageTabs = new WeakSet();
function mountInPageTabs(tablist) {
  if (!tablist || mountedInPageTabs.has(tablist)) return;
  mountedInPageTabs.add(tablist);
  const buttons = () => [...tablist.querySelectorAll('[data-in-page-tab]')];
  const select = target => {
    if (!target || target.disabled || !buttons().includes(target)) return;
    for (const button of buttons()) {
      const active = button === target;
      button.setAttribute('aria-selected', String(active));
      button.tabIndex = active ? 0 : -1;
      const panelId = button.getAttribute('aria-controls');
      const panel = panelId ? tablist.ownerDocument.getElementById(panelId) : null;
      if (panel) panel.hidden = !active;
    }
  };
  tablist.addEventListener('click', event => select(event.target.closest('[data-in-page-tab]')));
  tablist.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const enabled = buttons().filter(button => !button.disabled);
    const index = enabled.indexOf(event.target);
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1
      : (index + (event.key === 'ArrowRight' ? 1 : -1) + enabled.length) % enabled.length;
    select(enabled[next]);
    enabled[next].focus();
  });
}
