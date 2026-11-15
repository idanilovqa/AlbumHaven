// While the server publishes the library, projection-backed requests answer 503
// with a pending code. The same request repeats once per second for up to 60 s;
// aborting init.signal cancels the wait without another request.
async function fetchRetryingPendingProjection(url, init) {
  const signal = init?.signal;
  const deadline = Date.now() + 60000;
  while (true) {
    const response = await fetch(url, init);
    if (response.status !== 503) return response;
    const pending = await response.clone().json().catch(() => null);
    if (!['search_projection_pending', 'gallery_projection_pending'].includes(pending?.code) || Date.now() >= deadline) return response;
    await new Promise((resolve, reject) => {
      let timer;
      const abort = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        reject(Object.assign(new Error('Request cancelled'), { name: 'AbortError' }));
      };
      if (signal?.aborted) return abort();
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => {
        signal?.removeEventListener('abort', abort);
        resolve();
      }, 1000);
    });
  }
}
