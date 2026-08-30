function isCoverLookupTaskCompleted(task) {
  return ['completed', 'failed', 'canceled'].includes(String(task?.status || ''));
}

function getCoverLookupTaskCompletionValue(task) {
  return String(
    task?.notification_completed_at
    || task?.finished_at
    || task?.updated_at
    || task?.created_at
    || ''
  ).trim();
}

function formatCoverLookupTaskElapsedLabel(task, nowMs = Date.now()) {
  const status = String(task?.status || '').trim();
  const isActive = ['pending', 'running'].includes(status);
  const isTerminal = isCoverLookupTaskCompleted(task);
  if (!isActive && !isTerminal) return '';

  const startedAtMs = Date.parse(String(task?.created_at || '').trim());
  if (!Number.isFinite(startedAtMs)) return '';

  const endedAtValue = isTerminal
    ? String(
      task?.notification_completed_at
      || task?.finished_at
      || task?.updated_at
      || ''
    ).trim()
    : '';
  const endedAtMs = isActive ? Number(nowMs) : Date.parse(endedAtValue);
  if (!Number.isFinite(endedAtMs)) return '';

  const elapsedSeconds = Math.max(0, Math.floor((endedAtMs - startedAtMs) / 1000));
  let durationLabel = `${elapsedSeconds}s`;
  if (elapsedSeconds >= 3600) {
    const hours = Math.floor(elapsedSeconds / 3600);
    const minutes = Math.floor((elapsedSeconds % 3600) / 60);
    durationLabel = `${hours}h ${String(minutes).padStart(2, '0')}m`;
  } else if (elapsedSeconds >= 60) {
    const minutes = Math.floor(elapsedSeconds / 60);
    const seconds = elapsedSeconds % 60;
    durationLabel = `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  }
  return `${isActive ? 'Elapsed' : 'Took'} ${durationLabel}`;
}

function normalizeCoverLookupNotificationTask(task, options = {}) {
  if (!task || typeof task !== 'object') return null;
  const normalized = deepCloneJson(task) || {};
  if (!String(normalized.id || '').trim()) return null;
  const actionTaken = options.actionTaken ?? Boolean(normalized.notification_action_taken);
  normalized.notification_action_taken = actionTaken;
  if (isCoverLookupTaskCompleted(normalized)) {
    normalized.notification_completed_at = getCoverLookupTaskCompletionValue(normalized);
    normalized.notification_expires_at = '';
  } else {
    normalized.notification_completed_at = '';
    normalized.notification_expires_at = '';
  }
  return normalized;
}

function pruneCoverLookupNotificationTasks(tasks) {
  return (Array.isArray(tasks) ? tasks : [])
    .map((task) => normalizeCoverLookupNotificationTask(task))
    .filter(Boolean);
}

function loadPersistedCoverLookupNotificationTasks() {
  return [];
}

function persistCoverLookupNotificationTasks(_tasks) {
  return false;
}

function clearPersistedCoverLookupNotificationTasks() {
  return false;
}

function mergeCoverLookupTasksWithNotifications(tasks) {
  return pruneCoverLookupNotificationTasks(tasks);
}

function markCoverLookupTaskActionTaken(taskId, album = null) {
  const normalizedId = String(taskId || '').trim();
  const albumSignature = album ? buildTrackPathSignature(album) : '';
  const matchingTaskIds = [];
  state.coverLookup.tasks = (state.coverLookup.tasks || []).map((task) => {
    if (!isCoverLookupTaskCompleted(task)) return task;
    const taskIdMatches = normalizedId && String(task?.id || '') === normalizedId;
    const taskAlbumSignature = task?.album_payload ? buildTrackPathSignature(task.album_payload) : '';
    const taskAlbumMatches = albumSignature && taskAlbumSignature && taskAlbumSignature === albumSignature;
    if (!taskIdMatches && !taskAlbumMatches) return task;
    const nextTask = normalizeCoverLookupNotificationTask(task, { actionTaken: true }) || task;
    matchingTaskIds.push(String(nextTask?.id || '').trim());
    return nextTask;
  });
  matchingTaskIds
    .filter(Boolean)
    .forEach((matchedTaskId) => {
      fetch(`/utilities/cover-lookup/task/${encodeURIComponent(matchedTaskId)}/mark-action-taken`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      }).catch((error) => {
        console.warn('[AlbumHaven][CoverLookup] Failed to persist actioned notification state.', error);
      });
    });
}
