// Repeated identical operations must cost about the same every time. A series passes
// when its spread is within MAX_SPREAD_RATIO or within SPREAD_FLOOR_MS (so jitter on
// sub-second timings is not a failure), and when its later half is not slower than
// its earlier half by more than MAX_GROWTH_RATIO (again with the absolute floor).
// Proposed for owner approval (2026-11-18); see FTC-TAGS-031P and FTC-TAGS-032P.
export const MAX_SPREAD_RATIO = 2;
export const MAX_GROWTH_RATIO = 1.5;
export const SPREAD_FLOOR_MS = 500;

const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;

export function summarizeTimingSeries(timingsMs) {
  const values = timingsMs.map(Number);
  if (values.length < 2 || values.some((value) => !Number.isFinite(value) || value < 0)) {
    throw new TypeError(`A timing series needs two or more valid timings: ${JSON.stringify(timingsMs)}`);
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const half = Math.floor(values.length / 2);
  const firstHalfMeanMs = mean(values.slice(0, half));
  const lastHalfMeanMs = mean(values.slice(values.length - half));
  return {
    timingsMs: values,
    minMs: min,
    maxMs: max,
    spreadMs: max - min,
    spreadRatio: min > 0 ? max / min : Number.POSITIVE_INFINITY,
    firstHalfMeanMs,
    lastHalfMeanMs,
    growthMs: lastHalfMeanMs - firstHalfMeanMs,
    growthRatio: firstHalfMeanMs > 0 ? lastHalfMeanMs / firstHalfMeanMs : Number.POSITIVE_INFINITY,
  };
}

export function expectComparableTimings(expect, timingsMs, label) {
  const summary = summarizeTimingSeries(timingsMs);
  const rounded = summary.timingsMs.map(Math.round).join(', ');
  expect(
    summary.spreadRatio <= MAX_SPREAD_RATIO || summary.spreadMs <= SPREAD_FLOOR_MS,
    `${label} must be comparable: [${rounded}] ms spread ${Math.round(summary.spreadMs)} ms `
      + `(x${summary.spreadRatio.toFixed(2)}), allowed x${MAX_SPREAD_RATIO} or ${SPREAD_FLOOR_MS} ms.`,
  ).toBe(true);
  expect(
    summary.growthRatio <= MAX_GROWTH_RATIO || summary.growthMs <= SPREAD_FLOOR_MS,
    `${label} must not grow: first-half mean ${Math.round(summary.firstHalfMeanMs)} ms, `
      + `last-half mean ${Math.round(summary.lastHalfMeanMs)} ms, allowed x${MAX_GROWTH_RATIO} `
      + `or +${SPREAD_FLOOR_MS} ms.`,
  ).toBe(true);
  return summary;
}
