const SESSION_COOKIE = '__Host-album_haven_session';
const SESSION_CSRF_COOKIE = '__Host-album_haven_csrf';

function cookieMatchesHost(cookie, hostname) {
  const domain = String(cookie?.domain || '').replace(/^\./u, '').toLowerCase();
  const host = String(hostname || '').toLowerCase();
  return domain === host || (domain && host.endsWith(`.${domain}`));
}

function cookieMatchesPath(cookie, pathname) {
  const cookiePath = String(cookie?.path || '/');
  return pathname === cookiePath
    || pathname.startsWith(cookiePath.endsWith('/') ? cookiePath : `${cookiePath}/`);
}

function serializeCookies(cookies, target) {
  return cookies
    .filter((cookie) => cookieMatchesHost(cookie, target.hostname))
    .filter((cookie) => cookieMatchesPath(cookie, target.pathname))
    .map((cookie) => {
      const name = String(cookie?.name || '');
      const value = String(cookie?.value || '');
      if (!name || /[\s=;]/u.test(name) || /[;\r\n]/u.test(value)) {
        throw new Error('Functional browser cookie data is invalid.');
      }
      return `${name}=${value}`;
    });
}

function hasHeader(headers, expectedName) {
  const normalizedExpectedName = expectedName.toLowerCase();
  return Object.keys(headers).some((name) => name.toLowerCase() === normalizedExpectedName);
}

async function authenticatedPageOptions(page, url, options = {}, { mutation = false } = {}) {
  const current = new URL(page.url());
  const target = new URL(url, current);
  if (target.origin !== current.origin) {
    throw new Error('Authenticated functional requests must target a same-origin production route.');
  }
  const cookies = await page.context().cookies();
  const serialized = serializeCookies(cookies, target);
  if (!serialized.some((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`))) {
    throw new Error('Authenticated functional request is missing the browser session cookie.');
  }
  const headers = { ...(options.headers || {}) };
  if (hasHeader(headers, 'cookie')) {
    throw new Error('Authenticated functional requests manage the Cookie header.');
  }
  headers.Cookie = serialized.join('; ');
  if (mutation) {
    const csrfCookie = cookies.find((cookie) => (
      cookie?.name === SESSION_CSRF_COOKIE
      && cookieMatchesHost(cookie, target.hostname)
      && cookieMatchesPath(cookie, target.pathname)
    ));
    if (!csrfCookie?.value) {
      throw new Error('Authenticated mutation request is missing the browser CSRF cookie.');
    }
    if (!hasHeader(headers, 'origin')) headers.Origin = target.origin;
    if (!hasHeader(headers, 'x-album-haven-csrf')) {
      headers['X-Album-Haven-CSRF'] = String(csrfCookie.value);
    }
  }
  return { target: target.toString(), options: { ...options, headers } };
}

export async function authenticatedPageGet(page, url, options = {}) {
  const request = await authenticatedPageOptions(page, url, options);
  return page.request.get(request.target, request.options);
}

export async function authenticatedPagePost(page, url, options = {}) {
  const request = await authenticatedPageOptions(page, url, options, { mutation: true });
  return page.request.post(request.target, request.options);
}

export async function authenticatedPagePut(page, url, options = {}) {
  const request = await authenticatedPageOptions(page, url, options, { mutation: true });
  return page.request.put(request.target, request.options);
}
