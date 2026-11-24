// Owner (2026-11-17): an Edit Tags save the page got no answer for (lost connection, overloaded server) is
// never rolled back or dropped. The edit stays as shown and the save waits here until the server confirms
// it: each save carries the page's id, which the server records once and refuses twice, so asking about it
// and sending it again are both safe. The Edit Queue (MusicBrainz Delivery 2) lists these entries through
// window.AlbumHavenPendingTagEdits; nothing else reads the storage key directly.
const PENDING_TAG_EDITS_STORAGE_KEY = 'albumHaven.pendingTagEdits';
const PENDING_TAG_EDITS_EVENT = 'albumhaven:pending-tag-edits-changed';
const PENDING_TAG_EDIT_SAVED = new Set(['completed', 'reconciled_external']);
const PENDING_TAG_EDIT_FAILED = new Set(['rolled_back', 'recovery_failed']);
const PENDING_TAG_EDIT_FIRST_DELAY_MS = 2000;
const PENDING_TAG_EDIT_MAX_DELAY_MS = 60000;
// 6.5 (11-23): a save with no final answer after a day is dropped and logged, never checked forever.
const PENDING_TAG_EDIT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Owner (2026-11-23): a "finishing" save (files written and verified, the library still catching up) stays
// here so a reload or another tab still shows its values; it is never resent, only checked.
const PENDING_TAG_EDIT_SHOWN_STATES = new Set(['finishing', 'waiting', 'resending']);
// 6.5 (11-22): a retry pass asks about its waiting saves in requests of at most this many ids (the route's cap).
const PENDING_TAG_EDIT_STATUS_BATCH = 500;

// T3: the account and library this page belongs to (an opaque key the page carries); entries of another
// scope stay in storage for their own pages and are neither shown nor checked here.
function currentPendingTagEditScope() {
  if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return '';
  return String(document.querySelector('meta[name="album-haven-edit-scope"]')?.content || '');
}

