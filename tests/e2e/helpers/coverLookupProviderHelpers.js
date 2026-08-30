function coverLookupFixtureEndpoint(testInfo, pathname) {
  const providerBaseURL = String(testInfo?.config?.metadata?.providerBaseURL || '').trim();
  if (!providerBaseURL) {
    throw new Error('The isolated Playwright config must expose its fixture-owned provider base URL.');
  }
  const endpoint = new URL(pathname, providerBaseURL);
  if (!['127.0.0.1', 'localhost'].includes(endpoint.hostname)) {
    throw new Error(`Refusing to control a non-loopback cover provider fixture at ${endpoint.origin}.`);
  }
  return endpoint;
}

async function readJsonResponse(response, operation) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${operation} failed with HTTP ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

export function isCoverLookupCancellationSettledBeforeArchiveWork(evidence) {
  const musicbrainzStarted = Number(evidence?.musicbrainz_started);
  const musicbrainzCompleted = Number(evidence?.musicbrainz_completed);
  return Number.isInteger(musicbrainzStarted)
    && musicbrainzStarted >= 1
    && musicbrainzStarted <= 2
    && Number.isInteger(musicbrainzCompleted)
    && musicbrainzCompleted >= 0
    && musicbrainzCompleted <= musicbrainzStarted
    && evidence?.cover_art_archive_requests === 0
    && evidence?.later_provider_released === true;
}

export async function setCoverLookupLaterProviderGate(testInfo, action) {
  const endpoint = coverLookupFixtureEndpoint(testInfo, '/cover-lookup-fixture/control');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  });
  return readJsonResponse(response, `Cover lookup fixture action ${action}`);
}

export async function setCoverLookupCandidateImageGate(testInfo, action) {
  const endpoint = coverLookupFixtureEndpoint(testInfo, '/cover-lookup-fixture/control');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action }),
  });
  return readJsonResponse(response, `Cover lookup candidate image action ${action}`);
}

export async function setCoverLookupProviderMode(testInfo, mode) {
  const endpoint = coverLookupFixtureEndpoint(testInfo, '/cover-lookup-fixture/control');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'set-mode', mode }),
  });
  return readJsonResponse(response, `Cover lookup fixture mode ${mode}`);
}

export async function setCoverLookupProviderLatency(testInfo, delaySeconds) {
  const endpoint = coverLookupFixtureEndpoint(testInfo, '/cover-lookup-fixture/control');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'set-itunes-search-delay',
      delay_seconds: delaySeconds,
    }),
  });
  return readJsonResponse(response, `Cover lookup fixture Apple search delay ${delaySeconds}`);
}

export async function resetCoverLookupProviderEvidence(testInfo) {
  const endpoint = coverLookupFixtureEndpoint(testInfo, '/cover-lookup-fixture/control');
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'reset-evidence' }),
  });
  return readJsonResponse(response, 'Cover lookup fixture evidence reset');
}

export async function readCoverLookupProviderEvidence(testInfo) {
  const endpoint = coverLookupFixtureEndpoint(testInfo, '/cover-lookup-fixture/evidence');
  const response = await fetch(endpoint, { headers: { Accept: 'application/json' } });
  return readJsonResponse(response, 'Cover lookup fixture evidence read');
}
