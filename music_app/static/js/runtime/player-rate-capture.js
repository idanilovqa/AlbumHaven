// Observation only. A failed report must never control playback or create a new clock.
const PlaybackRateCapture = (() => {
  'use strict';
  const PROTOCOL = 'app-rate-tagged-position-v1';
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const LIMIT = 131072, BODY_LIMIT = 32768, ROW_CHARGE = 512;
  const TERMINALS = new Set(['ended', 'stopped', 'track_change', 'owner_closed', 'capture_limit', 'transport_abandoned', 'error']);
  const owners = new Set();
  let job = null; // Retained until actual digest/fetch settlement, even after abandonment.
  const safe = (n, min = 0) => Number.isSafeInteger(n) && !Object.is(n, -0) && n >= min;
  const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`
    : JSON.stringify(value);
  function validSpan(s) {
    return s && Object.keys(s).sort().join(',') === 'continuity_serial,coordinate_start_frame,frame_count,map_ref,output_start_frame,repeat_count'
      && UUID.test(s.map_ref) && safe(s.coordinate_start_frame) && safe(s.output_start_frame)
      && safe(s.frame_count, 1) && safe(s.repeat_count, 1) && safe(s.continuity_serial, 1)
      && safe(s.coordinate_start_frame + s.frame_count)
      && safe(s.frame_count * s.repeat_count, 1)
      && safe(s.output_start_frame + s.frame_count * s.repeat_count);
  }
  function createOwner({ ownerUuid, coordinateRateHz, deviceUuid, postCheckpoint,
    crypto: cryptoApi, clock, diagnostic = () => {}, onDisable = () => {} }) {
    if (!UUID.test(ownerUuid) || !UUID.test(deviceUuid) || !safe(coordinateRateHz, 8000)
        || coordinateRateHz > 192000 || owners.size >= 2) return null;
    const parents = new Set(), groups = [];
    let dead = false, retiring = false, timer = null, bytes = 0, ownerSequence = 1, frozen = null;
    let lastOutputEnd = null;
    const now = () => clock.now();
    const arm = () => { if (!dead && timer === null) timer = clock.setTimeout(() => { timer = null; tick(); }, 100); };
    function abandon(reason) {
      if (dead) return;
      dead = true;
      if (timer !== null) clock.clearTimeout(timer);
      timer = null;
      frozen?.controller?.abort();
      groups.length = 0; parents.clear(); bytes = 0; frozen = null;
      owners.delete(api);
      try { onDisable(); } catch (_) {}
      try { diagnostic(reason); } catch (_) {}
    }
    function release(parent) {
      if (parent.closed && !groups.some(g => g.parent === parent) && frozen?.parent !== parent) parents.delete(parent);
    }
    function bindParent({ editionSelectionRef = null, resolveSelection = null, readyForSeal = null } = {}) {
      if (dead || retiring || parents.size >= 8 || editionSelectionRef !== null && !UUID.test(editionSelectionRef)
          || resolveSelection !== null && typeof resolveSelection !== 'function'
          || readyForSeal !== null && typeof readyForSeal !== 'function') return null;
      const captureId = cryptoApi.randomUUID();
      if (!UUID.test(captureId)) return null;
      const parent = { captureId, sequence: 1, known: 0, admitted: false, closed: false,
        selected: editionSelectionRef, resolver: resolveSelection, readyForSeal, sealed: false };
      parents.add(parent); return parent;
    }
    function append(parent, spans) {
      if (dead || !parents.has(parent) || parent.closed || !Array.isArray(spans) || spans.length > 256) return false;
      for (const value of spans) {
        if (!validSpan(value) || lastOutputEnd !== null && value.output_start_frame < lastOutputEnd) {
          abandon('invalid_rate_capture_span'); return false;
        }
        let group = groups.at(-1);
        if (!group || group.parent !== parent || group.terminal) {
          group = { parent, spans: [], terminal: null, created: now() }; groups.push(group);
        }
        const tail = group.spans.at(-1), end = value.output_start_frame + value.frame_count * value.repeat_count;
        if (tail && tail.map_ref === value.map_ref && tail.continuity_serial === value.continuity_serial
            && tail.output_start_frame + tail.frame_count * tail.repeat_count === value.output_start_frame
            && tail.coordinate_start_frame === value.coordinate_start_frame && tail.frame_count === value.frame_count
            && safe(tail.repeat_count + value.repeat_count, 1)
            && safe(tail.frame_count * (tail.repeat_count + value.repeat_count), 1)) {
          tail.repeat_count += value.repeat_count;
        } else if (tail && tail.repeat_count === 1 && value.repeat_count === 1
            && tail.map_ref === value.map_ref && tail.continuity_serial === value.continuity_serial
            && tail.output_start_frame + tail.frame_count === value.output_start_frame
            && tail.coordinate_start_frame + tail.frame_count === value.coordinate_start_frame
            && safe(tail.frame_count + value.frame_count, 1)) {
          tail.frame_count += value.frame_count;
        } else {
          if (bytes + ROW_CHARGE > LIMIT || groups.length > 8) { abandon('rate_capture_capacity'); return false; }
          group.spans.push({ ...value }); bytes += ROW_CHARGE;
        }
        lastOutputEnd = end;
      }
      arm(); return true;
    }
    function close(parent, reason) {
      if (dead || !parents.has(parent) || parent.closed || !TERMINALS.has(reason)) return;
      parent.closed = true;
      let group = groups.at(-1);
      if (!group || group.parent !== parent) {
        if (!parent.admitted && frozen?.parent !== parent && !groups.some(g => g.parent === parent)) { release(parent); return; }
        group = { parent, spans: [], terminal: null, created: now() }; groups.push(group);
      }
      group.terminal = reason;
      if (groups.length > 8) { abandon('rate_capture_capacity'); return; }
      arm();
    }
    function prepare() {
      const group = groups[0], parent = group.parent;
      if (!parent.sealed) {
        if (!parent.selected && parent.resolver) {
          try { const ref = parent.resolver(); if (UUID.test(ref || '')) parent.selected = ref; } catch (_) {}
        }
        parent.sealed = true; parent.resolver = null; parent.readyForSeal = null;
      }
      const spans = [];
      const evidence = { owner_uuid: ownerUuid, owner_sequence: ownerSequence,
        coordinate_rate_hz: coordinateRateHz, spans, terminal: false, terminal_reason: null };
      const envelope = { protocol: PROTOCOL, device_uuid: deviceUuid, capture_uuid: parent.captureId,
        sequence: parent.sequence, evidence, ...(parent.selected ? { edition_selection_ref: parent.selected } : {}) };
      let body = '', count = 0;
      // Test full UTF-8 envelope INCLUDING terminal metadata before accepting a row.
      while (count < group.spans.length && count < 256) {
        spans.push(group.spans[count]);
        evidence.terminal = Boolean(group.terminal && count + 1 === group.spans.length);
        evidence.terminal_reason = evidence.terminal ? group.terminal : null;
        const candidate = JSON.stringify(envelope);
        if (new TextEncoder().encode(candidate).length > BODY_LIMIT) { spans.pop(); break; }
        body = candidate; count += 1;
      }
      evidence.terminal = Boolean(group.terminal && count === group.spans.length);
      evidence.terminal_reason = evidence.terminal ? group.terminal : null;
      body = JSON.stringify(envelope);
      if (!count && !evidence.terminal || new TextEncoder().encode(body).length > BODY_LIMIT) throw new Error('capture body capacity');
      const known = spans.reduce((n, s) => n + s.frame_count * s.repeat_count, 0);
      if (!safe(known) || !safe(parent.known + known)) throw new Error('capture numeric capacity');
      group.spans.splice(0, count); bytes -= count * ROW_CHARGE;
      if (!group.spans.length) groups.shift();
      return { parent, body, evidence, known, terminal: evidence.terminal, sequence: parent.sequence,
        ownerSequence, digest: null, attempts: 0, started: null, retryAt: 0, controller: null };
    }
    async function send(batch) {
      const token = {}; job = token;
      if (batch.started === null) batch.started = now();
      batch.attempts += 1;
      const controller = new AbortController(); batch.controller = controller;
      const timeout = clock.setTimeout(() => controller.abort(), 10000);
      try {
        if (!batch.digest) {
          const input = new TextEncoder().encode(`${PROTOCOL}\n${batch.sequence}\n${canonical(batch.evidence)}`);
          const hash = await cryptoApi.subtle.digest('SHA-256', input);
          batch.digest = Array.from(new Uint8Array(hash), n => n.toString(16).padStart(2, '0')).join('');
          batch.evidence = null;
        }
        if (dead) return;
        const response = await postCheckpoint(batch.body, { signal: controller.signal });
        if (dead || frozen !== batch) return;
        const d = response.data;
        if (response.status >= 200 && response.status < 300) {
          if (!d || d.ok !== true || d.capture_uuid !== batch.parent.captureId || d.sequence !== batch.sequence
              || d.owner_sequence !== batch.ownerSequence || d.digest !== batch.digest || d.terminal !== batch.terminal
              || d.accepted_known_frames !== batch.parent.known + batch.known || d.accepted_lost_frames !== 0) {
            abandon('invalid_rate_capture_receipt'); return;
          }
          batch.parent.known += batch.known; batch.parent.admitted = true;
          batch.parent.sequence += 1; ownerSequence += 1;
          if (!safe(ownerSequence, 1) || !safe(batch.parent.sequence, 1)) { abandon('rate_capture_numeric_limit'); return; }
          frozen = null; release(batch.parent);
        } else if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          abandon(d?.error || 'rate_capture_rejected');
        }
      } catch (_) { /* Unknown commit outcome: retry exactly these bytes and sequences. */ }
      finally {
        clock.clearTimeout(timeout); batch.controller = null;
        if (job === token) job = null;
        if (!dead && frozen === batch) batch.retryAt = now() + [1000, 2000, 4000, 8000, 16000, 30000][Math.min(batch.attempts - 1, 5)];
        for (const owner of owners) owner.wake();
      }
    }
    function tick() {
      if (dead) return;
      if (frozen?.started !== null && frozen?.started !== undefined && now() - frozen.started >= 120000) { abandon('transport_abandoned'); return; }
      if (!job) {
        if (!frozen && groups.length && (groups.length > 1 || groups[0].terminal || now() - groups[0].created >= 2000)) {
          try {
            if (!groups[0].parent.sealed && groups[0].parent.readyForSeal && !groups[0].parent.readyForSeal()) { arm(); return; }
            frozen = prepare();
          } catch (_) { abandon('rate_capture_capacity'); return; }
        }
        if (frozen && now() >= frozen.retryAt) void send(frozen);
      }
      if (retiring && !parents.size && !frozen && !groups.length) { dead = true; owners.delete(api); return; }
      if (frozen || groups.length) arm();
    }
    function retire(reason = 'owner_closed') {
      if (dead) return;
      retiring = true;
      for (const parent of parents) close(parent, reason);
      arm();
    }
    const api = { bindParent, append, close, retire, abandon, wake: arm, ownerUuid, coordinateRateHz };
    owners.add(api); return api;
  }
  return { createOwner };
})();