const pendingTagEdits = (() => {
  const scope = currentPendingTagEditScope();
  // Ids this tab settled, discarded or expired: never written back from another tab's older copy.
  const removedIds = new Set();
  let entries = readEntries();
  let timer = 0;
  let delayMs = PENDING_TAG_EDIT_FIRST_DELAY_MS;
  let running = false;
  const listeners = new Set();

  function readStoredEntries() {
    try {
      const stored = JSON.parse(getLocalStorageItem(PENDING_TAG_EDITS_STORAGE_KEY, '[]') || '[]');
      return Array.isArray(stored) ? stored.filter((entry) => entry && entry.id && entry.payload) : [];
    } catch (_error) {
      return [];
    }
  }

  function inScope(entry) {
    return !scope || !entry.scope || entry.scope === scope;
  }

  function expired(entry) {
    const created = Number(entry.created_at || 0);
    return entry.state !== 'failed' && created > 0 && Date.now() - created > PENDING_TAG_EDIT_MAX_AGE_MS;
  }

  function readEntries() {
    return readStoredEntries().filter((entry) => {
      if (!inScope(entry) || removedIds.has(entry.id)) return false;
      if (!expired(entry)) return true;
      removedIds.add(entry.id);
      console.warn(`[AlbumHaven][PendingTagEdits] Dropped a pending save with no answer for 24 hours (${entry.id}).`);
      return false;
    });
  }

  function snapshot() {
    return entries.map((entry) => ({ ...entry, payload: undefined }));
  }

  function publish() {
    // T4: merge per entry, so another tab's saves (and other scopes' saves) survive this tab's write.
    const ownIds = new Set(entries.map((entry) => entry.id));
    const others = readStoredEntries().filter((entry) => !ownIds.has(entry.id) && !removedIds.has(entry.id));
    setLocalStorageItem(PENDING_TAG_EDITS_STORAGE_KEY, JSON.stringify([...others, ...entries]));
    const current = snapshot();
    listeners.forEach((listener) => {
      try { listener(current); } catch (error) { console.error('[AlbumHaven][PendingTagEdits] Listener failed.', error); }
    });
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
      window.dispatchEvent(new CustomEvent(PENDING_TAG_EDITS_EVENT, { detail: { entries: current } }));
    }
  }

  function schedule(ms) {
    if (typeof clearTimeout === 'function') clearTimeout(timer);
    if (!entries.some((entry) => entry.state !== 'failed') || typeof setTimeout !== 'function') return;
    timer = setTimeout(() => { void run(); }, ms);
  }

  async function readJson(response) {
    return response.json().catch(() => ({}));
  }

  // The server's answer for each waiting save, by id, one request per chunk; throws when it cannot be reached.
  async function readStatuses(waiting) {
    const statuses = {};
    for (let start = 0; start < waiting.length; start += PENDING_TAG_EDIT_STATUS_BATCH) {
      const status = await fetch('/utilities/edit-tags/requests/status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ ids: waiting.slice(start, start + PENDING_TAG_EDIT_STATUS_BATCH).map((entry) => entry.id) }),
      });
      const answer = await readJson(status);
      if (!status.ok || answer.ok !== true) throw new Error(answer.error || `Save status answered ${status.status}`);
      Object.assign(statuses, answer.requests);
    }
    return statuses;
  }

  // 'saved', 'failed' or 'waiting' from the server's answer for this save; throws when a resend cannot reach it.
  async function settle(entry, known) {
    if (!known) throw new Error('The server did not accept this save id.');
    if (known.found && PENDING_TAG_EDIT_SAVED.has(known.status)) return 'saved';
    if (known.found && PENDING_TAG_EDIT_FAILED.has(known.status)) return 'failed';
    // A finishing save is already held by the server: it is only ever checked, never sent again.
    if (known.found || entry.state === 'finishing') return 'waiting';
    // The server never received it: send it again under the same id.
    Object.assign(entry, { state: 'resending', attempts: Number(entry.attempts || 0) + 1, last_attempt_at: Date.now() });
    publish();
    const resent = await fetch('/utilities/edit-tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry.payload),
    });
    const result = await readJson(resent);
    if (result.code === 'duplicate_request') return 'waiting';
    if (typeof result.ok !== 'boolean') throw new Error(`Save answered ${resent.status}`);
    if (!resent.ok || !result.ok) {
      entry.last_error = String(result.error || 'The server refused this save.');
      return 'failed';
    }
    // A save without a file write keeps no journal entry, so its accepted answer is final.
    const taskStatus = String(result.save_task_status || '').trim().toLowerCase();
    return !result.save_task_id || taskStatus === 'completed' ? 'saved' : 'waiting';
  }

  // A save with no answer this pass keeps waiting; a finishing one stays finishing, so it is never resent.
  function keepWaiting(entry, error) {
    if (entry.state !== 'finishing') entry.state = 'waiting';
    entry.last_error = String(error?.message || error || '');
  }

  async function run() {
    if (running) return;
    running = true;
    let reachedServer = false;
    let settledAny = false;
    try {
      const waiting = entries.filter((item) => item.state !== 'failed');
      let statuses;
      try {
        statuses = await readStatuses(waiting);
        reachedServer = true;
      } catch (error) {
        waiting.forEach((entry) => keepWaiting(entry, error));
        return;
      }
      for (const entry of waiting) {
        let outcome;
        try {
          outcome = await settle(entry, statuses[entry.id]);
        } catch (error) {
          keepWaiting(entry, error);
          continue;
        }
        if (outcome === 'saved') {
          entries = entries.filter((item) => item !== entry);
          removedIds.add(entry.id);
          settledAny = true;
        } else if (outcome === 'failed') {
          entry.state = 'failed';
          entry.last_error = entry.last_error || 'The server could not save this edit.';
          settledAny = true;
          if (typeof showToast === 'function') {
            showToast(`Tag edit for “${entry.album?.name || 'an album'}” was not saved. It is in the Edit Queue.`, 'error', 5200);
          }
        } else if (entry.state !== 'finishing') {
          entry.state = 'waiting';
        }
      }
    } finally {
      running = false;
      // T6: saves the server holds but has not finished are checked less and less often, up to a minute.
      const onlyFinishing = entries.length > 0 && entries.every((entry) => entry.state === 'finishing');
      delayMs = reachedServer && !onlyFinishing
        ? PENDING_TAG_EDIT_FIRST_DELAY_MS
        : Math.min(delayMs * 2, PENDING_TAG_EDIT_MAX_DELAY_MS);
      publish();
      // What the library holds now replaces the kept edit once the server has decided.
      if (settledAny && typeof refreshCurrentViewAfterBackgroundCompletion === 'function') {
        void refreshCurrentViewAfterBackgroundCompletion();
      }
      schedule(delayMs);
    }
  }

  // The Save's own optimistic path lays each shown save's values over the loaded view (every display site).
  // Each update commits the patched view, and every view commit lays the open saves over it: that nested call
  // finds this pass already laying them and returns.
  let laying = false;

  function overlayCurrentView() {
    if (laying) return 0;
    laying = true;
    let laid = 0;
    try {
      for (const entry of entries) {
        const updates = entry.payload?.updates;
        if (!PENDING_TAG_EDIT_SHOWN_STATES.has(entry.state) || !entry.display_album || !updates) continue;
        if (typeof buildOptimisticUpdatedAlbumsFromEdits !== 'function' || typeof applyUpdatedAlbumsToCurrentView !== 'function') break;
        applyUpdatedAlbumsToCurrentView(buildOptimisticUpdatedAlbumsFromEdits(entry.display_album, updates), {
          skipRender: true, originalAlbum: entry.display_album, preserveScroll: true, tagEdits: updates,
        });
        if (typeof applyTagEditsToNonAlbumView === 'function') applyTagEditsToNonAlbumView(entry.display_album, updates);
        laid += 1;
      }
    } finally {
      laying = false;
    }
    return laid;
  }

  function overlayAlbumDetails(albumPayload) {
    if (!albumPayload || !Array.isArray(albumPayload.tracks)) return albumPayload;
    const values = {};
    for (const entry of entries) {
      if (!PENDING_TAG_EDIT_SHOWN_STATES.has(entry.state)) continue;
      Object.entries(entry.payload?.updates || {}).forEach(([path, fields]) => {
        values[path] = { ...(values[path] || {}), ...fields };
      });
    }
    if (!Object.keys(values).length) return albumPayload;
    return {
      ...albumPayload,
      tracks: albumPayload.tracks.map((track) => (values[track?.path] ? { ...track, ...values[track.path] } : track)),
    };
  }

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    // Another tab wrote: show its saves here too (the storage event never fires in the writing tab).
    window.addEventListener('storage', (event) => {
      if (event?.key !== PENDING_TAG_EDITS_STORAGE_KEY) return;
      entries = readEntries();
      const current = snapshot();
      listeners.forEach((listener) => {
        try { listener(current); } catch (error) { console.error('[AlbumHaven][PendingTagEdits] Listener failed.', error); }
      });
      if (overlayCurrentView() && typeof renderView === 'function') renderView();
      schedule(delayMs);
    });
  }

  return {
    list: snapshot,
    overlayCurrentView,
    overlayAlbumDetails,
    addFinishing({ id, payload, album = {} }) {
      if (!id || !payload || entries.some((entry) => entry.id === id)) return;
      entries.push({
        id,
        payload,
        album: {
          key: String(album.key || ''), name: String(album.name || ''),
          album_artist: String(album.album_artist || ''), year: album.year ?? null,
        },
        display_album: JSON.parse(JSON.stringify(album || {})),
        scope,
        track_count: Array.isArray(album.tracks) ? album.tracks.length : 0,
        created_at: Date.now(),
        attempts: 0,
        last_attempt_at: null,
        state: 'finishing',
        last_error: '',
      });
      delayMs = PENDING_TAG_EDIT_FIRST_DELAY_MS;
      publish();
      schedule(delayMs);
    },
    add({ id, payload, album = {}, trackCount = 0 }) {
      if (!id || !payload || entries.some((entry) => entry.id === id)) return;
      entries.push({
        id,
        payload,
        album: {
          key: String(album.key || ''), name: String(album.name || ''),
          album_artist: String(album.album_artist || ''), year: album.year ?? null,
        },
        track_count: Number(trackCount) || 0,
        scope,
        created_at: Date.now(),
        attempts: 0,
        last_attempt_at: null,
        state: 'waiting',
        last_error: '',
      });
      delayMs = PENDING_TAG_EDIT_FIRST_DELAY_MS;
      publish();
      schedule(delayMs);
    },
    retry(id) {
      const entry = entries.find((item) => item.id === id);
      if (!entry) return;
      Object.assign(entry, { state: 'waiting', last_error: '' });
      delayMs = PENDING_TAG_EDIT_FIRST_DELAY_MS;
      publish();
      schedule(0);
    },
    discard(id) {
      entries = entries.filter((item) => item.id !== id);
      removedIds.add(id);
      publish();
      // A discarded edit may still have landed; show what the library holds.
      if (typeof refreshCurrentViewAfterBackgroundCompletion === 'function') void refreshCurrentViewAfterBackgroundCompletion();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    resume() {
      if (entries.some((entry) => entry.state !== 'failed')) schedule(1000);
    },
  };
})();

if (typeof window !== 'undefined') {
  window.AlbumHavenPendingTagEdits = pendingTagEdits;
}
pendingTagEdits.resume();
