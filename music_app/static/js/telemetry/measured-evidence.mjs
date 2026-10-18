/* Dormant pure client evidence. No DOM, storage, network, clock or audio wiring.
 * Histogram weights report rendering; coverage alone supplies an exact lower
 * bound. Neither source identity nor server authority is created here. */
export const LIMITS = Object.freeze({ bins: 2048, intervals: 4096, bodyBytes: 262144,
  instancesPerSession: 128, instancesPerPage: 256, pendingBytes: 8 * 1024 * 1024 });
export const VERSION = 'rendered-position-histogram-v1';
const MAX = Number.MAX_SAFE_INTEGER;
function fail(code) { throw new Error(code); }
function integer(value, minimum = 0, maximum = MAX) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail('invalid_integer');
  return value;
}
function uuid(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
      || value === '00000000-0000-0000-0000-000000000000') fail('invalid_identity');
  return value;
}
function freeze(value) {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); }
  return value;
}
function identity(value) {
  if (!value || typeof value !== 'object') fail('invalid_identity');
  const keys = ['account_id', 'library_id', 'track_id', 'device_id', 'session_id', 'decoder_instance_id', 'sample_rate'];
  if (Object.keys(value).sort().join() !== [...keys].sort().join()) fail('invalid_identity');
  return freeze({ account_id: integer(value.account_id, 1), library_id: integer(value.library_id, 1),
    track_id: integer(value.track_id, 1), device_id: uuid(value.device_id), session_id: uuid(value.session_id),
    decoder_instance_id: uuid(value.decoder_instance_id), sample_rate: integer(value.sample_rate, 8000, 192000) });
}
function widthFor(rate, extent) { let width = rate; while (extent > width * LIMITS.bins) width *= 2; return width; }
function union(intervals, start, end) {
  const result = []; let inserted = false;
  for (const [a, b] of intervals) {
    if (b < start) result.push([a, b]);
    else if (end < a) { if (!inserted) { result.push([start, end]); inserted = true; } result.push([a, b]); }
    else { start = Math.min(start, a); end = Math.max(end, b); }
  }
  if (!inserted) result.push([start, end]);
  return result;
}
// Wire values are ASCII keys, UUIDs, booleans, integers and arrays. This sorted
// serializer matches Python's compact sort_keys encoding for these values only.
export function canonicalCheckpoint(value) {
  return JSON.stringify(value, Object.keys(value).sort());
}

