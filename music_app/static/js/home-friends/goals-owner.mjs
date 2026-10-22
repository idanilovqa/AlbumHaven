import {createGoalsProvider} from './goals-provider.mjs';
import {createGoalsController} from './goals-model.mjs';

// One account lifetime, shared by off-tab attention and the visible panel.
// Views borrow this pair; only the containing session retires it.
export function createGoalsOwner({transport, sourceTransport = null, isCurrent = () => true, document = null,
  now = () => Date.now(), setTimer = (run, delay) => setTimeout(run, delay), clearTimer = value => clearTimeout(value)}) {
  let disposed = false, provider, controller, unsubscribe, lastData = null, queued = false, sourceContext = null;
  let timer = null, reading = null, lastAttempt = -Infinity, refreshAfterRead = false;
  const visible = () => !document || document.visibilityState !== 'hidden' &&
    (typeof document.hasFocus !== 'function' || document.hasFocus());
  const current = () => {if (disposed) return false; try {return isCurrent() === true && !disposed;} catch {return false;}};
  function arm() {
    if (timer !== null) clearTimer(timer); timer = null;
    if (!current() || !document || !visible()) return;
    timer = setTimer(() => {timer = null; void refreshAttention(); arm();}, 300000);
  }
  function refreshAttention({changedData = false, immediate = false} = {}) {
    if (!current() || !visible()) return Promise.resolve();
    if (reading) {if (changedData) refreshAfterRead = true; return reading;}
    const state = controller.getSnapshot();
    if (state.mutation !== 'idle' || state.error || ['loading','denied'].includes(state.status)
      || state.attentionStatus === 'loading' || !changedData && !immediate && now() - lastAttempt < 1000) return Promise.resolve();
    lastAttempt = now();
    const work = controller.loadAttention();
    reading = Promise.resolve(work).finally(() => {
      reading = null;
      if (refreshAfterRead) {refreshAfterRead = false; void refreshAttention({changedData:true});}
    });
    return reading;
  }
  const resume = () => {if (visible()) void refreshAttention(); arm();};
  const blur = () => {if (timer !== null) clearTimer(timer); timer = null;};
  try {sourceContext = sourceTransport?.context() || null;} catch {}
  const sourceCurrent = () => {
    if (!current() || !sourceContext) return false;
    try {return sourceTransport.context() === sourceContext && current();} catch {return false;}
  };
  const dispose = () => {
    if (disposed) return; disposed = true;
    if (timer !== null) clearTimer(timer); timer = null;
    document?.removeEventListener('visibilitychange', resume);
    document?.defaultView?.removeEventListener('focus', resume);
    document?.defaultView?.removeEventListener('blur', blur);
    try {unsubscribe?.();} finally {try {controller?.dispose();} finally {provider?.dispose();}}
  };
  try {
    provider = createGoalsProvider(transport);
    controller = createGoalsController({provider, canDrawBonus: sourceCurrent});
    unsubscribe = controller.subscribe(() => {
      if (queued || disposed) return; queued = true;
      queueMicrotask(() => {
        queued = false; if (!current()) return;
        const state = controller.getSnapshot();
        if (state.status !== 'ready' || state.mutation !== 'idle' || state.error || state.data === lastData) return;
        lastData = state.data;
        if (state.attentionStatus !== 'ready' || state.attention?.revision !== state.data.revision) void refreshAttention({changedData:true});
      });
    });
    document?.addEventListener('visibilitychange', resume);
    document?.defaultView?.addEventListener('focus', resume);
    document?.defaultView?.addEventListener('blur', blur);
    arm();
    return {provider, controller, sourceCurrent, refreshAttention, visitState: {pendingToken: null}, dispose};
  } catch (error) {dispose(); throw error;}
}
