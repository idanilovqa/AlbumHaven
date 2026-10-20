/* Shared authenticated transport. Context is continuity, never authorization. */
// Image transport is bounded before Blob construction or pixel decoding. These
// helpers have no URL/authority policy; their caller owns the exact destination.
function albumTopImageResourceError(code = 'resource_unavailable', status) {
  return Object.assign(new Error('Album Top image resource is unavailable.'), {code, ...(status === undefined ? {} : {status})});
}
function albumTopImageInventoryReference(value) {
  if (typeof value !== 'string' || !/^inventory-album:[1-9]\d{0,18}:[1-9]\d{0,18}$/.test(value)) return false;
  return value.split(':').slice(1).every(part => part.length < 19 || part <= '9223372036854775807');
}
function albumTopImagePngHeader(bytes) {
  const invalid = () => {throw albumTopImageResourceError('invalid_png');};
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 33) return invalid();
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (signature.some((value, index) => bytes[index] !== value)) return invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8) !== 13 || bytes[12] !== 73 || bytes[13] !== 72 || bytes[14] !== 68 || bytes[15] !== 82) return invalid();
  const width = view.getUint32(16), height = view.getUint32(20), depth = bytes[24], color = bytes[25];
  const depths = {0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16]};
  if (!width || !height || width > 2048 || height > 2048 || !depths[color]?.includes(depth)
    || bytes[26] !== 0 || bytes[27] !== 0 || bytes[28] > 1) return invalid();
  let crc = 0xffffffff;
  for (let index = 12; index < 29; index++) {
    crc ^= bytes[index];
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  if (((crc ^ 0xffffffff) >>> 0) !== view.getUint32(29)) return invalid();
  return {width, height};
}
async function readAlbumTopImageBytes(response, maximum, assertCurrent, validate = () => {}) {
  let reader = null, body = null, finished = false, failed = false, unknown = false, chunks = [], total = 0;
  try {
    // Status policy has already excluded consumed denials. Own the ordinary
    // response before caller/MIME validation can reject without draining it.
    body = response.body;
    if (!body || typeof body.getReader !== 'function') {assertCurrent();throw albumTopImageResourceError();}
    reader = body.getReader();
    if (!reader || typeof reader.read !== 'function' || typeof reader.cancel !== 'function'
      || typeof reader.releaseLock !== 'function') throw albumTopImageResourceError();
    assertCurrent();
    validate();
    const length = response.headers?.get?.('Content-Length');
    if (typeof length === 'string' && /^\d+$/.test(length) && Number(length) > maximum) throw albumTopImageResourceError('resource_budget');
    while (true) {
      assertCurrent();
      const part = await reader.read();
      assertCurrent();
      if (!part || typeof part.done !== 'boolean') throw albumTopImageResourceError();
      if (part.done) {finished = true; break;}
      const value = part.value;
      if (!(value instanceof Uint8Array) || !Number.isSafeInteger(value.byteLength)
        || value.byteLength > maximum - total) throw albumTopImageResourceError('resource_budget');
      total += value.byteLength;
      // Copy only admitted bytes; mutable platform chunks never survive as
      // trusted header/Blob inputs. Platform transient allocation is not bounded.
      chunks.push(value.slice());
    }
    assertCurrent();
    return {chunks, total};
  } catch (error) {
    failed = true; chunks.length = 0;
    if (reader && typeof reader.cancel === 'function') {
      try {await reader.cancel();} catch {unknown = true;}
    } else if (body) {
      try {if(typeof body.cancel!=='function')throw null;await body.cancel();} catch {unknown = true;}
    }
    if (error?.name === 'AbortError' || ['source_retired', 'resource_budget'].includes(error?.code)) throw error;
    throw albumTopImageResourceError();
  } finally {
    if (reader && typeof reader.releaseLock === 'function') {
      // A thrown release is unconfirmed. Do not falsely settle the owner's lane.
      try {reader.releaseLock();} catch {unknown = true;}
    }
    if (failed || !finished) chunks.length = 0;
    // All cleanup attempts precede quarantine. An unknown cancellation/lock
    // release must not settle renderer preparation or permit another lane.
    if (unknown) await new Promise(() => {});
  }
}
async function prepareAlbumTopImagePngResponse(response, assertCurrent) {
  const input = await readAlbumTopImageBytes(response, 20971520, assertCurrent, () => {
    if (response.status !== 200 || response.redirected === true
    || !/^image\/png(?:\s*;[^\r\n]*)?$/i.test(String(response.headers?.get?.('Content-Type') || '').trim())) {
      throw albumTopImageResourceError();
    }
  });
  try {
    assertCurrent();
    if (input.total < 33) throw albumTopImageResourceError('invalid_png');
    const header = new Uint8Array(33); let copied = 0;
    for (const chunk of input.chunks) {const length = Math.min(33 - copied, chunk.byteLength); header.set(chunk.subarray(0, length), copied); copied += length; if (copied === 33) break;}
    const {width, height} = albumTopImagePngHeader(header);
    assertCurrent();
    const blob = new Blob(input.chunks, {type: 'image/png'});
    assertCurrent();
    if (blob.size !== input.total || blob.type !== 'image/png') throw albumTopImageResourceError();
    let released = false;
    const prepared = {blob, width, height, release() {if (released) return; released = true; prepared.blob = null;}};
    return prepared;
  } finally {input.chunks.length = 0;}
}
function createPrivateUITransport({root = null, accountGoals = false} = {}) {
  if (typeof accountGoals !== 'boolean') throw new TypeError('Invalid private transport scope.');
  const stamp = () => (root || document.getElementById('app-shell'))?.dataset?.[accountGoals ? 'accountGoalsContext' : 'privateUiContext'] || '';
  const listeners = new Set();
  let current = stamp(), generation = 0, blocked = false, disposed = false;
  function notify() {
    for (const listener of [...listeners]) {
      if (accountGoals) {try {listener();} catch { /* One consumer cannot prevent privacy retirement. */ }}
      else listener();
    }
  }
  function invalidate() {if (!blocked) {blocked = true; generation++; notify();}}
  function sync() {
    const next = stamp();
    if (disposed || next === current) return;
    if (accountGoals) {invalidate(); return;}
    current = next; blocked = false; generation++; notify();
  }
  const observedRoot = root || document.getElementById('app-shell');
  const observer = observedRoot && typeof MutationObserver === 'function' ? new MutationObserver(sync) : null;
  observer?.observe(observedRoot, {attributes: true, attributeFilter: [accountGoals ? 'data-account-goals-context' : 'data-private-ui-context']});
  const failure = (message, status, code) => Object.assign(new Error(message), {status, code});
  const abort = () => Object.assign(new Error('Private interface request was superseded.'), {name: 'AbortError'});
  function context() {
    sync();
    const value = stamp();
    if (disposed || blocked || !/^[a-f0-9]{64}$/.test(value)) throw failure('Reload to restore this session.', 409, 'stale_context');
    return value;
  }
  function accept(payload, expected = context()) {
    if (disposed || accountGoals && blocked || stamp() !== expected) throw abort();
    if (payload?.context_ref !== expected || accountGoals && payload?.context_scope !== 'account-goals-v1') {
      invalidate();
      throw failure('Reload to restore this session.', 409, 'stale_context');
    }
    return payload;
  }
  async function request(path, {method = 'GET', body, signal, expected = context(), isCurrent} = {}) {
    if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || /[\\\x00-\x20\x7f]/.test(path)) throw failure('Invalid private request.', 400);
    // Undefined is the ordinary legacy path, including rejected-await behavior.
    // Opted-in callers own their epoch; context equality cannot infer that epoch.
    const guarded = isCurrent !== undefined;
    const assertCurrent = () => {
      if (disposed || accountGoals && blocked || signal?.aborted || stamp() !== expected) throw abort();
      if (!guarded) return;
      let current = false;
      try {current = typeof isCurrent === 'function' && isCurrent() === true;} catch { /* Retired caller. */ }
      // The caller itself can synchronously retire a signal or change context.
      if (!current || disposed || accountGoals && blocked || signal?.aborted || stamp() !== expected) throw abort();
    };
    assertCurrent();
    const options = {method, credentials: 'same-origin', cache: 'no-store', signal,
      headers: {Accept: 'application/json', [accountGoals ? 'X-AlbumHaven-Account-Context' : 'X-AlbumHaven-Context']: expected,
        ...(body === undefined ? {} : {'Content-Type': 'application/json'})},
      ...(body === undefined ? {} : {body: JSON.stringify(body)})};
    if (guarded) assertCurrent();
    let response;
    try {response = await fetch(path, options);} catch (error) {
      if (guarded) assertCurrent();
      throw error;
    }
    assertCurrent();
    if (accountGoals && [401, 403].includes(response.status)) {
      // A login/denial body may be HTML or fail to decode. Retire private owners
      // on the authenticated HTTP result before attempting any body work.
      const error = Object.assign(failure('The request could not be completed.', response.status, 'forbidden'), {responseRejected: true});
      invalidate(); throw error;
    }
    let payload;
    try {payload = await response.json();} catch (error) {
      if (guarded) assertCurrent();
      throw error;
    }
    assertCurrent();
    if (!response.ok) {
      const structuredCode = payload?.error_code;
      const code = typeof structuredCode === 'string' && structuredCode.length ? structuredCode : payload?.error;
      const error = Object.assign(failure('The request could not be completed.', response.status, code), {responseRejected: true});
      if (guarded) assertCurrent();
      if (accountGoals && ([401, 403].includes(response.status) || code === 'stale_context')) invalidate();
      throw error;
    }
    // Deliberately outside rejected-I/O catches: accept can revoke continuity,
    // retire this caller through generation listeners, and throw stale_context.
    // That current policy failure must remain its original 409, not AbortError.
    const accepted = accept(payload, expected);
    if (guarded) assertCurrent();
    return accepted;
  }
  // Remote preparation statuses are an explicit, closed transport capability.
  // The ordinary request function above intentionally keeps its legacy behavior.
  function remoteOperation(path, method) {
    if (accountGoals || typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')
      || /[\\\x00-\x20\x7f]/.test(path)) return null;
    if (path === '/album-top-catalog/remote-preparations') {
      if (method === 'POST') return 'begin';
      if (method === 'GET') return 'status';
    }
    if (method !== 'POST') return null;
    if (path === '/album-top-catalog/remote-preparations/maintain') return 'maintain';
    if (/^\/album-top-catalog\/remote-preparations\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/close$/.test(path)) return 'close';
    if (path === '/album-top-catalog/remote-search') return 'search';
    if (path === '/album-top-catalog/remote-acquisitions') return 'acquire';
    return null;
  }
  async function requestAlbumTopRemote(path, {method = 'GET', body, signal,
    expected = context(), expectedGeneration, isCurrent} = {}) {
    const operation = remoteOperation(path, method);
    if (!operation) throw failure('Invalid Album Top remote request.', 400);
    sync();
    const requestGeneration = expectedGeneration === undefined ? generation : expectedGeneration;
    const sameGeneration = () => !disposed && !blocked && generation === requestGeneration
      && Number.isSafeInteger(requestGeneration) && requestGeneration >= 0
      && typeof expected === 'string' && expected.length === 64 && /^[a-f0-9]{64}$/.test(expected)
      && current === expected && stamp() === expected;
    const assertCurrent = () => {
      if (!sameGeneration() || signal?.aborted) throw abort();
      if (isCurrent === undefined) return;
      let live = false;
      try {live = typeof isCurrent === 'function' && isCurrent() === true;} catch { /* Retired caller. */ }
      if (!live || !sameGeneration() || signal?.aborted) throw abort();
    };
    const retire = () => {
      if (!sameGeneration()) return;
      // Retire this exact transport generation before notifying reentrant owners.
      // A throwing subscriber must neither hide denial nor skip other owners.
      blocked = true; generation++;
      for (const listener of [...listeners]) {
        try {listener();} catch { /* Privacy retirement is already committed. */ }
      }
    };
    assertCurrent();
    const options = {method, credentials: 'same-origin', cache: 'no-store', signal,
      headers: {Accept: 'application/json', 'X-AlbumHaven-Context': expected,
        ...(body === undefined ? {} : {'Content-Type': 'application/json'})},
      ...(body === undefined ? {} : {body: JSON.stringify(body)})};
    // JSON serialization can synchronously dispose the caller or change actor.
    assertCurrent();
    let response;
    try {response = await fetch(path, options);} catch (error) {
      assertCurrent(); throw error;
    }
    const status = response.status;
    if (status === 401 || status === 403) {
      // Actual consumed denial belongs to the actor/context generation, even
      // when a newer form request superseded or physically aborted this one.
      if (!sameGeneration()) throw abort();
      const error = Object.assign(failure('The request could not be completed.', status, 'forbidden'), {responseRejected: true});
      retire(); throw error;
    }
    assertCurrent();
    let payload;
    try {payload = await response.json();} catch (error) {
      assertCurrent(); throw error;
    }
    assertCurrent();
    const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
    const ready = record(payload) && payload.status === 'ready' && record(payload.data);
    const data = ready ? payload.data : null;
    const capacityOperation = operation === 'begin' || operation === 'acquire';
    const stateResponse = data?.version === 2 && (
      operation === 'acquire' && status === 202 && data.state === 'in_flight'
      || capacityOperation && status === 409 && data.state === 'maintenance_required'
        && data.error === 'remote_preparation_maintenance_required'
      || capacityOperation && status === 429 && data.state === 'limit' && data.error === 'remote_acquisition_limit'
      || operation === 'acquire' && status === 503 && data.state === 'failed'
        && ['provider_unavailable', 'invalid_provider_metadata', 'provider_identity_changed'].includes(data.error));
    if (!response.ok && !stateResponse) {
      const structuredCode = payload?.error_code;
      const code = typeof structuredCode === 'string' && structuredCode.length ? structuredCode
        : payload?.error ?? (ready ? data.error_code ?? data.error : undefined);
      const error = Object.assign(failure('The request could not be completed.', status, code), {responseRejected: true});
      if (code === 'stale_context') retire();
      throw error;
    }
    const ordinaryReady = status === 200 && !['in_flight', 'maintenance_required', 'limit', 'failed'].includes(data?.state);
    if (!ready || !ordinaryReady && !stateResponse) throw failure('Album Top remote response was not acknowledged.', 502);
    if (payload.context_ref !== expected || data.context_ref !== expected) {
      retire(); throw failure('Reload to restore this session.', 409, 'stale_context');
    }
    // State/identity/capacity projection remains with the exact remote provider.
    assertCurrent();
    return payload;
  }
  async function requestAlbumTopImagePng(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw albumTopImageResourceError();
    const {inventoryAlbumRef, signal, expected, expectedGeneration, isCurrent, maxEncodedBytes} = options;
    const allowed = ['inventoryAlbumRef', 'signal', 'expected', 'expectedGeneration', 'isCurrent', 'maxEncodedBytes'];
    if (accountGoals || !options || Reflect.ownKeys(options).some(key => !allowed.includes(key))
      || !albumTopImageInventoryReference(inventoryAlbumRef)
      || maxEncodedBytes !== 20971520 || typeof isCurrent !== 'function'
      || !Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0 || !/^[a-f0-9]{64}$/.test(expected || '')) {
      throw albumTopImageResourceError();
    }
    sync();
    const sameGeneration = () => !disposed && !blocked && generation === expectedGeneration
      && current === expected && stamp() === expected;
    const assertGeneration = () => {if (!sameGeneration()) throw abort();};
    const assertCaller = () => {
      assertGeneration(); if (signal?.aborted) throw abort();
      let live = false; try {live = isCurrent() === true;} catch { /* Retired caller. */ }
      if (!live || signal?.aborted || !sameGeneration()) throw abort();
    };
    const retire = () => {
      if (!sameGeneration()) return;
      blocked = true; generation++;
      for (const listener of [...listeners]) {try {listener();} catch { /* Retirement is committed. */ }}
    };
    assertCaller();
    let response;
    try {
      response = await fetch('/library/album-artwork/' + inventoryAlbumRef, {
        method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal,
        headers: {Accept: 'image/png', 'X-AlbumHaven-Context': expected},
      });
    } catch {assertCaller(); throw albumTopImageResourceError();}
    // A consumed denial belongs to this generation, not the individual form.
    // Never inspect its headers/body or call a superseded caller before retirement.
    const status = response.status;
    if (status === 401 || status === 403) {
      assertGeneration(); retire(); throw albumTopImageResourceError('forbidden', status);
    }
    if (status !== 200) {
      let input;
      try {
        input = await readAlbumTopImageBytes(response, 65536, assertGeneration);
        assertGeneration();
        const bytes = new Uint8Array(input.total); let offset = 0;
        for (const chunk of input.chunks) {bytes.set(chunk, offset); offset += chunk.byteLength;}
        const value = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
        assertGeneration();
        const code = typeof value?.error_code === 'string' && value.error_code.length ? value.error_code : value?.error;
        if (code === 'stale_context') {retire(); throw albumTopImageResourceError('stale_context', status);}
      } catch (error) {
        if (error?.code === 'stale_context' || error?.name === 'AbortError') throw error;
        throw albumTopImageResourceError();
      } finally {if (input) input.chunks.length = 0;}
      throw albumTopImageResourceError();
    }
    return await prepareAlbumTopImagePngResponse(response, assertCaller);
  }
  const query = (path, values) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(values)) if (value !== null && value !== undefined) params.set(key, String(value));
    return `${path}?${params}`;
  };
  return Object.freeze({context, accept, request, requestAlbumTopRemote, requestAlbumTopImagePng, query, invalidate,
    dispose() {if (disposed) return; disposed = true; observer?.disconnect(); invalidate(); listeners.clear();},
    peekGeneration: () => !disposed && !blocked && stamp() === current && /^[a-f0-9]{64}$/.test(current) ? generation : null,
    generation: () => {sync(); return generation;}, subscribe(listener) {if (disposed) throw abort(); listeners.add(listener); return () => listeners.delete(listener);}});
}
const PrivateUITransport = createPrivateUITransport();
window.AlbumHavenPrivateUITransport = PrivateUITransport;
window.createAlbumHavenPrivateUITransport = createPrivateUITransport;
