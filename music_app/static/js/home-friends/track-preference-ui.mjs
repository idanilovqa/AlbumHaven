import {createTrackPreferenceController} from './track-preference.mjs';

export function createTrackPreferences(initial, onChange) {
  let props = initial, disposed = false, unsubscribe, subscribedRuntime, revision = 0, subscriptionRevision = 0;
  const editor = createTrackPreferenceController({getView: () => disposed ? null : props,
    onChange: () => {if (!disposed) onChange?.();}, onError: message => {if (!disposed) props.onError?.(message);}});
  function dispose() {
    if (disposed) return; disposed = true; revision++; subscriptionRevision++;
    const release = unsubscribe; unsubscribe = null; let failure;
    try {release?.();} catch (error) {failure = error;}
    try {editor.cancel();} catch (error) {failure ??= error;}
    if (failure) throw failure;
  }
  function update(next) {
    if (disposed) return;
    const token = ++revision, current = () => !disposed && revision === token;
    props = next;
    try {
      if (subscribedRuntime !== props.runtime) {
        const subscription = ++subscriptionRevision, release = unsubscribe; unsubscribe = null; release?.(); if (!current()) return;
        editor.cancel(); if (!current()) return; subscribedRuntime = props.runtime;
        let subscribing = true, notified = false;
        const notify = () => {if (disposed || subscription !== subscriptionRevision) return; editor.sync(); if (!disposed && subscription === subscriptionRevision) onChange?.();};
        const nextUnsubscribe = props.runtime.subscribeTrackPreferences?.(() => {if (subscribing) notified = true; else notify();});
        subscribing = false;
        if (!current()) {nextUnsubscribe?.(); return;} unsubscribe = nextUnsubscribe;
        if (notified) {notify(); if (!current()) return;}
      }
      editor.sync();
    } catch (error) {try {dispose();} catch {} throw error;}
  }
  update(initial);
  return {get: editor.get, cycle: row => {if (!disposed) return editor.cycle(row);}, update, dispose};
}
