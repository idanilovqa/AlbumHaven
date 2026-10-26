import {isCompletedTarget} from './listening-settings-provider.mjs';
const freeze = Object.freeze;
const invalidPreference = freeze({status: 'unavailable'});
const unavailableState = freeze({status: 'unavailable', data: null, draft: '', message: ''});
export function createListeningSettingsController({provider, isCurrent}) {
  let disposed = false, sequence = 0, active = null, pendingWrite = null, lastReadSequence = null;
  const listeners = new Set();
  let state = freeze({status: 'idle', data: null, draft: '', message: ''});
  const alive = () => {try {return !disposed && isCurrent() === true;} catch {return false;}};
  const emit = patch => {if (!alive()) return; state = freeze({...state, ...patch}); for (const listener of [...listeners]) listener();};
  const owns = token => alive() && token === sequence;
  const begin = () => {const token = ++sequence; active?.abort(); active = new AbortController(); return {token, signal: active.signal};};
  const denied = error => [401, 403].includes(error?.status) || error?.code === 'stale_context';
  const draftValue = () => /^[1-9][0-9]{0,15}$/.test(state.draft) && isCompletedTarget(Number(state.draft)) ? Number(state.draft) : null;
  async function read() {
    if (!alive() || active || state.status === 'denied') return false;
    lastReadSequence = null;
    const {token, signal} = begin(), reconciling = Boolean(pendingWrite);
    emit({status: reconciling ? 'reconciling' : 'loading', message: reconciling ? 'Checking the saved target…' : 'Loading listening target…'});
    try {
      const data = await provider.read({signal}); if (!owns(token)) return false;
      active = null; lastReadSequence = token;
      const pending = pendingWrite;
      // A same-revision GET after a lost PUT cannot prove that the PUT will not
      // commit later. Only a newer revision fences that pending conditional write.
      if (pending?.uncertain && BigInt(data.settings_revision) <= BigInt(pending.revision)) {
        emit({status: 'uncertain', data, message: 'Save outcome is still unconfirmed. Check again or deliberately retry the same target before making another change.'});
        return false;
      }
      pendingWrite = null;
      emit({status: 'ready', data, draft: String(data.completed_target),
        message: pending ? 'Current saved target refreshed. Review it before making another change.' : ''});
      return true;
    } catch (error) {
      if (owns(token)) {active = null; emit({...(denied(error) ? {data: null, draft: ''} : {}), status: denied(error) ? 'denied' : pendingWrite ? 'uncertain' : 'error',
        message: denied(error) ? 'Listening settings are unavailable for this session. Reload or sign in again.'
          : pendingWrite ? 'Save outcome is unconfirmed. Check the saved target before changing it again.' : 'Listening target could not be loaded. Try again.'});}
      return false;
    } finally {if (token === sequence) active = null;}
  }
  async function write(command) {
      // retrySave admits only the same desired target at the same original CAS
      // revision. A rejection of this attempt cannot settle an older unknown
      // attempt in that logical operation; only a receipt/newer revision can.
      const inheritedUncertainty = pendingWrite?.uncertain === true;
      const {token, signal} = begin(); pendingWrite = {revision: command.settings_revision, target: command.completed_target, uncertain: true};
      emit({status: 'saving', message: 'Saving listening target…'});
      let reconcile = false;
      try {
        const data = await provider.save(command, {signal}); if (!owns(token)) return false;
        active = null; pendingWrite = null; emit({status: 'ready', data, draft: String(data.completed_target), message: 'Listening target saved.'}); return true;
      } catch (error) {
        if (!owns(token)) return false;
        if (denied(error)) {emit({data: null, draft: '', status: 'denied', message: 'Listening settings are unavailable for this session. Reload or sign in again.'}); return false;}
        const rejected = ['settings_revision_conflict', 'concurrent_change', 'revision_exhausted', 'invalid_command', 'body_too_large'].includes(error?.code);
        pendingWrite = {...pendingWrite, uncertain: inheritedUncertainty || !rejected};
        emit({status: 'uncertain', message: rejected ? 'The setting changed or was rejected. Refreshing the saved target…' : 'Save outcome is unconfirmed. Checking the saved target…'});
        reconcile = true; return false;
      } finally {
        if (token === sequence) active = null;
        if (reconcile && owns(token)) await read();
      }
  }
  const controller = {
    getSnapshot: () => alive() ? state : unavailableState,
    subscribe(listener) {listeners.add(listener); return () => listeners.delete(listener);},
    load: read,
    setDraft(value) {if (!alive() || state.status !== 'ready' || active || pendingWrite || typeof value !== 'string') return;
      emit({draft: value.slice(0, 16), message: ''});},
    resetDraft() {if (alive() && state.status === 'ready' && !active && !pendingWrite && state.data) emit({draft: String(state.data.completed_target), message: ''});},
    canSave: () => alive() && state.status === 'ready' && !active && !pendingWrite && state.data !== null
      && draftValue() !== null && draftValue() !== state.data.completed_target,
    presentation() {
      if (!alive() || state.status !== 'ready' || pendingWrite || !state.data || draftValue() !== state.data.completed_target) return invalidPreference;
      return freeze({status: state.data.preference_status, value: state.data.completed_target,
        revision: state.data.settings_revision});
    },
    save() {
      if (!controller.canSave()) return Promise.resolve(false);
      return write({completed_target: draftValue(), settings_revision: state.data.settings_revision});
    },
    canRetry: () => alive() && state.status === 'uncertain' && !active && Boolean(pendingWrite),
    async retrySave() {
      if (!controller.canRetry()) return false;
      const pending = pendingWrite;
      await read();
      if (!alive() || active || pendingWrite !== pending || state.status !== 'uncertain'
        || lastReadSequence !== sequence || state.data?.settings_revision !== pending.revision
        || state.data.completed_target === pending.target) return false;
      // Deliberate retry only, after a fresh unchanged receipt. Never PUT the
      // observed old target: a same-value no-op would not fence the lost write.
      return write({completed_target: pending.target, settings_revision: state.data.settings_revision});
    },
    suspend() {
      if (disposed) return;
      sequence++; active?.abort(); active = null; lastReadSequence = null;
      // A hidden/aborted PUT can still commit. Keep its original CAS and desired
      // value; reentry may GET, but never automatically repeat that write.
      state = freeze({...state, status: pendingWrite ? 'uncertain' : 'idle',
        message: pendingWrite ? 'Save outcome is unconfirmed. Check the saved target before changing it again.' : ''});
    },
    dispose() {if (disposed) return; disposed = true; sequence++; active?.abort(); active = null; pendingWrite = null;
      state = unavailableState; listeners.clear(); provider.dispose();},
  };
  return freeze(controller);
}
