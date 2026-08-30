function readViewDataRequest(request, sequence) {
  const requestUrl = new URL(request.url());
  if (!['/view-data', '/home-data'].includes(requestUrl.pathname)) return null;
  return {
    full: String(requestUrl.searchParams.get('payload_tier') || '').trim().toLowerCase() !== 'sidebar',
    sequence,
    url: request.url(),
  };
}

function isSaveTaskRequest(request) {
  if (typeof request?.method !== 'function' || request.method() !== 'GET') return false;
  const requestUrl = new URL(request.url());
  return /^\/utilities\/save-task\/[^/]+$/u.test(requestUrl.pathname);
}

function normalizeVisibleText(value) {
  return String(value || '').trim().replace(/\s+/gu, ' ');
}

function sameTextEntries(left = [], right = []) {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

export function hasStableDomEvidence(initial = {}, final = {}) {
  return Boolean(initial.attachedMatch) === Boolean(final.attachedMatch)
    && sameTextEntries(initial.attachedArtists, final.attachedArtists)
    && sameTextEntries(initial.sidebarArtists, final.sidebarArtists);
}

export function hasAppliedCanonicalArtist(canonicalArtists = [], attachedArtists = []) {
  const canonicalNames = new Set(
    canonicalArtists.map(normalizeVisibleText).filter(Boolean),
  );
  return attachedArtists
    .map(normalizeVisibleText)
    .filter(Boolean)
    .some((artist) => canonicalNames.has(artist));
}

export function hasAppliedCanonicalArtistSurface(
  canonicalArtists = [],
  attachedArtists = [],
  state = {},
) {
  const normalizedCanonical = canonicalArtists.map(normalizeVisibleText).filter(Boolean);
  const normalizedAttached = attachedArtists.map(normalizeVisibleText).filter(Boolean);
  if (normalizedCanonical.length > 0) {
    return hasAppliedCanonicalArtist(normalizedCanonical, normalizedAttached);
  }
  return normalizedAttached.length === 0 && Boolean(
    state.settledEmpty
    || (state.payloadPresent && !state.loaderVisible),
  );
}

export function readCanonicalArtistGroups(payload = {}) {
  const groupsByArtist = new Map();
  for (const field of ['artist_groups', 'primary_artist_groups', 'family_artist_groups']) {
    for (const group of Array.isArray(payload?.[field]) ? payload[field] : []) {
      const artist = String(group?.artist || group?.artist_display || '').trim();
      if (!artist) continue;
      const albums = (Array.isArray(group?.albums) ? group.albums : [])
        .map((album) => String(album?.name || album?.title || '').trim())
        .filter(Boolean);
      const current = groupsByArtist.get(artist) || { artist, albums: [] };
      current.albums = [...new Set([...current.albums, ...albums])];
      groupsByArtist.set(artist, current);
    }
  }
  return [...groupsByArtist.values()];
}

function readCompletedSaveTaskAlbums(payload = {}) {
  if (payload?.ok !== true) return [];
  if (String(payload?.status || '').trim().toLowerCase() !== 'completed') return [];
  if (!Array.isArray(payload?.updated_albums)) return [];
  const albums = payload.updated_albums.map((album) => ({
    artist: String(album?.album_artist || album?.artist || album?.artist_display || '').trim(),
    identity: String(
      album?.key || album?.request_key || album?.identity_key || album?.album_ref || '',
    ).trim(),
    name: String(album?.name || album?.title || '').trim(),
  }));
  if (albums.some(({ artist, identity, name }) => !artist || !identity || !name)) return [];
  const identities = new Set(albums.map((album) => album.identity));
  if (identities.size !== albums.length) return [];
  return albums;
}

export function readCanonicalAlbumTargetEvidence(observation = {}, expected = {}) {
  const expectedAlbum = String(expected.album || '').trim();
  const expectedArtist = String(expected.artist || '').trim();
  const fullGroups = readCanonicalArtistGroups(observation.latestFullPayload);
  const mutationPayloads = Array.isArray(observation.completedCanonicalMutationPayloads)
    ? observation.completedCanonicalMutationPayloads
    : [observation.latestCompletedSaveTaskPayload].filter(Boolean);
  const completedAlbumsByIdentity = new Map();
  for (const payload of mutationPayloads) {
    for (const album of readCompletedSaveTaskAlbums(payload)) {
      completedAlbumsByIdentity.set(album.identity, album);
    }
  }
  const completedAlbums = [...completedAlbumsByIdentity.values()];
  const fullMatch = fullGroups.some(
    (group) => group.artist === expectedArtist && group.albums.includes(expectedAlbum),
  );
  const completedSaveTaskMatch = completedAlbums.some(
    (album) => album.artist === expectedArtist && album.name === expectedAlbum,
  );
  const observedAlbums = [...new Set([
    ...fullGroups.flatMap((group) => group.albums),
    ...completedAlbums.map((album) => album.name),
  ])];
  const observedArtists = [...new Set([
    ...fullGroups.map((group) => group.artist),
    ...completedAlbums.map((album) => album.artist),
  ].filter(Boolean))];

  return {
    canonicalMatch: fullMatch || completedSaveTaskMatch,
    canonicalSource: completedSaveTaskMatch
      ? 'completed-save-task'
      : (fullMatch ? 'full-view' : ''),
    observedAlbums,
    observedArtists,
  };
}

export class ProductionViewObserver {
  constructor(page) {
    this.activeRequests = new Map();
    this.latestFullPayload = null;
    this.latestFullPayloadError = null;
    this.latestFullRequestSequence = 0;
    this.latestFullRequestUrl = '';
    this.latestFullPayloadRead = null;
    this.latestCompletedSaveTaskPayload = null;
    this.completedCanonicalMutationPayloads = [];
    this.authorityGeneration = 0;
    this.nextRequestSequence = 0;
    this.nextSaveTaskRequestSequence = 0;
    this.latestSaveTaskRequestSequence = 0;
    this.pendingPayloadReads = new Set();
    this.requestDetails = new WeakMap();
    this.stateRevision = 0;

    page.on('request', (request) => {
      if (
        typeof request.isNavigationRequest === 'function'
        && request.isNavigationRequest()
        && typeof request.resourceType === 'function'
        && request.resourceType() === 'document'
      ) {
        this.authorityGeneration += 1;
        this.activeRequests.clear();
        this.latestFullPayload = null;
        this.latestFullPayloadError = null;
        this.latestFullRequestSequence = 0;
        this.latestFullRequestUrl = '';
        this.latestFullPayloadRead = null;
        this.latestCompletedSaveTaskPayload = null;
        this.completedCanonicalMutationPayloads = [];
        this.pendingPayloadReads.clear();
        this.stateRevision += 1;
      }
      if (isSaveTaskRequest(request)) {
        const sequence = this.nextSaveTaskRequestSequence + 1;
        this.nextSaveTaskRequestSequence = sequence;
        this.latestSaveTaskRequestSequence = sequence;
        const saveTaskDetail = {
          authorityGeneration: this.authorityGeneration,
          full: false,
          kind: 'save-task',
          sequence,
          url: request.url(),
        };
        this.requestDetails.set(request, saveTaskDetail);
        this.activeRequests.set(request, saveTaskDetail);
        this.stateRevision += 1;
        return;
      }
      const detail = readViewDataRequest(request, this.nextRequestSequence + 1);
      if (!detail) return;
      this.nextRequestSequence = detail.sequence;
      this.requestDetails.set(request, detail);
      this.activeRequests.set(request, detail);
      this.stateRevision += 1;
      if (detail.full) {
        this.authorityGeneration += 1;
        this.latestFullPayload = null;
        this.latestFullPayloadError = null;
        this.latestFullRequestSequence = detail.sequence;
        this.latestFullRequestUrl = detail.url;
        this.latestFullPayloadRead = null;
        this.latestCompletedSaveTaskPayload = null;
        this.completedCanonicalMutationPayloads = [];
      }
    });

    page.on('response', (response) => {
      const responseRequest = response.request();
      const detail = this.requestDetails.get(responseRequest);
      if (detail?.kind === 'save-task') {
        if (!response.ok()) return;
        const pendingRead = `save-task:${detail.sequence}`;
        this.pendingPayloadReads.add(pendingRead);
        this.stateRevision += 1;
        Promise.resolve(response.json())
          .then((payload) => {
            if (detail.sequence !== this.latestSaveTaskRequestSequence) return;
            if (detail.authorityGeneration !== this.authorityGeneration) return;
            const acceptedAlbums = readCompletedSaveTaskAlbums(payload);
            if (acceptedAlbums.length === 0) return;
            const acceptedIdentities = new Set(acceptedAlbums.map((album) => album.identity));
            const existingIndex = this.completedCanonicalMutationPayloads.findIndex((current) => {
              const currentIdentities = readCompletedSaveTaskAlbums(current)
                .map((album) => album.identity);
              return currentIdentities.length === acceptedIdentities.size
                && currentIdentities.every((identity) => acceptedIdentities.has(identity));
            });
            if (existingIndex >= 0) {
              this.completedCanonicalMutationPayloads[existingIndex] = payload;
            } else {
              this.completedCanonicalMutationPayloads.push(payload);
            }
            this.latestCompletedSaveTaskPayload = payload;
          })
          .catch((error) => {
            this.latestFullPayloadError = String(
              error?.message || error || `Unable to parse save-task payload for ${detail.url}`,
            );
          })
          .finally(() => {
            this.pendingPayloadReads.delete(pendingRead);
            this.stateRevision += 1;
          });
        return;
      }
      if (!detail?.full) return;
      if (!response.ok()) {
        if (detail.sequence === this.latestFullRequestSequence) {
          this.latestFullPayloadError = `HTTP ${response.status()} for ${detail.url}`;
          this.stateRevision += 1;
        }
        return;
      }
      this.pendingPayloadReads.add(detail.sequence);
      this.stateRevision += 1;
      const payloadRead = Promise.resolve(response.json())
        .then((payload) => {
          if (detail.sequence !== this.latestFullRequestSequence) return;
          const payloadTier = String(payload?.payload_tier || 'full').trim().toLowerCase();
          if (payloadTier !== 'full') {
            this.latestFullPayloadError = `Expected full production view payload, received ${payloadTier || 'unknown'}`;
            return;
          }
          this.latestFullPayload = payload;
          this.latestFullPayloadError = null;
        })
        .catch((error) => {
          if (detail.sequence === this.latestFullRequestSequence) {
            this.latestFullPayloadError = String(error?.message || error || 'Unable to parse production view payload');
          }
        })
        .finally(() => {
          this.pendingPayloadReads.delete(detail.sequence);
          this.stateRevision += 1;
        });
      if (detail.sequence === this.latestFullRequestSequence) {
        this.latestFullPayloadRead = payloadRead;
      }
    });

    const finishRequest = (request) => {
      if (this.activeRequests.delete(request)) this.stateRevision += 1;
    };
    page.on('requestfinished', finishRequest);
    page.on('requestfailed', (request) => {
      const detail = this.requestDetails.get(request);
      finishRequest(request);
      if (detail?.full && detail.sequence === this.latestFullRequestSequence) {
        this.latestFullPayloadError = `Request failed for ${detail.url}`;
        this.stateRevision += 1;
      }
    });
  }

  read() {
    const activeRequest = [...this.activeRequests.values()]
      .sort((left, right) => right.sequence - left.sequence)[0];
    return {
      activeRequestCount: this.activeRequests.size,
      activeRequestUrl: String(activeRequest?.url || ''),
      latestFullPayload: this.latestFullPayload,
      latestFullPayloadError: this.latestFullPayloadError,
      latestFullRequestUrl: this.latestFullRequestUrl,
      latestCompletedSaveTaskPayload: this.latestCompletedSaveTaskPayload,
      completedCanonicalMutationPayloads: [...this.completedCanonicalMutationPayloads],
      pendingPayloadReadCount: this.pendingPayloadReads.size,
      stateRevision: this.stateRevision,
    };
  }

  async readLatestFullPayloadWhenSettled() {
    if (this.latestFullPayloadRead) await this.latestFullPayloadRead;
    return this.read();
  }
}
