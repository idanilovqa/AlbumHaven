(() => {
  'use strict';

  const PROCESSOR_NAME = 'album-haven-gapless-playback';
  const CHANNELS = 2;
  const MAX_BOUNDARY_CAPTURE_FRAMES = 64;
  const MAX_GENERATION = 2_147_483_647;

  function isIntegerBetween(value, minimum, maximum = MAX_GENERATION) {
    return Number.isInteger(value) && value >= minimum && value <= maximum;
  }

  function createRing(capacityFrames) {
    return {
      samples: new Float32Array(capacityFrames * CHANNELS),
      capacityFrames,
      readFrame: 0,
      writeFrame: 0,
      bufferedFrames: 0,
      streamId: null,
      nextSequence: 0,
      receivedFrames: 0,
      eos: false,
      emittedFrames: 0,
      authoritativeTotalFrames: 0,
      firstFrameReported: false,
    };
  }

  function clearRing(ring) {
    ring.captureSerial = 0;
    ring.captureSource = 0;
    ring.readFrame = 0;
    ring.writeFrame = 0;
    ring.bufferedFrames = 0;
    ring.streamId = null;
    ring.nextSequence = 0;
    ring.receivedFrames = 0;
    ring.eos = false;
    ring.emittedFrames = 0;
    ring.authoritativeTotalFrames = 0;
    ring.firstFrameReported = false;
  }

  function appendInterleaved(ring, pcm, frameCount) {
    for (let frame = 0; frame < frameCount; frame += 1) {
      const target = ring.writeFrame * CHANNELS;
      const source = frame * CHANNELS;
      ring.samples[target] = pcm[source];
      ring.samples[target + 1] = pcm[source + 1];
      ring.writeFrame = (ring.writeFrame + 1) % ring.capacityFrames;
    }
    ring.bufferedFrames += frameCount;
    ring.receivedFrames += frameCount;
  }

  function takeFrame(ring, left, right, outputFrame) {
    const source = ring.readFrame * CHANNELS;
    left[outputFrame] = ring.samples[source];
    right[outputFrame] = ring.samples[source + 1];
    ring.readFrame = (ring.readFrame + 1) % ring.capacityFrames;
    ring.bufferedFrames -= 1;
  }

  // Capture has its own credits, coordinates and epochs. It never controls PCM.
  class PositionCapture {
    constructor(processor) {
      this.processor = processor;
      this.owner = 0;
      this.enabled = false;
      this.packetVersion = 1;
      this.continuitySerial = 1;
      this.lastOutputEnd = null;
      this.lastOrdinalEnd = null;
      this.pendingBreak = false;
      this.epoch = 1;
      this.ordinal = 0;
      this.packet = 0;
      this.lastSerial = 0;
      this.lastFlush = 0;
      this.maxQuantum = 128;
      this.credits = [];
      this.view = null;
      this.count = 0;
      this.outstanding = 0;
      this.inFlight = [false, false, false, false];
      this.bufferId = 0;
      this.transfer = [null];
      this.message = { type: 'capture-packet', buffer: null };
      this.probe = null;
      this.unboundLoss = { first: 0, last: 0, frames: 0, outputFirst: 0, outputLast: 0, epoch: 0 };
      this.slots = Array.from({ length: 8 }, () => ({ serial: 0, pending: false,
        stream: 0, generation: 0, base: 0, lost: 0, first: 0, last: 0,
        outputFirst: 0, outputLast: 0, reasons: 0, epoch: 0, final: 0 }));
    }

    safe(value, min = 0) {
      return Number.isSafeInteger(value) && !Object.is(value, -0) && value >= min;
    }

    command(message) {
      if (message.type === 'capture-enable') {
        // One-time port-local credit admission may precede the first PCM configure.
        // Source-sensitive commands below still require the current generation.
        const packetVersion = message.packetVersion === undefined ? 1 : message.packetVersion;
        if (![1, 2].includes(packetVersion) || this.owner || !this.safe(message.ownerSerial, 1)
            || message.sourceRate !== 48000 || message.outputRate !== 48000
            || sampleRate !== 48000 || !Array.isArray(message.buffers)
            || message.buffers.length !== 4
            || new Set(message.buffers).size !== 4
            || message.buffers.some(buffer => !(buffer instanceof ArrayBuffer) || buffer.byteLength !== 16384)) return;
        this.owner = message.ownerSerial;
        this.packetVersion = packetVersion;
        this.enabled = true;
        this.credits = message.buffers.map((buffer, index) => ({ buffer, id: index + 1 }));
        return;
      }
      if (!this.owner || message.ownerSerial !== this.owner) return;
      // Returned credits survive playback generation changes and capture disable.
      if (message.type === 'capture-credit') {
        if (!(message.buffer instanceof ArrayBuffer) || message.buffer.byteLength !== 16384
            || !this.safe(message.bufferId, 1) || message.bufferId > 4
            || !this.inFlight[message.bufferId - 1]) { this.enabled = false; return; }
        this.outstanding -= 1;
        this.inFlight[message.bufferId - 1] = false;
        this.credits.push({ buffer: message.buffer, id: message.bufferId });
        this.flush();
        return;
      }
      if (message.type === 'capture-disable') { this.flush(); this.enabled = false; return; }
      if (!this.enabled || message.generation !== this.processor.generation) return;
      if (message.type === 'capture-bind') {
        const slot = this.slots[message.slot - 1];
        if (!slot || slot.serial || !this.safe(message.bindingSerial, this.lastSerial + 1)
            || !this.safe(message.streamId, 1) || !this.safe(message.sourceBase48)
            || this.slots.some(item => item.serial && item.stream === message.streamId
              && item.generation === message.generation)) return;
        const rings = [this.processor.current, this.processor.continuity];
        if (rings.some(ring => ring.streamId === message.streamId && ring.receivedFrames > 0)) return;
        Object.assign(slot, { serial: message.bindingSerial, stream: message.streamId,
          generation: message.generation, base: message.sourceBase48, pending: false,
          final: 0, lost: 0, first: 0, last: 0, outputFirst: 0, outputLast: 0, reasons: 0, epoch: 0 });
        this.lastSerial = message.bindingSerial;
      } else if (message.type === 'capture-unbind') {
        const slot = this.slots.find(item => item.serial === message.bindingSerial);
        if (slot) slot.pending = true;
        this.flush();
      } else if (message.type === 'capture-epoch') {
        this.barrier();
      } else if (message.type === 'capture-probe') {
        if (!this.probe && this.safe(message.probe_id, 1)) {
          this.probe = [message.probe_id, this.epoch, currentFrame, this.maxQuantum];
          this.flush();
        }
      }
    }

    binding(stream) {
      return this.slots.find(slot => slot.serial && slot.stream === stream
        && slot.generation === this.processor.generation) || null;
    }

    barrier(reason = 'discontinuity') {
      if (!this.owner) return;
      if (this.packetVersion === 2 && reason !== 'seamless-track' && reason !== 'seamless-loop') {
        this.pendingBreak = true;
      }
      if (!this.safe(this.epoch + 1, 1)) { this.enabled = false; return; }
      this.epoch += 1;
    }

    live(slot) {
      const p = this.processor;
      return p.current.captureSerial === slot.serial && p.current.bufferedFrames > 0
        || p.continuity.captureSerial === slot.serial && p.continuity.bufferedFrames > 0
        || p.retainedCaptureSerial === slot.serial && p.retainedLoopFrames > 0
          && p.retainedLoopStreamId !== null;
    }

    acquire() {
      if (this.view) return true;
      const credit = this.credits.pop();
      if (!credit) return false;
      this.bufferId = credit.id;
      this.view = new Float64Array(credit.buffer);
      this.view.fill(0);
      this.count = 0;
      return true;
    }

    record(serial, source, output) {
      if (!this.enabled) return;
      if (!this.safe(this.ordinal + 1) || !this.safe(source + 1) || !this.safe(output + 1)) {
        this.enabled = false;
        return;
      }
      const ordinal = this.ordinal++;
      let slot = null;
      if (serial > 0) for (let index = 0; index < 8; index++) {
        if (this.slots[index].serial === serial) { slot = this.slots[index]; break; }
      }
      if (!slot) {
        if (this.packetVersion === 2) this.pendingBreak = true;
        if (!this.unboundLoss.frames) {
          this.unboundLoss.first = ordinal; this.unboundLoss.outputFirst = output;
          this.unboundLoss.epoch = this.epoch;
        }
        if (this.unboundLoss.epoch !== this.epoch) this.unboundLoss.epoch = 0;
        this.unboundLoss.last = ordinal + 1;
        this.unboundLoss.outputLast = output + 1;
        this.unboundLoss.frames += 1;
        return;
      }
      slot.final = ordinal + 1;
      if (!this.acquire()) {
        if (this.packetVersion === 2) this.pendingBreak = true;
        if (!slot.lost) { slot.first = ordinal; slot.outputFirst = output; slot.epoch = this.epoch; }
        if (slot.epoch !== this.epoch) { slot.reasons |= 8; slot.epoch = 0; }
        slot.last = ordinal + 1;
        slot.outputLast = output + 1;
        slot.lost += 1;
        slot.reasons |= 1;
        return;
      }
      // A first successful capture has no predecessor to break from.
      if (this.packetVersion === 2 && this.lastOutputEnd !== null
          && (this.pendingBreak || output !== this.lastOutputEnd || ordinal !== this.lastOrdinalEnd)) {
        if (!this.safe(this.continuitySerial + 1, 1)) { this.enabled = false; return; }
        this.continuitySerial += 1;
      }
      const continuity = this.packetVersion === 2 ? this.continuitySerial : 0;
      const data = this.view;
      let offset = 256 + (this.count - 1) * 7;
      if (this.count && data[offset] === serial && data[offset + 1] === this.epoch
          && data[offset + 2] + data[offset + 3] === source
          && data[offset + 4] + data[offset + 3] === output
          && data[offset + 5] + data[offset + 3] === ordinal
          && data[offset + 6] === continuity) {
        data[offset + 3] += 1;
      } else {
        offset = 256 + this.count * 7;
        data[offset] = serial; data[offset + 1] = this.epoch;
        data[offset + 2] = source; data[offset + 3] = 1;
        data[offset + 4] = output; data[offset + 5] = ordinal;
        data[offset + 6] = continuity;
        this.count += 1;
      }
      if (this.packetVersion === 2) {
        this.lastOutputEnd = output + 1; this.lastOrdinalEnd = ordinal + 1;
        this.pendingBreak = false;
      }
      if (this.count === 256) this.flush();
    }

    flush() {
      if (!this.owner) return;
      if (!this.safe(this.packet + 1, 1)) { this.enabled = false; return; }
      let hasControl = Boolean(this.probe);
      for (let index = 0; index < 8; index++) {
        const slot = this.slots[index];
        if (slot.lost || slot.serial && slot.pending && !this.live(slot)) hasControl = true;
      }
      if (!this.count && !hasControl || !this.acquire()) return;
      const data = this.view;
      data[0] = 1094927184; data[1] = this.packetVersion; data[2] = this.owner;
      data[3] = ++this.packet; data[4] = this.count;
      data[5] = 48000; data[6] = 48000; data[7] = this.epoch;
      data[11] = this.maxQuantum; data[12] = this.bufferId;
      this.inFlight[this.bufferId - 1] = true;
      for (const slot of this.slots) {
        if (slot.lost) {
          const offset = 32 + data[8]++ * 8;
          data[offset] = slot.serial; data[offset + 1] = slot.epoch;
          data[offset + 2] = slot.first; data[offset + 3] = slot.last;
          data[offset + 4] = slot.lost; data[offset + 5] = slot.outputFirst;
          data[offset + 6] = slot.outputLast; data[offset + 7] = slot.reasons;
          slot.lost = 0; slot.reasons = 0;
        }
        if (slot.serial && slot.pending && !this.live(slot)) {
          const offset = 96 + data[9]++ * 4;
          data[offset] = slot.serial; data[offset + 1] = this.packet;
          data[offset + 2] = slot.final; data[offset + 3] = this.epoch;
          slot.serial = 0; slot.pending = false;
        }
      }
      if (this.probe) { data[10] = 1; data.set(this.probe, 128); this.probe = null; }
      const buffer = data.buffer;
      this.view = null; this.count = 0;
      this.outstanding += 1;
      this.lastFlush = currentFrame;
      this.message.buffer = buffer; this.transfer[0] = buffer;
      this.processor.port.postMessage(this.message, this.transfer);
      this.message.buffer = null; this.transfer[0] = null;
    }

    quantum(frames) {
      if (!this.enabled) return;
      this.maxQuantum = Math.max(this.maxQuantum, frames);
      if (currentFrame - this.lastFlush >= 12000) this.flush();
    }
  }

  class GaplessPlaybackProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this.positionCapture = new PositionCapture(this);
      this.retainedCaptureSerial = 0;
      this.generation = 0;
      this.sampleRate = 0;
      this.configured = false;
      this.current = createRing(1);
      this.continuity = createRing(1);
      this.renderedFrames = 0;
      this.timelineFrame = 0;
      this.playing = false;
      this.startupBufferFrames = 1;
      this.underruns = 0;
      this.outgoingCaptureLeft = new Float32Array(MAX_BOUNDARY_CAPTURE_FRAMES);
      this.outgoingCaptureRight = new Float32Array(MAX_BOUNDARY_CAPTURE_FRAMES);
      this.outgoingCaptureCount = 0;
      this.outgoingCaptureWrite = 0;
      this.boundaryOutgoingLeft = new Float32Array(MAX_BOUNDARY_CAPTURE_FRAMES);
      this.boundaryOutgoingRight = new Float32Array(MAX_BOUNDARY_CAPTURE_FRAMES);
      this.boundaryIncomingLeft = new Float32Array(MAX_BOUNDARY_CAPTURE_FRAMES);
      this.boundaryIncomingRight = new Float32Array(MAX_BOUNDARY_CAPTURE_FRAMES);
      this.retainedLoopSamples = new Float32Array(CHANNELS);
      this.loopActive = false;
      this.shortLoopActive = false;
      this.retainedLoopStreamId = null;
      this.retainedLoopFrames = 0;
      this.retainedLoopCapturedFrames = 0;
      this.retainedLoopReadFrame = 0;
      this.loopKind = '';
      this.loopStartFrame = 0;
      this.loopEndFrame = 0;
      this.shortLoopRendering = false;
      this.pendingSeek = null;
      this.expectContinuity = false;
      this.port.onmessage = ({ data }) => this.handleCommand(data);
    }

    reset(generation, timelineStartFrame = 0) {
      this.positionCapture.barrier();
      this.retainedCaptureSerial = 0;
      this.generation = generation;
      clearRing(this.current);
      clearRing(this.continuity);
      this.renderedFrames = timelineStartFrame;
      this.timelineFrame = timelineStartFrame;
      this.playing = false;
      this.underruns = 0;
      this.outgoingCaptureCount = 0;
      this.outgoingCaptureWrite = 0;
      this.loopActive = false;
      this.shortLoopActive = false;
      this.retainedLoopStreamId = null;
      this.retainedLoopFrames = 0;
      this.retainedLoopCapturedFrames = 0;
      this.retainedLoopReadFrame = 0;
      this.loopKind = '';
      this.loopStartFrame = 0;
      this.loopEndFrame = 0;
      this.shortLoopRendering = false;
      this.pendingSeek = null;
      this.expectContinuity = false;
      this.positionCapture.flush();
    }

    handleCommand(message) {
      if (!message || typeof message !== 'object' || typeof message.type !== 'string') return;
      if (message.type.startsWith("capture-")) { this.positionCapture.command(message); return; }
      if (message.type === 'configure') {
        this.configure(message);
        return;
      }
      if (message.type === 'seek-reset') {
        this.seekReset(message);
        return;
      }
      if (!this.configured || message.generation !== this.generation) return;
      if (['pause', 'play', 'stop'].includes(message.type)) this.positionCapture.barrier();
      if (message.type === 'pause') this.positionCapture.flush();
      if (message.type === 'enqueue') this.enqueue(message);
      else if (message.type === 'eos') this.markEos(message);
      else if (message.type === 'play') this.playing = true;
      else if (message.type === 'pause') this.playing = false;
      else if (message.type === 'set-loop') this.setLoop(message);
      else if (message.type === 'drop-continuity') this.dropContinuity(message);
      else if (message.type === 'reserve-seek') this.reserveSeek(message);
      else if (message.type === 'prepare-seek') this.prepareSeek(message);
      else if (message.type === 'expect-continuity') {
        this.expectContinuity = message.active === true;
      }
      else if (message.type === 'stop') this.stop(message);
    }

    configure(message) {
      const startupBufferFrames = message.startupBufferFrames === undefined
        ? (this.configured
          ? this.startupBufferFrames
          : Math.min(message.currentCapacityFrames, 128))
        : message.startupBufferFrames;
      const startupCapacityFrames = this.configured
        ? this.current.capacityFrames
        : message.currentCapacityFrames;
      if (!isIntegerBetween(message.generation, 1)
          || !isIntegerBetween(message.sampleRate, 8_000, 192_000)
          || !isIntegerBetween(message.currentCapacityFrames, 1, 10_000_000)
          || !isIntegerBetween(message.continuityCapacityFrames, 1, 10_000_000)
          || !isIntegerBetween(startupBufferFrames, 1, startupCapacityFrames)) return;
      if (this.configured && message.generation <= this.generation) return;
      if (!this.configured) {
        this.current = createRing(message.currentCapacityFrames);
        this.continuity = createRing(message.continuityCapacityFrames);
        this.retainedLoopSamples = new Float32Array(message.continuityCapacityFrames * CHANNELS);
        this.configured = true;
      }
      this.sampleRate = message.sampleRate;
      this.startupBufferFrames = startupBufferFrames;
      this.reset(message.generation, 0);
    }

    seekReset(message) {
      if (!this.configured
          || !isIntegerBetween(message.generation, this.generation + 1)
          || !isIntegerBetween(message.streamId, 1)
          || !isIntegerBetween(message.timelineStartFrame, 0, Number.MAX_SAFE_INTEGER)) return;
      this.reset(message.generation, message.timelineStartFrame);
      this.current.streamId = message.streamId;
    }

    ringForRole(role) {
      if (role === 'current') return this.current;
      if (role === 'continuity') return this.continuity;
      return null;
    }

    enqueue(message) {
      const ring = this.ringForRole(message.role);
      let rejection = '';
      if (!ring) rejection = 'unknown-role';
      else if (!isIntegerBetween(message.streamId, 1)) rejection = 'invalid-stream';
      else if (!isIntegerBetween(message.sequence, 0, MAX_GENERATION)) rejection = 'invalid-sequence';
      else if (!isIntegerBetween(message.frameCount, 1, ring.capacityFrames)) rejection = 'invalid-frame-count';
      else if (!(message.pcm instanceof Float32Array)) rejection = 'invalid-pcm';
      else if (message.pcm.length !== message.frameCount * CHANNELS) rejection = 'pcm-length';
      else if (message.frameCount > ring.capacityFrames - ring.bufferedFrames) rejection = 'capacity';
      else if (ring.eos) rejection = 'after-eos';
      if (rejection) {
        this.port.postMessage({
          type: 'protocol-reject', generation: this.generation, operation: 'enqueue',
          reason: rejection, role: message.role, streamId: message.streamId,
          sequence: message.sequence, frameCount: message.frameCount,
          ringStreamId: ring?.streamId ?? null, ringSequence: ring?.nextSequence ?? null,
          ringBufferedFrames: ring?.bufferedFrames ?? null, ringReceivedFrames: ring?.receivedFrames ?? null,
        });
        return;
      }
      const other = message.role === 'current' ? this.continuity : this.current;
      if ((ring.streamId !== null && ring.streamId !== message.streamId)
          || (other.streamId !== null && other.streamId === message.streamId)
          || message.sequence !== ring.nextSequence) {
        this.port.postMessage({
          type: 'protocol-reject', generation: this.generation, operation: 'enqueue',
          reason: message.sequence !== ring.nextSequence ? 'sequence' : 'identity',
          role: message.role, streamId: message.streamId, sequence: message.sequence,
          frameCount: message.frameCount, ringStreamId: ring.streamId,
          ringSequence: ring.nextSequence, ringBufferedFrames: ring.bufferedFrames,
          ringReceivedFrames: ring.receivedFrames,
        });
        return;
      }
      if (ring.streamId === null) ring.streamId = message.streamId;
      if (!ring.receivedFrames) {
        const binding = this.positionCapture.binding(message.streamId);
        ring.captureSerial = binding?.serial || 0;
        ring.captureSource = binding?.base || 0;
        if (message.streamId === this.retainedLoopStreamId) this.retainedCaptureSerial = ring.captureSerial;
      }
      appendInterleaved(ring, message.pcm, message.frameCount);
      if (message.role === 'continuity'
          && this.shortLoopActive
          && message.streamId === this.retainedLoopStreamId
          && this.retainedLoopCapturedFrames < this.retainedLoopFrames) {
        const retainedFrames = Math.min(
          message.frameCount,
          this.retainedLoopFrames - this.retainedLoopCapturedFrames,
        );
        for (let frame = 0; frame < retainedFrames; frame += 1) {
          const source = frame * CHANNELS;
          const target = (this.retainedLoopCapturedFrames + frame) * CHANNELS;
          this.retainedLoopSamples[target] = message.pcm[source];
          this.retainedLoopSamples[target + 1] = message.pcm[source + 1];
        }
        this.retainedLoopCapturedFrames += retainedFrames;
      }
      ring.nextSequence += 1;
    }

    markEos(message) {
      const ring = this.ringForRole(message.role);
      const validEmittedFrames = isIntegerBetween(
        message.emittedFrames,
        0,
        Number.MAX_SAFE_INTEGER,
      );
      const validAuthoritativeFrames = isIntegerBetween(
        message.authoritativeTotalFrames,
        message.emittedFrames,
        Number.MAX_SAFE_INTEGER,
      );
      const canBindEmptyRing = message.role === 'continuity'
        && ring?.streamId === null
        && isIntegerBetween(message.streamId, 1)
        && this.current.streamId !== message.streamId
        && message.emittedFrames === 0
        && validAuthoritativeFrames
        && ring.receivedFrames === 0
        && ring.bufferedFrames === 0;
      if (!ring
          || (ring.streamId !== message.streamId && !canBindEmptyRing)
          || !validEmittedFrames
          || !validAuthoritativeFrames
          || message.emittedFrames !== ring.receivedFrames) {
        this.port.postMessage({
          type: 'protocol-reject', generation: this.generation, operation: 'eos',
          reason: !ring ? 'unknown-role'
            : ring.streamId !== message.streamId ? 'identity'
              : message.emittedFrames !== ring.receivedFrames ? 'received-frames' : 'invalid-eos',
          role: message.role, streamId: message.streamId,
          emittedFrames: message.emittedFrames,
          ringStreamId: ring?.streamId ?? null,
          ringReceivedFrames: ring?.receivedFrames ?? null,
          ringBufferedFrames: ring?.bufferedFrames ?? null,
        });
        return;
      }
      if (canBindEmptyRing) ring.streamId = message.streamId;
      ring.eos = true;
      ring.emittedFrames = message.emittedFrames;
      ring.authoritativeTotalFrames = message.authoritativeTotalFrames;
    }

    dropContinuity(message) {
      if (!isIntegerBetween(message.streamId, 1)
          || this.continuity.streamId !== message.streamId) return;
      clearRing(this.continuity);
      if (this.pendingSeek?.streamId === message.streamId) this.pendingSeek = null;
    }

    prepareSeek(message) {
      if (!isIntegerBetween(message.streamId, 1)
          || !isIntegerBetween(message.timelineStartFrame, 0, Number.MAX_SAFE_INTEGER)
          || this.continuity.streamId !== message.streamId
          || this.continuity.bufferedFrames <= 0) return;
      this.pendingSeek = { ...this.pendingSeek, streamId: message.streamId,
        timelineStartFrame: message.timelineStartFrame, ready: true };
    }

    reserveSeek(message) {
      if (!isIntegerBetween(message.streamId, 1)
          || !isIntegerBetween(message.timelineStartFrame, 0, Number.MAX_SAFE_INTEGER)
          || (this.continuity.streamId !== null
            && this.continuity.streamId !== message.streamId)) return;
      this.pendingSeek = {
        streamId: message.streamId,
        timelineStartFrame: message.timelineStartFrame,
        ready: false,
        outgoingCapture: this.snapshotOutgoingCapture(),
      };
    }

    setLoop(message) {
      if (typeof message.active !== 'boolean') return;
      this.positionCapture.barrier();
      if (!message.active) {
        const resumeTimelineFrame = this.shortLoopRendering
          ? this.loopEndFrame
          : this.timelineFrame;
        const preparedRetainedStreamId = this.retainedLoopStreamId;
        if (preparedRetainedStreamId !== null
            && this.continuity.streamId === preparedRetainedStreamId) {
          clearRing(this.continuity);
        }
        this.loopActive = false;
        this.shortLoopActive = false;
        this.retainedLoopStreamId = null;
        this.retainedLoopFrames = 0;
        this.retainedLoopCapturedFrames = 0;
        this.retainedLoopReadFrame = 0;
        this.loopKind = '';
        this.loopStartFrame = 0;
        this.loopEndFrame = 0;
        this.shortLoopRendering = false;
        this.timelineFrame = resumeTimelineFrame;
        return;
      }
      if (!isIntegerBetween(message.startFrame, 0, Number.MAX_SAFE_INTEGER)
          || !isIntegerBetween(message.endFrame, message.startFrame + 1, Number.MAX_SAFE_INTEGER)
          || !isIntegerBetween(message.retainedStreamId, 1)) return;
      const loopFrames = message.endFrame - message.startFrame;
      const acceptedKind = ['short-loop', 'long-loop', 'whole-track-repeat'].includes(message.kind)
        ? message.kind
        : (loopFrames <= this.sampleRate * 5 ? 'short-loop' : 'long-loop');
      const shortLoop = acceptedKind === 'short-loop';
      if ((this.continuity.streamId !== null
          && this.continuity.streamId !== message.retainedStreamId)
          || this.current.streamId === message.retainedStreamId) return;
      if (shortLoop && loopFrames > this.retainedLoopSamples.length / CHANNELS) return;
      if (this.continuity.streamId === null) {
        this.continuity.streamId = message.retainedStreamId;
      }

      const wasLoopActive = this.loopActive;
      this.loopActive = true;
      this.shortLoopActive = shortLoop;
      this.loopKind = acceptedKind;
      this.loopStartFrame = message.startFrame;
      this.loopEndFrame = message.endFrame;
      if (!wasLoopActive) {
        this.timelineFrame = Math.max(this.timelineFrame, this.renderedFrames);
      }
      this.retainedLoopStreamId = message.retainedStreamId;
      this.retainedCaptureSerial = this.continuity.captureSerial || 0;
      this.retainedLoopFrames = shortLoop ? loopFrames : 0;
      this.retainedLoopCapturedFrames = 0;
      this.retainedLoopReadFrame = 0;
      this.shortLoopRendering = false;
      this.pendingSeek = null;
      if (!shortLoop) return;
      const retainedFrames = Math.min(loopFrames, this.continuity.bufferedFrames);
      for (let frame = 0; frame < retainedFrames; frame += 1) {
        const sourceFrame = (this.continuity.readFrame + frame) % this.continuity.capacityFrames;
        const source = sourceFrame * CHANNELS;
        const target = frame * CHANNELS;
        this.retainedLoopSamples[target] = this.continuity.samples[source];
        this.retainedLoopSamples[target + 1] = this.continuity.samples[source + 1];
      }
      this.retainedLoopCapturedFrames = retainedFrames;
    }

    stop(message) {
      if (typeof message.reason !== 'string' || message.reason.length === 0 || message.reason.length > 256) return;
      this.playing = false;
      clearRing(this.current);
      clearRing(this.continuity);
      this.loopActive = false;
      this.shortLoopActive = false;
      this.retainedLoopStreamId = null;
      this.retainedLoopFrames = 0;
      this.retainedLoopCapturedFrames = 0;
      this.retainedLoopReadFrame = 0;
      this.loopKind = '';
      this.loopStartFrame = 0;
      this.loopEndFrame = 0;
      this.shortLoopRendering = false;
      this.expectContinuity = false;
      this.positionCapture.flush();
      this.port.postMessage({
        type: 'stopped',
        generation: this.generation,
        reason: message.reason,
        renderedFrame: this.renderedFrames,
      });
    }

    rememberOutgoing(leftSample, rightSample) {
      this.outgoingCaptureLeft[this.outgoingCaptureWrite] = leftSample;
      this.outgoingCaptureRight[this.outgoingCaptureWrite] = rightSample;
      this.outgoingCaptureWrite = (this.outgoingCaptureWrite + 1) % MAX_BOUNDARY_CAPTURE_FRAMES;
      this.outgoingCaptureCount = Math.min(MAX_BOUNDARY_CAPTURE_FRAMES, this.outgoingCaptureCount + 1);
    }

    copyOutgoingCapture() {
      this.boundaryOutgoingLeft.fill(0);
      this.boundaryOutgoingRight.fill(0);
      const start = (this.outgoingCaptureWrite - this.outgoingCaptureCount + MAX_BOUNDARY_CAPTURE_FRAMES)
        % MAX_BOUNDARY_CAPTURE_FRAMES;
      for (let index = 0; index < this.outgoingCaptureCount; index += 1) {
        const source = (start + index) % MAX_BOUNDARY_CAPTURE_FRAMES;
        this.boundaryOutgoingLeft[index] = this.outgoingCaptureLeft[source];
        this.boundaryOutgoingRight[index] = this.outgoingCaptureRight[source];
      }
      return this.outgoingCaptureCount;
    }

    snapshotOutgoingCapture() {
      const frames = this.copyOutgoingCapture();
      return {
        frames,
        left: this.boundaryOutgoingLeft.slice(),
        right: this.boundaryOutgoingRight.slice(),
      };
    }

    promoteContinuity(reason = 'discontinuity') {
      this.positionCapture.barrier(reason);
      const oldCurrent = this.current;
      this.current = this.continuity;
      this.continuity = oldCurrent;
      clearRing(this.continuity);
      this.outgoingCaptureCount = 0;
      this.outgoingCaptureWrite = 0;
    }

    commitPreparedSeek() {
      const pending = this.pendingSeek;
      if (!pending?.ready || this.continuity.streamId !== pending.streamId
          || this.continuity.bufferedFrames <= 0) return false;
      const outgoingStreamId = this.current.streamId;
      const renderedFrame = this.renderedFrames;
      const reservedOutgoing = pending.outgoingCapture || null;
      const outgoingFrames = reservedOutgoing?.frames ?? this.copyOutgoingCapture();
      this.boundaryIncomingLeft.fill(0);
      this.boundaryIncomingRight.fill(0);
      const incomingSource = this.continuity.readFrame * CHANNELS;
      this.boundaryIncomingLeft[0] = this.continuity.samples[incomingSource];
      this.boundaryIncomingRight[0] = this.continuity.samples[incomingSource + 1];
      this.promoteContinuity();
      this.timelineFrame = pending.timelineStartFrame;
      this.pendingSeek = null;
      this.port.postMessage({
        type: 'seek-boundary',
        generation: this.generation,
        outgoingStreamId,
        incomingStreamId: this.current.streamId,
        renderedFrame,
        timelineFrame: this.timelineFrame,
        silentFrames: 0,
        capture: {
          outgoing: {
            frames: outgoingFrames,
            left: reservedOutgoing?.left || this.boundaryOutgoingLeft,
            right: reservedOutgoing?.right || this.boundaryOutgoingRight,
          },
          incoming: {
            frames: 1,
            left: this.boundaryIncomingLeft,
            right: this.boundaryIncomingRight,
          },
        },
      });
      return true;
    }

    emitShortLoopBoundary(outgoingStreamId, renderedFrame) {
      this.positionCapture.barrier('seamless-loop');
      const outgoingFrames = this.copyOutgoingCapture();
      this.boundaryIncomingLeft.fill(0);
      this.boundaryIncomingRight.fill(0);
      const source = this.retainedLoopReadFrame * CHANNELS;
      this.boundaryIncomingLeft[0] = this.retainedLoopSamples[source];
      this.boundaryIncomingRight[0] = this.retainedLoopSamples[source + 1];
      this.port.postMessage({
        type: 'boundary',
        generation: this.generation,
        outgoingStreamId,
        incomingStreamId: this.retainedLoopStreamId,
        renderedFrame,
        capture: {
          outgoing: {
            frames: outgoingFrames,
            left: this.boundaryOutgoingLeft,
            right: this.boundaryOutgoingRight,
          },
          incoming: {
            frames: 1,
            left: this.boundaryIncomingLeft,
            right: this.boundaryIncomingRight,
          },
        },
      });
      this.outgoingCaptureCount = 0;
      this.outgoingCaptureWrite = 0;
    }

    process(_inputs, outputs) {
      const output = outputs[0];
      if (!output || output.length < 2) return true;
      const left = output[0];
      const right = output[1];
      this.positionCapture.quantum(left.length);
      left.fill(0);
      right.fill(0);
      this.commitPreparedSeek();
      if (!this.playing || !this.configured) return true;
      if (!this.current.firstFrameReported && !this.current.eos
          && this.current.bufferedFrames < this.startupBufferFrames) return true;

      let firstConsumedRing = null;
      let firstConsumedStreamId = null;
      let firstConsumedRole = 'current';
      let firstConsumedFrames = 0;
      let firstConsumedAudible = false;
      let firstConsumedEvidence = null;
      let secondConsumedRing = null;
      let secondConsumedStreamId = null;
      let secondConsumedFrames = 0;
      let secondConsumedAudible = false;
      let secondConsumedEvidence = null;
      let pendingPlaybackNotification = null;
      const appendConsumedEvidence = (evidence, leftSample, rightSample) => {
        const result = evidence || {
          finiteSamples: 0, nonZeroSamples: 0, peakSample: 0, samples: [],
        };
        for (const sample of [leftSample, rightSample]) {
          if (!Number.isFinite(sample)) continue;
          result.finiteSamples += 1;
          const magnitude = Math.abs(sample);
          if (magnitude > 0) result.nonZeroSamples += 1;
          result.peakSample = Math.max(result.peakSample, magnitude);
          if (result.samples.length < 32) result.samples.push(sample);
        }
        return result;
      };
      const recordConsumedSample = (
        ring, streamId, role, leftSample, rightSample, audible = false,
      ) => {
        if (!firstConsumedRing) {
          firstConsumedRing = ring;
          firstConsumedStreamId = streamId;
          firstConsumedRole = role;
          firstConsumedFrames = 1;
          firstConsumedAudible = audible;
          firstConsumedEvidence = appendConsumedEvidence(null, leftSample, rightSample);
          return;
        }
        if (ring === firstConsumedRing && streamId === firstConsumedStreamId) {
          firstConsumedFrames += 1;
          firstConsumedAudible ||= audible;
          firstConsumedEvidence = appendConsumedEvidence(
            firstConsumedEvidence, leftSample, rightSample,
          );
          return;
        }
        if (!secondConsumedRing) {
          secondConsumedRing = ring;
          secondConsumedStreamId = streamId;
        }
        secondConsumedFrames += 1;
        secondConsumedAudible ||= audible;
        secondConsumedEvidence = appendConsumedEvidence(
          secondConsumedEvidence, leftSample, rightSample,
        );
      };
      let boundaryPending = false;
      let boundaryOutgoingStreamId = null;
      let boundaryIncomingStreamId = null;
      let boundaryRenderedFrame = 0;
      let boundaryOutgoingFrames = 0;
      let boundaryIncomingCount = 0;
      let outputFrame = 0;
      while (outputFrame < left.length) {
        if (this.loopActive && this.timelineFrame >= this.loopEndFrame) {
          if (this.shortLoopActive) {
            if (this.retainedLoopFrames <= 0
                || this.retainedLoopCapturedFrames !== this.retainedLoopFrames) {
              const missingFrames = left.length - outputFrame;
              this.underruns += 1;
              this.positionCapture.barrier();
              this.port.postMessage({
                type: 'underrun', generation: this.generation,
                streamId: this.current.streamId, role: 'current',
                renderedFrame: this.renderedFrames + outputFrame, missingFrames,
              });
              outputFrame = left.length;
              break;
            }
            const outgoingStreamId = this.shortLoopRendering
              ? this.retainedLoopStreamId
              : this.current.streamId;
            this.retainedLoopReadFrame = 0;
            this.emitShortLoopBoundary(
              outgoingStreamId,
              this.renderedFrames + outputFrame,
            );
            this.shortLoopRendering = true;
            this.timelineFrame = this.loopStartFrame;
            continue;
          }
          if (this.continuity.streamId !== null && this.continuity.bufferedFrames > 0) {
            boundaryOutgoingStreamId = this.current.streamId;
            boundaryIncomingStreamId = this.continuity.streamId;
            boundaryRenderedFrame = this.renderedFrames + outputFrame;
            boundaryOutgoingFrames = this.copyOutgoingCapture();
            boundaryPending = true;
            this.promoteContinuity('seamless-loop');
            this.timelineFrame = this.loopStartFrame;
            continue;
          }
          const missingFrames = left.length - outputFrame;
          this.underruns += 1;
              this.positionCapture.barrier();
          this.port.postMessage({
            type: 'underrun', generation: this.generation,
            streamId: this.current.streamId, role: 'current',
            renderedFrame: this.renderedFrames + outputFrame, missingFrames,
          });
          outputFrame = left.length;
          break;
        }
        if (this.shortLoopRendering) {
          const retainedSource = this.retainedLoopReadFrame * CHANNELS;
          const loopLeft = this.retainedLoopSamples[retainedSource];
          const loopRight = this.retainedLoopSamples[retainedSource + 1];
          left[outputFrame] = loopLeft;
          right[outputFrame] = loopRight;
          if (this.positionCapture.enabled) this.positionCapture.record(this.retainedCaptureSerial,
            this.loopStartFrame + this.retainedLoopReadFrame, currentFrame + outputFrame);
          recordConsumedSample(
            this.current,
            this.retainedLoopStreamId,
            'continuity',
            loopLeft,
            loopRight,
            true,
          );
          this.retainedLoopReadFrame = (this.retainedLoopReadFrame + 1) % this.retainedLoopFrames;
          this.rememberOutgoing(loopLeft, loopRight);
          this.timelineFrame += 1;
          outputFrame += 1;
          continue;
        }
        if (this.current.bufferedFrames === 0) {
          if (this.current.eos && this.pendingSeek
              && this.continuity.streamId === this.pendingSeek.streamId) {
            const missingFrames = left.length - outputFrame;
            this.underruns += 1;
              this.positionCapture.barrier();
            pendingPlaybackNotification = {
              type: 'underrun', generation: this.generation,
              streamId: this.current.streamId, role: 'current',
              renderedFrame: this.renderedFrames + outputFrame, missingFrames,
            };
            outputFrame = left.length;
            break;
          }
          if (this.current.eos && this.continuity.streamId !== null
              && this.continuity.bufferedFrames > 0) {
            boundaryOutgoingStreamId = this.current.streamId;
            boundaryIncomingStreamId = this.continuity.streamId;
            boundaryRenderedFrame = this.renderedFrames + outputFrame;
            boundaryOutgoingFrames = this.copyOutgoingCapture();
            boundaryPending = true;
            this.promoteContinuity('seamless-track');
            this.expectContinuity = false;
            this.timelineFrame = 0;
            continue;
          }
          if (this.current.eos && this.loopActive && this.shortLoopActive
              && this.current.streamId === this.retainedLoopStreamId
              && this.retainedLoopFrames > 0
              && this.retainedLoopCapturedFrames === this.retainedLoopFrames) {
            const retainedSource = this.retainedLoopReadFrame * CHANNELS;
            const loopLeft = this.retainedLoopSamples[retainedSource];
            const loopRight = this.retainedLoopSamples[retainedSource + 1];
            left[outputFrame] = loopLeft;
            right[outputFrame] = loopRight;
            if (this.positionCapture.enabled) this.positionCapture.record(this.retainedCaptureSerial,
              this.loopStartFrame + this.retainedLoopReadFrame, currentFrame + outputFrame);
            recordConsumedSample(
              this.current,
              this.retainedLoopStreamId,
              'continuity',
              loopLeft,
              loopRight,
              true,
            );
            this.retainedLoopReadFrame = (this.retainedLoopReadFrame + 1) % this.retainedLoopFrames;
            if (boundaryPending && boundaryIncomingCount < MAX_BOUNDARY_CAPTURE_FRAMES) {
              this.boundaryIncomingLeft[boundaryIncomingCount] = loopLeft;
              this.boundaryIncomingRight[boundaryIncomingCount] = loopRight;
              boundaryIncomingCount += 1;
            }
            this.rememberOutgoing(loopLeft, loopRight);
            this.timelineFrame += 1;
            outputFrame += 1;
            continue;
          }
          if (this.current.eos) {
            if (this.expectContinuity && !this.continuity.eos) {
              if (this.current.firstFrameReported) {
                this.underruns += 1;
              this.positionCapture.barrier();
                pendingPlaybackNotification = {
                  type: 'underrun', generation: this.generation,
                  streamId: this.current.streamId, role: 'current',
                  renderedFrame: this.renderedFrames + outputFrame,
                  missingFrames: left.length - outputFrame,
                };
              }
              outputFrame = left.length;
              break;
            }
            pendingPlaybackNotification = {
              type: 'ended',
              generation: this.generation,
              streamId: this.current.streamId,
              timelineFrame: this.timelineFrame,
            };
            this.playing = false;
            break;
          }
          const missingFrames = left.length - outputFrame;
          if (this.current.firstFrameReported) {
            this.underruns += 1;
              this.positionCapture.barrier();
            pendingPlaybackNotification = {
              type: 'underrun',
              generation: this.generation,
              streamId: this.current.streamId,
              role: 'current',
              renderedFrame: this.renderedFrames + outputFrame,
              missingFrames,
            };
          }
          outputFrame = left.length;
          break;
        }

        const ring = this.current;
        if (!ring.firstFrameReported) {
          ring.firstFrameReported = true;
          this.port.postMessage({
            type: 'first-frame',
            generation: this.generation,
            streamId: ring.streamId,
            renderedFrame: this.renderedFrames + outputFrame,
            contextTime: currentTime,
          });
        }
        takeFrame(ring, left, right, outputFrame);
        if (this.positionCapture.enabled) {
          this.positionCapture.record(ring.captureSerial, ring.captureSource, currentFrame + outputFrame);
          ring.captureSource += 1;
        }
        const leftSample = left[outputFrame];
        const rightSample = right[outputFrame];
        const isBoundaryIncoming = boundaryPending && ring.streamId === boundaryIncomingStreamId;
        recordConsumedSample(
          ring,
          ring.streamId,
          isBoundaryIncoming ? 'continuity' : 'current',
          leftSample,
          rightSample,
        );
        if (isBoundaryIncoming && boundaryIncomingCount < MAX_BOUNDARY_CAPTURE_FRAMES) {
          this.boundaryIncomingLeft[boundaryIncomingCount] = leftSample;
          this.boundaryIncomingRight[boundaryIncomingCount] = rightSample;
          boundaryIncomingCount += 1;
        }
        this.rememberOutgoing(leftSample, rightSample);
        this.timelineFrame += 1;
        outputFrame += 1;
      }

      if (firstConsumedRing) {
        this.port.postMessage({
          type: 'consumed',
          generation: this.generation,
          streamId: firstConsumedStreamId,
          role: firstConsumedRole,
          frames: firstConsumedFrames,
          bufferedFrames: firstConsumedRing.bufferedFrames,
          audible: firstConsumedAudible,
          ...firstConsumedEvidence,
        });
      }
      if (secondConsumedRing) {
        this.port.postMessage({
          type: 'consumed',
          generation: this.generation,
          streamId: secondConsumedStreamId,
          role: 'continuity',
          frames: secondConsumedFrames,
          bufferedFrames: secondConsumedRing.bufferedFrames,
          audible: secondConsumedAudible,
          ...secondConsumedEvidence,
        });
      }
      if (boundaryPending && boundaryIncomingCount > 0) {
        this.port.postMessage({
          type: 'boundary',
          generation: this.generation,
          outgoingStreamId: boundaryOutgoingStreamId,
          incomingStreamId: boundaryIncomingStreamId,
          renderedFrame: boundaryRenderedFrame,
          timelineFrame: this.timelineFrame,
          capture: {
            outgoing: {
              frames: boundaryOutgoingFrames,
              left: this.boundaryOutgoingLeft,
              right: this.boundaryOutgoingRight,
            },
            incoming: {
              frames: boundaryIncomingCount,
              left: this.boundaryIncomingLeft,
              right: this.boundaryIncomingRight,
            },
          },
        });
      }
      // Credit this block before a terminal or interruption event closes its listen segment.
      if (pendingPlaybackNotification) this.positionCapture.flush();
      if (pendingPlaybackNotification) this.port.postMessage(pendingPlaybackNotification);
      if (this.current?.firstFrameReported && outputFrame > 0) {
        this.port.postMessage({
          type: 'position',
          generation: this.generation,
          streamId: this.current.streamId,
          timelineFrame: this.timelineFrame,
        });
      }
      this.renderedFrames += left.length;
      return true;
    }
  }

  registerProcessor(PROCESSOR_NAME, GaplessPlaybackProcessor);
})();
