export const LASTFM_PLAYBACK_TARGET = Object.freeze({
  artist: 'Album Haven Last.fm Fixture',
  album: 'Signed Scrobble Journey',
  track: 'Fake Loop Source',
  year: 2026,
});

// Last.fm never scrobbles a track of 30 s or less: the album's first track is the 14 s loop source
// and never scrobbles, while its later 32 s tracks each do.
export const LASTFM_SCROBBLE_TRACK = Object.freeze({
  index: 1,
  title: `${LASTFM_PLAYBACK_TARGET.album} Track 2`,
});

export const LASTFM_CONSECUTIVE_PLAYBACK_TRACKS = Object.freeze([
  LASTFM_SCROBBLE_TRACK.title,
  `${LASTFM_PLAYBACK_TARGET.album} Track 3`,
  `${LASTFM_PLAYBACK_TARGET.album} Track 4`,
]);

function resolveLastfmFixtureProviderBaseURL(testInfo) {
  const providerBaseURL = String(testInfo.config.metadata?.providerBaseURL || '').trim();
  if (!providerBaseURL) {
    throw new Error('The isolated Playwright config must expose its fixture-owned provider base URL.');
  }
  const provider = new URL(providerBaseURL);
  if (provider.protocol !== 'http:' || provider.hostname !== '127.0.0.1' || !provider.port) {
    throw new Error(`Refusing to use non-loopback Last.fm fixture provider ${provider.origin}.`);
  }
  return provider;
}

async function readJsonResponse(response, label) {
  if (!response.ok) {
    throw new Error(`${label} failed with HTTP ${response.status}.`);
  }
  return response.json();
}

export async function controlLastfmProvider(testInfo, action, payload = {}) {
  const endpoint = new URL(
    '/lastfm-fixture/control',
    resolveLastfmFixtureProviderBaseURL(testInfo),
  );
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: String(action), ...payload }),
  });
  return readJsonResponse(response, `Last.fm provider control ${action}`);
}

export async function readLastfmProviderState(testInfo) {
  const endpoint = new URL(
    '/lastfm-fixture/state',
    resolveLastfmFixtureProviderBaseURL(testInfo),
  );
  return readJsonResponse(await fetch(endpoint), 'Last.fm provider state');
}

export async function readLastfmProviderRequests(testInfo) {
  const endpoint = new URL(
    '/lastfm/requests',
    resolveLastfmFixtureProviderBaseURL(testInfo),
  );
  const response = await fetch(endpoint);
  const payload = await readJsonResponse(response, 'Last.fm provider evidence');
  if (!Array.isArray(payload.requests)) {
    throw new Error('Last.fm provider evidence did not contain a requests array.');
  }
  return payload.requests;
}
