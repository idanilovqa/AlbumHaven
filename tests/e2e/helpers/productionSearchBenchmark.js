export const PRODUCTION_SEARCH_FIRST_VISIBLE_BUDGET = Object.freeze({
  targetMs: 800,
  graceMs: 400,
  hardCeilingMs: 1200,
});

export function classifyProductionSearchFirstVisible(elapsedMs) {
  const elapsed = Number(elapsedMs);
  if (elapsed <= PRODUCTION_SEARCH_FIRST_VISIBLE_BUDGET.targetMs) return 'target-met';
  if (elapsed <= PRODUCTION_SEARCH_FIRST_VISIBLE_BUDGET.hardCeilingMs) return 'grace-used';
  return 'hard-fail';
}

export function isProductionSearchHostTelemetryRequest({
  method,
  url,
  allowedOrigin,
}) {
  const parsedUrl = url instanceof URL ? url : new URL(String(url || ''));
  const normalizedMethod = String(method || '').trim().toUpperCase();
  const normalizedAllowedOrigin = String(allowedOrigin || '').trim();
  const isCloudflareBeacon = (
    normalizedMethod === 'GET'
    && parsedUrl.origin === 'https://static.cloudflareinsights.com'
    && (
      parsedUrl.pathname === '/beacon.min.js'
      || parsedUrl.pathname.startsWith('/beacon.min.js/')
    )
  );
  const isSameOriginRum = (
    normalizedMethod === 'POST'
    && parsedUrl.origin === normalizedAllowedOrigin
    && parsedUrl.pathname === '/cdn-cgi/rum'
  );
  return isCloudflareBeacon || isSameOriginRum;
}

export function hasDirectSearchArtist(payload, expectedArtist) {
  const artist = String(expectedArtist || '').trim();
  const directMatches = Array.isArray(payload?.search_context?.result_groups?.direct_matches)
    ? payload.search_context.result_groups.direct_matches
    : [];
  return directMatches.some((entry) => String(entry || '').trim() === artist);
}

export function expectedAlbumFromSearch(payload, expectedArtist) {
  const artist = String(expectedArtist || '').trim();
  const groups = [
    ...(Array.isArray(payload?.primary_artist_groups) ? payload.primary_artist_groups : []),
    ...(Array.isArray(payload?.family_artist_groups) ? payload.family_artist_groups : []),
    ...(Array.isArray(payload?.artist_groups) ? payload.artist_groups : []),
  ];
  const group = groups.find((entry) => (
    String(entry?.artist_display || entry?.artist || '').trim() === artist
  ));
  const album = Array.isArray(group?.albums) ? group.albums[0] : null;
  return String(album?.name || album?.title || album?.album || '').trim();
}

export function readProductionSearchReadiness(statusPayload, expectedDatabaseIdentityProof) {
  const relationProjection = statusPayload?.relation_projection;
  const builderVersion = String(relationProjection?.builder_version || '').trim();
  const runtimeDatabaseIdentity = statusPayload?.database_identity;
  const catalogAlbumCount = Number(runtimeDatabaseIdentity?.catalog_album_count);
  if (relationProjection?.ready !== true || !builderVersion || !(catalogAlbumCount > 0)) {
    throw new Error('Sandbox1 runtime projection readiness could not be verified.');
  }
  const expectedScheme = String(expectedDatabaseIdentityProof?.scheme || '').trim();
  const expectedKeyVersion = Number(expectedDatabaseIdentityProof?.keyVersion);
  const expectedProof = String(expectedDatabaseIdentityProof?.proof || '').trim();
  if (
    runtimeDatabaseIdentity?.ready !== true
    || runtimeDatabaseIdentity?.schema_version !== 2
    || runtimeDatabaseIdentity?.scheme !== 'hmac-sha256-v1'
    || expectedScheme !== 'hmac-sha256-v1'
    || !Number.isSafeInteger(expectedKeyVersion)
    || expectedKeyVersion < 1
    || runtimeDatabaseIdentity?.key_version !== expectedKeyVersion
    || !/^[a-f0-9]{64}$/u.test(expectedProof)
    || runtimeDatabaseIdentity?.proof !== expectedProof
  ) {
    throw new Error('Sandbox1 runtime database identity does not match the operator attestation.');
  }
  return {
    builderVersion,
    catalogAlbumCountPositive: true,
    databaseIdentityMatched: true,
    relationProjectionReady: true,
  };
}

export function availableTiming(valueMs) {
  if (valueMs === null || valueMs === undefined || valueMs === '') {
    return { availability: 'unavailable', valueMs: null };
  }
  const value = Number(valueMs);
  return Number.isFinite(value) && value >= 0
    ? { availability: 'available', valueMs: Number(value.toFixed(1)) }
    : { availability: 'unavailable', valueMs: null };
}

export function unavailableTiming() {
  return { availability: 'unavailable', valueMs: null };
}

export function calculateProductionSearchPhaseDurations(boundaries = {}) {
  const orderedNames = [
    'submittedAtMs',
    'responseEndAtMs',
    'domReadyAtMs',
    'paintAtMs',
  ];
  const orderedValues = orderedNames.map((name) => Number(boundaries[name]));
  const valid = orderedValues.every((value) => Number.isFinite(value) && value >= 0);
  const monotonic = orderedValues.every((value, index) => (
    index === 0 || value >= orderedValues[index - 1]
  ));
  if (!valid || !monotonic) {
    throw new Error('Production search timing boundaries must be finite and monotonic.');
  }
  const [
    submittedAtMs,
    responseEndAtMs,
    domReadyAtMs,
    paintAtMs,
  ] = orderedValues;
  return {
    browserProcessingMs: domReadyAtMs - responseEndAtMs,
    renderMs: paintAtMs - domReadyAtMs,
    responseToFirstVisibleMs: paintAtMs - responseEndAtMs,
    submitToFirstVisibleMs: paintAtMs - submittedAtMs,
  };
}
