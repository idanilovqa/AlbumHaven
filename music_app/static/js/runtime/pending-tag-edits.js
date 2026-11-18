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

const pendingTagEdits = (() => {
  let entries = readEntries();
  let timer = 0;
  let delayMs = PENDING_TAG_EDIT_FIRST_DELAY_MS;
  let running = false;
  const listeners = new Set();

  function readEntries() {
    try {
      const stored = JSON.parse(getLocalStorageItem(PENDING_TAG_EDITS_STORAGE_KEY, '[]') || '[]');
      return Array.isArray(stored) ? stored.filter((entry) => entry && entry.id && entry.payload) : [];
    } catch (_error) {
      return [];
    }
  }

  function snapshot() {
    return entries.map((entry) => ({ ...entry, payload: undefined }));
  }

  function publish() {
    setLocalStorageItem(PENDING_TAG_EDITS_STORAGE_KEY, JSON.stringify(entries));
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

  // 'saved', 'failed' or 'waiting'; throws when the server cannot be reached.
  async function settle(entry) {
    const status = await fetch(`/utilities/edit-tags/requests/${encodeURIComponent(entry.id)}`, {
      headers: { Accept: 'application/json' },
    });
    const known = await readJson(status);
    if (!status.ok || known.ok !== true) throw new Error(known.error || `Save status answered ${status.status}`);
    if (known.found && PENDING_TAG_EDIT_SAVED.has(known.status)) return 'saved';
    if (known.found && PENDING_TAG_EDIT_FAILED.has(known.status)) return 'failed';
    if (known.found) return 'waiting';
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

  async function run() {
    if (running) return;
    running = true;
    let reachedServer = false;
    let settledAny = false;
    try {
      for (const entry of entries.filter((item) => item.state !== 'failed')) {
        let outcome;
        try {
          outcome = await settle(entry);
          reachedServer = true;
        } catch (error) {
          entry.state = 'waiting';
          entry.last_error = String(error?.message || error || '');
          continue;
        }
        if (outcome === 'saved') {
          entries = entries.filter((item) => item !== entry);
          settledAny = true;
        } else if (outcome === 'failed') {
          entry.state = 'failed';
          entry.last_error = entry.last_error || 'The server could not save this edit.';
          settledAny = true;
          if (typeof showToast === 'function') {
            showToast(`Tag edit for “${entry.album?.name || 'an album'}” was not saved. It is in the Edit Queue.`, 'error', 5200);
          }
        } else {
          entry.state = 'waiting';
        }
      }
    } finally {
      running = false;
      delayMs = reachedServer ? PENDING_TAG_EDIT_FIRST_DELAY_MS : Math.min(delayMs * 2, PENDING_TAG_EDIT_MAX_DELAY_MS);
      publish();
      // What the library holds now replaces the kept edit once the server has decided.
      if (settledAny && typeof refreshCurrentViewAfterBackgroundCompletion === 'function') {
        void refreshCurrentViewAfterBackgroundCompletion();
      }
      schedule(delayMs);
    }
  }

  return {
    list: snapshot,
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
