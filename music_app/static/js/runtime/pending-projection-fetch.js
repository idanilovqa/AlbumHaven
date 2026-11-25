// A gateway answering for a server it cannot reach (a tunnel without its server answers 502,
// 504 or 520-530 with its own page). The app's own 503 means "not ready yet", never unreachable.
const isGatewayFailureStatus = status => status === 502 || status === 504 || (status >= 520 && status <= 530);

// What a surface that needs the server says while the server cannot be reached, the device
// offline or the server down alike: [subject] names what could not load.
// The detail stands under an "Offline" title where the message is centered (v004).
const SERVER_UNREACHABLE_TITLE = 'Offline';
function serverUnreachableDetail(subject) {
  return `Can't load ${subject}, check your network or try again later`;
}
function serverUnreachableMessage(subject) {
  return `${SERVER_UNREACHABLE_TITLE}. ${serverUnreachableDetail(subject)}`;
}

// Reachability, so Offline does not outlast an outage after the network returns. Once a
// request finds the server unreachable, it is probed every few seconds, each probe given up after a
// few more so a tunnel holding requests cannot stall it, and at once on the browser's `online`
// event; the first answer, or any answered request, tells every surface showing Offline to load
// again (onServerReachableAgain).
const REACHABILITY_PROBE_INTERVAL_MS = 2500;
const REACHABILITY_PROBE_TIMEOUT_MS = 4000;
const serverReachability = {
  unreachable: false, probing: false, timer: 0, listening: false, listeners: new Set(),
  // Some answer while unreachable came from the device copy, so its views refresh on recovery.
  copyServed: false,
};

// The device copy's worker answered in the server's place (app-copy-worker.js marks such answers).
const isDeviceCopyAnswer = response => response?.headers?.get?.('X-Album-Haven-App-Copy') === 'cache';

function onServerReachableAgain(listener) {
  serverReachability.listeners.add(listener);
  return () => serverReachability.listeners.delete(listener);
}

function isServerUnreachable() {
  return serverReachability.unreachable;
}

// The page says Offline: the runtime found the server unreachable, or the page runs from its device
// copy without an answer yet (app-copy.js). A failure then is explained by that line, not an alert.
function isOfflineShown() {
  if (serverReachability.unreachable) return true;
  const notice = typeof document !== 'undefined' ? document.getElementById('app-copy-offline-notice') : null;
  return Boolean(notice && !notice.hidden);
}

// The page's Offline line and read-only follow this state in every tab (app-copy.js).
function tellAppCopyReachability(unreachable) {
  if (typeof window !== 'undefined') window.AlbumHavenAppCopy?.setServerUnreachable?.(unreachable);
}

function noteServerReachable() {
  if (!serverReachability.unreachable) return;
  serverReachability.unreachable = false;
  tellAppCopyReachability(false);
  clearTimeout(serverReachability.timer);
  serverReachability.timer = 0;
  const recovery = { copyServed: serverReachability.copyServed };
  serverReachability.copyServed = false;
  serverReachability.listeners.forEach((listener) => {
    try {
      listener(recovery);
    } catch (error) {
      console.error('[AlbumHaven][Reachability] A surface failed to load again.', error);
    }
  });
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
  tellAppCopyReachability(true);
  scheduleReachabilityProbe();
}

// The device going offline is known at once: the open page says so without waiting for a request.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('offline', () => noteServerUnreachable());
}

function scheduleReachabilityProbe() {
  clearTimeout(serverReachability.timer);
  serverReachability.timer = setTimeout(() => { void probeServerReachability(); }, REACHABILITY_PROBE_INTERVAL_MS);
}

// Whether the server's health check answers within a few seconds.
async function serverAnswersHealthCheck() {
  const controller = new AbortController();
  const giveUp = setTimeout(() => controller.abort(), REACHABILITY_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch('/health', { cache: 'no-store', headers: { Accept: 'application/json' }, signal: controller.signal });
    return response.status < 500;
  } catch (_error) {
    return false;
  } finally {
    clearTimeout(giveUp);
  }
}

async function probeServerReachability() {
  if (!serverReachability.unreachable || serverReachability.probing) return;
  serverReachability.probing = true;
  clearTimeout(serverReachability.timer);
  let answered = false;
  try {
    answered = await serverAnswersHealthCheck();
  } finally {
    serverReachability.probing = false;
  }
  if (answered) noteServerReachable();
  else if (serverReachability.unreachable) scheduleReachabilityProbe();
}

// A dead network often fails no request at all (a laptop whose VPN or virtual adapter stays up never
// reports `offline`): the request just hangs until the system gives up, a minute or more. So a request
// still unanswered after a few seconds checks the server: no answer to that either (or the server
// already known unreachable) gives the request up as unreachable at once. A slow server that answers
// its health check is waited on as long as it takes.
async function fetchGivingUpWhenUnreachable(url, init) {
  // Without abortable requests (a bare script host) the request is simply waited on.
  if (typeof AbortController !== 'function' || typeof AbortSignal === 'undefined'
      || typeof AbortSignal.timeout !== 'function') return fetch(url, init);
  const own = new AbortController();
  const callerSignal = init?.signal;
  const forward = () => own.abort();
  if (callerSignal?.aborted) own.abort();
  else callerSignal?.addEventListener('abort', forward, { once: true });
  let settled = false;
  let givenUp = false;
  const checkDue = AbortSignal.timeout(REACHABILITY_PROBE_TIMEOUT_MS);
  const check = async () => {
    if (settled || (!serverReachability.unreachable && await serverAnswersHealthCheck()) || settled) return;
    givenUp = true;
    own.abort();
  };
  checkDue.addEventListener('abort', check, { once: true });
  try {
    return await fetch(url, { ...init, signal: own.signal });
  } catch (error) {
    if (givenUp) throw new TypeError('Album Haven did not answer.');
    throw error;
  } finally {
    settled = true;
    checkDue.removeEventListener('abort', check);
    callerSignal?.removeEventListener('abort', forward);
  }
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
      response = await fetchGivingUpWhenUnreachable(url, init);
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
    // An answer from the device copy means the server was not reached: shown as kept data, and the
    // server still probed until it answers.
    if (isDeviceCopyAnswer(response)) {
      noteServerUnreachable();
      serverReachability.copyServed = true;
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
