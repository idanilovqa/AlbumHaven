function isLoopbackHostname(hostname) {
  const normalized = String(hostname || '').toLowerCase();
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized === '[::1]';
}

export function observeNonLoopbackHttpRequests(page) {
  const requests = [];
  const onRequest = (request) => {
    const url = new URL(request.url());
    if (!['http:', 'https:'].includes(url.protocol) || isLoopbackHostname(url.hostname)) return;
    requests.push({
      method: request.method(),
      resourceType: request.resourceType(),
      url: url.toString(),
    });
  };
  page.on('request', onRequest);
  return {
    snapshot() {
      return requests.map((request) => ({ ...request }));
    },
    stop() {
      page.off('request', onRequest);
    },
  };
}
