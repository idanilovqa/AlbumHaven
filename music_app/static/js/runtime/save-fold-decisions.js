// Owner (2026-11-22): cards change at the Save click, before anything is written. Whether a save folds a
// copy into another album is the server's one rule: it is asked when the confirmation opens, shown in
// the save's first render, or as soon as it answers after a fast click. A failed or outdated decision
// keeps that copy's card and says so; it never waits for the save to finish.
const SAVE_FOLD_STORAGE_KEY = 'albumHaven.savingTagEdits';
const SAVE_FOLD_FIELDS = ['album', 'album_artist', 'artist', 'year', 'edition', 'title', 'track_number', 'disc_number'];
const SAVE_FOLD_REQUEST_TIMEOUT_MS = 4000;
// Longer than any save is waited for; a page closed mid-save leaves nothing behind for longer.
const SAVE_FOLD_PENDING_MS = 120000;
const SAVE_FOLD_UNCHECKED = 'The fold couldn’t be checked, so that copy keeps its card for now.';

const saveFoldDecisions = (() => {
  let asked = null;
  let saves = readSaves();
  let showing = false;

  function readSaves() {
    try {
      const stored = JSON.parse(getLocalStorageItem(SAVE_FOLD_STORAGE_KEY, '[]') || '[]');
      return Array.isArray(stored)
        ? stored.filter((save) => save?.album && save?.updates && Date.now() - Number(save.at) < SAVE_FOLD_PENDING_MS)
        : [];
    } catch (_error) {
      return [];
    }
  }

  function storeSaves() {
    setLocalStorageItem(SAVE_FOLD_STORAGE_KEY, JSON.stringify(saves.map(({ own, ...save }) => save)));
  }

  function knownRevision() {
    return Number(state.status?.inventory_mutation_revision) || 0;
  }

  function ask(updates) {
    if (!Object.values(updates || {}).some((values) => SAVE_FOLD_FIELDS.some((field) => field in (values || {})))) {
      asked = null;
      return null;
    }
    const question = { key: JSON.stringify(updates), revision: knownRevision(), decision: undefined };
    question.answer = fetch('/utilities/tag-editor/fold-decision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates }),
      ...(typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? { signal: AbortSignal.timeout(SAVE_FOLD_REQUEST_TIMEOUT_MS) } : {}),
    }).then(async (response) => {
      const data = await response.json();
      return response.ok && data?.ok === true && Array.isArray(data.albums) ? data : null;
    }).catch(() => null).then((decision) => {
      question.decision = decision;
      return decision;
    });
    asked = question;
    return question;
  }

  // The confirmation's question, if it asked about exactly these updates and this inventory.
  function questionFor(updates) {
    const current = asked && asked.key === JSON.stringify(updates) && asked.revision >= knownRevision();
    const question = current ? asked : ask(updates);
    asked = null;
    return question;
  }

  function isAlbum(card, key, paths) {
    if (key && String(card?.key || '') === String(key)) return true;
    const cardPaths = Array.from(getAlbumTrackPaths(card));
    const albumPaths = new Set(paths || []);
    return cardPaths.length > 0 && cardPaths.every((path) => albumPaths.has(path));
  }

  function showFolds(decision) {
    const folds = decision.albums.filter((album) => album.folds_into);
    const unfolds = decision.albums.filter((album) => album.card);
    if (!folds.length && !unfolds.length) return false;
    const owns = (card) => folds.some((album) => isAlbum(card, album.folds_into_key, album.folds_into));
    const owned = (card) => unfolds.some((album) => isAlbum(card, album.was_folded_into_key, album.was_folded_into));
    const isFolded = (card) => !owns(card) && folds.some((album) => isAlbum(card, album.album_key, album.track_paths));
    const removed = new Set();
    let changed = false;
    const patch = {};
    for (const field of ['artist_groups', 'primary_artist_groups', 'family_artist_groups']) {
      if (!Array.isArray(state.view[field])) continue;
      patch[field] = state.view[field].map((group) => ({
        ...group,
        albums: (group.albums || []).flatMap((card) => {
          if (isFolded(card)) {
            removed.add(String(card.key || card.name));
            changed = true;
            return [];
          }
          const marked = owns(card) ? true : (owned(card) ? false : null);
          if (marked === null || (card.has_duplicate_files === true) === marked) return [card];
          changed = true;
          return [{ ...card, has_duplicate_files: marked }];
        }),
      })).filter((group) => group.albums.length);
    }
    if (changed) {
      mergeViewPayload({
        ...patch,
        ...(removed.size ? { album_count: Math.max(0, Number(state.view.album_count || 0) - removed.size) } : {}),
      }, { trackSidebarReveal: false });
      synchronizeCurrentViewAlbumIndex();
    }
    const visible = collectVisibleAlbumsUnique();
    const appearing = unfolds
      .filter((album) => !visible.some((card) => isAlbum(card, album.album_key, album.track_paths)))
      .map((album) => album.card);
    if (appearing.length) applyUpdatedAlbumsToCurrentView(appearing, { skipRender: true });
    return changed || appearing.length > 0;
  }

  // A view read while the save is being written still holds the album as it was.
  function showEdit(save) {
    if (!Object.values(save.updates).some((values) => 'album' in values || 'album_artist' in values)) return false;
    const unedited = collectVisibleAlbumsUnique().some((card) => (
      String(card.key || '') === String(save.album.key || '')
      && String(card.name || '') === String(save.album.name || '')
      && String(card.album_artist || '') === String(save.album.album_artist || '')
    ));
    if (!unedited) return false;
    applyUpdatedAlbumsToCurrentView(buildOptimisticUpdatedAlbumsFromEdits(save.album, save.updates), {
      skipRender: true, originalAlbum: save.album, tagEdits: save.updates,
    });
    return true;
  }

  function show() {
    if (showing || !saves.length) return false;
    showing = true;
    try {
      return saves.reduce((changed, save) => {
        const edited = showEdit(save);
        const folded = save.decision ? showFolds(save.decision) : false;
        return changed || edited || folded;
      }, false);
    } finally {
      showing = false;
    }
  }

  return {
    prepare(updates) {
      ask(updates);
    },
    // Called in the click, before its first render. `stillOwns` says the view is still this save's.
    start({ album, updates, stillOwns, render }) {
      const question = questionFor(updates);
      const save = {
        id: `${Date.now()}:${Math.random()}`, own: true, at: Date.now(),
        album, updates, decision: question?.decision || null,
      };
      saves.push(save);
      storeSaves();
      let failed = false;
      const shown = {
        fail() {
          failed = true;
          this.finish();
        },
        finish() {
          if (!saves.includes(save)) return;
          saves = saves.filter((item) => item !== save);
          storeSaves();
        },
        // The save's own answer lists a folded copy as an album: its card must not come back.
        keep() {
          if (save.decision && stillOwns()) showFolds(save.decision);
        },
        // After the click's render and its saving alert, so neither hides this.
        follow() {
          if (!question) return;
          void question.answer.then((decision) => {
            if (failed || !stillOwns()) return;
            if (!decision) {
              showRepairAlert(SAVE_FOLD_UNCHECKED, 'warning', 8000, { title: 'Fold not checked' });
              return;
            }
            if (save.decision === decision) return;
            save.decision = decision;
            storeSaves();
            if (showFolds(decision)) render();
          });
        },
      };
      return shown;
    },
    show,
    // Another page started, decided or finished a save.
    readOtherPages() {
      const before = saves;
      const own = before.filter((save) => save.own);
      saves = [...own, ...readSaves().filter((save) => !own.some((item) => item.id === save.id))];
      const ended = before.some((save) => !saves.some((item) => item.id === save.id));
      if (ended && typeof refreshCurrentViewAfterBackgroundCompletion === 'function') {
        void refreshCurrentViewAfterBackgroundCompletion();
      } else if (show()) {
        renderView({ preserveScroll: true });
      }
    },
  };
})();

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (event) => {
    if (event.key === SAVE_FOLD_STORAGE_KEY) saveFoldDecisions.readOtherPages();
  });
}
