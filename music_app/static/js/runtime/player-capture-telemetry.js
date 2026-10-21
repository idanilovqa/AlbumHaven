// Staged vertical slice. Enable only after source, storage and served-worklet acceptance.
const PLAYBACK_CAPTURE_ENABLED = false;

const PlaybackCaptureTelemetry = (() => {
  'use strict';
  const PROTOCOL = 'app-rendered-position-v1';
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const REASONS = ['buffer_credit', 'queue_capacity', 'binding_capacity',
    'timing_discontinuity', 'owner_reset', 'numeric_limit'];
  const TERMINALS = ['ended', 'stopped', 'track_change', 'owner_closed',
    'capture_limit', 'transport_abandoned', 'error'];
  const MAX = Number.MAX_SAFE_INTEGER;
  // Reserve includes frozen body, canonical digest input, encoding and temporary
  // serialization. Pending records are conservatively charged separately.
  const FIXED_BYTES = 8192 + 196608;
  const LIMIT = 262144;
  let pageOwner = null;
  let successor = null;
  let nextOwner = 1;
  let networkAttempt = null;
  // Disposal cannot settle WebCrypto or release its retained input graph.
  let digestAttempt = null;
  function wakeSuccessor() {
    if (!pageOwner && !networkAttempt && !digestAttempt && successor) {
      const resume = successor.resume; successor = null; resume();
    }
  }
  const integer = (value, minimum = 0) => Number.isSafeInteger(value) && !Object.is(value, -0) && value >= minimum;
  const range = (start, count) => integer(start) && integer(count, 1) && start <= MAX - count;
  function canonical(value) {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort()
      .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
  }

  function createOwner({ getContext, postCheckpoint, clock, crypto: cryptoApi,
    diagnostic = () => {}, sendCommand = () => {}, generation = () => 0 }) {
    const serial = nextOwner++;
    const slots = Array(8).fill(null);
    const parents = Array(8).fill(null);
    const held = [];
    const bufferAtMain = [false, false, false, false];
    let enabled = false, dead = false, closing = false, closingAt = null, scope = null;
    let producerDisposed = false, creditsIssued = false, enablePromise = null;
    let lastPacket = 0, bindingSerial = 0, epoch = 1, roundRobin = 0;
    let bytes = FIXED_BYTES, frozen = null, freezing = false;
    let timer = null, probe = null, nextProbe = 1, lastProbeAt = -Infinity;
    let contextState = 'suspended', runningSince = Infinity;
    let barrierVersion = 0;
    const command = (type, fields = {}, transfers = []) => {
      if (producerDisposed) return;
      try { sendCommand({ type, ownerSerial: serial, generation: generation(), ...fields }, transfers); }
      catch (_) { abandon('capture_transport'); }
    };
    const now = () => clock.now();
    const arm = () => {
      if (!dead && timer === null) timer = clock.setTimeout(() => { timer = null; tick(); }, 100);
    };
    function abandon(reason) {
      if (dead) return;
      dead = true; enabled = false;
      if (timer !== null) clock.clearTimeout(timer);
      timer = null;
      if (frozen?.controller) frozen.controller.abort();
      // Fetch and digest retain their global ownership until actual settlement.
      held.length = 0;
      parents.fill(null); slots.fill(null); frozen = null; probe = null;
      try { sendCommand({ type: 'capture-disable', ownerSerial: serial, generation: generation() }); } catch (_) {}
      const releasedOwner = pageOwner === api && (!creditsIssued || producerDisposed);
      if (releasedOwner) pageOwner = null;
      if (successor?.owner === api) { const cancel = successor.cancel; successor = null; cancel(); }
      diagnostic(reason);
      if (releasedOwner) wakeSuccessor();
    }
    function barrier() {
      barrierVersion += 1;
      command('capture-epoch');
    }
    function findParent(handle) { return parents.find(parent => parent?.handle === handle) || null; }
    function parentFor(serialId) { return slots.find(slot => slot?.bindingSerial === serialId)?.parent || null; }
    function releaseParent(parent) {
      if (slots.some(slot => slot?.parent === parent) || frozen?.parent === parent) return;
      if (!parent.failed && parent.status !== 'terminal-acknowledged') return;
      const index = parents.indexOf(parent);
      if (index >= 0) { bytes -= parent.charge + parent.runs.length * 512 + parent.anchors.length * 512; parents[index] = null; }
    }
    function enable() {
      if (dead) return Promise.resolve(false);
      if (enabled) return Promise.resolve(true);
      if (enablePromise) return enablePromise;
      enablePromise = enableWhenAvailable();
      return enablePromise;
    }
    async function enableWhenAvailable() {
      if (dead || !integer(serial, 1)) return false;
      if (pageOwner && pageOwner !== api || networkAttempt || digestAttempt) {
        if (successor) { diagnostic('capture_owner_capacity'); return false; }
        return new Promise(resolve => {
          successor = { owner: api, cancel: () => resolve(false),
            resume: () => { enablePromise = null; void enable().then(resolve); } };
        });
      }
      pageOwner = api;
      try {
        const value = await getContext();
        if (dead || pageOwner !== api) return false;
        if (!value || value.ok !== true || value.protocol !== PROTOCOL
            || value.source_rate !== 48000 || value.output_rate !== 48000
            || typeof value.expected_scope !== 'string' || value.expected_scope.length > 256) {
          abandon('unsupported_capture_context'); return false;
        }
        scope = value.expected_scope;
        const buffers = Array.from({ length: 4 }, () => new ArrayBuffer(16384));
        enabled = true;
        creditsIssued = true;
        command('capture-enable', { sourceRate: 48000, outputRate: 48000, buffers }, buffers);
        arm();
        return !dead;
      } catch (_) { abandon('capture_context_unavailable'); return false; }
    }
    function bindTrack({ trackPath, deviceId, v1SessionId = null }) {
      if (!enabled || closing || typeof trackPath !== 'string' || !trackPath
          || trackPath.length > 32768 || !UUID.test(deviceId || '')
          || v1SessionId !== null && !UUID.test(v1SessionId)) return null;
      const index = parents.indexOf(null), charge = 2048 + trackPath.length * 2;
      if (index < 0 || bytes + charge + 512 > LIMIT) { diagnostic('capture_binding_capacity'); return null; }
      const captureId = cryptoApi.randomUUID();
      if (!UUID.test(captureId)) return null;
      const parent = { handle: Object.freeze({}), path: trackPath, deviceId, captureId,
        v1SessionId, sequence: 1, status: 'unadmitted', terminal: null, failed: false,
        runs: [], anchors: [], gaps: [], firstPending: null, firstPositive: true,
        charge, anchorsAccepted: 0, anchorsPlanned: 0, known: 0, lost: 0 };
      parents[index] = parent; bytes += charge;
      return parent.handle;
    }
    function linkStream(handle, binding) {
      const parent = findParent(handle), index = slots.indexOf(null);
      if (!enabled || closing || !parent || parent.failed || parent.terminal || index < 0
          || binding.sourceRate !== 48000 || binding.outputRate !== 48000
          || !integer(binding.generation, 1) || !integer(binding.streamId, 1)
          || !integer(binding.sourceBase48) || !integer(bindingSerial + 1, 1)) {
        diagnostic(index < 0 ? 'capture_binding_capacity' : 'unsupported_capture_rate'); return null;
      }
      const descriptor = Object.freeze({ slot: index + 1, bindingSerial: ++bindingSerial,
        generation: binding.generation, streamId: binding.streamId, sourceBase48: binding.sourceBase48 });
      slots[index] = { ...descriptor, parent, unbinding: false };
      command('capture-bind', descriptor);
      return descriptor;
    }
    function unlinkStream(descriptor) {
      const slot = slots[descriptor?.slot - 1];
      if (!slot || slot.bindingSerial !== descriptor.bindingSerial || slot.unbinding) return;
      slot.unbinding = true;
      command('capture-unbind', { bindingSerial: slot.bindingSerial });
    }
    function validatePacket(buffer) {
      if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== 16384) return null;
      const data = new Float64Array(buffer);
      if (data.some(value => !integer(value)) || data[0] !== 1094927184 || data[1] !== 1
          || data[2] !== serial || data[3] !== lastPacket + 1 || data[4] > 256
          || data[5] !== 48000 || data[6] !== 48000 || data[7] < 1
          || data[8] > 8 || data[9] > 8 || data[10] > 1 || data[11] < 1
          || data[12] < 1 || data[12] > 4 || bufferAtMain[data[12] - 1]) return null;
      for (let i = 13; i < 32; i++) if (data[i]) return null;
      for (let i = 32 + data[8] * 8; i < 96; i++) if (data[i]) return null;
      for (let i = 96 + data[9] * 4; i < 128; i++) if (data[i]) return null;
      if (!data[10]) for (let i = 128; i < 132; i++) if (data[i]) return null;
      for (let i = 132; i < 256; i++) if (data[i]) return null;
      for (let i = 256 + data[4] * 7; i < 2048; i++) if (data[i]) return null;
      for (let i = 0; i < data[4]; i++) {
        const p = 256 + i * 7;
        const slot = slots.find(item => item?.bindingSerial === data[p]);
        if (!slot || slot.ackPacket || data[p + 1] < 1 || data[p + 6] !== 0
            || !range(data[p + 2], data[p + 3]) || !range(data[p + 4], data[p + 3])
            || !range(data[p + 5], data[p + 3])) return null;
      }
      for (let i = 0; i < data[8]; i++) {
        const p = 32 + i * 8;
        const slot = slots.find(item => item?.bindingSerial === data[p]);
        if (!slot || slot.ackPacket || !range(data[p + 2], data[p + 4])
            || data[p + 3] < data[p + 2] + data[p + 4]
            || data[p + 6] < data[p + 5] || data[p + 7] < 1 || data[p + 7] > 63) return null;
        for (let j = 0; j < i; j++) if (data[32 + j * 8] === data[p]) return null;
      }
      for (let i = 0; i < data[9]; i++) {
        const p = 96 + i * 4;
        const slot = slots.find(item => item?.bindingSerial === data[p]);
        if (!slot?.unbinding || slot.ackPacket
            || data[p + 1] !== data[3] || data[p + 3] < 1) return null;
        for (let j = 0; j < i; j++) if (data[96 + j * 4] === data[p]) return null;
        let finalOrdinal = slot.lastSeenOrdinal || 0;
        for (let j = 0; j < data[4]; j++) {
          const r = 256 + j * 7;
          if (data[r] === data[p]) finalOrdinal = Math.max(finalOrdinal, data[r + 5] + data[r + 3]);
        }
        for (let j = 0; j < data[8]; j++) {
          const r = 32 + j * 8;
          if (data[r] === data[p]) finalOrdinal = Math.max(finalOrdinal, data[r + 3]);
        }
        if (data[p + 2] !== finalOrdinal) return null;
      }
      if (data[10] && (!probe || data[128] !== probe.id || data[129] < 1 || data[131] < 1)) return null;
      return data;
    }
    function collectProbe(data, received) {
      if (!data[10]) return;
      const span = received.p - probe.p, wall = received.u - probe.u;
      const bounded = span >= 0 && span <= 250 && Math.abs(wall - span) <= 100
        && contextState === 'running' && runningSince <= probe.p
        && data[131] <= 2048 && data[129] === data[7] && probe.barrierVersion === barrierVersion;
      const quantumMs = data[131] / 48;
      const anchor = { epoch: data[129], probe_id: data[128], output_frame: data[130],
        utc_lower_ms: bounded ? Math.floor(probe.u - quantumMs) : null,
        utc_upper_ms: bounded ? Math.ceil(received.u + quantumMs) : null,
        monotonic_probe_span_ms: Math.max(0, Math.ceil(span)), max_quantum_frames: data[131],
        quality: bounded ? 'bounded' : 'unknown' };
      for (const parent of parents) {
        if (!parent || parent.failed || parent.terminal || parent.anchorsPlanned >= 17282
            || parent.anchors.length >= 8 || bytes + 512 + 4096 > LIMIT) continue;
        parent.anchors.push(anchor); parent.anchorsPlanned += 1; bytes += 512;
        if (parent.firstPending === null) parent.firstPending = now();
      }
      epoch = data[129];
      probe = null;
      if (!bounded) barrier();
    }
    function drain() {
      while (held.length && !dead) {
        const packet = held[0], data = packet.data;
        if (!packet.control) {
          collectProbe(data, packet.received);
          for (let i = 0; i < data[8]; i++) {
            const p = 32 + i * 8, parent = parentFor(data[p]);
            if (parent.failed) continue;
            const gap = { ordinal_start: data[p + 2], ordinal_end: data[p + 3],
              positive_frames: data[p + 4], output_start: data[p + 5], output_end: data[p + 6],
              epoch: data[p + 1] || null, reasons: REASONS.filter((_, bit) => data[p + 7] & (1 << bit)).sort() };
            // At most eight bindings, each reserves one loss/control envelope.
            const existing = parent.gaps[0];
            if (existing) {
              const g = existing.value;
              g.ordinal_start = Math.min(g.ordinal_start, gap.ordinal_start);
              g.output_start = Math.min(g.output_start, gap.output_start);
              g.ordinal_end = Math.max(g.ordinal_end, gap.ordinal_end);
              g.output_end = Math.max(g.output_end, gap.output_end);
              g.positive_frames += gap.positive_frames;
              if (!integer(g.positive_frames, 1)) { abandon('capture_numeric_limit'); return; }
              if (g.epoch !== gap.epoch) g.epoch = null;
              g.reasons = [...new Set([...g.reasons, ...gap.reasons])].sort();
            } else parent.gaps.push({ slot: data[p], value: gap });
            if (contextState !== 'running') parent.flushRequested = true;
            if (parent.firstPending === null) parent.firstPending = now();
          }
          packet.control = true;
        }
        while (packet.index < data[4]) {
          const p = 256 + packet.index * 7, parent = parentFor(data[p]);
          if (parent.failed) { packet.index++; continue; }
          if (bytes + 512 > LIMIT || parent.runs.length === 256) return;
          if (data[p + 5] < (parent.lastOrdinalEnd || 0)) { abandon('invalid_capture_order'); return; }
          parent.runs.push({ source_start48: data[p + 2], frames: data[p + 3], output_start: data[p + 4],
            ordinal_start: data[p + 5], epoch: data[p + 1], anchor_before: null,
            anchor_after: null, quality: 'unknown' });
          bytes += 512; packet.index++;
          parent.lastOrdinalEnd = data[p + 5] + data[p + 3];
          if (contextState !== 'running') parent.flushRequested = true;
          if (parent.firstPending === null) parent.firstPending = now();
        }
        for (let i = 0; i < data[9]; i++) {
          const serialId = data[96 + i * 4], index = slots.findIndex(slot => slot?.bindingSerial === serialId);
          const parent = slots[index].parent;
          slots[index] = null;
          releaseParent(parent);
        }
        held.shift();
        const bufferId = data[12], buffer = data.buffer;
        data.fill(0); bufferAtMain[bufferId - 1] = false;
        command('capture-credit', { bufferId, buffer }, [buffer]);
      }
    }
    function acceptPacket(buffer) {
      if (dead || !enabled || producerDisposed) return { returnBuffer: false };
      const data = validatePacket(buffer);
      if (!data || held.length >= 4) { abandon('invalid_capture_packet'); return { returnBuffer: false }; }
      lastPacket = data[3]; epoch = data[7]; bufferAtMain[data[12] - 1] = true;
      for (let i = 0; i < data[4]; i++) {
        const p = 256 + i * 7, slot = slots.find(item => item?.bindingSerial === data[p]);
        slot.lastSeenOrdinal = Math.max(slot.lastSeenOrdinal || 0, data[p + 5] + data[p + 3]);
      }
      for (let i = 0; i < data[8]; i++) {
        const p = 32 + i * 8, slot = slots.find(item => item?.bindingSerial === data[p]);
        slot.lastSeenOrdinal = Math.max(slot.lastSeenOrdinal || 0, data[p + 3]);
      }
      for (let i = 0; i < data[9]; i++) slots.find(slot => slot?.bindingSerial === data[96 + i * 4]).ackPacket = data[3];
      held.push({ data, index: 0, control: false, received: { p: now(), u: clock.utc() } });
      drain(); tick();
      return { returnBuffer: false }; // Sender returns only fully copied credits.
    }
    function requestClose(handle, reason) {
      const parent = findParent(handle);
      if (!parent || parent.failed || parent.terminal || !TERMINALS.includes(reason)) return;
      parent.terminal = reason; parent.status = 'closing';
      tick();
    }
    function buildBody(parent, runs, anchors, gaps, terminal) {
      const evidence = { runs, anchors, gaps, terminal, terminal_reason: terminal ? parent.terminal : null };
      const envelope = { protocol: PROTOCOL, device_uuid: parent.deviceId,
        capture_uuid: parent.captureId, sequence: parent.sequence, evidence };
      if (parent.v1SessionId) envelope.v1_session_uuid = parent.v1SessionId;
      if (parent.firstPositive) envelope.initial_path = parent.path;
      return { evidence, body: JSON.stringify(envelope) };
    }
    async function freeze(parent) {
      if (freezing || frozen || dead || digestAttempt) return;
      const first = parent.firstPositive;
      if (first && !parent.runs.length) {
        if (parent.terminal && !slots.some(slot => slot?.parent === parent)) {
          parent.failed = true; releaseParent(parent);
        }
        return;
      }
      // Reserve before serialization/encoding or invoking external crypto. The
      // exact job, not pageOwner or a cancellation flag, owns settlement.
      const job = { owner: api, batch: null };
      digestAttempt = job; freezing = true;
      let prepared = null, gaps = null, batch = null;
      let input = null, encoded = null, digest = null, evidenceCharge = 0;
      try {
        let count = Math.min(256, parent.runs.length), anchorCount = Math.min(8, parent.anchors.length);
        gaps = parent.gaps.map(item => item.value);
        while (true) {
          const terminal = Boolean(parent.terminal && count === parent.runs.length
            && !slots.some(slot => slot?.parent === parent) && !held.length);
          prepared = buildBody(parent, parent.runs.slice(0, count), parent.anchors.slice(0, anchorCount), gaps, terminal);
          if (new TextEncoder().encode(prepared.body).byteLength <= 32768) break;
          if (count > 1) count = Math.floor(count / 2);
          else if (anchorCount) anchorCount--;
          else { parent.failed = true; diagnostic('capture_too_large'); releaseParent(parent); return; }
        }
        if (!count && !anchorCount && !gaps.length && !prepared.evidence.terminal) return;
        if (dead) return;
        // Frozen bytes exist before hashing or fetch; close/retries cannot change them.
        batch = { parent, body: prepared.body, sequence: parent.sequence, evidence: prepared.evidence,
          terminal: prepared.evidence.terminal, anchorCount,
          known: prepared.evidence.runs.reduce((sum, run) => sum + run.frames, 0),
          lost: gaps.reduce((sum, gap) => sum + gap.positive_frames, 0),
          digest: null, firstAttempt: null, retryAt: 0, attempts: 0, pending: false, controller: null };
        frozen = batch; job.batch = batch;
        parent.runs.splice(0, count); parent.anchors.splice(0, anchorCount); parent.gaps.length = 0;
        evidenceCharge = (count + anchorCount) * 512;
        parent.firstPending = parent.runs.length || parent.anchors.length ? now() : null;
        parent.flushRequested = false;
        parent.firstPositive = false;
        prepared = null; gaps = null;
        input = `${PROTOCOL}\n${batch.sequence}\n${canonical(batch.evidence)}`;
        encoded = new TextEncoder().encode(input);
        digest = await cryptoApi.subtle.digest('SHA-256', encoded);
        if (dead || frozen !== batch || digestAttempt !== job
            || job.owner !== api || job.batch !== batch) return;
        batch.digest = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
      } catch (_) { abandon('capture_digest_failed'); }
      finally {
        const resume = batch !== null && !dead && frozen === batch && digestAttempt === job;
        // Async locals retain evidence even after abandon() clears frozen.
        // Release these aliases and their transferred charge before admission.
        if (batch) batch.evidence = null;
        prepared = null; gaps = null; input = null; encoded = null; digest = null;
        bytes -= evidenceCharge; evidenceCharge = 0;
        batch = null; parent = null;
        job.batch = null; job.owner = null;
        freezing = false;
        if (digestAttempt === job) digestAttempt = null;
        wakeSuccessor();
        if (resume && !dead && !digestAttempt) { drain(); tick(); }
      }
    }
    async function attempt(batch, keepalive = false) {
      if (dead || batch !== frozen || batch.pending || networkAttempt || !batch.digest) return;
      if (batch.firstAttempt === null) batch.firstAttempt = now();
      if (now() - batch.firstAttempt >= 120000) { abandon('transport_abandoned'); return; }
      batch.pending = true; batch.attempts++;
      const controller = new AbortController(); batch.controller = controller;
      const timeout = clock.setTimeout(() => controller.abort(), 10000);
      const promise = Promise.resolve().then(() => postCheckpoint(batch.body, scope, { signal: controller.signal, keepalive }));
      networkAttempt = promise;
      try {
        const response = await promise;
        if (dead || frozen !== batch) return;
        const data = response.data;
        if (response.status >= 200 && response.status < 300) {
          if (!data || data.ok !== true || data.capture_uuid !== batch.parent.captureId
              || data.sequence !== batch.sequence || data.digest !== batch.digest
              || data.terminal !== batch.terminal
              || !integer(data.accepted_known_frames) || !integer(data.accepted_lost_frames)) {
            abandon('invalid_capture_receipt'); return;
          }
          const parent = batch.parent;
          const known = batch.known;
          const lost = batch.lost;
          if (data.accepted_known_frames !== parent.known + known || data.accepted_lost_frames !== parent.lost + lost) {
            abandon('invalid_capture_receipt'); return;
          }
          parent.known = data.accepted_known_frames; parent.lost = data.accepted_lost_frames;
          parent.anchorsAccepted += batch.anchorCount;
          if (!integer(parent.sequence + 1, 1)) { abandon('capture_numeric_limit'); return; }
          parent.sequence++; parent.status = data.terminal ? 'terminal-acknowledged' : parent.terminal ? 'closing' : 'open';
          frozen = null; releaseParent(parent);
        } else if (response.status === 401 || response.status === 403 || data?.error === 'capture_scope_changed') {
          abandon('capture_scope_lost');
        } else if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          batch.parent.failed = true; frozen = null; releaseParent(batch.parent);
          diagnostic(data?.error || 'capture_rejected');
        }
      } catch (_) { /* Unknown commit outcome: retain this exact batch. */ }
      finally {
        clock.clearTimeout(timeout); batch.pending = false; batch.controller = null;
        if (networkAttempt === promise) networkAttempt = null;
        wakeSuccessor();
        if (!dead && frozen === batch) {
          const backoff = [1000, 2000, 4000, 8000, 16000, 30000][Math.min(batch.attempts - 1, 5)];
          batch.retryAt = now() + backoff + (serial * 31 + batch.sequence * 17 + batch.attempts * 13) % 251;
        }
        if (!dead) { drain(); tick(); }
      }
    }
    function tick() {
      if (!enabled || dead) return;
      const time = now();
      if (closingAt !== null && time - closingAt >= 120000) { abandon('transport_abandoned'); return; }
      if (frozen?.firstAttempt !== null && frozen?.firstAttempt !== undefined
          && time - frozen.firstAttempt >= 120000) { abandon('transport_abandoned'); return; }
      if (!closing && contextState === 'running' && !probe && time - lastProbeAt >= 5000) {
        if (time - lastProbeAt > 10000 && Number.isFinite(lastProbeAt)) barrier();
        if (!integer(nextProbe, 1)) { abandon('capture_numeric_limit'); return; }
        probe = { id: nextProbe++, p: time, u: clock.utc(), epoch, barrierVersion };
        lastProbeAt = time;
        command('capture-probe', { probe_id: probe.id, epoch });
      }
      if (!frozen && !freezing) {
        for (let step = 0; step < 8; step++) {
          const index = (roundRobin + step) % 8, parent = parents[index];
          if (!parent || parent.failed || parent.status === 'terminal-acknowledged') continue;
          if (parent.firstPositive && !parent.runs.length && !parent.terminal) continue;
          if (!parent.runs.length && !parent.anchors.length && !parent.gaps.length && !parent.terminal) continue;
          if (parent.terminal || parent.flushRequested || parent.runs.length >= 256 || held.length
              || parent.firstPositive && parent.runs.length
              || parent.firstPending !== null && time - parent.firstPending >= 5000) {
            roundRobin = (index + 1) % 8;
            void freeze(parent); break;
          }
        }
      }
      if (frozen && !freezing && time >= frozen.retryAt) void attempt(frozen);
      if (closing && producerDisposed && !frozen && !freezing && !held.length && parents.every(parent => !parent)) {
        abandon('capture_closed'); return;
      }
      arm();
    }
    function onContextState(value) {
      if (dead) {
        if (value === 'closed') {
          producerDisposed = true;
          if (pageOwner === api) { pageOwner = null; wakeSuccessor(); }
        }
        return;
      }
      if (value === contextState) return;
      contextState = value;
      if (value === 'closed') {
        // Only confirmed physical context teardown reaches this branch. Any
        // unconverted/in-flight packet is deliberately abandoned, never guessed
        // into a loss count. Compact evidence/frozen retries still drain normally.
        producerDisposed = true; held.length = 0; slots.fill(null); probe = null;
        bufferAtMain.fill(false);
        closing = true; if (closingAt === null) closingAt = now();
        for (const parent of parents) {
          if (!parent) continue;
          if (parent.failed || parent.status === 'terminal-acknowledged') releaseParent(parent);
          else { parent.terminal = 'owner_closed'; parent.status = 'closing'; }
        }
        diagnostic('capture_context_disposed');
        tick();
        return;
      }
      runningSince = value === 'running' ? now() : Infinity;
      if (value !== 'running') for (const parent of parents) if (parent) parent.flushRequested = true;
      barrier(); lastProbeAt = -Infinity;
      tick();
    }
    function close(reason = 'owner_closed') {
      if (dead) return;
      if (!enabled) { abandon('capture_closed'); return; }
      closing = true;
      if (closingAt === null) closingAt = now();
      for (const parent of parents) if (parent) requestClose(parent.handle, TERMINALS.includes(reason) ? reason : 'owner_closed');
      for (const slot of slots) if (slot) unlinkStream(slot);
      command('capture-epoch'); tick();
    }
    function pagehide() {
      if (frozen && !frozen.pending && !networkAttempt && !freezing) void attempt(frozen, true);
    }
    const api = { enable, bindTrack, linkStream, unlinkStream, acceptPacket, requestClose,
      onContextState, onScopeLost: () => abandon('capture_scope_lost'), close, tick, pagehide };
    return api;
  }
  return Object.freeze({ createOwner });
})();
