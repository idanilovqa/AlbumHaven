import {normalizeArtistLovedDescriptor, normalizeArtistLovedRecipe} from './artist-loved-recipe.mjs';
import {normalizePlaylistPayload} from './model.mjs';

// Temporary generated Playlist state. Server receipts own membership and rights.
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const granted = (value, key) => record(value?.allowed_actions) && Object.hasOwn(value.allowed_actions, key) && value.allowed_actions[key] === true;
const frozen = value => Object.freeze(value);
export {MIX_ORDER_OPTIONS, mixOrder, normalizeMixRecipe} from './library-mix-recipe.mjs';
import {mixOrder, mixRefreshStatus, mixRefreshError, normalizeMixRecipe, normalizeMixCoverage, normalizeArtistMixScope, mixSourceProtocol} from './library-mix-recipe.mjs';

export function orderUnplayedMixRows(rows) {
  // Unknown personal counts stay unknown; only an explicitly supplied zero is unplayed.
  return [...rows.filter(row => row.play_count === 0), ...rows.filter(row => row.play_count !== 0)];
}

function projectMix(value, scopeKey, requested, artistScope = null, artistLovedDescriptor = null) {
  const data = value?.status === 'ready' ? value.data : null;
  const recipe = artistLovedDescriptor ? normalizeArtistLovedRecipe(data?.artist_loved) : normalizeMixRecipe(data?.library_mix);
  if (!data || data.scopeKey !== scopeKey || data.source_protocol !== (artistLovedDescriptor ? 'artist_loved_selection_v1' : artistScope ? 'artist_popular_selection_v1' : 'library_mix_selection_v1')
    || data.mode !== 'ordinary' || data.source?.kind !== 'library' || !uuid(data.source.ref) || !uuid(data.source.revision)
    || data.entries_complete !== true || !granted(data, 'can_read') || !granted(data, 'can_use_for_playlist')
    || (artistLovedDescriptor && data.library_mix != null)
    || (!artistLovedDescriptor && mixSourceProtocol(data.library_mix) !== data.source_protocol)
    || (artistScope && JSON.stringify(normalizeArtistMixScope(data.library_mix.scope)) !== JSON.stringify(artistScope))
    || (!artistLovedDescriptor && (data.library_mix.provider !== 'lastfm' || data.library_mix.metric !== 'overall_scrobbles'))
    || !recipe || JSON.stringify(recipe) !== JSON.stringify(requested)
    || !Array.isArray(data.entries) || data.entries.length > 5000) throw new TypeError('The library mix source was not acknowledged.');
  const refs = data.entries.map(row => row?.entry_ref);
  if (refs.some(ref => !uuid(ref)) || new Set(refs).size !== refs.length
    || data.entries.some(row => !granted(row, 'can_read') || !granted(row, 'can_select'))) throw new TypeError('Invalid library mix membership.');
  const projection = normalizePlaylistPayload({playlist_sidebar: {items: []}, playlist_detail: {
    playlist_id: data.source.ref, revision: data.source.revision, title: artistLovedDescriptor ? 'Loved and Obsessed' : artistScope ? 'Popular Artist tracks' : 'Library Mix', description: '',
    ...(artistLovedDescriptor ? {} : {playlist_kind: 'library_mix'}), items_complete: true, active_sort: {key: 'playlist_position', direction: 'asc'},
    allowed_actions: {can_open: true, can_play: granted(data, 'can_play')},
    track_rows: data.entries.map((row, index) => ({...row, playlist_item_id: row.entry_ref,
      playlist_position: index, source_readable: true, allowed_actions: {can_play: granted(row, 'can_play')},
      album_ref: row.parent_album?.album_ref ?? row.album_ref})),
  }});
  const coverage = artistLovedDescriptor ? frozen({}) : normalizeMixCoverage(data.coverage);
  if (coverage.selected_count !== undefined && coverage.selected_count !== refs.length) throw new TypeError('Invalid library mix coverage.');
  return frozen({source: frozen({...data.source}), source_protocol:data.source_protocol, artistScope, artistLovedDescriptor, recipe, detail: artistLovedDescriptor
      ? frozen({...projection.detail, playlist_kind: 'artist_loved', artist_loved: recipe}) : projection.detail,
    entry_refs: frozen(refs), coverage, popularityRefreshStatus: artistLovedDescriptor ? null : mixRefreshStatus(data.popularity_refresh_status),
    popularityRefreshError: artistLovedDescriptor ? null : mixRefreshError(data.popularity_refresh_error), expires_at: data.expires_at});
}

