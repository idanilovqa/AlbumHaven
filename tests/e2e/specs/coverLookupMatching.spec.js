import { expect, test } from '../support/baseFixtures.js';

const CASE_ID = 'FTC-COVERS-016';
const TARGET = {
  artist: 'Metallica',
  album: "Kill 'Em All",
  year: '1983',
};
const ALLOWED_MATCH_NAMES = new Set([
  "Kill 'Em All",
  'Kill "Em" All',
  "Kill 'Em All (Deluxe Edition)",
]);
const ALLOWED_MATCH_RESOLUTIONS = new Set([
  '1000x1000',
  '1400x1400',
  '2937x6819',
  '4518x4518',
]);
const FALSE_MATCH_NAMES = [
  'Kill "Em" All (feat. Discrepancies) - Single',
  "Kill 'Em All (Featuring Discrepancies)",
  "Kill 'Em All - Remixed",
];
const FALSE_MATCH_RESOLUTIONS = new Set([
  '3000x3000',
  '3200x3200',
  '3400x3400',
  '3600x3600',
  '3800x3800',
  '3900x3900',
  '4000x4000',
  '4100x4100',
  '4200x4200',
]);
const FALSE_ARTIST_IDENTITIES = [
  'Metallica feat. Discrepancies',
  'Metallica & Discrepancies',
  'Metallica Orchestra',
  'Metallica Experience',
  'The Metallica Project',
];
const EXPECTED_PROVIDER_ROLES = [
  'base',
  'deluxe',
  'false-single-feature',
  'false-tribute-artist',
  'false-remix',
  'false-album-identity-featuring',
  'false-other-band',
  'false-artist-identity-featured',
  'false-artist-identity-collaboration',
  'false-artist-identity-orchestra',
  'false-artist-identity-experience',
  'false-artist-identity-project',
];

test(`${CASE_ID} lookup matching rejects larger false Metallica releases before provider autoselection`, async ({
  coverLookupActions,
  galleryActions,
  stepLogger,
  thirdPartyRequestEvidence,
  trackModalActions,
}) => {
  let taskTitle = '';
  let baselineLocalCover;
  let baselineFullSizeCover;

  await stepLogger.step('Open the isolated Postgres Metallica album and its Cover Lookup Gallery', async () => {
    await galleryActions.goto();
    await galleryActions.waitForGalleryReady();
    expect(await galleryActions.selectAlbumDetailsByIdentity(TARGET)).toEqual(TARGET);
    expect((await trackModalActions.waitForLoadedSummary()).title)
      .toBe(Object.values(TARGET).join(' - '));
    await trackModalActions.openCoverLookup();
    await coverLookupActions.waitForModalReady();
    taskTitle = await coverLookupActions.readModalSubtitle();
    expect(taskTitle).toBe(Object.values(TARGET).join(' - '));
    baselineLocalCover = await coverLookupActions.readActiveLocalCoverEvidence();
    expect(baselineLocalCover.isActive).toBe(true);
    expect(baselineLocalCover.image.naturalWidth).toBe(480);
    expect(baselineLocalCover.resolution).toBe('7500x7500');
    baselineFullSizeCover = await coverLookupActions.readFullSizeCoverEvidence({
      source: baselineLocalCover.fullSizeSource,
      label: 'baseline active local cover',
    });
  });

  await stepLogger.step('Run normal lookup against the deterministic mismatch provider result set', async () => {
    const fixtureMode = await coverLookupActions.setProviderFixtureMode('metallica-mismatch');
    expect(fixtureMode.mode).toBe('metallica-mismatch');
    await coverLookupActions.startSearch();
    await coverLookupActions.closeModal();
    await trackModalActions.close();
    await coverLookupActions.waitForDrawerBadgeCountAtLeast(1);
    await coverLookupActions.openDrawer();
    await coverLookupActions.waitForTaskStatus(taskTitle, 'Completed');
    await coverLookupActions.openTask(taskTitle);
    await coverLookupActions.waitForModalResultsReady();
  });

  await stepLogger.step('Require provider filtering to prefer only the base or legitimate deluxe release', async () => {
    const providerEvidence = await coverLookupActions.readProviderFixtureEvidence();
    expect(providerEvidence.mode).toBe('metallica-mismatch');
    expect(providerEvidence.fixture_candidate_roles).toEqual(EXPECTED_PROVIDER_ROLES);
    expect(providerEvidence.fixture_candidate_artists)
      .toEqual(expect.arrayContaining(FALSE_ARTIST_IDENTITIES));
    expect(providerEvidence.fixture_original_source_sha256).toBe(
      baselineFullSizeCover.sha256.toLowerCase(),
    );

    const candidates = await coverLookupActions.readRemoteCandidateSummaries();
    const appleCandidates = candidates.filter(
      (candidate) => candidate.source.toLowerCase().includes('apple'),
    );
    expect(candidates.length).toBeGreaterThan(0);
    expect(appleCandidates).toHaveLength(1);
    expect(ALLOWED_MATCH_NAMES.has(appleCandidates[0].name)).toBe(true);
    expect(candidates.every((candidate) => ALLOWED_MATCH_NAMES.has(candidate.name))).toBe(true);
    expect(candidates.every((candidate) => ALLOWED_MATCH_RESOLUTIONS.has(candidate.resolution)))
      .toBe(true);
    expect(candidates.map((candidate) => candidate.name))
      .toEqual(expect.arrayContaining([expect.stringMatching(/Kill (?:(?:"Em")|'Em) All/)]));
    expect(candidates.some((candidate) => FALSE_MATCH_NAMES.includes(candidate.name))).toBe(false);
    expect(candidates.some((candidate) => candidate.name.includes('Tribute'))).toBe(false);
    expect(candidates.some((candidate) => FALSE_MATCH_RESOLUTIONS.has(candidate.resolution)))
      .toBe(false);
    const selectedCandidates = candidates.filter((candidate) => candidate.selected);
    expect(selectedCandidates).toHaveLength(0);
    const preservedLocalCover = await coverLookupActions.readActiveLocalCoverEvidence();
    expect(preservedLocalCover.isActive).toBe(true);
    expect(preservedLocalCover.sourcePath).toBe(baselineLocalCover.sourcePath);
    expect(preservedLocalCover.image.naturalWidth).toBe(480);
    expect(preservedLocalCover.resolution).toBe('7500x7500');
    const preservedFullSizeCover = await coverLookupActions.readFullSizeCoverEvidence({
      source: preservedLocalCover.fullSizeSource,
      label: 'preserved active local cover',
    });
    expect(preservedFullSizeCover.sha256).toBe(baselineFullSizeCover.sha256);
    expect(thirdPartyRequestEvidence.snapshot()).toEqual([]);
  });
});
