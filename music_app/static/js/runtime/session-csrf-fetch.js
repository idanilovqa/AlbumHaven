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

  const readSessionCsrfCookie = () => readCookie(csrfCookieName);
  window.readSessionCsrfCookie = readSessionCsrfCookie;

  const fetchSameOriginRead = async (input, init) => {
    try {
      return await originalFetch(input, init);
    } catch (error) {
      if (error?.name !== 'TypeError') throw error;
      return originalFetch(input, init);
    }
  };

  window.fetch = (input, init) => {
    const requestInit = init && typeof init === 'object' ? init : undefined;
    const method = String(requestInit?.method || input?.method || 'GET').toUpperCase();
    let url;
    try {
      url = new URL(input?.url ?? input, window.location.href);
    } catch (_error) {
      return originalFetch(input, init);
    }
    if (safeMethods.has(method)) {
      return url.origin === window.location.origin
        ? fetchSameOriginRead(input, init)
        : originalFetch(input, init);
    }
    if (url.origin !== window.location.origin) return originalFetch(input, init);
    const send = () => {
      const csrfToken = readSessionCsrfCookie();
      if (!csrfToken) return originalFetch(input, init);
      const headers = new Headers(requestInit?.headers || input?.headers || undefined);
      headers.set('X-Album-Haven-CSRF', csrfToken);
      return originalFetch(input, {
        ...(requestInit || {}),
        credentials: requestInit?.credentials ?? input?.credentials ?? 'same-origin',
        headers,
      });
    };
    // Owner (11-09): writes failed now and then when the page's token was missing or out of date. The server
    // refuses such a write before any work and sends the session's current token, so it is retried once.
    // A Request input or a streamed body cannot be sent twice.
    const replayable = !(typeof Request === 'function' && input instanceof Request)
      && !(typeof ReadableStream === 'function' && requestInit?.body instanceof ReadableStream);
    return send().then(async (response) => {
      if (!replayable || response?.status !== 403 || typeof response.clone !== 'function') return response;
      const detail = await response.clone().json().then((data) => data?.detail, () => null);
      return detail === 'CSRF validation failed.' ? send() : response;
    });
  };
})();
