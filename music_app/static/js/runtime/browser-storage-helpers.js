// Kept for the signed-in account only: read back by that account alone, and removed when signing
// out (here) or in (login.js removes the same keys). Kept songs (player-track-cache.js) stay.
const ACCOUNT_LOCAL_STORAGE_KEYS = ['albumhaven.playerState.v1', 'albumhaven.androidNativeQueue.v1'];
const ACCOUNT_SESSION_STORAGE_KEYS = ['albumhaven.recentSearches.v1', 'albumhaven.playbackHandoff.v1'];
let browserStorageAccount = null;
// After a sign-out submit this page keeps nothing more for the account, as it unloads included.
let accountBrowserStorageClosed = false;

// The signed-in account this page belongs to, or '' when it has none.
function getBrowserStorageAccount() {
  if (browserStorageAccount === null) {
    let accountId = null;
    try {
      accountId = JSON.parse(document.getElementById('client-layout-preferences-bootstrap')?.textContent || '{}').account_id;
    } catch (_error) {
      accountId = null;
    }
    browserStorageAccount = Number.isSafeInteger(accountId) && accountId > 0 ? String(accountId) : '';
  }
  return browserStorageAccount;
}

function readBrowserStorageItem(storage, accountKeys, key, fallback) {
  if (!storage) return fallback;
  const name = String(key || '');
  try {
    const value = storage.getItem(name);
    if (value == null) return fallback;
    if (!accountKeys.includes(name)) return String(value);
    const account = getBrowserStorageAccount();
    if (!account || accountBrowserStorageClosed) return fallback;
    let record = null;
    try {
      record = JSON.parse(value);
    } catch (_error) {
      record = null;
    }
    if (record?.account === account && typeof record.value === 'string') return record.value;
    // Another account's, or kept before it had one.
    storage.removeItem(name);
    return fallback;
  } catch (_error) {
    return fallback;
  }
}

function writeBrowserStorageItem(storage, accountKeys, key, value) {
  if (!storage) return false;
  const name = String(key || '');
  let stored = String(value ?? '');
  if (accountKeys.includes(name)) {
    const account = getBrowserStorageAccount();
    if (!account || accountBrowserStorageClosed) return false;
    stored = JSON.stringify({ account, value: stored });
  }
  try {
    storage.setItem(name, stored);
    return true;
  } catch (_error) {
    return false;
  }
}

function removeBrowserStorageItem(storage, key) {
  if (!storage) return false;
  try {
    storage.removeItem(String(key || ''));
    return true;
  } catch (_error) {
    return false;
  }
}

function getBrowserLocalStorage() {
  try {
    return window.localStorage || null;
  } catch (_error) {
    return null;
  }
}

function getLocalStorageItem(key, fallback = '') {
  const preferences = window.AlbumHavenDevicePreferences;
  if (preferences?.handles?.(key)) return preferences.getItem(key) ?? fallback;
  return readBrowserStorageItem(getBrowserLocalStorage(), ACCOUNT_LOCAL_STORAGE_KEYS, key, fallback);
}

function setLocalStorageItem(key, value) {
  const preferences = window.AlbumHavenDevicePreferences;
  if (preferences?.handles?.(key)) return preferences.setItem(key, String(value ?? ''));
  return writeBrowserStorageItem(getBrowserLocalStorage(), ACCOUNT_LOCAL_STORAGE_KEYS, key, value);
}

function removeLocalStorageItem(key) {
  return removeBrowserStorageItem(getBrowserLocalStorage(), key);
}

function getBrowserSessionStorage() {
  try {
    return window.sessionStorage || null;
  } catch (_error) {
    return null;
  }
}

function getSessionStorageItem(key, fallback = '') {
  return readBrowserStorageItem(getBrowserSessionStorage(), ACCOUNT_SESSION_STORAGE_KEYS, key, fallback);
}

function setSessionStorageItem(key, value) {
  return writeBrowserStorageItem(getBrowserSessionStorage(), ACCOUNT_SESSION_STORAGE_KEYS, key, value);
}

function removeSessionStorageItem(key) {
  return removeBrowserStorageItem(getBrowserSessionStorage(), key);
}

// A submitted sign-out form: what this page kept for the account goes now.
function closeAccountBrowserStorageOnSignOut(event) {
  let path = '';
  try {
    path = new URL(event?.target?.action || '', window.location.href).pathname;
  } catch (_error) {
    return false;
  }
  if (path !== '/logout') return false;
  accountBrowserStorageClosed = true;
  ACCOUNT_LOCAL_STORAGE_KEYS.forEach(key => removeLocalStorageItem(key));
  ACCOUNT_SESSION_STORAGE_KEYS.forEach(key => removeSessionStorageItem(key));
  return true;
}
