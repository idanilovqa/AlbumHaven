import {mountButton} from './native-controls.mjs';

export function mountActivityMissingAction(host, runtime, initial) {
  let props, source, key, request, eligibilityRead, click, generation = 0, disposed = false, button;
  const clear = () => {button?.dispose(); button = null; host.replaceChildren();};
  const current = owner => !disposed && owner === generation;
  function render(eligibility, owner) {
    if (!current(owner)) return; clear();
    if (eligibility.tooLarge) {const message = host.ownerDocument.createElement('span'); message.className = 'home-friends__muted'; message.setAttribute('role', 'status'); message.textContent = 'Select up to 5,000 activity rows to inspect missing tracks.'; host.append(message); return;}
    if (eligibility.data?.can_inspect_missing !== true || typeof runtime.inspectActivityMissing !== 'function') return;
    button = mountButton(host, runtime, options(owner));
  }
  function options(owner) {return {label: 'Inspect missing tracks', icon: 'missing-playlist', disabled: Boolean(click),
    title: request.row_refs === null ? 'Inspect missing tracks from the full activity period' : 'Inspect missing tracks from the selected activity rows',
    attributes: {'data-home-inspect-missing': 'true'}, onClick: () => inspect(owner)};}
  async function inspect(owner) {
    if (!current(owner) || click || !request) return;
    const abort = new AbortController(); click = abort; button?.update(options(owner));
    try {
      const opened = await runtime.inspectActivityMissing({...request, signal: abort.signal, isCurrent: () => current(owner)});
      if (opened !== true && current(owner) && !abort.signal.aborted) props.onError?.('This activity source changed. Refresh it before inspecting missing tracks.');
    } catch (error) {if (current(owner) && !abort.signal.aborted && error?.name !== 'AbortError') props.onError?.(error?.status === 413
      ? 'This activity source exceeds the 5,000-row limit. Select fewer rows to inspect.' : 'Missing tracks could not be inspected. Refresh the activity and try again.');}
    finally {if (click === abort) {click = null; if (current(owner)) button?.update(options(owner));}}
  }
  function update(next) {
    if (disposed) return; props = next;
    const {value, scopeKey, account_ref = null, kind, period, selectedRowIds, enabled = true} = props;
    const nextKey = JSON.stringify([scopeKey, account_ref, kind, period, enabled, Array.isArray(selectedRowIds) && selectedRowIds.length ? selectedRowIds : null]);
    if (source === value && key === nextKey) return;
    source = value; key = nextKey; const owner = ++generation;
    eligibilityRead?.abort(); click?.abort(); click = null; clear();
    request = enabled && value?.status === 'ready' && ['tracks', 'listens'].includes(kind) && typeof value.data?.snapshot_ref === 'string'
      ? {scopeKey, origin: {audience: account_ref === null ? 'own' : 'friend', subject_ref: account_ref, kind, period, snapshot_ref: value.data.snapshot_ref}, row_refs: Array.isArray(selectedRowIds) && selectedRowIds.length ? [...selectedRowIds] : null} : null;
    if (!request || typeof runtime.readActivityMissingEligibility !== 'function') return;
    const abort = new AbortController(); eligibilityRead = abort;
    Promise.resolve().then(() => current(owner) && !abort.signal.aborted ? runtime.readActivityMissingEligibility({...request, signal: abort.signal, isCurrent: () => current(owner)}) : null)
      .then(data => {if (!abort.signal.aborted) render({data}, owner);}, error => {if (!abort.signal.aborted) render({tooLarge: error?.status === 413}, owner);});
  }
  update(initial); return {element: host, update, dispose() {if (!disposed) {disposed = true; generation++; eligibilityRead?.abort(); click?.abort(); clear();}}};
}
