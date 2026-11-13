function fixtureProvider(testInfo) {
  const provider = new URL(String(testInfo.config.metadata?.providerBaseURL || ''));
  if (provider.protocol !== 'http:' || provider.hostname !== '127.0.0.1' || !provider.port) {
    throw new Error('MusicBrainz fixture provider must be loopback-owned.');
  }
  return provider;
}

async function readJson(response, label) {
  if (!response.ok) throw new Error(`${label} failed with HTTP ${response.status}.`);
  return response.json();
}

export async function waitForMusicBrainzHydrationRequest(testInfo) {
  const endpoint = new URL('/musicbrainz-fixture/state', fixtureProvider(testInfo));
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const state = await readJson(await fetch(endpoint), 'MusicBrainz fixture state');
    if (state.started) return state;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('MusicBrainz fixture did not receive the held hydration request.');
}

export async function releaseMusicBrainzHydration(testInfo) {
  const endpoint = new URL('/musicbrainz-fixture/control', fixtureProvider(testInfo));
  return readJson(await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'release-hydration' }),
  }), 'MusicBrainz hydration release');
}
