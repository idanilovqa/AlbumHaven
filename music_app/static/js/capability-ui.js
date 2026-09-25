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
        clientSurface: String(payload.client_surface || 'private_web'),
      });
    } catch (_error) {
      return null;
    }
  }

  function install(document) {
    const policy = readPolicy(document);
    const allows = (action) => Boolean(policy && policy.actions[action] === true);
    const result = Object.freeze({ allows, clientSurface: policy?.clientSurface || 'private_web' });
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