export class EvidenceAccumulator {
  #identity; #histogram = new Map(); #coverage = []; #frames = 0; #extent = 0;
  #width; #coverageComplete = true; #instrumentationComplete = true;
  #last = null; #finalized = false; #halted = false;
  constructor(binding) { this.#identity = identity(binding); this.#width = binding.sample_rate; }
  get binding() { return this.#identity; }
  consume(event) {
    if (this.#halted || this.#finalized) fail('instance_closed');
    if (!event || Object.keys(event).sort().join() !== 'event_index,frames,start_frame') fail('invalid_event');
    const index = integer(event.event_index), start = integer(event.start_frame), frames = integer(event.frames, 1);
    const end = integer(start + frames);
    if (this.#last && index === this.#last.event_index && start === this.#last.start_frame && frames === this.#last.frames) return false;
    if (index !== (this.#last ? this.#last.event_index + 1 : 0)) {
      this.#instrumentationComplete = false; this.#halted = true; fail('event_order_conflict');
    }
    const total = integer(this.#frames + frames);
    const extent = Math.max(this.#extent, end), width = widthFor(this.#identity.sample_rate, extent);
    const histogram = new Map();
    for (const [bin, weight] of this.#histogram) {
      const target = Math.floor(bin * this.#width / width);
      histogram.set(target, integer((histogram.get(target) || 0) + weight));
    }
    for (let at = start; at < end;) {
      const bin = Math.floor(at / width), stop = Math.min(end, (bin + 1) * width);
      const delta = stop - at; // Subtract positions before adding weight: avoid an unsafe intermediate.
      histogram.set(bin, integer((histogram.get(bin) || 0) + delta)); at = stop;
    }
    const coverage = union(this.#coverage, start, end);
    if (coverage.length <= LIMITS.intervals) this.#coverage = coverage;
    else this.#coverageComplete = false; // Retain every old exact interval; never bridge a gap.
    this.#histogram = histogram; this.#frames = total; this.#extent = extent; this.#width = width;
    this.#last = Object.freeze({ event_index: index, start_frame: start, frames });
    return true;
  }
  markInstrumentationIncomplete() { this.#instrumentationComplete = false; }
  finalize() { this.#finalized = true; }
  snapshot(sequence) {
    integer(sequence);
    return freeze({ version: VERSION, device_id: this.#identity.device_id, session_id: this.#identity.session_id,
      checkpoint_sequence: sequence, sample_rate: this.#identity.sample_rate, histogram_bin_frames: this.#width,
      histogram: [...this.#histogram].sort((a, b) => a[0] - b[0]).map(pair => [...pair]),
      rendered_frames: this.#frames, max_observed_frame: this.#extent,
      coverage_intervals: this.#coverage.map(pair => [...pair]), coverage_complete: this.#coverageComplete,
      instrumentation_complete: this.#instrumentationComplete,
      resolution_state: this.#width === this.#identity.sample_rate ? 'one_second' : 'coarsened', finalized: this.#finalized });
  }
}

// Caller supplies authenticated scope and transport outcomes. This owner does not
// authenticate a receipt, choose a path, perform retries, or grant server admission.
export class PendingEvidenceOwner {
  #entries = new Map(); #bytes = 0; #pendingLimit; #bodyLimit;
  constructor({ pendingBytes = LIMITS.pendingBytes, bodyBytes = LIMITS.bodyBytes } = {}) {
    // Callers may tighten budgets, never expand the reviewed bounds.
    this.#pendingLimit = integer(pendingBytes, 1, LIMITS.pendingBytes);
    this.#bodyLimit = integer(bodyBytes, 1, LIMITS.bodyBytes);
  }
  get pendingBytes() { return this.#bytes; }
  get size() { return this.#entries.size; }
  open(binding) {
    const checked = identity(binding), id = checked.decoder_instance_id;
    if (this.#entries.has(id)) {
      const entry = this.#entries.get(id);
      if (JSON.stringify(entry.accumulator.binding) !== JSON.stringify(checked)) fail('identity_conflict');
      return entry.accumulator;
    }
    if (this.#entries.size >= LIMITS.instancesPerPage) fail('page_instance_limit');
    let count = 0;
    for (const entry of this.#entries.values()) {
      const other = entry.accumulator.binding;
      if (other.account_id === checked.account_id && other.library_id === checked.library_id &&
          other.device_id === checked.device_id && other.session_id === checked.session_id) {
        if (other.track_id !== checked.track_id) fail('logical_track_conflict');
        count += 1;
      }
    }
    if (count >= LIMITS.instancesPerSession) fail('session_instance_limit');
    const accumulator = new EvidenceAccumulator(checked);
    this.#entries.set(id, { accumulator, sequence: 0, pending: null, receipt: null, blocked: false, complete: false });
    return accumulator;
  }
  #entry(id) { const entry = this.#entries.get(uuid(id)); if (!entry) fail('unknown_instance'); return entry; }
  prepare(id) {
    const entry = this.#entry(id);
    if (entry.blocked) fail('reconciliation_required');
    if (entry.pending) return entry.pending;
    if (entry.complete) fail('already_finalized');
    const checkpoint = entry.accumulator.snapshot(entry.sequence), body = canonicalCheckpoint(checkpoint);
    // ASCII only by construction: byte length equals string length.
    if (body.length > this.#bodyLimit) fail('checkpoint_body_limit');
    if (this.#bytes + body.length > this.#pendingLimit) fail('pending_byte_limit');
    entry.pending = freeze({ decoder_instance_id: id, checkpoint, body });
    this.#bytes += body.length;
    return entry.pending;
  }
  pending(id) { return this.#entry(id).pending; }
  receipt(id) { return this.#entry(id).receipt; }
  acknowledge(id, pendingBody, status, receiptBody) {
    const entry = this.#entry(id), pending = entry.pending;
    if (!pending || pending.body !== pendingBody) fail('pending_mismatch');
    if (status !== 200 || typeof receiptBody !== 'string' || receiptBody.length > 8192 ||
        /[^\x00-\x7f]/.test(receiptBody)) fail('invalid_receipt');
    let receipt; try { receipt = JSON.parse(receiptBody); } catch { fail('invalid_receipt'); }
    const binding = entry.accumulator.binding;
    if (!receipt || receipt.ok !== true || receipt.decoder_instance_id !== id ||
        receipt.device_id !== binding.device_id || receipt.session_id !== binding.session_id ||
        receipt.checkpoint_sequence !== pending.checkpoint.checkpoint_sequence ||
        receipt.finalized !== pending.checkpoint.finalized ||
        typeof receipt.digest !== 'string' || !/^[0-9a-f]{64}$/.test(receipt.digest)) fail('invalid_receipt');
    const next = integer(entry.sequence + 1);
    entry.receipt = Object.freeze({ status, body: receiptBody });
    entry.complete = pending.checkpoint.finalized;
    entry.sequence = next; this.#bytes -= pending.body.length; entry.pending = null;
    return entry.receipt;
  }
  block(id) { this.#entry(id).blocked = true; } // Conflict/stale: preserve exact pending bytes.
  finalize(id) { this.#entry(id).accumulator.finalize(); }
  // No eviction/rebind/reset API. Seek opens a different UUID; promotion keeps it.
}

// Separately versioned dormant protocol; v1 entry points never call these helpers.
export const V2_VERSION = 'rendered-position-slices-v2';
export const V2_DIGEST_DOMAIN = 'AlbumHaven:rendered-position-slices-v2\n';
const v2Flags = ['instrumentation_complete', 'occurrence_complete', 'coverage_complete'];
const v2Envelope = ['version', 'decoder_instance_id', 'process_epoch', 'device_id', 'session_id',
  'sample_rate', 'checkpoint_sequence', 'previous_digest', 'cumulative', 'epochs', 'slices', 'terminal'];
const v2Cumulative = ['rendered_frames', 'max_observed_frame', 'histogram_bin_frames', 'histogram',
  'coverage_intervals', 'resolution_state', ...v2Flags];
const v2Epoch = ['epoch_id', 'audio_origin_tick', 'wall_origin_us', 'uncertainty_us', 'quality'];
const v2Slice = ['slice_id', 'epoch_id', 'first_consumption_frame', 'frames',
  'render_start_tick', 'render_end_tick', 'runs', 'quality'];
const v2Binding = ['decoder_instance_id', 'process_epoch', 'device_id', 'session_id', 'sample_rate'];
function v2Fields(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail('invalid_fields');
}
function v2List(value, maximum) {
  if (!Array.isArray(value) || value.length > maximum) fail('collection_limit');
  return value;
}
function v2Integer(value, minimum = 0, maximum = MAX) {
  if (Object.is(value, -0)) fail('invalid_integer');
  return integer(value, minimum, maximum);
}
function v2Digest(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) fail('invalid_digest');
  return value;
}
function v2Width(rate, extent) {
  let width = BigInt(rate);
  while (BigInt(extent) > width * BigInt(LIMITS.bins)) width *= 2n;
  return v2Exact(width);
}
function v2Bin(frame, width) { return Number(BigInt(frame) / BigInt(width)); }
function v2Exact(value, minimum = 0) {
  if (value < BigInt(minimum) || value > BigInt(MAX)) fail('invalid_integer');
  return Number(value);
}
function v2Sorted(value) {
  if (Array.isArray(value)) return value.map(v2Sorted);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, v2Sorted(value[k])]));
  return value;
}
function v2JSON(value) { return JSON.stringify(v2Sorted(value)); }
function v2CheckEpoch(epoch) {
  v2Fields(epoch, v2Epoch);
  v2Integer(epoch.epoch_id, 0, 63); v2Integer(epoch.audio_origin_tick);
  if (epoch.quality === 'unknown') {
    if (epoch.wall_origin_us !== null || epoch.uncertainty_us !== null) fail('invalid_epoch');
  } else if (epoch.quality === 'app_clock_estimate') {
    v2Integer(epoch.wall_origin_us, -MAX); v2Integer(epoch.uncertainty_us);
  } else fail('invalid_epoch');
}
export function occurrenceBoundaryV2(epoch, tick, sampleRate) {
  v2CheckEpoch(epoch); v2Integer(sampleRate, 8000, 192000); v2Integer(tick, epoch.audio_origin_tick);
  if (epoch.quality === 'unknown') return freeze({ wall_us: null, uncertainty_us: null });
  const wall = BigInt(epoch.wall_origin_us) + (BigInt(tick) - BigInt(epoch.audio_origin_tick)) * 1000000n / BigInt(sampleRate);
  return freeze({ wall_us: v2Exact(wall, -MAX), uncertainty_us: v2Exact(BigInt(epoch.uncertainty_us) + 1n) });
}
export function emptyCumulativeV2(sampleRate) {
  v2Integer(sampleRate, 8000, 192000);
  return freeze({ rendered_frames: 0, max_observed_frame: 0, histogram_bin_frames: sampleRate,
    histogram: [], coverage_intervals: [], resolution_state: 'one_second',
    instrumentation_complete: true, occurrence_complete: true, coverage_complete: true });
}
function v2Pairs(value, maximum) {
  v2List(value, maximum);
  for (const pair of value) {
    if (!Array.isArray(pair) || pair.length !== 2) fail('invalid_pairs');
    v2Integer(pair[0]); v2Integer(pair[1]);
  }
  return value;
}
function v2CheckCumulative(value, rate) {
  v2Fields(value, v2Cumulative);
  for (const key of v2Flags) if (typeof value[key] !== 'boolean') fail('invalid_flag');
  if (!value.instrumentation_complete && (value.occurrence_complete || value.coverage_complete)) fail('inconsistent_quality_or_delta');
  const frames = v2Integer(value.rendered_frames), extent = v2Integer(value.max_observed_frame);
  const width = v2Integer(value.histogram_bin_frames, 1);
  if (width !== v2Width(rate, extent) || value.resolution_state !== (width === rate ? 'one_second' : 'coarsened')) fail('invalid_resolution');
  let last = -1, sum = 0n;
  for (const [index, weight] of v2Pairs(value.histogram, LIMITS.bins)) {
    if (index <= last || index >= LIMITS.bins || weight < 1 || BigInt(index) * BigInt(width) >= BigInt(extent)) fail('invalid_histogram');
    last = index; sum += BigInt(weight);
  }
  if (sum !== BigInt(frames) || (frames === 0) !== (extent === 0)) fail('histogram_total_mismatch');
  if (value.histogram.length && last !== v2Bin(extent - 1, width)) fail('unsupported_extent');
  last = -1; sum = 0n;
  for (const [start, end] of v2Pairs(value.coverage_intervals, LIMITS.intervals)) {
    if (start <= last || end <= start || end > extent) fail('invalid_coverage');
    last = end; sum += BigInt(end) - BigInt(start);
  }
  if (sum > BigInt(frames)) fail('coverage_exceeds_rendered');
}
export function normalizeCheckpointV2(payload) {
  // Decoded objects cannot disclose duplicate JSON keys or 1.0/1e0 spelling.
  // Use parseCheckpointV2 for untrusted wire bytes.
  v2Fields(payload, v2Envelope);
  if (payload.version !== V2_VERSION) fail('invalid_version');
  for (const name of v2Binding.slice(0, -1)) uuid(payload[name]);
  const rate = v2Integer(payload.sample_rate, 8000, 192000);
  const seq = v2Integer(payload.checkpoint_sequence, 0, 719);
  if (seq === 0) { if (payload.previous_digest !== null) fail('invalid_previous_digest'); }
  else v2Digest(payload.previous_digest);
  if (![null, 'source_exhausted', 'collection_limited', 'client_stopped'].includes(payload.terminal)) fail('invalid_terminal');
  v2CheckCumulative(payload.cumulative, rate);
  for (const epoch of v2List(payload.epochs, 16)) v2CheckEpoch(epoch);
  let count = 0;
  for (const item of v2List(payload.slices, 128)) {
    v2Fields(item, v2Slice);
    v2Integer(item.slice_id, 0, 7199); v2Integer(item.epoch_id, 0, 63);
    v2Integer(item.first_consumption_frame); v2Integer(item.frames, 1);
    const start = v2Integer(item.render_start_tick), end = v2Integer(item.render_end_tick);
    if (!(end > start && end - start <= rate)) fail('invalid_slice_span');
    v2Fields(item.quality, ['instrumentation_complete', 'occurrence_quality']);
    if (typeof item.quality.instrumentation_complete !== 'boolean' ||
        !['unknown', 'app_clock_estimate'].includes(item.quality.occurrence_quality)) fail('invalid_quality');
    const runs = v2List(item.runs, 256);
    if (!runs.length) fail('empty_slice');
    let total = 0, prior = start;
    for (const run of runs) {
      if (!Array.isArray(run) || run.length !== 3) fail('invalid_run');
      const source = v2Integer(run[0]), frames = v2Integer(run[1], 1), tick = v2Integer(run[2]);
      v2Integer(source + frames); const stop = v2Integer(tick + frames);
      if (tick < prior || stop > end) fail('invalid_run_order');
      total = v2Integer(total + frames); prior = stop;
    }
    if (runs[0][2] !== start || prior !== end || total !== item.frames) fail('slice_total_mismatch');
    v2Integer(item.first_consumption_frame + total); count += runs.length;
  }
  if (count > 2048) fail('collection_limit');
  const body = v2JSON(payload);
  if (body.length > LIMITS.bodyBytes) fail('checkpoint_body_limit');
  return freeze(JSON.parse(body));
}
export function parseCheckpointV2(body) {
  if (typeof body !== 'string' || /[^\x00-\x7f]/.test(body) || body.length > LIMITS.bodyBytes) fail('checkpoint_body_limit');
  // Small strict JSON reader preserves duplicate-key and numeric-token evidence.
  // Depth is bounded well above the fixed envelope/slice/run schema.
  let at = 0;
  function space() { while (at < body.length && /[ \r\n\t]/.test(body[at])) at++; }
  function string() {
    const start = at++;
    while (at < body.length) {
      const c = body[at++];
      if (c === '\\') { at++; continue; }
      if (c === '"') {
        try { return JSON.parse(body.slice(start, at)); } catch { fail('invalid_json'); }
      }
    }
    fail('invalid_json');
  }
  function value(depth) {
    if (depth > 16) fail('invalid_json');
    space(); const c = body[at];
    if (c === '"') return string();
    if (c === '{') {
      at++; space(); const result = Object.create(null);
      if (body[at] === '}') { at++; return result; }
      for (;;) {
        space(); if (body[at] !== '"') fail('invalid_json');
        const key = string();
        if (Object.hasOwn(result, key)) fail('duplicate_key');
        space(); if (body[at++] !== ':') fail('invalid_json');
        result[key] = value(depth + 1); space();
        if (body[at] === '}') { at++; return result; }
        if (body[at++] !== ',') fail('invalid_json');
      }
    }
    if (c === '[') {
      at++; space(); const result = [];
      if (body[at] === ']') { at++; return result; }
      for (;;) {
        result.push(value(depth + 1)); space();
        if (body[at] === ']') { at++; return result; }
        if (body[at++] !== ',') fail('invalid_json');
      }
    }
    for (const [token, parsed] of [['true', true], ['false', false], ['null', null]]) {
      if (body.startsWith(token, at)) { at += token.length; return parsed; }
    }
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(body.slice(at));
    if (!match) fail('invalid_json');
    const token = match[0]; at += token.length;
    if (token === '-0' || /[.eE]/.test(token) || token.replace('-', '').length > 16) fail('invalid_integer');
    return v2Exact(BigInt(token), -MAX);
  }
  const parsed = value(0); space();
  if (at !== body.length) fail('invalid_json');
  return normalizeCheckpointV2(parsed);
}
export function canonicalCheckpointV2(payload) { return v2JSON(normalizeCheckpointV2(payload)); }
export function checkpointDigestInputV2(payload) { return V2_DIGEST_DOMAIN + canonicalCheckpointV2(payload); }
function v2Reduce(base, slices, rate, terminal) {
  let extent = base.max_observed_frame;
  for (const item of slices) for (const [start, frames] of item.runs) extent = Math.max(extent, start + frames);
  const width = v2Width(rate, extent), factor = width / base.histogram_bin_frames, bins = new Map();
  if (width < base.histogram_bin_frames || !Number.isInteger(factor)) fail('resolution_regressed');
  for (const [index, weight] of base.histogram) {
    const target = Math.floor(index / factor);
    bins.set(target, v2Integer((bins.get(target) || 0) + weight));
  }
  const result = { ...base, histogram_bin_frames: width, max_observed_frame: extent,
    resolution_state: width === rate ? 'one_second' : 'coarsened' };
  let coverage = base.coverage_intervals.map(pair => [...pair]);
  for (const item of slices) {
    result.instrumentation_complete &&= item.quality.instrumentation_complete;
    result.occurrence_complete &&= item.quality.occurrence_quality === 'app_clock_estimate';
    result.rendered_frames = v2Integer(result.rendered_frames + item.frames);
    for (const [start, frames] of item.runs) {
      const end = start + frames;
      for (let index = v2Bin(start, width); index <= v2Bin(end - 1, width); index++) {
        const left = BigInt(index) * BigInt(width), right = left + BigInt(width);
        const a = left > BigInt(start) ? left : BigInt(start), b = right < BigInt(end) ? right : BigInt(end);
        bins.set(index, v2Exact(BigInt(bins.get(index) || 0) + b - a));
      }
      const merged = union(coverage, start, end);
      if (merged.length <= LIMITS.intervals) coverage = merged;
      else result.coverage_complete = false;
    }
  }
  if (terminal === 'collection_limited') result.instrumentation_complete = false;
  if (!result.instrumentation_complete) result.occurrence_complete = result.coverage_complete = false;
  result.histogram = [...bins].sort((a, b) => a[0] - b[0]); result.coverage_intervals = coverage;
  return result;
}
export function compareCheckpointV2(previous, payload, binding, observedRanges, previousDigest = null) {
  // Pure protocol checks only. Caller owns live authority/source checks and the
  // persisted previousDigest (SHA-256 of checkpointDigestInputV2(previous.latest)).
  // All prior state is trusted storage input, never accepted from a client.
  const incoming = normalizeCheckpointV2(payload);
  v2Fields(binding, v2Binding);
  for (const key of v2Binding.slice(0, -1)) uuid(binding[key]);
  v2Integer(binding.sample_rate, 8000, 192000);
  if (v2Binding.some(key => incoming[key] !== binding[key])) fail('identity_changed');
  const observed = v2Pairs(observedRanges, LIMITS.intervals); let end = -1;
  for (const [a, b] of observed) { if (a <= end || b <= a) fail('invalid_observed_ranges'); end = b; }
  const digestInput = checkpointDigestInputV2(incoming);
  let latest = null, epochs = [], lastSlice = -1, lastEpoch = -1, lastTick = 0;
  if (previous !== null) {
    v2Fields(previous, ['latest', 'epochs', 'last_slice_id', 'last_epoch_id', 'last_render_end_tick']);
    latest = normalizeCheckpointV2(previous.latest); v2Digest(previousDigest);
    if (v2Binding.some(key => latest[key] !== binding[key])) fail('identity_changed');
    epochs = v2List(previous.epochs, 64);
    for (const [index, epoch] of epochs.entries()) {
      v2CheckEpoch(epoch); if (epoch.epoch_id !== index) fail('invalid_state');
    }
    lastSlice = v2Integer(previous.last_slice_id, 0, 7199);
    lastEpoch = v2Integer(previous.last_epoch_id, 0, 63); lastTick = v2Integer(previous.last_render_end_tick);
    if (lastEpoch !== epochs.length - 1 || lastTick < epochs[lastEpoch].audio_origin_tick) fail('invalid_state');
    if (lastEpoch > lastSlice || lastSlice >= latest.cumulative.rendered_frames) fail('invalid_state');
    for (const epoch of latest.epochs) {
      if (epoch.epoch_id >= epochs.length || v2JSON(epoch) !== v2JSON(epochs[epoch.epoch_id])) fail('invalid_state');
    }
    const tail = latest.slices;
    if (!tail.length && latest.epochs.length) fail('invalid_state');
    if (tail.length) {
      const final = tail[tail.length - 1];
      if (final.slice_id !== lastSlice || final.epoch_id !== lastEpoch || final.render_end_tick !== lastTick ||
          final.first_consumption_frame + final.frames !== latest.cumulative.rendered_frames) fail('invalid_state');
    }
    const seq = incoming.checkpoint_sequence, oldSeq = latest.checkpoint_sequence;
    if (seq < oldSeq) return freeze({ kind: 'stale', digestInput, state: null });
    if (seq === oldSeq) {
      if (canonicalCheckpointV2(incoming) !== canonicalCheckpointV2(latest)) fail('sequence_conflict');
      return freeze({ kind: 'replay', digestInput, state: null });
    }
    if (latest.terminal !== null) fail('already_finalized');
    if (seq !== oldSeq + 1) fail('sequence_gap');
    if (incoming.previous_digest !== previousDigest) fail('previous_digest_mismatch');
  } else if (incoming.checkpoint_sequence !== 0) fail('sequence_gap');
  if (!incoming.slices.length && latest === null) fail('empty_initial_checkpoint');
  // Copy trusted historical anchors as well; freezing a result must not freeze
  // caller-owned state as an accidental side effect.
  epochs = epochs.map(epoch => ({ ...epoch })); const oldCount = epochs.length;
  for (const epoch of incoming.epochs) {
    if (epoch.epoch_id !== epochs.length || epochs.length >= 64) fail('epoch_redefinition');
    epochs.push(epoch);
  }
  const base = latest ? latest.cumulative : emptyCumulativeV2(incoming.sample_rate);
  let cursor = base.rendered_frames; const used = new Set();
  for (const item of incoming.slices) {
    if (item.slice_id !== lastSlice + 1 || item.first_consumption_frame !== cursor) fail('slice_cursor_gap');
    const eid = item.epoch_id;
    if (eid < lastEpoch) fail('retired_epoch');
    if (eid >= epochs.length || eid > lastEpoch + 1) fail('epoch_gap');
    const epoch = epochs[eid];
    if (item.quality.occurrence_quality !== epoch.quality) fail('invalid_quality');
    if (eid === lastEpoch && item.render_start_tick < lastTick) fail('overlapping_slice');
    for (const [start, frames, tick] of item.runs) {
      occurrenceBoundaryV2(epoch, tick, incoming.sample_rate);
      occurrenceBoundaryV2(epoch, tick + frames, incoming.sample_rate);
      if (!observed.some(([a, b]) => a <= start && start + frames <= b)) fail('admission_not_ready');
    }
    used.add(eid); lastSlice = item.slice_id; lastEpoch = eid; lastTick = item.render_end_tick;
    cursor = v2Integer(cursor + item.frames);
  }
  for (let eid = oldCount; eid < epochs.length; eid++) if (!used.has(eid)) fail('unused_epoch');
  const expected = v2Reduce(base, incoming.slices, incoming.sample_rate, incoming.terminal), submitted = incoming.cumulative;
  for (const key of v2Cumulative) {
    if ((v2Flags.includes(key) && submitted[key] && !expected[key]) ||
        (!v2Flags.includes(key) && v2JSON(submitted[key]) !== v2JSON(expected[key]))) fail('inconsistent_quality_or_delta');
  }
  if (!incoming.slices.length && incoming.terminal === null && v2Flags.every(k => submitted[k] === base[k])) fail('unchanged_checkpoint');
  return freeze({ kind: 'accept', digestInput, state: { latest: incoming, epochs,
    last_slice_id: lastSlice, last_epoch_id: lastEpoch, last_render_end_tick: lastTick } });
}
