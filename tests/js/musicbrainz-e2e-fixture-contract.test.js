const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..', '..');
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

test('renamed MusicBrainz cases use artists present in the v1.0.30 projection', () => {
  const fixture = read('tests/e2e/helpers/musicbrainzIdentityFixture.js');

  assert.doesNotMatch(fixture, /Functional Balance Artist 0[5-9]/);
  for (const source of ['Solo Voice', 'Onségen Ensemble', 'Flaming Row', '東京事変', 'Борис']) {
    assert.match(fixture, new RegExp(`rename(?:dMatchedArtist)?\\('${source}'|ratingMismatch\\('${source}'|providerUnavailableArtist\\('${source}'`));
  }
});

test('person-and-band identities use albums owned by the matched local artist', () => {
  const fixture = read('tests/e2e/helpers/musicbrainzIdentityFixture.js');

  assert.match(fixture, /kind: 'Person', albums: \['Control Lead Solo'\]/);
  assert.match(fixture, /disambiguation: 'the band', albums: \['Functional Fixture Album 266'\]/);
  assert.doesNotMatch(fixture, /disambiguation: 'the band', albums: \['Non-Compilation Cross-Credits'\]/);
});

test('rating mismatch fixtures use the album library owner account', () => {
  const fixture = read('tests/e2e/helpers/musicbrainzIdentityFixture.js');
  const ratingMismatch = fixture.slice(
    fixture.indexOf('async ratingMismatch('),
    fixture.indexOf('async assignAlbums('),
  );

  assert.match(
    ratingMismatch,
    /select owner_account_id from library\.libraries\s+where id = \$\{album\.library\}/,
  );
  assert.doesNotMatch(ratingMismatch, /library\.library_memberships/);
});

