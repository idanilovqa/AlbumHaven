const SHELL_LAYOUT_KEY = 'albumhaven.shellLayoutPreferences.v1';

// Seed the disposable browser context before its first document loads. Reloads
// subsequently read the preference written by the real Artist Tree controls.
export function withArtistTreePreference(storageState, baseURL, folded = false) {
  const result = structuredClone(storageState);
  if (folded === null) return result;
  if (typeof folded !== 'boolean') throw new TypeError('Artist Tree baseline must be boolean or null');
  const origin = new URL(baseURL).origin;
  let entry = result.origins.find((item) => item.origin === origin);
  if (!entry) {
    entry = { origin, localStorage: [] };
    result.origins.push(entry);
  }
  let preference = entry.localStorage.find((item) => item.name === SHELL_LAYOUT_KEY);
  const shell = preference ? JSON.parse(preference.value) : {};
  if (!shell || typeof shell !== 'object' || Array.isArray(shell)) {
    throw new TypeError('Shell layout preference must be an object');
  }
  const value = JSON.stringify({ ...shell, artistTreeFolded: folded });
  if (preference) preference.value = value;
  else entry.localStorage.push({ name: SHELL_LAYOUT_KEY, value });
  return result;
}
