'use strict';
// Transport-only doubles for the real existing Sample controller/native owner.
const F = require('./sample-native-fixtures.cjs');
const targets = (count = 30) => Array.from({length: count}, (_, n) => ({
  track_ref: `inventory-track:5:${n + 1}`, primary_artist_ref: 'musicbrainz-artist:' + F.id(n + 1)}));
function discovery(input, patch = {}) {
  const field = name => ({status: 'ready',
    choices: name === 'styles' ? [{identity: 'genre-tag:Rock', label: 'Rock'}] :
      [{identity: 'musicbrainz-country:GB', label: 'GB'}],
    coverage: {candidate_count: 30, known: 30, unknown: 0, unresolved: 0},
    error: null, enrichment_targets: name === 'countries' ? targets() : []});
  return {status: 'ready', data: {scopeKey: input.scopeKey, selection_method: input.selectionMethod,
    facets: Object.fromEntries(input.facets.map(name => [name, field(name)])),
    allowed_actions: {enrich_country: input.facets.includes('countries')}, ...patch}};
}
function acquired(input, statuses = []) {
  return {status: 'ready', data: {scopeKey: input.scopeKey, selection_method: input.selectionMethod,
    results: input.targets.map((pair, i) => ({...pair, status: statuses[i] || 'stored_known'}))}};
}
async function facetFixture({discover, acquire, providers = {}, extra = {}} = {}) {
  const facetCalls = {discovery: [], acquisition: []}; let facetActive = true;
  const h = await F.controllerFixture({
    readSamplePlaylistFacets: async input => {
      facetCalls.discovery.push(input); return discover ? discover(input) : discovery(input);
    },
    enrichSamplePlaylistCountryMetadata: async input => {
      facetCalls.acquisition.push(input); return acquire ? acquire(input) : acquired(input);
    }, ...providers}, {isFacetActive: () => facetActive, ...extra});
  const input = (patch = {}) => ({source: F.parent(), selectionMethod: 'random',
    facets: ['styles', 'countries'], ...patch});
  return {...h, facetCalls, discoveryInput: input, discover: (patch = {}) => h.controller.discoverFacets(input(patch)),
    suspendFacets() {facetActive = false;}, resumeFacets() {facetActive = true;}};
}
module.exports = {...F, targets, discovery, acquired, facetFixture};
