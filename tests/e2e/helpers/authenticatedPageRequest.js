const SESSION_COOKIE = '__Host-album_haven_session';

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

export async function authenticatedPageGet(page, url, options = {}) {
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
  if (Object.keys(headers).some((name) => name.toLowerCase() === 'cookie')) {
    throw new Error('Authenticated functional requests manage the Cookie header.');
  }
  headers.Cookie = serialized.join('; ');
  return page.request.get(target.toString(), { ...options, headers });
}
