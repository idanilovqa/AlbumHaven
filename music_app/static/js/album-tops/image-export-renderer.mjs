import {layoutAlbumTopImage, validateAlbumTopImageModel} from './image-export-layout.mjs';

// Held core: injected owners prove authority, acquire bounded PNGs and own the
// browser. No URL, DOM, network, persistent state or process-global cache here.
const INPUT_BYTES = 20971520, OUTPUT_BYTES = 67108864, DECODED_BYTES = 128000000;
const BINDING_KEYS = ['scopeKey', 'topRef', 'revision', 'sourceKey'];
const PORTS = ['isCurrent', 'onState', 'scheduleFrame', 'cancelFrame', 'createSurface',
  'prepareResource', 'decodeResource', 'encodePng'];
const CONTEXT_METHODS = ['measureText', 'setTransform', 'clearRect', 'fillRect', 'save',
  'restore', 'beginPath', 'rect', 'roundRect', 'clip', 'fill', 'drawImage', 'fillText'];
const STALE = Symbol('retired image generation');
const fontValid = value => typeof value === 'string' && value.length > 0 && value.length <= 256
  && !/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value);
const dimension = value => Number.isSafeInteger(value) && value > 0 && value <= 2048;
const png = value => value instanceof Blob && Number.isSafeInteger(value.size)
  && value.size > 0 && value.type === 'image/png';
const equalBinding = (a, b) => BINDING_KEYS.every(key => a[key] === b[key]);
const frozenBinding = value => Object.freeze(Object.fromEntries(BINDING_KEYS.map(key => [key, value[key]])));

