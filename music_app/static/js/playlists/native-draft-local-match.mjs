import {createNativeOwnerScope} from './native-owner-scope.mjs';
import {mountButton, mountChoice} from '../home-friends/native-controls.mjs';
import {openNativeDialog} from '../home-friends/native-dialog.mjs';

export function mountDraftLocalMatchContent(host, runtime, initial) {
  const scope = createNativeOwnerScope();
  let props = initial, disposed = false;
  function dispose() {
    if (disposed) return;
    disposed = true;
    scope.dispose();
    host.replaceChildren();
  }
  try {
    const document = host.ownerDocument;
    const identity = document.createElement('p'), status = document.createElement('div');
    const note = document.createElement('p'), choiceHost = document.createElement('div');
    const reloadHost = document.createElement('span'), acceptHost = document.createElement('span');
    const cancelHost = document.createElement('span');
    host.replaceChildren(identity, status, note, choiceHost, reloadHost, acceptHost, cancelHost);
    const choice = scope.own(mountChoice(choiceHost, runtime, {label: 'Possible local matches', options: []}));
    const reload = scope.own(mountButton(reloadHost, runtime, {label: 'Review current choices'}));
    const accept = scope.own(mountButton(acceptHost, runtime, {label: 'Accept match'}));
    const cancel = scope.own(mountButton(cancelHost, runtime, {label: 'Cancel'}));

    function update(next) {
      if (disposed) return;
      props = next;
      const {state, row, controller, close} = props;
      const blocked = ['loading', 'accepting'].includes(state.status), uncertain = state.status === 'uncertain';
      const current = () => !disposed && props === next && controller.getSnapshot() === state;
      host.setAttribute('aria-busy', String(blocked));
      identity.textContent = [row.title, row.artist, row.album_title].filter(Boolean).join(' · ');
      const message = {
        idle: 'Choose a local version, then accept the match.', loading: 'Checking possible local matches…',
        accepting: 'Checking and accepting this local match…',
        accepted: 'Matched locally. It remains in your draft until you remove it; TXT excludes it.',
        error: 'Local matches could not be checked. The original information is preserved.',
        uncertain: 'The match was not confirmed. Check the result before continuing; the same chosen match will be retried.',
        conflict: 'This source or match changed. Review the current choices.',
        denied: 'You no longer have permission to match this source track.',
        unavailable: 'Local matching is unavailable for this source track.',
      }[state.status] || (state.candidates.length ? 'Choose a local version, then accept the match.'
        : 'No suggested local match was found in the checked tracks. The original remains in the draft and TXT.');
      status.innerHTML = runtime.alertHtml({
        severity: ['error', 'uncertain', 'conflict', 'denied'].includes(state.status) ? 'error' : 'info',
        role: 'status', message,
      });
      note.textContent = state.status === 'ready' && !state.suggestionsComplete
        ? 'Suggestions cover a limited set of local tracks.' : '';
      choiceHost.hidden = !state.candidates.length;
      choice.update({
        label: 'Possible local matches', value: state.selectedKey, disabled: blocked || uncertain,
        options: [['', 'Choose local match', true], ...state.candidates.map(candidate => [candidate.key,
          [candidate.title, candidate.artist, candidate.album_title, candidate.duration_seconds === null ? ''
            : `${Math.floor(candidate.duration_seconds / 60)}:${String(Math.floor(candidate.duration_seconds % 60)).padStart(2, '0')}`]
            .filter(Boolean).join(' · ')])],
        onChange: key => {if (current()) controller.select(key);},
      });
      reloadHost.hidden = !['error', 'conflict', 'unavailable'].includes(state.status);
      reload.update({label: 'Review current choices', onClick: () => {if (current()) controller.load();}});
      acceptHost.hidden = state.status === 'accepted';
      accept.update({label: uncertain ? 'Check match result' : 'Accept match',
        disabled: blocked || !state.selectedKey || !['ready', 'uncertain'].includes(state.status),
        onClick: async () => {if (current() && await controller.accept() && !disposed) await close({force: true});}});
      cancel.update({label: state.status === 'accepted' ? 'Close' : 'Cancel', disabled: controller.blocking(),
        onClick: () => {if (current()) close();}});
    }

    update(initial);
    return {update, dispose};
  } catch (error) {
    dispose();
    throw error;
  }
}

