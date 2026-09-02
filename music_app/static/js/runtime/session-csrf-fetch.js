(() => {
  const originalFetch = window.fetch.bind(window);
  const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
  const csrfCookieName = '__Host-album_haven_csrf';

  const readCookie = (name) => {
    for (const part of String(document.cookie || '').split(';')) {
      const separator = part.indexOf('=');
      if (separator < 0) continue;
      const key = part.slice(0, separator).trim();
      if (key !== name) continue;
      try {
        return decodeURIComponent(part.slice(separator + 1));
      } catch (_error) {
        return '';
      }
    }
    return '';
  };

  window.fetch = (input, init) => {
    const requestInit = init && typeof init === 'object' ? init : undefined;
    const method = String(requestInit?.method || input?.method || 'GET').toUpperCase();
    let url;
    try {
      url = new URL(typeof input === 'string' ? input : input.url, window.location.href);
    } catch (_error) {
      return originalFetch(input, init);
    }
    if (safeMethods.has(method) || url.origin !== window.location.origin) {
      return originalFetch(input, init);
    }
    const csrfToken = readCookie(csrfCookieName);
    if (!csrfToken) {
      return originalFetch(input, init);
    }
    const headers = new Headers(requestInit?.headers || input?.headers || undefined);
    headers.set('X-Album-Haven-CSRF', csrfToken);
    return originalFetch(input, {
      ...(requestInit || {}),
      credentials: requestInit?.credentials || 'same-origin',
      headers,
    });
  };
})();
