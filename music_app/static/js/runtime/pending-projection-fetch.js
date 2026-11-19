// A gateway answering for a server it cannot reach (a tunnel without its server answers 502,
// 504 or 520-530 with its own page). The app's own 503 means "not ready yet", never unreachable.
const isGatewayFailureStatus = status => status === 502 || status === 504 || (status >= 520 && status <= 530);

// What a surface that needs the server says while the server cannot be reached, the device
// offline or the server down alike (the owner's wording): [subject] names what could not load.
function serverUnreachableMessage(subject) {
  return `Offline. Can't load ${subject}, check your network or try again later`;
}

// Reachability (owner round 8: after the network returned, Offline stayed for minutes). Once a
// request finds the server unreachable, it is probed every few seconds, each probe given up after a
// few more so a tunnel holding requests cannot stall it, and at once on the browser's `online`
// event; the first answer, or any answered request, tells every surface showing Offline to load
// again (onServerReachableAgain).
const REACHABILITY_PROBE_INTERVAL_MS = 2500;
const REACHABILITY_PROBE_TIMEOUT_MS = 4000;
const serverReachability = {
  unreachable: false, probing: false, timer: 0, listening: false, listeners: new Set(), keptShown: false,
};
// The device copy's worker answers with what it kept when the server cannot be reached
// (app-copy-worker.js): such an answer is not the server's, and what it showed reloads on return.
const DEVICE_COPY_HEADER = 'X-Album-Haven-App-Copy';

// Whether a surface showed data kept on the device since the server was last reachable; listeners
// of onServerReachableAgain reload it from the server.
function keptDataShownWhileUnreachable() {
  return serverReachability.keptShown;
}

function onServerReachableAgain(listener) {
  serverReachability.listeners.add(listener);
  return () => serverReachability.listeners.delete(listener);
}

function isServerUnreachable() {
  return serverReachability.unreachable;
}

function noteServerReachable() {
  if (!serverReachability.unreachable) return;
  serverReachability.unreachable = false;
  clearTimeout(serverReachability.timer);
  serverReachability.timer = 0;
  serverReachability.listeners.forEach((listener) => {
    try {
      listener();
    } catch (error) {
      console.error('[AlbumHaven][Reachability] A surface failed to load again.', error);
    }
  });
  serverReachability.keptShown = false;
}

function noteServerUnreachable() {
  if (!serverReachability.listening && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    serverReachability.listening = true;
    window.addEventListener('online', () => {
      if (serverReachability.unreachable) void probeServerReachability();
    });
  }
  if (serverReachability.unreachable) return;
  serverReachability.unreachable = true;
  scheduleReachabilityProbe();
}

function scheduleReachabilityProbe() {
  clearTimeout(serverReachability.timer);
  serverReachability.timer = setTimeout(() => { void probeServerReachability(); }, REACHABILITY_PROBE_INTERVAL_MS);
}

async function probeServerReachability() {
  if (!serverReachability.unreachable || serverReachability.probing) return;
  serverReachability.probing = true;
  clearTimeout(serverReachability.timer);
  const controller = new AbortController();
  const giveUp = setTimeout(() => controller.abort(), REACHABILITY_PROBE_TIMEOUT_MS);
  let answered = false;
  try {
    const response = await fetch('/health', { cache: 'no-store', headers: { Accept: 'application/json' }, signal: controller.signal });
    answered = response.status < 500;
  } catch (_error) {
    answered = false;
  } finally {
    clearTimeout(giveUp);
    serverReachability.probing = false;
  }
  if (answered) noteServerReachable();
  else if (serverReachability.unreachable) scheduleReachabilityProbe();
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
      if (error?.name === 'TypeError') {
        error.serverUnreachable = true;
        noteServerUnreachable();
      }
      throw error;
    }
    if (isGatewayFailureStatus(response.status)) {
      noteServerUnreachable();
      throw Object.assign(new Error(`Album Haven could not be reached (${response.status}).`), {
        status: response.status, serverUnreachable: true,
      });
    }
    if (response.headers?.get?.(DEVICE_COPY_HEADER) === 'cache') {
      serverReachability.keptShown = true;
      noteServerUnreachable();
      return response;
    }
    noteServerReachable();
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
