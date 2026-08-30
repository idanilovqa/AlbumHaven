import { formatMegabytes } from './performanceHelpers.js';

function buildTimingMessage(label, timingMs) {
  return `${label} in ${Number(timingMs || 0)} ms`;
}

function buildMemoryMessage(label, memoryBytes) {
  return `${label} ${formatMegabytes(memoryBytes)} (${Number(memoryBytes || 0)} bytes)`;
}

function buildMessageParts(checkpoint) {
  if (checkpoint.timingMs !== null) {
    return [
      buildTimingMessage(checkpoint.label, checkpoint.timingMs),
      checkpoint.memoryBytes === null
        ? null
        : `memory ${formatMegabytes(checkpoint.memoryBytes)} (${checkpoint.memoryBytes} bytes)`,
    ].filter(Boolean);
  }
  if (checkpoint.memoryBytes !== null) {
    return [buildMemoryMessage(checkpoint.label, checkpoint.memoryBytes)];
  }
  if (checkpoint.valueText) {
    return [`${checkpoint.label}: ${checkpoint.valueText}`];
  }
  return [checkpoint.label];
}

export function createPerformanceCheckpointRecorder(runLabel) {
  const checkpoints = [];

  function recordCheckpoint({
    key,
    label,
    timingMs = null,
    memoryBytes = null,
    memorySource = null,
    memorySamples = [],
    valueText = '',
    details = null,
  }) {
    const checkpoint = {
      key,
      label,
      timingMs: timingMs === null ? null : Number(timingMs),
      memoryBytes: memoryBytes === null ? null : Number(memoryBytes),
      memorySource: memorySource || null,
      memorySamples,
      valueText: valueText || '',
      details: details || null,
      recordedAt: new Date().toISOString(),
    };
    checkpoints.push(checkpoint);
    const message = buildMessageParts(checkpoint).join(' | ');
    console.log(`[${runLabel}] ${message}`);
    return checkpoint;
  }

  function recordTimingCheckpoint({ key, label, timingMs, memorySample, details = null }) {
    return recordCheckpoint({
      key,
      label,
      timingMs,
      memoryBytes: Number(memorySample?.bytes || 0),
      memorySource: memorySample?.source || null,
      memorySamples: memorySample ? [memorySample] : [],
      details,
    });
  }

  function recordMemoryCheckpoint({ key, label, memoryBytes, memorySource = null, memorySamples = [], details = null }) {
    return recordCheckpoint({
      key,
      label,
      memoryBytes,
      memorySource,
      memorySamples,
      details,
    });
  }

  function recordTextCheckpoint({ key, label, valueText, details = null }) {
    return recordCheckpoint({
      key,
      label,
      valueText,
      details,
    });
  }

  return {
    checkpoints,
    recordTimingCheckpoint,
    recordMemoryCheckpoint,
    recordTextCheckpoint,
  };
}
