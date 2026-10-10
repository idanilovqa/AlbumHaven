// Shared validation for the private progress projection; no listening inference.
export const isProgressRevision = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(value)
  && (value.length < 19 || value <= '9223372036854775807');

function isCompletionTime(value) {
  if (value === null) return true;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 19) === value.slice(0, 19);
}

export const isManualProgress = value => Boolean(value && typeof value === 'object' && !Array.isArray(value)
  && Object.hasOwn(value, 'progress_revision') && Object.hasOwn(value, 'manual_completed_at')
  && isProgressRevision(value.progress_revision) && isCompletionTime(value.manual_completed_at)
  && (value.progress_revision !== '0' || value.manual_completed_at === null));
