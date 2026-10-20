import {albumTopActionAllowed} from './model.mjs';
import {createSourceImportTasks} from './source-import-tasks.mjs';
import {mountSourceImportView} from './source-import-view.mjs';
import {openNativeDialog} from '../home-friends/native-dialog.mjs';

// One bounded task owner belongs to the native index, not its selected view.
export function createSourceImportIndex({runtime, controller, providers, onChange}) {
  let disposed = false, registry = null, tasks = null, unsubscribeTasks = () => {};
  let dialog = null, handoff = null, generation = 0, syncing = false, queued = false, starting = false;
  const shellCurrent = (owner, shell = runtime.snapshot()) => !disposed && tasks === owner.tasks
    && shell.authenticated && shell.scopeKey === owner.scopeKey && runtime.acceptsPrivateScope(owner.scopeKey);
  const navigationCurrent = (owner, shell = runtime.snapshot()) => shellCurrent(owner, shell)
    && shell.inLibrary && shell.active && shell.topRef === null && shell.viewVersion === owner.viewVersion
    && shell.viewRequestId === owner.viewRequestId;
  const dialogCurrent = owner => dialog === owner && navigationCurrent(owner)
    && owner.controller.getSnapshot().status !== 'retired' && controller.getSnapshot().scopeKey === owner.scopeKey
    && controller.getSnapshot().directory.status !== 'denied';
  function release(owner) {
    if (owner.released) return;
    owner.released = true; owner.lease.release();
  }
  function retireDialog(owner = dialog) {
    if (!owner || dialog !== owner) return;
    dialog = null; owner.native?.dispose();
    if (handoff?.owner !== owner) release(owner);
  }
  function retireTasks() {
    generation++; const old = tasks; tasks = null;
    retireDialog();
    const oldHandoff = handoff; handoff = null;
    if (oldHandoff) release(oldHandoff.owner);
    unsubscribeTasks(); unsubscribeTasks = () => {}; old?.dispose();
  }
  function sync() {
    if (disposed) return;
    queued = true; if (syncing) return; syncing = true;
    try {
      while (queued && !disposed) {
        queued = false;
        const next = runtime.notificationRegistry?.() || null;
        if (next !== registry) {
          registry = next; retireTasks();
          if (disposed || registry !== next || (runtime.notificationRegistry?.() || null) !== next) {queued = true; continue;}
          if (next?.registerSource) {
            tasks = createSourceImportTasks({runtime, notifications: next, providers,
              onDenied: (scope, error) => controller.observeDenial(scope, error), onOpen: openNotification});
            unsubscribeTasks = tasks.subscribe(sync);
          }
        }
        if (dialog && !dialogCurrent(dialog)) retireDialog();
        if (handoff && (!shellCurrent(handoff.owner) || handoff.owner.controller.getSnapshot().status === 'retired')) {
          const old = handoff; handoff = null; release(old.owner);
        }
        onChange();
      }
    } finally {syncing = false;}
  }
  function show(importController, returnFocus, expected) {
    const shell = runtime.snapshot(), taskOwner = tasks;
    if (disposed || !taskOwner || expected && !expected() || !shell.visible || shell.topRef !== null
        || !albumTopActionAllowed(controller.getSnapshot(), 'create') || importController.getSnapshot().status === 'retired') return false;
    if (dialog) return dialog.controller === importController;
    const lease = taskOwner.retain(importController);
    if (!lease) return false;
    const owner = {tasks: taskOwner, controller: importController, scopeKey: shell.scopeKey,
      viewVersion: shell.viewVersion, viewRequestId: shell.viewRequestId, native: null, view: null, released: false, returnFocus, lease};
    dialog = owner;
    taskOwner.release(importController);
    if (!dialogCurrent(owner)) {retireDialog(owner); return false;}
    const opened = openNativeDialog(runtime, {title: 'Import Album Top', pageId: 'album-top-import', showCloseButton: true,
      returnFocus, beforeDismiss: () => owner.view?.beforeDismiss() ?? false}, {
      mount(host, close) {
        const view = mountSourceImportView(host, runtime, {controller: importController, topController: controller, providers,
          isCurrent: () => dialogCurrent(owner), onClose: () => close(), onOpenTop: (ref, current) => openReceipt(owner, ref, current)});
        owner.view = view; return view;
      },
      onClose() {
        if (dialog === owner) dialog = null;
        if (handoff?.owner !== owner) release(owner);
        onChange();
      },
    });
    owner.native = opened;
    if (opened.failed || opened.closed || !dialogCurrent(owner)) {
      if (dialog === owner) retireDialog(owner); else {opened.dispose(); release(owner);}
      return false;
    }
    onChange(); return true;
  }
  async function openNotification(row, current) {
    const taskOwner = tasks, sequence = ++generation;
    const active = () => !disposed && tasks === taskOwner && generation === sequence && current();
    if (!taskOwner || !active()) return false;
    let opened;
    try {opened = await runtime.navigate({top_ref: row.top_ref || null, isCurrent: active});} catch {return false;}
    if (opened === false || !active()) return false;
    if (row.top_ref) return true;
    const shell = runtime.snapshot(), owner = {tasks: taskOwner, scopeKey: shell.scopeKey,
      viewVersion: shell.viewVersion, viewRequestId: shell.viewRequestId};
    const atDestination = () => active() && navigationCurrent(owner);
    const imported = row.controller || await taskOwner.resume(row.job_ref);
    if (!imported) return false;
    if (!atDestination()) {taskOwner.release(imported); return false;}
    if (controller.getSnapshot().directory.status !== 'ready') await controller.load();
    if (!atDestination()) {taskOwner.release(imported); return false;}
    const state = imported.getSnapshot();
    if (state.status === 'retired' || !show(imported, undefined, atDestination)) {taskOwner.release(imported); return false;}
    // A retained unacknowledged submit is intentionally openable. A failed
    // server read is a retry surface, not a successfully opened job receipt.
    return row.controller ? true : Boolean(state.job && state.job.job_ref === row.job_ref);
  }
  async function openReceipt(owner, topRef, viewCurrent) {
    if (handoff || !dialogCurrent(owner) || !viewCurrent()) return false;
    const state = owner.controller.getSnapshot(), receipt = state.result || state.job;
    if (!receipt || receipt.top_ref !== topRef) return false;
    const operation = {owner, state, sequence: ++generation, started: false, requestId: owner.viewRequestId}; handoff = operation;
    const current = () => handoff === operation && generation === operation.sequence && shellCurrent(owner)
      && owner.controller.getSnapshot() === state && runtime.snapshot().viewVersion === owner.viewVersion
      && (!operation.started || runtime.snapshot().viewRequestId === operation.requestId);
    let result = false, settled = false, failedHere = false;
    try {
      result = await runtime.navigate({top_ref: topRef, isCurrent: current, expectedViewRequestId: owner.viewRequestId,
        onStart() {operation.started = true; operation.requestId = runtime.snapshot().viewRequestId;},
        onSettled(value) {settled = true; failedHere = !value.opened && current();}});
    } catch {failedHere = current();}
    finally {
      if (handoff === operation) {
        const retryHere = result === false && failedHere && shellCurrent(owner)
          && runtime.snapshot().viewVersion === owner.viewVersion && runtime.snapshot().topRef === null;
        handoff = null;
        if (!dialog && retryHere) {
          show(owner.controller, owner.returnFocus); release(owner);
        } else if (dialog !== owner) release(owner);
        onChange();
      }
    }
    return result !== false && settled;
  }
  const unsubscribeRegistry = runtime.subscribeNotificationRegistry?.(sync);
  const unsubscribeShell = runtime.subscribe(sync), unsubscribeController = controller.subscribe(sync);
  sync();
  return Object.freeze({
    canStart() {return !disposed && !starting && !dialog && !handoff && tasks?.getSnapshot().canCreate === true;},
    start(returnFocus) {
      if (disposed || starting || dialog || handoff || !runtime.snapshot().visible || runtime.snapshot().topRef !== null
          || !albumTopActionAllowed(controller.getSnapshot(), 'create') || !tasks?.getSnapshot().canCreate
          || controller.getSnapshot().mutation.refreshing === true || ['loading', 'uncertain'].includes(controller.getSnapshot().mutation.status)) return false;
      starting = true; generation++;
      try {
        const owner = tasks, imported = owner.create();
        if (!imported) return false;
        if (tasks !== owner || !show(imported, returnFocus)) {owner.release(imported); return false;}
        return true;
      } finally {starting = false; if (!disposed) onChange();}
    },
    dispose() {if (disposed) return; disposed = true; unsubscribeRegistry?.(); unsubscribeShell(); unsubscribeController(); retireTasks(); registry = null;},
  });
}
