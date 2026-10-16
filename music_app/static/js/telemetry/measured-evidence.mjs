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
