const LOOP_EDIT_INACTIVITY_MS = 5 * 60 * 1000;
const LOOP_EDIT_SECOND_CYCLE_GRACE_MS = 15 * 1000;

function createLoopEditSessionExpiryController(options = {}) {
  const setTimeoutFn = options.setTimeoutFn || setTimeout;
  const clearTimeoutFn = options.clearTimeoutFn || clearTimeout;
  const nowFn = options.nowFn || (() => Date.now());
  const sessions = new Map();
  let nextGeneration = 1;

  function clearSessionTimers(session) {
    if (session.inactivityTimer !== null) clearTimeoutFn(session.inactivityTimer);
    if (session.wholeRangeGraceTimer !== null) clearTimeoutFn(session.wholeRangeGraceTimer);
    session.inactivityTimer = null;
    session.wholeRangeGraceTimer = null;
  }

  function expire(session, reason) {
    if (sessions.get(session.ownerId) !== session) return false;
    sessions.delete(session.ownerId);
    clearSessionTimers(session);
    session.onExpire({ ownerId: session.ownerId, reason });
    return true;
  }

  function reconcileSession(session) {
    if (sessions.get(session.ownerId) !== session) return false;
    const now = Number(nowFn());
    if (session.wholeRangeGraceDeadlineAt !== null
        && now >= session.wholeRangeGraceDeadlineAt) {
      return expire(session, 'untouched-whole-range');
    }
    if (now >= session.inactivityDeadlineAt) return expire(session, 'inactive');
    return false;
  }

  function scheduleInactivity(session, renewDeadline = true) {
    if (session.inactivityTimer !== null) clearTimeoutFn(session.inactivityTimer);
    if (renewDeadline) {
      session.inactivityDeadlineAt = Number(nowFn()) + LOOP_EDIT_INACTIVITY_MS;
    }
    const remaining = Math.max(0, session.inactivityDeadlineAt - Number(nowFn()));
    session.inactivityTimer = setTimeoutFn(() => {
      session.inactivityTimer = null;
      if (!reconcileSession(session)) scheduleInactivity(session, false);
    }, remaining);
  }

  function stop(ownerId) {
    const normalizedOwnerId = String(ownerId || '');
    const session = sessions.get(normalizedOwnerId);
    if (!session) return false;
    sessions.delete(normalizedOwnerId);
    clearSessionTimers(session);
    return true;
  }

  function start({ ownerId, onExpire }) {
    const normalizedOwnerId = String(ownerId || '');
    if (!normalizedOwnerId) throw new Error('Loop edit expiry ownerId is required.');
    if (typeof onExpire !== 'function') throw new Error('Loop edit expiry onExpire callback is required.');
    stop(normalizedOwnerId);
    const session = {
      ownerId: normalizedOwnerId,
      onExpire,
      generation: nextGeneration,
      boundaryEdited: false,
      wholeRangeWrapObserved: false,
      inactivityDeadlineAt: 0,
      wholeRangeGraceDeadlineAt: null,
      inactivityTimer: null,
      wholeRangeGraceTimer: null,
    };
    nextGeneration += 1;
    sessions.set(normalizedOwnerId, session);
    scheduleInactivity(session);
    return session.generation;
  }

  function renewAfterBoundaryEdit(ownerId) {
    const session = sessions.get(String(ownerId || ''));
    if (!session) return false;
    session.boundaryEdited = true;
    if (session.wholeRangeGraceTimer !== null) {
      clearTimeoutFn(session.wholeRangeGraceTimer);
      session.wholeRangeGraceTimer = null;
    }
    session.wholeRangeGraceDeadlineAt = null;
    scheduleInactivity(session);
    return true;
  }

  function noteUntouchedWholeRangeWrap(ownerId) {
    const session = sessions.get(String(ownerId || ''));
    if (!session || session.boundaryEdited || session.wholeRangeWrapObserved) return false;
    session.wholeRangeWrapObserved = true;
    session.wholeRangeGraceDeadlineAt = Number(nowFn()) + LOOP_EDIT_SECOND_CYCLE_GRACE_MS;
    session.wholeRangeGraceTimer = setTimeoutFn(() => {
      session.wholeRangeGraceTimer = null;
      if (!reconcileSession(session)) {
        const remaining = Math.max(0, session.wholeRangeGraceDeadlineAt - Number(nowFn()));
        session.wholeRangeGraceTimer = setTimeoutFn(() => {
          reconcileSession(session);
        }, remaining);
      }
    }, LOOP_EDIT_SECOND_CYCLE_GRACE_MS);
    return true;
  }

  function reconcile() {
    let expiredCount = 0;
    [...sessions.values()].forEach((session) => {
      if (reconcileSession(session)) expiredCount += 1;
    });
    return expiredCount;
  }

  function has(ownerId) {
    return sessions.has(String(ownerId || ''));
  }

  return {
    start,
    renewAfterBoundaryEdit,
    noteUntouchedWholeRangeWrap,
    stop,
    has,
    reconcile,
  };
}

const loopEditSessionExpiryController = createLoopEditSessionExpiryController({
  setTimeoutFn: (...args) => setTimeout(...args),
  clearTimeoutFn: (...args) => clearTimeout(...args),
});
