import {mountButton} from '../home-friends/native-controls.mjs';
let serial = 0;
export function mountListeningSettingsControl(host, runtime, controller) {
  let disposed = false;
  const make = (tag, parent = host) => {const node = host.ownerDocument.createElement(tag); parent.append(node); return node;};
  const section = make('section'); section.setAttribute('aria-label', 'Your listening target');
  const label = make('label', section), input = make('input', section), help = make('p', section), status = make('p', section);
  const id = `album-top-listening-target-${++serial}`;
  label.htmlFor = id; label.textContent = 'Completed target';
  input.id = id; input.type = 'text'; input.inputMode = 'numeric'; input.maxLength = 16;
  input.setAttribute('autocomplete', 'off'); input.setAttribute('aria-describedby', `${id}-help ${id}-status`);
  help.id = `${id}-help`; help.textContent = 'Your account target defaults to 5 qualifying full listens, including qualifying overlapping sessions. Manual completion is separate. Changing this target does not create listening evidence.';
  status.id = `${id}-status`; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const saveHost = make('span', section), resetHost = make('span', section), reloadHost = make('span', section), retryHost = make('span', section);
  let save = null, reset = null, reload = null, retry = null, unsubscribe = null;
  const change = () => controller.setDraft(input.value);
  function dispose() {if (disposed) return; disposed = true; unsubscribe?.(); input.removeEventListener('input', change);
    save?.dispose(); reset?.dispose(); reload?.dispose(); retry?.dispose(); section.remove();}
  function update() {
    if (disposed) return;
    const state = controller.getSnapshot(), ready = state.status === 'ready', busy = ['loading', 'saving', 'reconciling'].includes(state.status);
    if (input.value !== state.draft) input.value = state.draft;
    input.disabled = !ready;
    const invalid = ready && !/^[1-9][0-9]{0,15}$/.test(state.draft)
      || ready && (!Number.isSafeInteger(Number(state.draft)) || Number(state.draft) < 1);
    input.setAttribute('aria-invalid', String(Boolean(invalid)));
    status.textContent = invalid ? 'Enter a whole number from 1 to 9007199254740991.' : state.message
      || (ready ? state.data.preference_status === 'default' ? 'Default target: 5. No personal target has been saved.' : `Saved target: ${state.data.completed_target}.` : 'Listening target unavailable.');
    section.setAttribute('aria-busy', String(busy));
    retryHost.hidden = !['uncertain', 'reconciling'].includes(state.status);
    retry.update({label: 'Retry same target', disabled: !controller.canRetry(), onClick: () => void controller.retrySave()});
    save.update({label: 'Save target', disabled: !controller.canSave(), onClick: () => void controller.save()});
    reset.update({label: 'Discard target edit', disabled: !ready || state.draft === String(state.data?.completed_target), onClick: () => controller.resetDraft()});
    reload.update({label: state.status === 'error' ? 'Retry loading target' : 'Check saved target', disabled: busy || ['denied', 'unavailable'].includes(state.status), onClick: () => void controller.load()});
  }
  try {
    save = mountButton(saveHost, runtime, {label: 'Save target', onClick: () => void controller.save()});
    reset = mountButton(resetHost, runtime, {label: 'Discard target edit', onClick: () => controller.resetDraft()});
    reload = mountButton(reloadHost, runtime, {label: 'Check saved target', onClick: () => void controller.load()});
    retry = mountButton(retryHost, runtime, {label: 'Retry same target', onClick: () => void controller.retrySave()});
    input.addEventListener('input', change); unsubscribe = controller.subscribe(update); update();
  } catch (error) {dispose(); throw error;}
  return {update, dispose};
}