test('rating mismatch cases own unlinked one-album fixture sources', () => {
  const fixture = read('tests/e2e/helpers/musicbrainzIdentityFixture.js');

  assert.match(
    fixture,
    /ratingMismatch\('東京事変', 'Arcade Fire', 'Reflektor', 6, 7\)/,
  );
  assert.match(
    fixture,
    /ratingMismatch\('Борис', 'Orphaned Land', 'Mabool: the Story of the Three Sons of Seven', 10, 5\)/,
  );
  assert.doesNotMatch(fixture, /ratingMismatch\('The (?:Flower Kings|Neal Morse Band)'/);
});

test('MusicBrainz UI mutation candidates are backed by the provider fixture', () => {
  const provider = read('tests/e2e/support/isolatedLibraryApp.py');
  const assignedArtists = [
    ['0e2e0001-0000-4000-8000-000000000003', 'Compilation Signal Lead'],
    ['0e2e0001-0000-4000-8000-000000000010', 'Compilation Signal Guest South'],
    ['0e2e0001-0000-4000-8000-000000000018', 'Control Signal Partner'],
  ];

  for (const [mbid, name] of assignedArtists) {
    assert.match(
      provider,
      new RegExp(`"${mbid}": \\("${name}", "[A-Z]{2}"\\)`),
      `${name} must survive the API's provider revalidation before assignment`,
    );
  }
});

test('renamed fixture albums carry the intended file tag artist', () => {
  const fixture = read('tests/e2e/helpers/musicbrainzIdentityFixture.js');

  assert.match(
    fixture,
    /update library\.local_albums set title = \$\{literal\(albumName\)\}, metadata = metadata\s*\|\| jsonb_build_object\('album_artist', \$\{literal\(artistName\)\}\)/,
  );
});

test('renamed matched albums seed the MusicBrainz identity used by Album Details', () => {
  const fixture = read('tests/e2e/helpers/musicbrainzIdentityFixture.js');
  const renamedStart = fixture.indexOf('async renamedMatchedArtist');
  const renamed = fixture.slice(renamedStart, fixture.indexOf('async providerUnavailableArtist', renamedStart));
  const assignStart = fixture.indexOf('async assignAlbums');
  const assign = fixture.slice(assignStart, fixture.indexOf('async unconfirmedArtist', assignStart));

  assert.ok(renamedStart >= 0);
  assert.match(renamed, /const artist = await renameArtistAlbum\(sourceArtist, name, album\)/);
  assert.match(renamed, /this\.assignAlbums\(artist, \[\{ \.\.\.musicbrainz, albums: \[album\], tagDiffers: musicbrainz\.name !== name \}\]\)/);
  assert.match(assign, /owner\.tagDiffers \? 'true' : 'false'/);
});

test('the provider-outage fixture survives startup until the owner retries it', () => {
  const fixture = read('tests/e2e/helpers/musicbrainzIdentityFixture.js');
  const start = fixture.indexOf('async providerUnavailableArtist');
  const providerOutage = fixture.slice(start, fixture.indexOf('async ratingMismatch', start));

  assert.ok(start >= 0);
  assert.match(providerOutage, /matcherVersion: PINNED_MATCHER_VERSION/);
  assert.match(providerOutage, /last_verified_at = now\(\)/);
});

test('the links case opens the artist that owns the zero-vote Discogs fixture', () => {
  const spec = read('tests/e2e/specs/musicbrainzArtistIdentity.spec.js');
  const start = spec.indexOf('MBD1-19:');
  const step = spec.slice(start, spec.indexOf('MBD1-38:', start));

  assert.ok(start >= 0);
  assert.match(step, /openArtist\(\{ galleryActions, searchToolbarActions \}, ZERO_VOTE\)/);
  assert.match(step, /MBID\.zeroVote/);
});

test('the Shamaani Duo album assertion locates the canonical Korpiklaani heading', () => {
  const spec = read('tests/e2e/specs/musicbrainzArtistIdentity.spec.js');
  const start = spec.indexOf('MBD1-40:');
  const step = spec.slice(start, spec.indexOf('FTC-MBID-002', start));

  assert.match(step, /albumDetailsTags\(\{ galleryActions, trackModalActions \}, 'Korpiklaani', 'Hunka lunka'\)/);
  assert.match(step, /toContain\('Tagged as Shamaani Duo'\)/);
});

test('the held hydration case uses the scrollable compilation artist fixture', () => {
  const fixture = read('tests/e2e/helpers/musicbrainzIdentityFixture.js');
  const spec = read('tests/e2e/specs/musicbrainzArtistIdentity.spec.js');

  assert.match(
    fixture,
    /hydrationArtist\('Compilation Signal Guest', 'Compilation Signal Guest', 'Compilation Guest Solo'/,
  );
  assert.match(fixture, /queueJob\(artist, \{ reason: 'stale_refresh', priority: 100 \}\)/);
  assert.match(spec, /const HYDRATING = 'Compilation Signal Guest';/);
});

test('the held hydration artist carries the provider MBID through the resolver hint path', () => {
  const fixture = read('tests/e2e/helpers/musicbrainzIdentityFixture.js');
  const start = fixture.indexOf('async hydrationArtist');
  const hydration = fixture.slice(start, fixture.indexOf('async renamedMatchedArtist', start));

  assert.ok(start >= 0);
  assert.match(hydration, /update library\.local_artists set mbid = '\$\{musicbrainz\.mbid\}' where id = \$\{artist\.artist\}/);
});

test('the person-and-band case asserts the exact family context title', () => {
  const spec = read('tests/e2e/specs/musicbrainzArtistIdentity.spec.js');
  const start = spec.indexOf('Delivery 1.1:');
  const step = spec.slice(start, spec.indexOf("MBD1-11:", start));

  assert.ok(start >= 0);
  assert.match(
    step,
    /openArtist\(\{ galleryActions, searchToolbarActions \}, PERSON_BAND, `\$\{PERSON_BAND\} family`\)/,
  );
  assert.match(step, /openArtistInfoPanel\(PERSON_BAND\)/);
  assert.match(
    step,
    /albumDetailsTags\(\{ galleryActions, trackModalActions \}, 'Control Signal Lead \/ Control Signal Partner', 'Non-Compilation Cross-Credits'\)/,
  );
});

test('metadata-conflict assignment keeps the exact family context title across reload', () => {
  const spec = read('tests/e2e/specs/musicbrainzArtistIdentity.spec.js');
  const start = spec.indexOf('MBD1-13: a metadata conflict can assign');
  const step = spec.slice(start, spec.indexOf('MBD1-14, MBD1-39:', start));
  const familyContextCalls = step.match(
    /openArtist\(\{ galleryActions, searchToolbarActions \}, CONFLICT_ASSIGN, `\$\{CONFLICT_ASSIGN\} family`\)/g,
  ) || [];

  assert.ok(start >= 0);
  assert.equal(familyContextCalls.length, 2);
});

test('metadata-conflict persistence is asserted on the family member information surface', () => {
  const spec = read('tests/e2e/specs/musicbrainzArtistIdentity.spec.js');
  const start = spec.indexOf('MBD1-13: a metadata conflict can assign');
  const step = spec.slice(start, spec.indexOf('MBD1-14, MBD1-39:', start));

  assert.ok(start >= 0);
  assert.match(step, /page\.reload\(\)[\s\S]*openArtistInfoPanel\(CONFLICT_ASSIGN\)/);
  assert.match(step, /heading: CONFLICT_ASSIGN/);
  assert.match(step, /countries: \['Finland'\]/);
  assert.match(step, /genres: \['Genre unavailable'\]/);
  assert.match(step, /musicbrainz\.org\/artist\/\$\{MBID\.conflictAssign\}/);
  assert.doesNotMatch(step, /readArtistContextMetadata/);
});

test('artist information actions can target a member header inside family results', () => {
  const actions = read('tests/e2e/actions/galleryActions.js');
  const start = actions.indexOf('async openArtistInfoPanel');
  const method = actions.slice(start, actions.indexOf('async readArtistInfoSnapshot', start));

  assert.ok(start >= 0);
  assert.match(method, /familyArtistInfoTrigger\(artist\)/);
});

test('the held provider is released when the hydration assertion fails', () => {
  const spec = read('tests/e2e/specs/musicbrainzArtistIdentity.spec.js');
  const start = spec.indexOf('MBD1-04:');
  const step = spec.slice(start, spec.indexOf('MBD1-06:', start));

  assert.match(step, /let hydrationReleased = false;/);
  assert.match(step, /finally \{\s*if \(!hydrationReleased\) await releaseMusicBrainzHydration\(testInfo\);/);
});

test('the held provider returns ranked MusicBrainz genres, not non-display tags', () => {
  const provider = read('tests/e2e/support/isolatedLibraryApp.py');
  const handler = provider.slice(provider.indexOf('def _serve_musicbrainz_artist'));

  assert.match(handler, /"genres": genres/);
  assert.match(handler, /"tags": \[\]/);
});

test('MusicBrainz composite cases use pre-start fixture data and only mutate identities through the UI', () => {
  const spec = read('tests/e2e/specs/musicbrainzArtistIdentity.spec.js');
  const fixture = read('tests/e2e/helpers/musicbrainzIdentityFixture.js');

  assert.doesNotMatch(spec, /fixture\.(?:restore|matchArtist|splitArtist|personWithBand|notFoundArtist|multipleArtist|conflictArtist|unconfirmedArtist)/);
  assert.match(spec, /fixture\.readStoredArtist/);
  assert.match(fixture, /--case=/);
  assert.match(fixture, /FTC-MBID-001/);
  assert.match(fixture, /FTC-MBID-002/);
  assert.match(fixture, /FTC-MBID-003/);
  assert.match(spec, /assignSelectedMusicBrainzIdentity/);
  assert.match(spec, /keepCurrentMusicBrainzIdentity/);
});

test('MusicBrainz owner-registry contracts are mapped to the existing three composite cases', () => {
  const matrix = JSON.parse(read('tests/ci/test-data-matrix.json'));
  const byId = new Map(matrix.filter((row) => row.case.startsWith('FTC-MBID-'))
    .map((row) => [row.case.slice(0, 12), row]));

  assert.ok(byId.get('FTC-MBID-001').expectedContracts.includes('mbd1-04-header-info-hydration-race'));
  assert.ok(byId.get('FTC-MBID-001').expectedContracts.includes('mbd1-40-shamaani-duo-korpiklaani'));
  assert.ok(byId.get('FTC-MBID-003').expectedContracts.includes('mbd1-14-provider-outage-retry-timing'));
  assert.ok(byId.get('FTC-MBID-003').expectedContracts.includes('mbd1-39-resolved-row-disappears'));
  assert.ok(byId.get('FTC-MBID-003').expectedContracts.includes('mbd1-43-file-rating-mismatch-no-mutation'));
});

test('the header race holds provider hydration, opens info first, then releases and verifies the populated panel', () => {
  const spec = read('tests/e2e/specs/musicbrainzArtistIdentity.spec.js');
  const start = spec.indexOf('MBD1-04:');
  const end = spec.indexOf('MBD1-06:', start);
  const step = spec.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(step, /waitForMusicBrainzHydrationRequest/);
  assert.match(step, /openArtistInfoPanel/);
  assert.ok(step.indexOf('openArtistInfoPanel') < step.indexOf('releaseMusicBrainzHydration'));
  assert.match(step, /releaseMusicBrainzHydration/);
  assert.match(step, /readArtistInfoSnapshot/);
});

test('MusicBrainz fixtures enable the worker required by hydration and retry cases', () => {
  assert.match(read('config.py'), /MUSICBRAINZ_ENRICHMENT_WORKER_ENABLED/);
  assert.match(read('music_app/services/musicbrainz_enrichment_worker.py'), /MUSICBRAINZ_ENRICHMENT_WORKER_ENABLED/);
  assert.match(read('scripts/ci/validate-functional-shards.cjs'), /childEnv\.MUSICBRAINZ_ENRICHMENT_WORKER_ENABLED = '1'/);
  assert.match(read('tests/py/test_config.py'), /test_musicbrainz_enrichment_worker_enabled_defaults_and_overrides/);
  assert.match(read('tests/py/test_musicbrainz_enrichment_worker.py'), /test_runtime_worker_can_be_disabled_without_disabling_management_api/);
});

test('native-script cases prove the Latin aliases persisted without rendering them as headings', () => {
  const fixture = read('tests/e2e/helpers/musicbrainzIdentityFixture.js');
  const spec = read('tests/e2e/specs/musicbrainzArtistIdentity.spec.js');
  const start = spec.indexOf('MBD1-07:');
  const step = spec.slice(start, spec.indexOf('MBD1-04:', start));

  assert.match(fixture, /async readStoredArtist\(mbid\)/);
  assert.match(step, /readStoredArtist\(nativeCase\.mbid\)/);
  assert.match(step, /aliases: \[nativeCase\.latin\]/);
  assert.match(step, /canonicalName: nativeCase\.name/);
  assert.match(step, /nativeName: nativeCase\.name/);
  assert.match(step, /sortName: nativeCase\.latin/);
});

test('provider retry clears the outage filter before asserting global row removal', () => {
  const spec = read('tests/e2e/specs/musicbrainzArtistIdentity.spec.js');
  const start = spec.indexOf('MBD1-14, MBD1-39:');
  const step = spec.slice(start, spec.indexOf('MBD1-39: a manually resolved', start));
  const clearIndex = step.indexOf("clearProblemFilter('MusicBrainz: Provider unavailable')");
  const searchIndex = step.indexOf('search(OUTAGE)');

  assert.ok(clearIndex >= 0);
  assert.ok(searchIndex > clearIndex);
});
