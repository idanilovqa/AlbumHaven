import {createNativeOwnerScope} from './native-owner-scope.mjs';
import {mountButton, mountChoice} from '../home-friends/native-controls.mjs';
import {openNativeDialog} from '../home-friends/native-dialog.mjs';
import {mountCreationForm} from './native-creation-form.mjs';
import {mountRetryOriginalRequest} from './native-mutation-status.mjs';
import {playlistCreationCompletionState} from './creation-session.mjs';
import {createPlaylistActionController, completeSelectionPlaylistCreation} from './selection-actions.mjs';

export function mountPlaylistActionSession(host, initial) {
  const scope = createNativeOwnerScope();
  let props = initial;
  const {runtime, packet, lifetime, sourceAdapter, providers, initialMode} = props;
  const controller = createPlaylistActionController({packet, lifetime, sourceAdapter, providers});
  let alive = true, completed = null, completing = false, retiredClose = false;
  let nativeClosed = null, reportedClose = false, closeOwner = null, dialog = null;
  let content = null, creation = null, creationUnsubscribe = null, mode = null;
  let owners = [], unsubscribe = null;
  let destinationForm, count, status, capabilities, choiceHost, retryHost, buttonsHost, choice, retry, buttons;

  function reportClose(options) {
    if (reportedClose) return;
    reportedClose = true;
    props.onClose?.(options);
  }

  function writePending() {
    const state = controller.getSnapshot();
    return completing || state.writeStarted && (state.busy
      || controller.getCreationController()?.getSnapshot().mutation.status === 'loading');
  }

  async function beforeDismiss() {
    const creationController = controller.getCreationController();
    const snapshot = creationController?.getSnapshot();
    if (writePending()) return false;
    const accept = () => {
      if (writePending()) return false;
      controller.dispose();
      return true;
    };
    if (completed || !snapshot?.dirty) return accept();
    if (typeof runtime.confirm !== 'function') return false;
    const accepted = await runtime.confirm('Discard this unsaved playlist?');
    return accepted === true && alive && controller.isCurrent()
      && creationController.getSnapshot() === snapshot && accept();
  }

  async function created(ack) {
    const saved = controller.getCreationController()?.getSnapshot();
    if (!alive || !saved || !controller.acknowledgeCreation(ack)) return false;
    completed = playlistCreationCompletionState(saved, ack);
    paint();
    completing = true;
    try {
      const finished = await completeSelectionPlaylistCreation({
        controller, ack, close: options => closeOwner?.(options),
        navigate: props.onNavigate, notify: props.onNotice,
      });
      if (finished && alive) reportClose({restoreFocus: false, current: true});
      return finished;
    } finally {
      completing = false;
      if (nativeClosed) {
        reportClose(nativeClosed);
        controller.dispose();
      }
    }
  }

  function creationProps() {
    return {
      controller: controller.getCreationController(),
      state: completed || controller.getCreationController().getSnapshot(),
      readDetail: props.readDetail, onCreated: created, onDismiss: closeOwner,
      canDismissWhileLoading: !controller.getSnapshot().writeStarted,
    };
  }

  function clear() {
    creationUnsubscribe?.();
    creationUnsubscribe = null;
    creation?.dispose();
    creation = null;
    for (const owner of owners) owner.dispose();
    owners = [];
    content?.replaceChildren();
  }

  function message(state) {
    const mutation = state.mutation;
    if (state.creationRecovery?.status === 'ready') {
      return 'Your previous playlist was created. Check Playlists before starting another.';
    }
    if (state.creationRecovery?.status === 'unknown') {
      return 'A previous playlist creation is still unconfirmed. Check its result before starting another.';
    }
    if (mutation.acknowledged) {
      return mutation.refresh === 'loading' ? 'Tracks added. Refreshing playlists…'
        : mutation.refresh === 'ready' ? 'Tracks added.'
          : 'Tracks added, but the playlist list could not be refreshed.';
    }
    if (mutation.status !== 'idle') {
      return {
        loading: 'Checking the destination and adding tracks…',
        denied: 'You do not have permission to add these tracks to that playlist.',
        unavailable: 'This selected-track action is not available from this provider.',
        conflict: 'This destination changed. Choose it again before adding tracks.',
        error: state.writeStarted
          ? 'Adding tracks was not confirmed. Check the playlist before starting another attempt.'
          : 'The destination could not be checked. Reload playlists and try again.',
      }[mutation.status];
    }
    return {
      loading: 'Loading playlists…', empty: 'No writable playlists are available.',
      denied: 'You do not have permission to use these tracks or playlists.',
      unavailable: 'Playlist destinations are not available from this provider.',
      error: 'Playlist destinations could not be loaded.',
      retired: 'The source changed. Close this form and choose the tracks again.',
    }[state.status];
  }

  function buildDestination() {
    const document = content.ownerDocument;
    destinationForm = document.createElement(initialMode === 'create' ? 'div' : 'form');
    destinationForm.className = 'playlists__form';
    if (initialMode !== 'create') {
      destinationForm.setAttribute('aria-label', 'Add selected tracks to playlist');
      const form = destinationForm;
      const submit = event => {
        event.preventDefault();
        if (alive && mode === 'destination' && destinationForm === form) controller.add();
      };
      form.addEventListener('submit', submit);
      const listener = scope.own({dispose: () => form.removeEventListener('submit', submit)});
      owners.push(listener);
    }
    content.append(destinationForm);
    const add = tag => {
      const node = document.createElement(tag);
      destinationForm.append(node);
      return node;
    };
    count = add('p');
    count.className = 'playlists__note';
    count.setAttribute('role', 'status');
    status = add('div');
    capabilities = add('div');
    choiceHost = add('div');
    retryHost = add('div');
    buttonsHost = add('div');
    buttonsHost.className = 'playlists__actions';
    choice = scope.own(mountChoice(choiceHost, runtime, {label: 'Playlist', options: []}));
    owners.push(choice);
    retry = scope.own(mountRetryOriginalRequest(retryHost, runtime, {
      scopeKey: packet.scopeKey, available: false,
    }));
    owners.push(retry);
    buttons = {};
    for (const key of ['add', 'create', 'reload', 'cancel']) {
      const slot = document.createElement('span');
      buttonsHost.append(slot);
      buttons[key] = scope.own(mountButton(slot, runtime, {label: key}));
      owners.push(buttons[key]);
    }
  }

  function paint() {
    if (!alive || !content) return;
    const state = controller.getSnapshot();
    if (state.status === 'retired' && !retiredClose) {
      retiredClose = true;
      completed = null;
      closeOwner?.({force: true, restoreFocus: false, returnToParent: false});
      return;
    }
    const nextMode = state.mode === 'create' ? 'create' : 'destination';
    if (mode !== nextMode) {
      clear();
      mode = nextMode;
      if (mode === 'create') {
        creation = scope.own(mountCreationForm(content, runtime, creationProps()));
        creationUnsubscribe = controller.getCreationController().subscribe(() => {
          if (alive) creation?.update(creationProps());
        });
      } else {
        buildDestination();
      }
    }
    dialog?.update(dialogOptions());
    if (mode === 'create') {
      creation.update(creationProps());
      return;
    }

    const finished = state.writeStarted, onlyCreate = initialMode === 'create';
    destinationForm.setAttribute('aria-busy', String(state.busy));
    const text = message(state);
    const error = state.status === 'error' || ['error', 'conflict', 'denied'].includes(state.mutation.status);
    status.innerHTML = text ? runtime.alertHtml({severity: error ? 'error' : 'info',
      role: error ? 'alert' : 'status', message: text}) : '';
    count.hidden = onlyCreate || !state.counts;
    count.textContent = state.counts
      ? `${state.counts.selectedRowCount} selected rows · ${state.counts.uniqueTrackCount} unique tracks`
        + (state.counts.unresolvedSourceCount > 0
          ? ` · ${state.counts.unresolvedSourceCount} unresolved source entries retained` : '')
        + (state.counts.duplicateCount > 0 ? `; ${state.counts.duplicateCount} repeats included once.` : '.')
      : '';

    capabilities.replaceChildren();
    if (!onlyCreate && ['ready', 'empty'].includes(state.status)) {
      const explain = (message, announce = false) => {
        const paragraph = content.ownerDocument.createElement('p');
        paragraph.className = 'playlists__note';
        if (announce) paragraph.setAttribute('role', 'status');
        paragraph.textContent = message;
        capabilities.append(paragraph);
      };
      if (!state.destinations.length && state.status !== 'empty') {
        explain('No writable playlists are available.', true);
      }
      if (!state.canAdd) {
        explain(state.counts?.unresolvedSourceCount > 0
          ? 'Some selected rows have no supported Playlist track identity. Create can retain their source entries when available.'
          : 'Adding these tracks is not available from this provider.');
      }
      if (!state.canCreate) {
        explain('Creating a playlist from these tracks is not available from this source.');
      }
    }
    choiceHost.hidden = onlyCreate || !['ready', 'empty'].includes(state.status) || !state.destinations.length;
    choice.update({
      label: 'Playlist', value: state.selectedId || '',
      options: [['', 'Choose a playlist', true], ...state.destinations.map(row =>
        [row.playlist_id, row.title || 'Untitled playlist'])],
      disabled: state.busy || finished || !state.canAdd,
      onChange: value => {if (alive && controller.getSnapshot() === state) controller.select(value);},
    });
    retry.update({scopeKey: packet.scopeKey, available: controller.canRetryOriginal?.() === true,
      disabled: state.busy, retry: controller.retryOriginal, current: () => alive && controller.isCurrent()});
    buttons.add.element.hidden = onlyCreate;
    buttons.add.update({label: 'Add to playlist', type: 'submit',
      disabled: state.busy || finished || !state.selectedId || !state.canAdd});
    buttons.create.update({
      label: onlyCreate ? 'Retry creation'
        : state.creationRecovery?.status === 'unknown' ? 'Check previous creation' : 'Create new playlist',
      disabled: state.busy || finished || (onlyCreate ? state.status === 'retired' : !state.canCreate),
      onClick: async () => {
        if (!alive || controller.getSnapshot() !== state) return;
        if (onlyCreate) await controller.load();
        if (alive) await controller.openCreate();
      },
    });
    buttons.reload.element.hidden = onlyCreate || state.status !== 'error' || finished;
    buttons.reload.update({label: 'Reload playlists', disabled: state.busy,
      onClick: () => {if (alive) controller.load();}});
    buttons.cancel.update({label: finished ? 'Close' : 'Cancel', disabled: state.busy && state.writeStarted,
      onClick: () => closeOwner?.({reason: 'cancel'})});
  }

  function dialogOptions() {
    const state = controller.getSnapshot();
    const isCreate = state.mode === 'create' || initialMode === 'create';
    return {title: isCreate ? 'Create playlist' : 'Add to playlist',
      pageId: isCreate ? 'create-playlist' : 'playlist-track-destination',
      presentationKey: 'playlist-selection', parentSurface: props.parentSurface,
      returnFocus: props.returnFocus, beforeDismiss};
  }

  function teardown() {
    if (!alive) return;
    alive = false;
    scope.dispose();
    unsubscribe?.();
    clear();
    // Acknowledged navigation still validates the receipt after native return.
    if (!completing) controller.dispose();
    content = null;
  }

  unsubscribe = controller.subscribe(paint);
  try {
    dialog = openNativeDialog(runtime, dialogOptions(), {
      fallbackHost: host,
      onError: () => teardown(),
      mount(node, close) {
        try {
          content = node;
          closeOwner = close;
          paint();
          return {dispose: teardown};
        } catch (error) {
          teardown();
          throw error;
        }
      },
      onClose(options) {
        nativeClosed = options || {};
        if (!completing || !controller.isCurrent()) reportClose(options);
      },
    });
  } catch (error) {
    teardown();
    throw error;
  }
  if (alive) {
    controller.load().then(() => {
      if (alive && initialMode === 'create') return controller.openCreate();
    });
  }
  return {
    update(next) {
      if (!alive) return;
      props = next;
      if (next.providers !== providers || next.sourceAdapter !== sourceAdapter || next.lifetime !== lifetime) {
        controller.retire();
        return;
      }
      paint();
    },
    dispose() {
      teardown();
      dialog?.dispose();
      if (!completing) controller.dispose();
    },
  };
}
