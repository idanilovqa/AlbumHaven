/* Settings owns its outlet, never the library document or audio runtime. */
(() => {
  'use strict';
  const isSettingsPath = (path) => path === '/account' || path === '/admin/members'
    || /^\/admin\/accounts\/(?:new|[0-9]+)$/.test(path);
  const isAccountPost = (path) => path === '/account/password'
    || path === '/account/password-suggestion/dismiss';

  function create({ document, window, fetch, DOMParser }) {
    const host = document.querySelector('[data-settings-host]');
    const outlet = document.querySelector('[data-settings-outlet]');
    const nav = document.querySelector('[data-settings-nav]');
    if (!host || !outlet || !nav) return null;
    const library = document.querySelector('#app-shell');
    const error = document.querySelector('[data-settings-navigation-error]');
    let currentUrl = window.location.href;
    let libraryUrl = library ? currentUrl : null;
    let libraryTitle = document.title;
    let sequence = 0;
    let pending = null;
    let disposeContent = () => {};
    let destroyed = false;
    let navigationPending = false;
    const urlFor = (value) => {
      try {
        const url = new URL(value, window.location.href);
        return url.origin === window.location.origin && !url.username && !url.password ? url : null;
      } catch { return null; }
    };
    const reportError = () => {
      if (error) {
        error.textContent = 'This page could not be loaded. Please try again.';
        error.hidden = false;
      }
    };
    const updateHistory = (url, mode) => {
      if (mode === 'push') window.history.pushState(null, '', url);
      else if (mode === 'replace') window.history.replaceState(null, '', url);
      currentUrl = url;
    };
    const mountContent = () => {
      const cleanups = [];
      // The callback is invalidated when its owning content is disposed. A late
      // mutation response must never navigate over a more recent user choice.
      let active = true;
      const navigateFromContent = (url) => active && !navigationPending ? navigate(url) : Promise.resolve(false);
      if (outlet.querySelector('[data-password-form]')) {
        cleanups.push(window.AlbumHavenMountAccount?.(outlet));
      } else {
        cleanups.push(window.AlbumHavenMountAdmin?.(outlet, { navigate: navigateFromContent }));
      }
      disposeContent = () => {
        active = false;
        cleanups.forEach((cleanup) => cleanup?.());
        outlet.querySelectorAll('input[type="password"], .password-control input').forEach((input) => { input.value = ''; });
      };
    };
    const reconcileNav = (incoming, url) => {
      const incomingUser = incoming.querySelector('[data-settings-section="users"]');
      const currentUser = nav.querySelector('[data-settings-section="users"]');
      if (currentUser && !incomingUser) currentUser.remove();
      else if (!currentUser && incomingUser) {
        const account = nav.querySelector('[data-settings-section="account"]');
        account?.before(incomingUser.cloneNode(true));
      }
      const token = incoming.querySelector('[name="csrf_token"]');
      const currentToken = nav.querySelector('[name="csrf_token"]');
      if (token && currentToken) currentToken.value = token.value;
      nav.querySelectorAll('[data-settings-section]').forEach((link) => {
        const active = link.dataset.settingsSection === (url.pathname === '/account' ? 'account' : 'users');
        link.classList.toggle('is-active', active);
        if (active) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
      });
    };

    async function navigate(value, { historyMode = 'push', method = 'GET', body } = {}) {
      const url = urlFor(value);
      const posting = method === 'POST' && url && isAccountPost(url.pathname);
      const returning = library && url && (url.href === libraryUrl || url.pathname === '/');
      if (destroyed || !url || (!isSettingsPath(url.pathname) && !posting && !returning)) return false;
      const ownSequence = ++sequence;
      navigationPending = true;
      pending?.abort();
      pending = new AbortController();
      if (error) error.hidden = true;
      if (returning && !posting) {
        disposeContent();
        outlet.replaceChildren();
        host.hidden = true;
        library.hidden = false;
        document.title = libraryTitle;
        updateHistory(libraryUrl, historyMode);
        navigationPending = false;
        return true;
      }
      try {
        const response = await fetch(url.href, {
          method, body, credentials: 'same-origin', cache: 'no-store',
          headers: { Accept: 'text/html' }, signal: pending.signal,
        });
        if (ownSequence !== sequence || destroyed) return false;
        const destination = urlFor(response.url || url.href);
        if (response.status === 401 || (destination?.pathname === '/login' && response.redirected)) {
          window.location.assign('/login');
          return false;
        }
        if (!destination || (!isSettingsPath(destination.pathname) && !(posting && isAccountPost(destination.pathname)))) throw new Error('Unexpected route');
        if (!response.ok && !(posting && [400, 409, 503].includes(response.status))) throw new Error('Request failed');
        if (!response.headers.get('content-type')?.includes('text/html')) throw new Error('Unexpected content');
        const parsed = new DOMParser().parseFromString(await response.text(), 'text/html');
        if (ownSequence !== sequence || destroyed) return false;
        const incoming = parsed.querySelector('[data-settings-outlet]');
        const incomingNav = parsed.querySelector('[data-settings-nav]');
        if (!incoming || !incomingNav) throw new Error('Missing Settings content');
        // Only known inert permission metadata is kept. Never execute fetched scripts.
        incoming.querySelectorAll('script').forEach((script) => {
          if (script.id !== 'admin-allowed-actions' || script.type !== 'application/json') script.remove();
        });
        const displayedUrl = posting && !response.ok ? new URL('/account', url.origin) : destination;
        if (library && host.hidden && historyMode !== 'none') {
          libraryUrl = currentUrl = window.location.href;
          libraryTitle = document.title;
        }
        disposeContent();
        outlet.replaceChildren(...incoming.childNodes);
        reconcileNav(incomingNav, displayedUrl);
        host.hidden = false;
        if (library) library.hidden = true;
        document.title = parsed.title;
        updateHistory(displayedUrl.href, posting ? 'replace' : historyMode);
        outlet.scrollTop = 0;
        mountContent();
        const heading = outlet.querySelector('h1');
        heading?.setAttribute('tabindex', '-1');
        heading?.focus({ preventScroll: true });
        return true;
      } catch (failure) {
        if (ownSequence !== sequence || destroyed || failure.name === 'AbortError') return false;
        if (historyMode === 'none') window.history.replaceState(null, '', currentUrl);
        reportError();
        return false;
      } finally {
        if (ownSequence === sequence) navigationPending = false;
      }
    }

    const onClick = (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const link = event.target?.closest?.('a[href]');
      if (!link || link.hasAttribute('download') || (link.target && link.target !== '_self')) return;
      const url = urlFor(link.href);
      if (!url || (!isSettingsPath(url.pathname) && !(library && !host.hidden && url.pathname === '/'))) return;
      event.preventDefault();
      void navigate(url.href);
    };
    const onSubmit = (event) => {
      const form = event.target;
      if (event.defaultPrevented || !outlet.contains(form)) return;
      const url = urlFor(form.action);
      if (!url || form.method.toLowerCase() !== 'post' || !isAccountPost(url.pathname)) return;
      event.preventDefault();
      if (!form.checkValidity()) { form.reportValidity(); return; }
      const body = new URLSearchParams(new FormData(form));
      void navigate(url.href, { method: 'POST', body });
    };
    const onPopState = (event) => {
      const url = urlFor(window.location.href);
      if (!url) return;
      if (!isSettingsPath(url.pathname)) {
        if (library) {
          ++sequence;
          navigationPending = false;
          pending?.abort();
          if (!host.hidden) {
            disposeContent();
            outlet.replaceChildren();
            host.hidden = true;
            library.hidden = false;
            document.title = libraryTitle;
            if (url.href === libraryUrl) event.stopImmediatePropagation();
          }
          libraryUrl = currentUrl = url.href;
        }
        return;
      }
      // This capture listener runs before the gallery's existing bubble listener.
      event.stopImmediatePropagation();
      void navigate(url.href, { historyMode: 'none' });
    };
    document.addEventListener('click', onClick);
    document.addEventListener('submit', onSubmit);
    window.addEventListener('popstate', onPopState, true);
    if (!host.hidden) mountContent();
    return {
      navigate,
      destroy() {
        destroyed = true;
        ++sequence;
        pending?.abort();
        disposeContent();
        document.removeEventListener('click', onClick);
        document.removeEventListener('submit', onSubmit);
        window.removeEventListener('popstate', onPopState, true);
      },
    };
  }
  window.AlbumHavenSettingsNavigation = { create };
  if (typeof document !== 'undefined') {
    window.AlbumHavenSettingsNavigation.instance = create({ document, window, fetch: window.fetch.bind(window), DOMParser: window.DOMParser });
  }
})();
