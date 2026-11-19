// A gateway answering for a server it cannot reach (a tunnel without its server answers 502,
// 504 or 520-530 with its own page). The app's own 503 means "not ready yet", never unreachable.
const isGatewayFailureStatus = status => status === 502 || status === 504 || (status >= 520 && status <= 530);

// What a surface that needs the server says while the server cannot be reached: [subject] names
// what could not be loaded.
function serverUnreachableNotice(subject) {
  return {
    title: globalThis.navigator?.onLine === false ? 'Offline' : "Can't reach Album Haven",
    message: `Can't load ${subject}. Check your network or try again later.`,
  };
}

// While the server publishes the library, projection-backed requests answer 503
// with a pending code. The same request repeats once per second for up to 60 s;
// aborting init.signal cancels the wait without another request. No answer at all,
// or a gateway's, rejects with `serverUnreachable` set.
async function fetchRetryingPendingProjection(url, init) {
  const signal = init?.signal;
  const deadline = Date.now() + 60000;
  while (true) {
    let response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      // fetch rejects with a TypeError when no answer arrives; an abort is the caller's own.
      if (error?.name === 'TypeError') error.serverUnreachable = true;
      throw error;
    }
    if (isGatewayFailureStatus(response.status)) {
      throw Object.assign(new Error(`Album Haven could not be reached (${response.status}).`), {
        status: response.status, serverUnreachable: true,
      });
    }
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
