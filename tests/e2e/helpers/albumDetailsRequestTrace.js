/** Observe real requests and apply browser-native network conditions, never route mocks. */
export async function observeAlbumDetailsRequests(page) {
  const session = await page.context().newCDPSession(page);
  await session.send('Network.enable');
  await session.send('Network.setCacheDisabled', { cacheDisabled: true });
  const records = [];
  const byRequest = new Map();
  const onRequest = (request) => {
    const url = new URL(request.url());
    const details = url.pathname === '/album-details';
    if (!details && !url.pathname.startsWith('/cover')) return;
    const record = { kind: details ? 'details' : 'art', albumKey: url.searchParams.get('album_key'),
      url: request.url(), observedAt: Date.now(), finished: false };
    records.push(record);
    byRequest.set(request, record);
  };
  const onResponse = (response) => {
    const record = byRequest.get(response.request());
    if (record) Object.assign(record, { status: response.status(), headersObservedAt: Date.now() });
  };
  const onFinished = (request) => {
    const record = byRequest.get(request);
    if (record) Object.assign(record, { finished: true, finishedObservedAt: Date.now(), timing: request.timing() });
  };
  const onFailed = (request) => {
    onFinished(request);
    const record = byRequest.get(request);
    if (record) record.failure = request.failure()?.errorText || 'failed';
  };
  page.on('request', onRequest);
  page.on('response', onResponse);
  page.on('requestfinished', onFinished);
  page.on('requestfailed', onFailed);
  return {
    records,
    async slowDetailsAndBlockArt() {
      const origin = new URL(page.url()).origin;
      await session.send('Network.emulateNetworkConditionsByRule', {
        matchedNetworkConditions: [{ urlPattern: `${origin}/album-details*`, latency: 2000,
          downloadThroughput: -1, uploadThroughput: -1 }],
      });
      await session.send('Network.setBlockedURLs', { urls: [`${origin}/cover*`] });
    },
    async dispose() {
      page.off('request', onRequest);
      page.off('response', onResponse);
      page.off('requestfinished', onFinished);
      page.off('requestfailed', onFailed);
      try {
        await session.send('Network.emulateNetworkConditionsByRule', { matchedNetworkConditions: [] });
        await session.send('Network.setBlockedURLs', { urls: [] });
        await session.send('Network.setCacheDisabled', { cacheDisabled: false });
      } finally {
        await session.detach();
      }
    },
  };
}