export function createLibraryMixController({providers, scopeKey, isCurrent, requestKey = () => crypto.randomUUID(), artistScope: requestedScope = null, artistLovedDescriptor: requestedLoved = null}) {
  const artistLovedDescriptor = requestedLoved === null ? null : normalizeArtistLovedDescriptor(requestedLoved);
  if (requestedLoved !== null && (!artistLovedDescriptor || requestedScope !== null)) throw new TypeError('Invalid Loved selection.');
  const artistScope = requestedScope === null ? null : normalizeArtistMixScope(requestedScope);
  if (requestedScope !== null && !artistScope) throw new TypeError('Invalid Artist selection.');
  let disposed = false, epoch = 0, request = null, source = null;
  let lovedSaveKey = null, lovedSaveUncertain = false;
  const listeners = new Set();
  let state = frozen({scopeKey, selectedPlaylistId: null, resource: frozen({status: 'unavailable', data: null}),
    drafts: frozen({}), filters: frozen({}), mutation: frozen({status: 'idle'}), title: artistLovedDescriptor ? 'Loved and Obsessed' : artistScope ? 'Popular Artist tracks' : 'Library Mix', description: '',
    artistScope, artistLovedDescriptor, recipe: null, playbackOrder: 'regular', coverage: frozen({}), dirty: false});
  const alive = () => !disposed && isCurrent() === true;
  const publish = patch => {state = frozen({...state, ...patch}); for (const listener of [...listeners]) listener();};
  const owns = token => alive() && token === epoch;
  const retireRequest = () => {epoch++; request?.abort(); request = null;};
  const busy = () => ['loading', 'ready'].includes(state.mutation.status);
  const canEdit = () => alive() && !busy() && !lovedSaveUncertain && providers.hasPendingPlaylistOperation?.({scopeKey, action: 'create'}) !== true;
  const currentSource = () => alive() && source && state.resource.status === 'ready';
  const api = {
    subscribe(listener) {listeners.add(listener); return () => listeners.delete(listener);},
    getSnapshot: () => state,
    source: () => currentSource() ? source : null,
    reorder: () => false,
    async prepare(value) {
      const recipe = artistLovedDescriptor ? normalizeArtistLovedRecipe({...artistLovedDescriptor, source: 'artist_loved', auto_update: true, playback_order: 'regular'}) : normalizeMixRecipe(value);
      if (artistLovedDescriptor && state.resource.status !== 'unavailable') return false;
      if (!alive() || !recipe || busy() || (artistScope && !canEdit()) || state.resource.status === 'loading' || typeof (artistLovedDescriptor ? providers.beginArtistLoved : artistScope ? providers.beginArtistMix : providers.beginLibraryMix) !== 'function') return false;
      const previous = artistScope ? source : null, previousState = state;
      retireRequest(); const token = epoch; request = new AbortController(); source = null;
      publish({resource: frozen({status: 'loading', data: null}), selectedPlaylistId: null, recipe,
        playbackOrder: recipe.playback_order, coverage: frozen({})});
      if (!owns(token)) return false;
      try {
        const result = await (artistLovedDescriptor ? providers.beginArtistLoved({descriptor: artistLovedDescriptor, scopeKey, signal: request.signal}) : artistScope
          ? previous ? providers.regenerateArtistMix({scopeKey, source:previous.source, recipe, signal:request.signal})
            : providers.beginArtistMix({scopeKey, artistScope, recipe, signal:request.signal})
          : providers.beginLibraryMix({scopeKey, recipe, signal:request.signal}));
        if (!owns(token)) return false;
        source = projectMix(result, scopeKey, recipe, artistScope, artistLovedDescriptor);
        publish({resource: frozen({status: 'ready', data: frozen({detail: source.detail, items: []})}),
          selectedPlaylistId: source.source.ref, coverage: source.coverage, popularityRefreshStatus: source.popularityRefreshStatus,
          popularityRefreshError: source.popularityRefreshError, selectionError: false, dirty: true});
        return owns(token);
      } catch (error) {
        if (owns(token) && error?.name !== 'AbortError') {
          if (previous && ![401,403,404,409,410].includes(error?.status)) {
            // Restore only the captured selection; metadata remains editable while
            // regeneration is pending and must not roll back with its receipt.
            const {title, description, playbackOrder, dirty} = state;
            source=previous;
            publish({...previousState, title, description, playbackOrder, dirty, selectionError:true});
          }
          else publish({resource: frozen({status: [401, 403].includes(error?.status) ? 'denied' : 'error', data: null})});
        }
        return false;
      }
    },
    edit(patch) {
      if (!canEdit() || !record(patch)) return false;
      const changes = {};
      if (Object.hasOwn(patch, 'title') && typeof patch.title === 'string' && patch.title.length <= 100) changes.title = patch.title;
      if (Object.hasOwn(patch, 'description') && typeof patch.description === 'string' && patch.description.length <= 1000) changes.description = patch.description;
      if (!Object.keys(changes).length) return false;
      publish({...changes, dirty: true}); return true;
    },
    setOrder(order) {
      if (!canEdit() || !mixOrder(order)) return false;
      publish({playbackOrder: order, dirty: true}); return true;
    },
    canSave() {return Boolean(currentSource() && canEdit() && state.title.trim() && typeof providers.createPlaylistFromSelection === 'function');},
    async save() {
      if (!api.canSave()) return false;
      retireRequest(); const token = epoch, retained = source; request = new AbortController();
      const options = {scopeKey, source_protocol: retained.source_protocol, mode: 'ordinary', source: retained.source,
        title: state.title.trim(), description: state.description, entry_refs: [...retained.entry_refs],
        mix_playback_order: state.playbackOrder, request_key: requestKey(), signal: request.signal};
      if (artistLovedDescriptor) {lovedSaveKey = options.request_key; lovedSaveUncertain = true;}
      publish({mutation: frozen({status: 'loading', action: 'create'})});
      if (!owns(token)) return false;
      try {
        const response = await providers.createPlaylistFromSelection(options);
        if (!owns(token) || source !== retained) return false;
        const receipt = response?.status === 'ready' ? response.data : null;
        if (!receipt || receipt.scopeKey !== scopeKey || receipt.request_key !== options.request_key || !uuid(receipt.playlist_id)
          || artistLovedDescriptor && (!['created', 'existing'].includes(receipt.creation_outcome) || !uuid(receipt.request_key)
            || lovedSaveKey !== null && receipt.request_key !== lovedSaveKey)) throw new TypeError('Library mix save was not acknowledged.');
        lovedSaveUncertain = false;
        publish({mutation: frozen({status: 'ready', action: 'create', data: receipt}), dirty: false});
        return owns(token) ? receipt : false;
      } catch (error) {
        if (artistLovedDescriptor && error?.responseRejected === true && typeof error.status === 'number' && error.status < 500) lovedSaveUncertain = false;
        if (owns(token) && error?.name !== 'AbortError') publish({mutation: frozen({status: [401, 403].includes(error?.status) ? 'denied' : 'error', action: 'create'})});
        return false;
      }
    },
    async retrySave() {
      if (!alive() || busy() || (!lovedSaveUncertain && providers.hasPendingPlaylistOperation?.({scopeKey, action: 'create'}) !== true)
        || typeof providers.retryPlaylistOperation !== 'function') return false;
      const token = ++epoch;
      publish({mutation: frozen({status: 'loading', action: 'create'})});
      if (!owns(token)) return false;
      try {
        const response = await providers.retryPlaylistOperation({scopeKey, action: 'create', ...(artistLovedDescriptor && lovedSaveKey ? {request_key: lovedSaveKey} : {})});
        if (!owns(token)) return false;
        const receipt = response?.status === 'ready' ? response.data : null;
        if (!receipt || receipt.scopeKey !== scopeKey || !uuid(receipt.playlist_id)
          || artistLovedDescriptor && (!['created', 'existing'].includes(receipt.creation_outcome) || !uuid(receipt.request_key)
            || lovedSaveKey !== null && receipt.request_key !== lovedSaveKey)) throw new TypeError('Library mix save was not acknowledged.');
        lovedSaveUncertain = false;
        publish({mutation: frozen({status: 'ready', action: 'create', data: receipt}), dirty: false});
        return owns(token) ? receipt : false;
      } catch (error) {if (owns(token)) publish({mutation: frozen({status: 'error', action: 'create'})}); return false;}
    },
    pendingSave: () => lovedSaveUncertain || providers.hasPendingPlaylistOperation?.({scopeKey, action: 'create'}) === true,
    dispose() {if (!disposed) {disposed = true; retireRequest(); source = null; listeners.clear();}},
  };
  return frozen(api);
}
