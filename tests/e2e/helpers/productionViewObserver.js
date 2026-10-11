import { CDPDocumentEvents } from './cdpDocumentEvents.js';

function readViewDataRequest(request, sequence) {
  const requestUrl = new URL(request.url());
  if (!['/view-data', '/home-data'].includes(requestUrl.pathname)) return null;
  const scopeParams = new URLSearchParams(requestUrl.searchParams);
  for (const key of ['payload_tier', 'gallery_offset', 'gallery_cursor', 'omit_sidebar']) {
    scopeParams.delete(key);
  }
  scopeParams.sort();
  return {
    gallery: requestUrl.pathname === '/view-data'
      && ['', 'albums', 'library'].includes(requestUrl.searchParams.get('surface') || ''),
    append: Boolean(requestUrl.searchParams.get('gallery_cursor'))
      || Number(requestUrl.searchParams.get('gallery_offset') || 0) > 0,
    scope: `${requestUrl.pathname}?${scopeParams}`,
    categoryScope: JSON.stringify(requestUrl.searchParams.getAll('category').sort()),
    search: Boolean(String(requestUrl.searchParams.get('q') || '').trim()),
    payloadTier: String(requestUrl.searchParams.get('payload_tier') || '').trim().toLowerCase(),
    full: !['sidebar', 'search_preview'].includes(
      String(requestUrl.searchParams.get('payload_tier') || '').trim().toLowerCase(),
    ),

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

export function isRootGalleryContinuationUrl(value) {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return url.pathname === '/view-data' && Boolean(url.searchParams.get('gallery_cursor'))
    && !['q', 'artist', 'playlist'].some(key => url.searchParams.get(key))
    && (!url.searchParams.get('surface') || url.searchParams.get('surface') === 'albums');
}

export function hasCompleteCanonicalAlbumInventory(payload) {
  return Boolean(payload) && String(payload.payload_tier || 'full').trim().toLowerCase() === 'full';
}

export function matchesAccumulatedRootProjection(payload, projection, allowLaterPage = false) {
  if (!payload?.gallery_page?.revision || !projection?.gallery_page) return false;
  if (payload.query || payload.selected_artist || projection.query || projection.selected_artist
      || projection.busy || projection.pendingViewTransition || projection.surface !== 'albums') return false;
  const page = payload.gallery_page;
  const applied = projection.gallery_page;
  return page.revision === applied.revision && (allowLaterPage || (page.next_cursor === applied.next_cursor
    && page.has_more === applied.has_more))
    && String(payload.gallery_scope || 'all') === String(projection.gallery_scope || 'all')
    && JSON.stringify(payload.visible_library_categories || [])
      === JSON.stringify(projection.visible_library_categories || [])
    && Array.isArray(projection.artist_groups);
}

export function readAppliedAlbumTargetEvidence(observation, projection, bootstrap, expected) {
  const payload = observation.latestFullPayload;
  const rootAnchor = matchesAccumulatedRootProjection(payload, projection) ? payload
    : matchesAccumulatedRootProjection(bootstrap, projection, true) ? bootstrap : null;
  const observed = readCanonicalAlbumTargetEvidence(observation, expected);
  const applied = readCanonicalAlbumTargetEvidence({ latestFullPayload: projection }, expected);
  const settled = projection && !projection.busy && !projection.pendingViewTransition && projection.surface === 'albums';
  const sameFilters = payload && settled
    && String(payload.gallery_scope || 'all') === String(projection.gallery_scope || 'all')
    && ['visible_library_categories', 'related_filter_artists'].every(key => JSON.stringify([...(payload[key] || [])].sort()) === JSON.stringify([...(projection[key] || [])].sort()))
    && Boolean(payload.primary_filter_active) === Boolean(projection.primary_filter_active);
  const sameQuery = String(payload?.query || '') === String(projection?.query || '');
  const sameScope = sameFilters && sameQuery
    && String(payload.selected_artist || '') === String(projection.selected_artist || '');
  const localSelection = sameFilters && (sameQuery || (!projection.query && projection.selected_artist
    && !projection.locationQuery && projection.locationArtist === projection.selected_artist));
  const inventory = (view) => {
    const groups = new Map();
    for (const field of ['artist_groups', 'primary_artist_groups', 'family_artist_groups']) {
      for (const group of view?.[field] || []) {
        const artist = String(group.artist || group.artist_display || '').trim();
        const albums = groups.get(artist) || new Set();
        for (const album of group.albums || []) albums.add(String(album.key || album.name || album.title || ''));
        groups.set(artist, albums);
      }
    }
    return groups;
  };
  const sourceGroups = inventory(payload);
  const appliedGroups = inventory(projection);
  const familyScope = localSelection && projection.authoritativeMountedFamily === true
    && Boolean(projection.selected_artist);
  const completeFamily = familyScope && appliedGroups.size > 0 && [...appliedGroups].every(([artist, albums]) => {
    const sourceAlbums = sourceGroups.get(artist);
    return sourceAlbums?.size === albums.size && [...albums].every(album => sourceAlbums.has(album));
  });
  const sourceMatch = rootAnchor
    ? readCanonicalAlbumTargetEvidence({ latestFullPayload: rootAnchor }, expected).canonicalMatch
    : observed.canonicalMatch && (!familyScope || appliedGroups.has(String(expected.artist || '').trim()));
  const acceptedScope = Boolean(rootAnchor || sameScope || localSelection);
  return {
    ...(acceptedScope ? applied : observed),
    canonicalMatch: Boolean(sourceMatch || applied.canonicalMatch),
    canonicalReadyMatch: Boolean(acceptedScope && applied.canonicalMatch && (rootAnchor || sourceMatch)),
    canonicalInventoryComplete: Boolean(rootAnchor ? projection.gallery_page.has_more === false
      : (sameScope || completeFamily) && observed.canonicalInventoryComplete),
    canonicalQuery: String((acceptedScope ? projection?.query : payload?.query) || ''),
  };
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
  const pageGroups = observation.observedGalleryGroups || [];
  const familyAlbums = observation.observedFamilyAlbums || [];
  const presenceGroups = [...fullGroups, ...pageGroups,
    ...familyAlbums.map((album) => ({ artist: album.artist, albums: [album.name] }))];
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
  const observedMatch = presenceGroups.some(
    (group) => group.artist === expectedArtist && group.albums.includes(expectedAlbum),
  );
  const observedAlbums = [...new Set([
    ...presenceGroups.flatMap((group) => group.albums),
    ...completedAlbums.map((album) => album.name),
  ])];
  const observedArtists = [...new Set([
    ...presenceGroups.map((group) => group.artist),
    ...completedAlbums.map((album) => album.artist),
  ].filter(Boolean))];

  return {

    canonicalInventoryComplete: hasCompleteCanonicalAlbumInventory(observation.latestFullPayload),
    canonicalMatch: observedMatch || completedSaveTaskMatch,

    canonicalSource: completedSaveTaskMatch
      ? 'completed-save-task'
      : (fullMatch ? 'full-view' : (observedMatch ? 'observed-gallery' : '')),
    observedAlbums,
    observedArtists,
  };
}

export class ProductionViewObserver {
  constructor(page, events = new CDPDocumentEvents(page)) {
    this.events = events;
    this.activeRequests = new Map();
    this.latestFullPayload = null;
    this.latestGalleryPage = null;
    this.latestGalleryPageError = null;
    this.latestGalleryRequestSequence = 0;
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
    this.pendingPayloadReads = new Map();
    this.requestDetails = new WeakMap();
    this.stateRevision = 0;
    this.topologyRevision = 0;
    this.galleryScope = null;
    this.galleryArtistTopologies = new Map();
    this.observedGalleryGroups = new Map();
    this.observedFamilyAlbums = new Map();
    this.categoryScope = null;
    this.galleryGeneration = 0;
    this.mutationGeneration = 0;
    this.galleryPayloadObserved = false;
    this.allowBootstrapFallback = false;

    this.documentGeneration = 0;
    const resetDocumentObservation = () => {
      this.documentGeneration += 1;
      this.topologyRevision += 1;
      this.galleryArtistTopologies.clear();
      this.observedGalleryGroups.clear();
      this.observedFamilyAlbums.clear();
      this.categoryScope = null;
      this.galleryGeneration += 1;
      this.galleryPayloadObserved = false;
      this.galleryScope = null;
      this.allowBootstrapFallback = true;
      this.authorityGeneration += 1;
      this.activeRequests.clear();
      this.latestFullPayload = null;
      this.latestGalleryPage = null;
      this.latestGalleryPageError = null;
      this.latestGalleryRequestSequence = 0;
      this.latestFullPayloadError = null;
      this.latestFullRequestSequence = 0;
      this.latestFullRequestUrl = '';
      this.latestFullPayloadRead = null;
      this.latestCompletedSaveTaskPayload = null;
      this.completedCanonicalMutationPayloads = [];
      this.pendingPayloadReads.clear();
      this.stateRevision += 1;
    };
    events.on('documentcommitted', resetDocumentObservation);
    events.on('request', (request) => {
      if (isSaveTaskRequest(request)) {
        this.allowBootstrapFallback = false;
        const sequence = this.nextSaveTaskRequestSequence + 1;
        this.nextSaveTaskRequestSequence = sequence;
        this.latestSaveTaskRequestSequence = sequence;
        const saveTaskDetail = {
          authorityGeneration: this.authorityGeneration,
          documentGeneration: this.documentGeneration,
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
      detail.documentGeneration = this.documentGeneration;
      detail.mutationGeneration = this.mutationGeneration;
      this.nextRequestSequence = detail.sequence;
      this.allowBootstrapFallback = false;
      const galleryScopeChanged = detail.gallery
        && this.galleryScope !== null && this.galleryScope !== detail.scope;
      if (detail.full
        || (detail.gallery && !detail.append && detail.payloadTier !== 'search_preview')
        || galleryScopeChanged) {
        this.topologyRevision += 1;
        this.galleryArtistTopologies.clear();
        this.observedGalleryGroups.clear();
        this.galleryGeneration += 1;
        this.galleryPayloadObserved = false;
        this.latestFullPayload = null;
        this.latestFullRequestSequence = 0;
        this.latestFullPayloadRead = null;
        this.latestFullPayloadError = null;
      }
      if (detail.gallery) {
        if (this.categoryScope !== detail.categoryScope) this.observedFamilyAlbums.clear();
        this.categoryScope = detail.categoryScope;
        if (galleryScopeChanged) {
          this.authorityGeneration += 1;
          this.latestCompletedSaveTaskPayload = null;
          this.completedCanonicalMutationPayloads = [];
        }
        this.galleryScope = detail.scope;
        this.latestGalleryRequestSequence = detail.sequence;
        this.latestGalleryPage = null;
        this.latestGalleryPageError = null;
      }
      detail.galleryGeneration = this.galleryGeneration;
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

    events.on('response', (response) => {
      const responseRequest = response.request();
      const detail = this.requestDetails.get(responseRequest);
      if (detail && detail.documentGeneration !== this.documentGeneration) return;
      if (detail?.kind === 'save-task') {
        if (!response.ok()) return;
        const pendingRead = `save-task:${detail.sequence}`;
        this.pendingPayloadReads.set(pendingRead, detail);
        this.stateRevision += 1;
        Promise.resolve(response.json())
          .then((payload) => {
            if (detail.sequence !== this.latestSaveTaskRequestSequence) return;
            if (detail.authorityGeneration !== this.authorityGeneration) return;
            if (detail.documentGeneration !== this.documentGeneration) return;
            if (payload?.ok !== true || String(payload?.status || '').trim().toLowerCase() !== 'completed') return;
            // A completed write invalidates pre-write reads even when no album remains.
            if (this.latestFullPayload || this.galleryPayloadObserved || this.observedFamilyAlbums.size) {
              this.topologyRevision += 1;
            }
            this.mutationGeneration += 1;
            this.galleryArtistTopologies.clear();
            this.observedFamilyAlbums.clear();
            this.observedGalleryGroups.clear();
            this.galleryPayloadObserved = false;
            this.latestFullPayload = null;
            this.latestGalleryPage = null;
            const acceptedAlbums = readCompletedSaveTaskAlbums(payload);
            if (acceptedAlbums.length === 0) {
              this.latestCompletedSaveTaskPayload = null;
              this.completedCanonicalMutationPayloads = [];
              return;
            }
            const acceptedIdentities = new Set(acceptedAlbums.map((album) => album.identity));
            const existingIndex = this.completedCanonicalMutationPayloads.findIndex((current) => {
              const currentIdentities = readCompletedSaveTaskAlbums(current)
                .map((album) => album.identity);
              return currentIdentities.length === acceptedIdentities.size
                && currentIdentities.every((identity) => acceptedIdentities.has(identity));
            });
            if (existingIndex >= 0) {
              if (JSON.stringify(this.completedCanonicalMutationPayloads[existingIndex].updated_albums) !== JSON.stringify(payload.updated_albums)) {
                this.topologyRevision += 1;
              }
              this.completedCanonicalMutationPayloads[existingIndex] = payload;
            } else {
              this.topologyRevision += 1;
              this.completedCanonicalMutationPayloads.push(payload);
            }
            this.latestCompletedSaveTaskPayload = payload;
          })
          .catch((error) => {
            if (detail.documentGeneration !== this.documentGeneration) return;
            if (detail.authorityGeneration !== this.authorityGeneration) return;
            this.observedFamilyAlbums.clear();
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
      if (!detail || (!detail.full && !detail.gallery)) return;
      if (detail.mutationGeneration !== this.mutationGeneration
        || detail.galleryGeneration !== this.galleryGeneration) return;
      if (!response.ok()) {
        if (detail.gallery && detail.documentGeneration === this.documentGeneration
          && detail.sequence === this.latestGalleryRequestSequence) {
          this.observedFamilyAlbums.clear();
          this.latestGalleryPageError = `HTTP ${response.status()} for ${detail.url}`;
          this.stateRevision += 1;
        }
        if (detail.documentGeneration === this.documentGeneration
          && detail.sequence === this.latestFullRequestSequence) {
          this.observedFamilyAlbums.clear();
          this.latestFullPayloadError = `HTTP ${response.status()} for ${detail.url}`;
          this.stateRevision += 1;
        }
        return;
      }
      this.pendingPayloadReads.set(detail.sequence, detail);
      this.stateRevision += 1;
      const payloadRead = Promise.resolve(response.json())
        .then((payload) => {
          if (detail.documentGeneration !== this.documentGeneration
            || detail.mutationGeneration !== this.mutationGeneration
            || detail.galleryGeneration !== this.galleryGeneration) return;
          if (detail.gallery) {
            if (detail.sequence === this.latestGalleryRequestSequence) {
              this.latestGalleryPage = payload?.gallery_page || null;
            }
            this.galleryPayloadObserved = true;
            for (const group of readCanonicalArtistGroups(payload)) {
              const current = this.observedGalleryGroups.get(group.artist);
              this.observedGalleryGroups.set(group.artist, {
                artist: group.artist,
                albums: [...new Set([...(current?.albums || []), ...group.albums])],
              });
            }
            for (const group of payload?.artist_groups || []) {
              this.galleryArtistTopologies.set(String(group.artist || group.artist_display || '').trim(),
                JSON.stringify((group.albums || []).map((album) => [
                  album.key, album.name || album.title, album.year, album.track_count_preview,
                ])));
            }
          }
          if (!detail.full) return;
          if (detail.documentGeneration !== this.documentGeneration
              || detail.sequence !== this.latestFullRequestSequence) return;
          const payloadTier = String(payload?.payload_tier || 'full').trim().toLowerCase();

          if (!['full', 'gallery_page'].includes(payloadTier)) {
            this.latestFullPayloadError = `Expected authoritative production view payload, received ${payloadTier || 'unknown'}`;

            return;
          }
          this.latestFullPayload = payload;
          this.latestFullPayloadError = null;
          this.observedFamilyAlbums.clear();
          // Local family restoration reuses these exact server-returned identities.
          // They prove presence only; they never make a later root page complete.
          if (detail.gallery && detail.search) {
            this.retainFamilyAlbums(payload);
          }
        })
        .catch((error) => {
          if (detail.mutationGeneration !== this.mutationGeneration
            || detail.galleryGeneration !== this.galleryGeneration) return;
          if (detail.gallery && detail.documentGeneration === this.documentGeneration
              && detail.sequence === this.latestGalleryRequestSequence) {
            this.observedFamilyAlbums.clear();
            this.latestGalleryPageError = String(error?.message || error || 'Unable to parse gallery continuation');
          }
          if (detail.documentGeneration === this.documentGeneration
              && detail.sequence === this.latestFullRequestSequence) {
            this.observedFamilyAlbums.clear();
            this.latestFullPayloadError = String(error?.message || error || 'Unable to parse production view payload');
          }
        })
        .finally(() => {
          this.pendingPayloadReads.delete(detail.sequence);
          this.stateRevision += 1;
        });
      if (detail.documentGeneration === this.documentGeneration
          && detail.sequence === this.latestFullRequestSequence) {
        this.latestFullPayloadRead = payloadRead;
      }
    });

    const finishRequest = (request) => {
      if (this.activeRequests.delete(request)) this.stateRevision += 1;
    };
    events.on('requestfinished', finishRequest);
    events.on('requestfailed', (request) => {
      const detail = this.requestDetails.get(request);
      finishRequest(request);
      if (detail && (detail.mutationGeneration !== this.mutationGeneration
        || detail.galleryGeneration !== this.galleryGeneration)) return;
      if (detail?.gallery && detail.documentGeneration === this.documentGeneration
          && detail.sequence === this.latestGalleryRequestSequence) {
        this.observedFamilyAlbums.clear();
        this.latestGalleryPageError = `Request failed for ${detail.url}`;
        this.stateRevision += 1;
      }
      if (detail?.full && detail.documentGeneration === this.documentGeneration
          && detail.sequence === this.latestFullRequestSequence) {
        this.observedFamilyAlbums.clear();
        this.latestFullPayloadError = `Request failed for ${detail.url}`;
        this.stateRevision += 1;
      }
    });
  }

  async initialize() {
    await this.events.initialize();
    return this;
  }

  retainFamilyAlbums(payload) {
    let changed = false;
    for (const group of payload?.family_artist_groups || []) {
      const artist = String(group?.artist || group?.artist_display || '').trim();
      for (const album of group?.albums || []) {
        const identity = String(album?.key || album?.request_key || album?.identity_key || album?.album_ref || '').trim();
        const name = String(album?.name || album?.title || '').trim();
        if (!artist || !identity || !name) continue;
        const previous = this.observedFamilyAlbums.get(identity);
        if (previous?.artist === artist && previous?.name === name) continue;
        this.observedFamilyAlbums.set(identity, { artist, identity, name });
        changed = true;
      }
    }
    return changed;
  }

  acceptBootstrapPresence(payload, stateRevision) {
    if (!this.allowBootstrapFallback || this.stateRevision !== stateRevision
      || this.activeRequests.size || this.pendingPayloadReads.size
      || this.latestFullPayloadError || this.latestGalleryPageError) return false;
    // Inline startup evidence is presence-only, bound to the current categories.
    // Never promote it to an observed full response or revive it after a request.
    if (Array.isArray(payload?.visible_library_categories)) {
      this.categoryScope = JSON.stringify([...payload.visible_library_categories].sort());
      if (this.retainFamilyAlbums(payload)) {
        this.topologyRevision += 1;
        this.stateRevision += 1;
      }
    }
    return true;
  }

  async dispose() {
    await this.events.close();
  }

  read() {
    if (this.events.observationError) throw this.events.observationError;
    const activeRequest = [...this.activeRequests.values()]
      .sort((left, right) => right.sequence - left.sequence)[0];
    return {
      activeRequestCount: this.activeRequests.size,
      activeRequestUrl: String(activeRequest?.url || ''),
      onlyRootContinuationsPending: this.activeRequests.size > 0
        && [...this.activeRequests.values()].every(detail => isRootGalleryContinuationUrl(detail.url))
        && [...this.pendingPayloadReads.values()].every(detail => isRootGalleryContinuationUrl(detail.url)),
      latestFullPayload: this.latestFullPayload,
      canonicalScopeComplete: this.latestFullPayload !== null,
      galleryPayloadObserved: this.galleryPayloadObserved,
      observedGalleryGroups: [...this.observedGalleryGroups.values()],
      observedFamilyAlbums: [...this.observedFamilyAlbums.values()],
      latestGalleryPage: this.latestGalleryPage,
      latestGalleryPageError: this.latestGalleryPageError,
      galleryBusy: [...this.activeRequests.values()].some((detail) => detail.gallery)
        || this.pendingPayloadReads.has(this.latestGalleryRequestSequence),
      latestFullPayloadError: this.latestFullPayloadError,
      requestGeneration: this.latestFullRequestSequence,
      latestFullRequestUrl: this.latestFullRequestUrl,
      latestCompletedSaveTaskPayload: this.latestCompletedSaveTaskPayload,
      completedCanonicalMutationPayloads: [...this.completedCanonicalMutationPayloads],
      pendingPayloadReadCount: this.pendingPayloadReads.size,
      stateRevision: this.stateRevision,
      topologyRevision: this.topologyRevision,
      galleryArtistTopologies: Object.fromEntries(this.galleryArtistTopologies),
      allowBootstrapFallback: this.allowBootstrapFallback,
    };
  }

  async readLatestFullPayloadWhenSettled() {
    if (this.latestFullPayloadRead) await this.latestFullPayloadRead;
    return this.read();
  }
}

const observersByPage = new WeakMap();
export function getProductionViewObserver(page) {
  if (!observersByPage.has(page)) observersByPage.set(page, new ProductionViewObserver(page));
  return observersByPage.get(page);
}