export function mountMissingPlaylistLocalMatch(host, runtime, initial) {
  let scope = createNativeOwnerScope();
  const controller = initial.controller.localMatch, document = host.ownerDocument;
  let props = initial, disposed = false, operational = true;
  let dialog = null, content = null, opening = false, unsubscribe = null, failed = false;
  let trigger, note, button, recovery = null, releaseRecovery = null;

  // Do not remove the fallback host or report native closure here. The failed
  // dialog still owns its explicit Close, even after all operational work ends.
  function retireOperational() {
    if (!operational) return;
    operational = false;
    unsubscribe?.();
    unsubscribe = null;
    content?.dispose();
    content = null;
    scope.dispose();
    trigger?.remove();
    note?.remove();
  }

  function closeOwnedMatch() {
    if (controller.getSnapshot().rowKey === props.row.row_key) controller.close();
  }

  function clearRecovery() {
    releaseRecovery?.();
    releaseRecovery = null;
    recovery?.remove();
    recovery = null;
  }

  function showRecovery() {
    if (disposed || recovery) return;
    // This control deliberately needs no renderer that may have caused failure.
    // Reopening is explicit; parent updates alone never retry a failed mount.
    recovery = document.createElement('button');
    recovery.type = 'button';
    recovery.textContent = 'Review local match again';
    recovery.disabled = Boolean(props.disabled);
    const retry = () => {
      if (disposed || props.disabled) return;
      clearRecovery();
      failed = false;
      operational = true;
      scope = createNativeOwnerScope();
      try {
        startOperational();
        if (operational && !disposed) activate();
      } catch (error) {
        failOpen();
        showRecovery();
        throw error;
      }
    };
    recovery.addEventListener('click', retry);
    const node = recovery;
    releaseRecovery = () => node.removeEventListener('click', retry);
    host.append(recovery);
  }

  function failOpen() {
    failed = true;
    retireOperational();
    // A read can safely be abandoned. A write (including ambiguity) belongs to
    // the model lifetime, not the failed UI, and must keep its chosen candidate.
    const state = controller.getSnapshot();
    if (state.rowKey === props.row.row_key && state.status === 'loading') controller.close();
  }

  function activate() {
    if (disposed || !operational || props.disabled) return;
    const state = controller.getSnapshot();
    if (state.rowKey === props.row.row_key && state.status !== 'closed') {
      paint();
      return;
    }
    // open publishes synchronously; a failed factory must prevent trailing load.
    const opened = controller.open(props.row.row_key);
    if (opened && operational && !disposed && !failed) controller.load();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    clearRecovery();
    retireOperational();
    dialog?.dispose();
    dialog = null;
    closeOwnedMatch();
    host.replaceChildren();
  }

  function paint() {
    if (disposed || !operational) return;
    const {row, disabled} = props, state = controller.getSnapshot(), available = controller.available();
    button.update({label: available ? 'Review local match' : 'Local matching unavailable',
      disabled: disabled || !available,
      onClick: () => {
        if (disposed || !operational || props.row !== row || props.disabled) return;
        activate();
      },
    });
    note.textContent = !available
      ? 'Local matching is unavailable for this source track. Its original information is preserved.'
      : row.match_state === 'accepted'
        ? 'Matched locally. Original information is preserved; TXT excludes this track.' : '';
    const opened = state.rowKey === row.row_key && state.status !== 'closed';
    if (opened && !dialog && !opening) {
      opening = true;
      try {
        const acquired = openNativeDialog(runtime, {
          title: 'Review local match', pageId: 'playlist-local-match',
          beforeDismiss: () => !controller.blocking(),
          returnFocus: () => operational ? trigger.querySelector('button:not(:disabled)') : null,
        }, {
          fallbackHost: host,
          onError: failOpen,
          mount(node, close) {
            try {
              content = mountDraftLocalMatchContent(node, runtime, {
                controller, state: controller.getSnapshot(), row: props.row, close,
              });
              return content;
            } catch (error) {
              failOpen();
              throw error;
            }
          },
          onClose() {
            dialog = null;
            content = null;
            if (failed) {
              if (!controller.blocking()) closeOwnedMatch();
              showRecovery();
            } else closeOwnedMatch();
          },
        });
        if (disposed) acquired.dispose();
        else if (!acquired.closed) dialog = acquired;
      } catch (error) {
        failOpen();
        throw error;
      } finally {
        opening = false;
      }
    } else if (!opened && dialog) {
      const previous = dialog;
      dialog = null;
      content = null;
      previous.dispose();
    } else if (content) {
      content.update({controller, state, row, close: options => dialog?.close(options)});
    }
  }

  function startOperational() {
    trigger = document.createElement('span');
    note = document.createElement('p');
    host.className = 'playlists__match-review';
    host.setAttribute('aria-label', 'Local match availability');
    host.replaceChildren(trigger, note);
    button = scope.own(mountButton(trigger, runtime, {label: 'Review local match'}));
    const acquiredUnsubscribe = controller.subscribe(paint);
    if (disposed || !operational) acquiredUnsubscribe();
    else unsubscribe = acquiredUnsubscribe;
    paint();
  }

  try {
    startOperational();
    return {
      update(next) {
        if (disposed) return;
        const previousKey = props.row.row_key;
        props = next;
        if (previousKey !== next.row.row_key && controller.getSnapshot().rowKey === previousKey
          || next.disabled && !controller.blocking()
            && controller.getSnapshot().rowKey === next.row.row_key) controller.close();
        if (recovery) recovery.disabled = Boolean(next.disabled);
        if (operational) paint();
      },
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
