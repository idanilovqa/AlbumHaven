(function exposeCapabilities(root) {
  'use strict';

  function readPolicy(document) {
    try {
      const payload = JSON.parse(document.getElementById('capability-bootstrap')?.textContent || '{}');
      const actions = payload.allowed_actions;
      if (!actions || typeof actions !== 'object' || Array.isArray(actions)) return null;
      return Object.freeze({
        actions: Object.freeze({ ...actions }),
        deniedSelectors: Array.isArray(payload.denied_selectors) ? payload.denied_selectors : [],
        deniedTabs: Array.isArray(payload.denied_tabs) ? payload.denied_tabs : [],
        availableTabs: Object.freeze(Array.isArray(payload.available_tabs)
          ? payload.available_tabs.filter(tab => typeof tab === 'string') : []),
        clientSurface: String(payload.client_surface || 'private_web'),
        coverProviderGroups: Object.freeze(Array.isArray(payload.cover_provider_groups)
          ? payload.cover_provider_groups.filter(group => typeof group === 'string') : []),
      });
    } catch (_error) {
      return null;
    }
  }

  function install(document) {
    const policy = readPolicy(document);
    const allows = (action) => Boolean(policy && policy.actions[action] === true);
    const allowsUtilityTab = (tab) => Boolean(policy && policy.availableTabs.includes(tab));
    const resolveUtilityTab = (preferred) => allowsUtilityTab(preferred)
      ? preferred : policy?.availableTabs[0] || null;
    const allowsCoverCandidate = (candidate) => Boolean(policy && (policy.clientSurface !== 'tv'
      || policy.coverProviderGroups.includes(candidate?.lookup_group)));
    const result = Object.freeze({ allows, allowsUtilityTab, resolveUtilityTab, allowsCoverCandidate,
      clientSurface: policy?.clientSurface || 'private_web' });
    root.AlbumHavenCapabilities = result;
    if (!policy) return result;
    const denied = policy.deniedSelectors.join(',');
    if (denied) {
      // CSS is applied before first paint. This capture guard also rejects
      // synthetic activation of a hidden control; the server remains decisive.
      document.addEventListener('click', (event) => {
        if (event.target?.closest?.(denied)) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      }, true);
    }
    const ready = () => {
      // Keyboard traversal uses native hidden state, not just CSS visibility.
      document.querySelectorAll?.('[data-utility-tab]').forEach(tab => {
        tab.hidden = !allowsUtilityTab(tab.getAttribute('data-utility-tab'));
      });
      if (!policy.deniedTabs.length) return;
      const dialog = document.querySelector('#utility-modal .utility-modal-dialog');
      if (!dialog || dialog.querySelector('.capability-section-denied')) return;
      const message = document.createElement('div');
      message.className = 'capability-section-denied utility-empty-state';
      message.setAttribute('role', 'status');
      message.textContent = 'This section is unavailable for your account or device. Choose an available section above.';
      dialog.append(message);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, { once: true });
    else ready();
    return result;
  }

  if (typeof module === 'object' && module.exports) module.exports = { readPolicy, install };
  if (root.document) install(root.document);
}(typeof window === 'object' ? window : globalThis));