export function createAlbumTopImageRenderer(dependencies) {
  if (!dependencies || Reflect.ownKeys(dependencies).length !== PORTS.length
    || PORTS.some(key => typeof dependencies[key] !== 'function')) throw new TypeError('Invalid image renderer ports.');
  const ports = Object.fromEntries(PORTS.map(key => [key, dependencies[key]]));
  let generation = 0, scope = null, desired = null, active = null, frame = null;
  let dead = false, quarantined = false, notifications = true, accepted = null;
  let cleanupDepth = 0;
  const released = new WeakSet();
  let resolveClosed;
  const closed = new Promise(resolve => {resolveClosed = resolve;});
  let state = Object.freeze({status: 'idle', generation: 0, binding: null, fontGeneration: null,
    hasPrevious: false, canDownload: false, output: null, error: null});

  function publish(status, error = null, output = null) {
    state = Object.freeze({status, generation, binding: scope ? frozenBinding(scope.binding) : null,
      fontGeneration: scope?.fontGeneration ?? null,
      hasPrevious: (status === 'pending' || status === 'error') && accepted !== null,
      canDownload: status === 'ready', output: output ? Object.freeze({...output}) : null, error});
    if (notifications) {
      try {ports.onState(state);}
      catch {notifications = false; stop();}
    }
  }
  function cancelFrame() {
    const queued = frame; frame = null;
    if (!queued) return;
    queued.cancelled = true;
    if (queued.token != null) {
      try {ports.cancelFrame(queued.token);}
      catch {stop();}
    }
  }
  function quarantine() {
    quarantined = true;
    stop('adapter_failed');
  }
  // A normal return is the port's confirmation of physical relinquishment.
  // A throw is never treated as a successful release, even if it might be one.
  function release(value) {
    if (!value || typeof value !== 'object') return true;
    if (released.has(value)) return !quarantined;
    released.add(value);
    try {
      if (typeof value.release !== 'function') {
        if ('image' in value || 'context' in value || 'blob' in value) {quarantine(); return false;}
        return true;
      }
      value.release(); return true;
    } catch {quarantine(); return false;}
  }
  function clearCache(owner) {
    if (!owner) return;
    cleanupDepth++;
    try {
      const entries = [...owner.cache.values()]; owner.cache.clear();
      for (const entry of entries) if (release(entry.handle)) owner.bytes -= entry.bytes;
    } finally {
      cleanupDepth--;
      finishClosed();
    }
  }
  function finishClosed() {
    if (dead && !active && cleanupDepth === 0 && !quarantined) resolveClosed();
  }
  function retire(owner) {
    if (!owner) return;
    owner.retired = true;
    if (active?.scope === owner) active.abort.abort();
    else clearCache(owner);
  }
  function stop(error = null) {
    if (dead) return;
    dead = true; desired = null; accepted = null;
    const old = scope; scope = null;
    cancelFrame(); retire(old);
    publish('disposed', error);
    finishClosed();
  }
  function retireCurrent(owner) {
    if (dead || scope !== owner || owner.retired) return;
    const retiringGeneration = generation;
    desired = null; accepted = null; scope = null;
    cancelFrame(); retire(owner);
    if (!dead && scope === null && generation === retiringGeneration) publish('error', 'source_retired');
  }
  function current(owner) {
    if (dead || !owner || owner.retired || scope !== owner) return false;
    let valid = false;
    try {valid = ports.isCurrent(owner.binding, owner.fontGeneration) === true;} catch { /* retired below */ }
    if (!valid) retireCurrent(owner);
    return valid && !dead && !owner.retired && scope === owner;
  }
  function check(task, latest = true) {
    if (!current(task.scope) || latest && task.generation !== generation) throw STALE;
  }
  function schedule() {
    if (dead || active || frame || !desired) return;
    const queued = {token: null, installing: true, called: false, cancelled: false};
    frame = queued;
    const callback = () => {
      if (queued.cancelled || dead) return;
      if (queued.installing || queued.called) {stop('adapter_failed'); return;}
      queued.called = true;
      if (frame === queued) frame = null;
      if (active || !desired) return;
      const next = desired; desired = null;
      const task = {...next, abort: new AbortController(), surface: null};
      active = task;
      void run(task);
    };
    try {
      queued.token = ports.scheduleFrame(callback);
      queued.installing = false;
      if (queued.token == null) {stop('adapter_failed'); return;}
      if (queued.cancelled || dead) {
        try {ports.cancelFrame(queued.token);} catch {stop('adapter_failed');}
      }
    } catch {queued.installing = false; stop('adapter_failed');}
  }
  function replace(input, options) {
    if (dead) return null;
    if (generation === Number.MAX_SAFE_INTEGER) {stop('adapter_failed'); return null;}
    const ownGeneration = ++generation;
    let admitted, fontGeneration;
    try {
      admitted = validateAlbumTopImageModel(input);
      fontGeneration = options?.fontGeneration;
      if (!fontValid(fontGeneration) || admitted.status !== 'ready') throw STALE;
    } catch {
      if (dead || generation !== ownGeneration) return ownGeneration;
      const old = scope; scope = null; desired = null; accepted = null;
      cancelFrame(); retire(old);
      if (!dead && generation === ownGeneration) publish('error', 'invalid_input');
      return ownGeneration;
    }
    if (dead || generation !== ownGeneration) return ownGeneration;
    const model = admitted.model;
    if (!scope || !equalBinding(scope.binding, model.binding) || scope.fontGeneration !== fontGeneration) {
      const old = scope;
      scope = {binding: frozenBinding(model.binding), fontGeneration, cache: new Map(), bytes: 0, retired: false};
      accepted = null; retire(old);
    }
    if (dead || generation !== ownGeneration) return ownGeneration;
    desired = {model, scope, generation: ownGeneration};
    publish('pending');
    schedule();
    return ownGeneration;
  }
  function currentBlob(requestedGeneration) {
    if (dead || state.status !== 'ready' || requestedGeneration !== generation || !accepted) return null;
    const owner = scope, previous = accepted;
    if (!current(owner) || accepted !== previous || requestedGeneration !== generation || state.status !== 'ready') return null;
    return accepted.blob;
  }
  async function portPromise(name, args, failure, malformed = failure) {
    let result;
    try {result = ports[name](...args);} catch {throw failure;}
    if (!(result instanceof Promise)) {
      release(result);
      throw malformed;
    }
    try {return await result;} catch {throw failure;}
  }
  async function asset(task, kind, member = null) {
    const owner = task.scope, key = kind === 'brand' ? 'brand' : 'cover:' + member.itemRef;
    const cached = owner.cache.get(key);
    if (cached) {
      if (cached.albumRef !== (member?.albumRef ?? null)) throw 'invalid_resource';
      return cached.handle;
    }
    if (owner.cache.size >= 5001) throw 'resource_budget';
    let prepared = null, handle = null, reserved = 0, adopted = false;
    try {
      check(task);
      const request = Object.freeze({binding: frozenBinding(owner.binding), kind,
        itemRef: member?.itemRef ?? null, albumRef: member?.albumRef ?? null,
        maxEncodedBytes: INPUT_BYTES, maxWidth: 2048, maxHeight: 2048, signal: task.abort.signal});
      prepared = await portPromise('prepareResource', [request], 'resource_unavailable', 'invalid_resource');
      // Same-source settings may reuse this captured input, but source retirement may not.
      check(task, false);
      if (!prepared || released.has(prepared) || typeof prepared.release !== 'function' || !png(prepared.blob)
        || prepared.blob.size > INPUT_BYTES || !dimension(prepared.width) || !dimension(prepared.height)) throw 'invalid_resource';
      const bytes = prepared.width * prepared.height * 4;
      if (!Number.isSafeInteger(bytes) || owner.bytes + bytes > DECODED_BYTES) throw 'resource_budget';
      reserved = bytes; owner.bytes += bytes;
      handle = await portPromise('decodeResource', [prepared, {signal: task.abort.signal}], 'resource_unavailable', 'invalid_resource');
      check(task, false);
      if (!handle || released.has(handle) || typeof handle.release !== 'function' || !handle.image
        || handle.width !== prepared.width || handle.height !== prepared.height) throw 'invalid_resource';
      owner.cache.set(key, {handle, bytes, albumRef: member?.albumRef ?? null});
      adopted = true;
      return handle;
    } finally {
      if (!adopted) {
        const confirmed = release(handle);
        if (confirmed) owner.bytes -= reserved;
      }
      release(prepared);
    }
  }
  function configureText(context, style, family) {
    context.font = `${style.fontWeight} ${style.fontSize}px ${family}`;
    context.textAlign = 'left'; context.textBaseline = 'alphabetic'; context.direction = 'ltr';
  }
  function measure(task, text, style) {
    check(task);
    const context = task.surface.context;
    configureText(context, style, style.fontFamily);
    const metric = context.measureText(text);
    check(task);
    return {advance: metric.width, left: -metric.actualBoundingBoxLeft, right: metric.actualBoundingBoxRight,
      ascent: Math.max(0, metric.actualBoundingBoxAscent), descent: Math.max(0, metric.actualBoundingBoxDescent)};
  }
  function paint(task, layout, handles, brand) {
    const context = task.surface.context;
    const call = (name, ...args) => {check(task); context[name](...args); check(task);};
    const path = (box, inset = 0) => {
      const coordinates = [box.x + inset, box.y + inset, box.width - 2 * inset, box.height - 2 * inset];
      if (box.radius) call('roundRect', ...coordinates, Math.max(0, box.radius - inset));
      else call('rect', ...coordinates);
    };
    const contain = (handle, box) => {
      const scale = Math.min(box.width / handle.width, box.height / handle.height);
      const width = handle.width * scale, height = handle.height * scale;
      call('drawImage', handle.image, box.x + (box.width - width) / 2, box.y + (box.height - height) / 2, width, height);
    };
    check(task); task.surface.resize(layout.width, layout.height); check(task);
    call('setTransform', 1, 0, 0, 1, 0, 0);
    context.globalAlpha = 1; context.filter = 'none'; context.globalCompositeOperation = 'source-over';
    context.shadowBlur = 0; context.shadowColor = 'rgba(0,0,0,0)'; context.shadowOffsetX = 0; context.shadowOffsetY = 0;
    call('clearRect', 0, 0, layout.width, layout.height);
    context.fillStyle = layout.options.backgroundColor;
    call('fillRect', 0, 0, layout.width, layout.height);
    for (let i = 0; i < layout.items.length; i++) {
      const item = layout.items[i], cover = item.cover;
      call('save'); call('beginPath'); path(cover); call('clip'); contain(handles[i], cover); call('restore');
      context.fillStyle = cover.frameColor;
      call('beginPath'); path(cover); path(cover, cover.frameWidth); call('fill', 'evenodd');
      if (item.numberBadge) {
        const badge = item.numberBadge; context.fillStyle = badge.color;
        call('fillRect', badge.x, badge.y, badge.width, badge.height);
      }
    }
    for (const text of layout.texts) {
      configureText(context, text, layout.fontFamily); context.fillStyle = text.color;
      call('fillText', text.text, text.baselineX, text.baseline);
    }
    contain(brand, layout.branding);
  }
  async function run(task) {
    let failure = 'surface_unavailable';
    try {
      check(task);
      task.surface = ports.createSurface();
      check(task);
      if (!task.surface || typeof task.surface.release !== 'function' || typeof task.surface.resize !== 'function'
        || !task.surface.context || CONTEXT_METHODS.some(name => typeof task.surface.context[name] !== 'function')) throw failure;
      const result = layoutAlbumTopImage(task.model, (text, style) => measure(task, text, style));
      check(task);
      if (result.status !== 'ready') throw result.code;
      const layout = result.layout, handles = [];
      failure = 'invalid_resource';
      for (const member of task.model.items) {
        handles.push(await asset(task, 'cover', member));
        check(task);
      }
      const brand = await asset(task, 'brand'); check(task);
      failure = 'paint_failed'; paint(task, layout, handles, brand); check(task);
      failure = 'encode_failed';
      const blob = await portPromise('encodePng', [task.surface, {signal: task.abort.signal, maxBytes: OUTPUT_BYTES}], failure);
      check(task);
      // Blob subclasses may run user code in metadata getters. Snapshot once,
      // before the last currentness check; publication reads only primitives.
      const bytes = blob instanceof Blob ? blob.size : null;
      const type = blob instanceof Blob ? blob.type : null;
      if (!Number.isSafeInteger(bytes) || bytes <= 0 || type !== 'image/png') throw 'invalid_png';
      if (bytes > OUTPUT_BYTES) throw 'output_budget';
      release(task.surface); task.surface = null;
      check(task);
      accepted = {blob};
      publish('ready', null, {width: layout.width, height: layout.height, bytes});
    } catch (error) {
      if (error !== STALE && current(task.scope) && task.generation === generation) {
        const codes = ['invalid_metrics', 'segmentation_unavailable', 'unreadable_text', 'text_budget', 'empty_source',
          'side_limit', 'pixel_limit', 'resource_unavailable', 'invalid_resource', 'resource_budget',
          'surface_unavailable', 'paint_failed', 'encode_failed', 'invalid_png', 'output_budget'];
        publish('error', codes.includes(error) ? error : failure);
      }
    } finally {
      release(task.surface);
      if (task.scope.retired || dead) clearCache(task.scope);
      active = null;
      finishClosed();
      schedule();
    }
  }
  return Object.freeze({replace, read: () => state, currentBlob,
    dispose() {stop(); return closed;}});
}
