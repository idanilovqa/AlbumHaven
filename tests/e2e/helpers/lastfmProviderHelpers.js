export const LASTFM_PLAYBACK_TARGET = Object.freeze({
  artist: 'Album Haven Last.fm Fixture',
  album: 'Signed Scrobble Journey',
  track: 'Fake Loop Source',
  year: 2026,
});

export const LASTFM_CONSECUTIVE_PLAYBACK_TRACKS = Object.freeze([
  LASTFM_PLAYBACK_TARGET.track,
  `${LASTFM_PLAYBACK_TARGET.album} Track 2`,
  `${LASTFM_PLAYBACK_TARGET.album} Track 3`,
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
