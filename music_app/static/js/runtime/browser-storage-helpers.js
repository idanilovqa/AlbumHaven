function getBrowserLocalStorage() {
  try {
    return window.localStorage || null;
  } catch (_error) {
    return null;
  }
}

function getLocalStorageItem(key, fallback = '') {
  const storage = getBrowserLocalStorage();
  if (!storage) return fallback;
  try {
    const value = storage.getItem(String(key || ''));
    return value == null ? fallback : String(value);
  } catch (_error) {
    return fallback;
  }
}

function setLocalStorageItem(key, value) {
  const storage = getBrowserLocalStorage();
  if (!storage) return false;
  try {
    storage.setItem(String(key || ''), String(value ?? ''));
    return true;
  } catch (_error) {
    return false;
  }
}

function removeLocalStorageItem(key) {
  const storage = getBrowserLocalStorage();
  if (!storage) return false;
  try {
    storage.removeItem(String(key || ''));
    return true;
  } catch (_error) {
    return false;
  }
}

function getBrowserSessionStorage() {
  try {
    return window.sessionStorage || null;
  } catch (_error) {
    return null;
  }
}

function getSessionStorageItem(key, fallback = '') {
  const storage = getBrowserSessionStorage();
  if (!storage) return fallback;
  try {
    const value = storage.getItem(String(key || ''));
    return value == null ? fallback : String(value);
  } catch (_error) {
    return fallback;
  }
}

function setSessionStorageItem(key, value) {
  const storage = getBrowserSessionStorage();
  if (!storage) return false;
  try {
    storage.setItem(String(key || ''), String(value ?? ''));
    return true;
  } catch (_error) {
    return false;
  }
}

function removeSessionStorageItem(key) {
  const storage = getBrowserSessionStorage();
  if (!storage) return false;
  try {
    storage.removeItem(String(key || ''));
    return true;
  } catch (_error) {
    return false;
  }
}
