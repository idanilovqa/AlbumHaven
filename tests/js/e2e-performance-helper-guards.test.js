const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const repoRoot = path.resolve(__dirname, '..', '..');

function readRepoFile(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function readExportedFunction(source, signature, nextSignature) {
  const start = source.indexOf(signature);
  const end = source.indexOf(nextSignature, start + signature.length);
  assert.notEqual(start, -1, `Expected ${signature} to exist.`);
  assert.notEqual(end, -1, `Expected ${nextSignature} to follow ${signature}.`);
  return source.slice(start, end);
}

test('playback evidence requires exact-track rendered samples instead of decoder ingress', async () => {
  const helperUrl = pathToFileURL(
    path.join(repoRoot, 'tests/e2e/helpers/gaplessPlaybackHelpers.js'),
  ).href;
  const { summarizeTrackPlaybackEvidence } = await import(helperUrl);
  const evidence = summarizeTrackPlaybackEvidence({
    after: {
      eventIndex: 0,
      generation: 2,
      path: 'C:/Music/previous.flac',
      renderedFrame: 256,
      streamId: 7,
    },
    events: [
      {
        direction: 'sent', type: 'open', path: 'C:/Music/track.flac',
        generation: 7, streamId: 19, role: 'current',
      },
      {
        direction: 'received', type: 'pcm', generation: 7, streamId: 19,
        frameCount: 2, finiteSamples: 4, nonZeroSamples: 4, peakSample: 0.75,
        samples: [0.25, -0.25, 0.75, -0.75],
      },
    ],
    path: 'C:/Music/track.flac',
    renderer: {
      currentStreamId: 19,
      generation: 7,
      renderedFrame: 384,
      firstFrameAtMs: 12,
      pcmEvidence: {
        finiteSamples: 4, frames: 2, generation: 7, nonZeroSamples: 4,
        peakSample: 0.75, samples: [0.25, -0.25, 0.75, -0.75], streamId: 19,
      },
    },
  });

  assert.equal(evidence.path, 'C:/Music/track.flac');
  assert.equal(evidence.streamId, 19);
  assert.equal(evidence.generation, 7);
  assert.equal(evidence.pcmFrames, 2);
  assert.equal(evidence.finiteSamples, 4);
  assert.equal(evidence.nonZeroSamples, 4);
  assert.equal(evidence.peakSample, 0.75);
  assert.equal(evidence.renderedFrameDelta, 384);
  assert.deepEqual(evidence.samples, [0.25, -0.25, 0.75, -0.75]);
});

test('playback evidence reuses verified buffered samples but requires new rendered progress', async () => {
  const helperUrl = pathToFileURL(
    path.join(repoRoot, 'tests/e2e/helpers/gaplessPlaybackHelpers.js'),
  ).href;
  const { summarizeTrackPlaybackEvidence } = await import(helperUrl);
  const evidence = summarizeTrackPlaybackEvidence({
    after: {
      eventIndex: 5,
      finiteSamples: 8,
      generation: 3,
      nonZeroSamples: 6,
      path: 'C:/Music/buffered.flac',
      pcmFrames: 4,
      peakSample: 0.8,
      renderedFrame: 1024,
      samples: [0.8, -0.8],
      streamId: 11,
    },
    events: [],
    path: 'C:/Music/buffered.flac',
    renderer: {
      currentStreamId: 11,
      firstFrameAtMs: 10,
      generation: 3,
      path: 'C:/Music/buffered.flac',
      pcmEvidence: {
        finiteSamples: 12, frames: 6, generation: 3, nonZeroSamples: 10,
        peakSample: 0.8, samples: [0.8, -0.8], streamId: 11,
      },
      renderedFrame: 1152,
    },
  });

  assert.equal(evidence.pcmFrames, 2);
  assert.equal(evidence.finiteSamples, 4);
  assert.equal(evidence.nonZeroSamples, 4);
  assert.equal(evidence.peakSample, 0.8);
  assert.equal(evidence.renderedFrameDelta, 128);
  assert.deepEqual(evidence.samples, [0.8, -0.8]);
});

test('playback evidence rejects decoder ingress when rendered samples are absent', async () => {
  const helperUrl = pathToFileURL(
    path.join(repoRoot, 'tests/e2e/helpers/gaplessPlaybackHelpers.js'),
  ).href;
  const { summarizeTrackPlaybackEvidence } = await import(helperUrl);
  const evidence = summarizeTrackPlaybackEvidence({
    after: { eventIndex: 0, renderedFrame: 0 },
    events: [{
      direction: 'received',
      finiteSamples: 256,
      frameCount: 128,
      generation: 4,
      nonZeroSamples: 250,
      peakSample: 0.4,
      role: 'current',
      samples: [0.4, -0.4],
      streamId: 9,
      type: 'pcm',
    }],
    path: 'C:/Music/current.flac',
    renderer: {
      currentStreamId: 9,
      firstFrameAtMs: 20,
      generation: 4,
      path: 'C:/Music/current.flac',
      renderedFrame: 128,
    },
  });

  assert.equal(evidence.generation, 4);
  assert.equal(evidence.streamId, 9);
  assert.equal(evidence.pcmFrames, 0);
  assert.equal(evidence.nonZeroSamples, 0);
  assert.equal(evidence.renderedFrameDelta, 128);
});

test('playback evidence accepts bounded production PCM diagnostics when decoder delivery preceded observation', async () => {
  const helperUrl = pathToFileURL(
    path.join(repoRoot, 'tests/e2e/helpers/gaplessPlaybackHelpers.js'),
  ).href;
  const { summarizeTrackPlaybackEvidence } = await import(helperUrl);
  const evidence = summarizeTrackPlaybackEvidence({
    after: { eventIndex: 0, renderedFrame: 0 },
    events: [],
    path: 'C:/Music/burst.flac',
    renderer: {
      currentStreamId: 14,
      firstFrameAtMs: 30,
      generation: 6,
      path: 'C:/Music/burst.flac',
      pcmEvidence: {
        finiteSamples: 96000,
        frames: 48000,
        generation: 6,
        nonZeroSamples: 95980,
        peakSample: 0.7,
        samples: [0.7, -0.7],
        streamId: 14,
      },
      renderedFrame: 256,
    },
  });

  assert.equal(evidence.pcmFrames, 48000);
  assert.equal(evidence.finiteSamples, 96000);
  assert.equal(evidence.nonZeroSamples, 95980);
  assert.equal(evidence.peakSample, 0.7);
  assert.equal(evidence.renderedFrameDelta, 256);
});

test('playback evidence rejects silent rendered output despite non-silent decoder ingress', async () => {
  const helperUrl = pathToFileURL(
    path.join(repoRoot, 'tests/e2e/helpers/gaplessPlaybackHelpers.js'),
  ).href;
  const { summarizeTrackPlaybackEvidence } = await import(helperUrl);
  const evidence = summarizeTrackPlaybackEvidence({
    after: { eventIndex: 0, renderedFrame: 0 },
    events: [{
      direction: 'received', finiteSamples: 512, frameCount: 256, generation: 9,
      nonZeroSamples: 500, peakSample: 0.7, samples: [0.7, -0.7], streamId: 31,
      type: 'pcm',
    }],
    path: 'C:/Music/silent-output.flac',
    renderer: {
      currentStreamId: 31, firstFrameAtMs: 60, generation: 9,
      path: 'C:/Music/silent-output.flac', renderedFrame: 256,
      pcmEvidence: {
        finiteSamples: 512, frames: 256, generation: 9, nonZeroSamples: 0,
        peakSample: 0, samples: [0, 0], streamId: 31,
      },
    },
  });

  assert.equal(evidence.pcmFrames, 256);
  assert.equal(evidence.finiteSamples, 512);
  assert.equal(evidence.nonZeroSamples, 0);
  assert.equal(evidence.peakSample, 0);
  assert.deepEqual(evidence.samples, [0, 0]);
});

test('playback evidence prefers the exact rendered identity over a later same-path continuity open', async () => {
  const helperUrl = pathToFileURL(
    path.join(repoRoot, 'tests/e2e/helpers/gaplessPlaybackHelpers.js'),
  ).href;
  const { summarizeTrackPlaybackEvidence } = await import(helperUrl);
  const evidence = summarizeTrackPlaybackEvidence({
    after: { eventIndex: 0, renderedFrame: 0 },
    events: [{
      direction: 'sent', generation: 8, path: 'C:/Music/reused.flac',
      role: 'continuity', streamId: 22, type: 'open',
    }],
    path: 'C:/Music/reused.flac',
    renderer: {
      currentStreamId: 21,
      firstFrameAtMs: 40,
      generation: 8,
      path: 'C:/Music/reused.flac',
      pcmEvidence: {
        finiteSamples: 512,
        frames: 256,
        generation: 8,
        nonZeroSamples: 500,
        peakSample: 0.6,
        samples: [0.6, -0.6],
        streamId: 21,
      },
      renderedFrame: 256,
    },
  });

  assert.equal(evidence.streamId, 21);
  assert.equal(evidence.pcmFrames, 256);
  assert.equal(evidence.renderedFrameDelta, 256);
});

test('playback evidence checkpoint and baseline share the currentStreamId schema', () => {
  const source = readRepoFile('tests/e2e/helpers/gaplessPlaybackHelpers.js');
  const checkpoint = readExportedFunction(
    source,
    'async function readPlaybackRendererCheckpoint(page) {',
    'export function observePlaybackPcmTraffic(page) {',
  );
  const baseline = readExportedFunction(
    source,
    '    async playbackMark() {',
    '    snapshotSince(mark) {',
  );

  assert.match(checkpoint, /currentStreamId:/);
  assert.match(baseline, /\.\.\.renderer/);
  assert.match(baseline, /renderer\.pcmEvidence\?\.frames/);
  assert.doesNotMatch(checkpoint, /\n\s*streamId:/);
});

test('playback evidence never reuses samples from an older same-path stream', async () => {
  const helperUrl = pathToFileURL(
    path.join(repoRoot, 'tests/e2e/helpers/gaplessPlaybackHelpers.js'),
  ).href;
  const { summarizeTrackPlaybackEvidence } = await import(helperUrl);
  const evidence = summarizeTrackPlaybackEvidence({
    after: {
      eventIndex: 0, finiteSamples: 96000, generation: 4, nonZeroSamples: 90000,
      path: 'C:/Music/replay.flac', pcmFrames: 48000, peakSample: 0.8,
      renderedFrame: 48000, samples: [0.8, -0.8], streamId: 8,
    },
    events: [],
    path: 'C:/Music/replay.flac',
    renderer: {
      currentStreamId: 9, firstFrameAtMs: 50, generation: 5,
      observedAtMs: 75, path: 'C:/Music/replay.flac', renderedFrame: 128,
    },
  });

  assert.equal(evidence.pcmFrames, 0);
  assert.equal(evidence.nonZeroSamples, 0);
  assert.equal(evidence.renderedFrameDelta, 128);
});

test('Utility Loops proves the exact media source decodes to finite non-silent samples', () => {
  const actions = readRepoFile('tests/e2e/actions/utilityLoopsActions.js');
  const pom = readRepoFile('tests/e2e/poms/utilityLoopEntryCard.js');
  const helper = readRepoFile('tests/e2e/helpers/loopPlaybackEvidence.js');
  const decoder = readRepoFile('tests/e2e/support/decode_audio_evidence.py');
  const spec = readRepoFile('tests/e2e/specs/loops.functional.spec.js');

  assert.match(actions, /async readDecodedLoopSampleEvidence\(loopId/);
  assert.doesNotMatch(actions, /\.evaluate\s*\(/);
  assert.doesNotMatch(pom, /decodeAudioData/);
  assert.match(actions, /authenticatedPageGet\(this\.utilityLoopsTab\.page, snapshot\.src\)/);
  assert.match(actions, /decodeAudioSampleEvidence/);
  assert.match(helper, /resolvePlaywrightPython/);
  assert.match(helper, /windowsHide:\s*true/);
  assert.match(decoder, /imageio_ffmpeg\.get_ffmpeg_exe/);
  assert.match(decoder, /finite_samples/);
  assert.match(decoder, /nonzero_samples/);
  assert.match(spec, /readDecodedLoopSampleEvidence/);
  assert.match(spec, /nonZeroSamples\)\.toBeGreaterThan\(0\)/);
});

test('every E2E spec that claims streaming playback requires exact sample evidence', () => {
  const e2eRoot = path.join(repoRoot, 'tests', 'e2e');
  const pendingDirectories = [e2eRoot];
  const playbackSpecs = [];
  while (pendingDirectories.length) {
    const directory = pendingDirectories.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pendingDirectories.push(absolutePath);
      } else if (entry.name.endsWith('.spec.js')) {
        const source = fs.readFileSync(absolutePath, 'utf8');
        if (/\b(?:playTrackAt(?:AndWaitFor\w+)?|playLoopByName|seekToSeconds|waitForCurrentTrack)\s*\(/.test(source)
            || /waitForPlaybackState\s*\(\s*\{[^}]*paused:\s*false/s.test(source)
            || /togglePlaybackWithSpace\s*\(\s*\{\s*paused:\s*false/.test(source)) {
          playbackSpecs.push(path.relative(repoRoot, absolutePath).replaceAll('\\', '/'));
        }
      }
    }
  }
  assert.ok(playbackSpecs.length >= 8, 'Expected the playback-spec inventory to find existing coverage.');

  for (const relativePath of playbackSpecs) {
    const spec = readRepoFile(relativePath);
    assert.match(spec, /playbackEvidence/, `${relativePath} must use the auto playback-evidence fixture.`);
    assert.match(
      spec,
      /waitForTrackPlaybackEvidence/,
      `${relativePath} must resolve exact-track PCM and renderer evidence.`,
    );
    assert.match(spec, /nonZeroSamples/, `${relativePath} must reject silent-only media.`);
    assert.match(spec, /renderedFrameDelta/, `${relativePath} must prove renderer advancement.`);
  }

  const fixtures = readRepoFile('tests/e2e/support/baseFixtures.js');
  assert.match(fixtures, /playbackEvidence: async \(\{ page \}, use\)/);
  assert.match(fixtures, /observePlaybackPcmTraffic\(page\)/);
  assert.match(fixtures, /observer\.stop\(\)/);
});

test('performance response collection propagates JSON parse failures', () => {
  const source = readRepoFile('tests/e2e/helpers/performanceHelpers.js');
  const collector = readExportedFunction(
    source,
    'export async function collectJsonResponsesDuringAction',
    'export function isRootAlbumsViewDataResponse',
  );

  assert.match(collector, /responseJsonPromises\.push\(response\.json\(\)\)/);
  assert.doesNotMatch(collector, /response\.json\(\)\.catch/);
  assert.doesNotMatch(collector, /__response_json_error/);
});

test('Postgres telemetry collection rejects a missing authoritative payload without a first-payload fallback', () => {
  const source = readRepoFile('tests/e2e/helpers/performanceHelpers.js');
  const assertion = readExportedFunction(
    source,
    'export function expectAtLeastOnePostgresLibraryBrowseTelemetryPayload',
    'async function collectGarbage',
  );

  assert.match(assertion, /expect\(\s*authoritativePayload,[\s\S]*?\)\.toBeTruthy\(\)/);
  assert.doesNotMatch(assertion, /return payloads\[0\]/);
  assert.doesNotMatch(assertion, /if \(!authoritativePayload\)/);
});

test('app-open specs share strict production startup-authority evidence', () => {
  const helper = readRepoFile('tests/e2e/helpers/realAppBenchmarkHelpers.js');
  const appOpenSpec = readRepoFile('tests/e2e/syntheticLargeLibrary/appOpenAllArtists.spec.js');
  const rootBrowseSpec = readRepoFile('tests/e2e/syntheticLargeLibrary/rootAlbumBrowse.spec.js');

  assert.match(helper, /export async function collectRootBrowseStartupAuthorityEvidence\(/);
  assert.match(helper, /export function expectRootBrowseStartupAuthorityEvidence\(/);
  assert.match(helper, /response\.request\(\)\.resourceType\(\) === 'document'/);
  assert.match(helper, /parseProductionBootstrapPayload/);
  for (const spec of [appOpenSpec, rootBrowseSpec]) {
    assert.match(spec, /collectRootBrowseStartupAuthorityEvidence\(page,/);
    assert.match(spec, /expectRootBrowseStartupAuthorityEvidence\(startupAuthorityEvidence\)/);
    assert.match(spec, /expectNoUnexpectedRuntimeFailures\(/);
    assert.match(spec, /testArtifacts\.getRuntimeLogs\(\)/);
    assert.doesNotMatch(spec, /if \(startupRootPayloads\.length > 0\)/);
  }
});

test('artist-family benchmark keeps browser mechanics outside the scenario spec', () => {
  const spec = readRepoFile('tests/e2e/syntheticLargeLibrary/artistFamilyResponsiveness.spec.js');
  const artistFamilyActions = readRepoFile('tests/e2e/actions/artistFamilyActions.js');
  const searchToolbarActions = readRepoFile('tests/e2e/actions/searchToolbarActions.js');
  const benchmarkHelpers = readRepoFile('tests/e2e/helpers/realAppBenchmarkHelpers.js');

  assert.doesNotMatch(spec, /\b(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(/);
  assert.doesNotMatch(spec, /page\.(?:addInitScript|locator|waitForFunction)\s*\(/);
  assert.doesNotMatch(spec, /\b(?:localStorage|sessionStorage)\b/);
  assert.match(artistFamilyActions, /async waitForViewReady\(/);
  assert.match(artistFamilyActions, /async waitForPrimaryAndRelatedFilterActive\(/);
  assert.match(searchToolbarActions, /async waitForUrlWithoutQueryParameter\(/);
  assert.match(benchmarkHelpers, /export async function enterAndWaitForPostgresBrowseWarmRoot\(/);
});

test('idle-memory pre-measurement readiness uses the fixture detail-cycle count', () => {
  const spec = readRepoFile('tests/e2e/performance/idleMemory.spec.js');

  assert.match(
    spec,
    /scrollGalleryToMiddle\(\);\s*await galleryActions\.waitForVisibleGalleryCoversLoaded\(\{\s*minimumCount:\s*fixture\.detailModalOpenCount,\s*\}\);/,
  );
  assert.match(
    spec,
    /await trackModalActions\.close\(\);\s*await galleryActions\.waitForVisibleGalleryCoversLoaded\(\{\s*minimumCount:\s*fixture\.detailModalOpenCount,\s*\}\);/,
  );
});

test('utility and cover actions consume POM locators instead of constructing selectors', () => {
  const actionFiles = [
    'coverLookupActions.js',
    'utilityAppearanceActions.js',
    'utilityIntegrationsActions.js',
    'utilityLogHistoryActions.js',
    'utilityLoopsActions.js',
    'utilityProblematicFilesActions.js',
    'utilityRulesActions.js',
  ];

  for (const fileName of actionFiles) {
    const source = readRepoFile(`tests/e2e/actions/${fileName}`);
    assert.doesNotMatch(source, /\.locator\s*\(/, `${fileName} must leave selector ownership in POMs.`);
    assert.doesNotMatch(
      source,
      /querySelector(?:All)?\s*\(\s*(?:['"`]|String\.raw)/,
      `${fileName} must receive browser-polling selectors from POMs.`,
    );
  }

  const coverLookup = readRepoFile('tests/e2e/poms/coverLookup.js');
  const loopEntryCard = readRepoFile('tests/e2e/poms/utilityLoopEntryCard.js');
  const problematicFilesTab = readRepoFile('tests/e2e/poms/utilityProblematicFilesTab.js');
  assert.match(coverLookup, /this\.activeLocalCoverImage\s*=/);
  assert.match(loopEntryCard, /entryByName\(name\)/);
  assert.match(problematicFilesTab, /this\.detailProblemReasons\s*=/);
});

test('Problematic Files network evidence settles readiness and summary together before listener cleanup', () => {
  const source = readRepoFile('tests/e2e/helpers/utilityPerformanceHelpers.js');
  const helper = readExportedFunction(
    source,
    'export async function measureProblematicFilesSettingsOpenWithNetworkEvidence',
    'export async function measureRulesOpen',
  );

  assert.match(helper, /waitForResponse\([\s\S]*?\{ timeout \}\)/);
  assert.match(helper, /await Promise\.allSettled/);
  assert.match(helper, /page\.off\('request', recordDetailRequest\)/);
  assert.doesNotMatch(helper, /await summaryResponsePromise/);
});

test('scan metadata search readiness is one atomic page condition with exact evidence asserted after timing', () => {
  const pom = readRepoFile('tests/e2e/poms/scanPage.js');
  const actions = readRepoFile('tests/e2e/actions/scanPageActions.js');
  const spec = readRepoFile('tests/e2e/scanPerformance/scanPerformance.spec.js');
  const observerStart = pom.indexOf('async waitForSearchReadiness(');
  const observerEnd = pom.indexOf('\n  async ', observerStart + 1);
  const observer = pom.slice(
    observerStart,
    observerEnd >= 0 ? observerEnd : pom.length,
  );

  assert.ok(observerStart >= 0, 'ScanPage must own one atomic search-readiness observer.');
  assert.match(observer, /page\.waitForFunction\(/);
  assert.match(observer, /performance\.now\(\)/);
  assert.match(observer, /snapshot/);
  assert.match(observer, /query/);
  assert.match(observer, /loaderVisible/);
  assert.match(observer, /sidebarArtistNames/);
  assert.match(observer, /allArtistsVisibleCount/);
  assert.match(observer, /selectedArtistName/);
  assert.match(observer, /selectedArtistHref/);
  assert.match(observer, /galleryHeadings/);
  assert.match(observer, /albumCards/);
  assert.match(observer, /coverSettled/);
  assert.match(observer, /expectedAlbumCount/);
  assert.doesNotMatch(observer, /waitForTimeout/);
  assert.match(actions, /waitForSearchReadiness\(expected, options\)/);
  assert.match(actions, /readPerformanceNow\(\)/);

  const searchStepStart = spec.indexOf(
    "Search from Scan Page and wait for the complete Artist 001 result view",
  );
  const searchStepEnd = spec.indexOf(
    "Reopen Scan Page and choose Artist 002",
    searchStepStart,
  );
  const searchStep = spec.slice(searchStepStart, searchStepEnd);
  assert.ok(searchStepStart >= 0 && searchStepEnd > searchStepStart);
  assert.match(
    searchStep,
    /searchSubmittedAt\s*=\s*await scanPageActions\.readPerformanceNow\(\)/,
  );
  assert.match(
    searchStep,
    /scanPageActions\.waitForSearchReadiness\(\{[\s\S]*expectedQuery:\s*BACKGROUND_BROWSE_QUERY/,
  );
  assert.match(searchStep, /expectedSidebarArtistNames:\s*BACKGROUND_BROWSE_ARTIST_NAMES/);
  assert.match(searchStep, /expectedSelectedArtistName:\s*METADATA_ARTIST_NAME/);
  assert.match(searchStep, /expectedAlbumCount:\s*10/);
  assert.match(
    searchStep,
    /searchReadiness\.completedAtMs\s*-\s*searchSubmittedAt/,
  );
  assert.match(searchStep, /searchReadiness\.snapshot\.query/);
  assert.match(searchStep, /searchReadiness\.snapshot\.sidebarArtistNames/);
  assert.match(searchStep, /searchReadiness\.snapshot\.allArtistsVisibleCount/);
  assert.match(searchStep, /searchReadiness\.snapshot\.selectedArtistName/);
  assert.match(searchStep, /searchReadiness\.snapshot\.selectedArtistHref/);
  assert.match(
    searchStep,
    /new URL\([\s\S]*searchReadiness\.snapshot\.selectedArtistHref,[\s\S]*searchReadiness\.snapshot\.url/,
  );
  assert.doesNotMatch(searchStep, /\bpage\.url\(\)/);
  assert.match(searchStep, /searchReadiness\.snapshot\.galleryHeadings/);
  assert.match(searchStep, /searchReadiness\.snapshot\.albumCards/);
  assert.match(
    spec,
    /performanceTimingBudget\('scan-metadata\.searchReadyMs'\)/,
  );
  assert.match(searchStep, /SCAN_METADATA_SEARCH_BUDGET/);
});

test('Scan Page Back requires an immediate stable complete top gallery', () => {
  const spec = readRepoFile('tests/e2e/scanPerformance/scanPerformance.spec.js');
  const actions = readRepoFile('tests/e2e/actions/scanPageActions.js');
  const backStepStart = spec.indexOf(
    'const restoredBackObservation = await scanPageActions.startGalleryExitObservation()',
  );
  const backStepEnd = spec.indexOf(
    'expectTerminalScanStatus(terminalStatus',
    backStepStart,
  );
  const backStep = spec.slice(backStepStart, backStepEnd);

  assert.ok(backStepStart >= 0 && backStepEnd > backStepStart);
  assert.match(backStep, /measureActionTime\(/);
  assert.match(backStep, /scanPageActions\.clickBack\(\)/);
  assert.match(backStep, /scanPageActions\.waitForBrowseContext\(/);
  assert.match(backStep, /scanPageActions\.finishGalleryExitObservation\(restoredBackObservation\)/);
  assert.match(backStep, /restoredBackExit\.firstReadyMs/);
  assert.match(backStep, /STRICT_ONE_SECOND_BUDGET/);
  assert.doesNotMatch(backStep, /waitForTimeout/);
  assert.match(actions, /result\.finalSample\.loaderVisible\)\.toBe\(false\)/);
  assert.match(actions, /result\.finalSample\.scrollTop\)\.toBe\(0\)/);
  assert.match(actions, /result\.finalSample\.headings\.length\)\.toBeGreaterThan\(0\)/);
  assert.match(actions, /result\.finalSample\.cards\.length\)\.toBeGreaterThan\(0\)/);
  assert.match(actions, /card\.albumKey && card\.title && card\.coverSettled/);
  assert.match(actions, /result\.invalidSamples[\s\S]*toEqual\(\[\]\)/);
});

test('focused search browse resolves its timing budget from the central authority', () => {
  const spec = readRepoFile('tests/e2e/syntheticLargeLibrary/searchBrowse.spec.js');

  assert.match(
    spec,
    /performanceTimingBudget\('search-browse\.searchBrowseReadyMs'\)/,
  );
  assert.match(spec, /recordTerminalTimingOutcome\(\s*SEARCH_BROWSE_BUDGET\.metricId/);
  assert.match(spec, /recordContractCompletion\(\)/);
  assert.doesNotMatch(spec, /benchmarkValidation\s*:/);
});

test('focused selected-artist and root browse reports own complete terminal timing evidence', () => {
  const selectedArtist = readRepoFile('tests/e2e/syntheticLargeLibrary/selectedArtist.spec.js');
  const rootBrowse = readRepoFile('tests/e2e/syntheticLargeLibrary/rootAlbumBrowse.spec.js');
  const fixtures = readRepoFile('tests/e2e/support/performanceFixtures.js');

  for (const metricId of [
    'selected-artist.selectedArtistApiMs',
    'selected-artist.albumDetailsOpenMs',
    'root-album-browse.rootAlbumBrowseApiMs',
  ]) {
    assert.match(`${selectedArtist}\n${rootBrowse}\n${fixtures}`, new RegExp(metricId.replaceAll('.', '\\.')));
  }
  assert.equal((selectedArtist.match(/recordTerminalTimingOutcome\(/g) || []).length, 2);
  assert.match(selectedArtist, /recordContractCompletion\(\)/);
  assert.equal((rootBrowse.match(/recordTerminalTimingOutcome\(/g) || []).length, 1);
  assert.match(rootBrowse, /recordContractCompletion\(\)/);
});

test('focused rules report maps all five observations to the approved utility-rules timing IDs', () => {
  const spec = readRepoFile('tests/e2e/syntheticLargeLibrary/utilityRules.spec.js');
  const fixtures = readRepoFile('tests/e2e/support/performanceFixtures.js');
  const metricIds = [
    'utility-rules-local-managed-chrome.rulesReadyMs',
    'utility-rules-local-managed-chrome.loopsReadyMs',
    'utility-rules-local-managed-chrome.logHistoryReadyMs',
    'utility-rules-local-managed-chrome.integrationsReadyMs',
    'utility-rules-local-managed-chrome.appearanceReadyMs',
  ];

  for (const metricId of metricIds) {
    assert.match(`${spec}\n${fixtures}`, new RegExp(metricId.replaceAll('.', '\\.')));
  }
  assert.match(spec, /RULES_TIMING_BUDGETS\[definition\.key\]/);
  assert.equal((spec.match(/recordTerminalTimingOutcome\(/g) || []).length, 2);
  assert.match(spec, /recordContractCompletion\(\)/);
});

test('cached and add-album scan cases publish their measured timing as terminal evidence', () => {
  const spec = readRepoFile('tests/e2e/scanPerformance/scanPerformance.spec.js');
  const fixtures = readRepoFile('tests/e2e/support/performanceFixtures.js');

  assert.match(`${spec}\n${fixtures}`, /scan-cached\.startupReadyMs/);
  assert.match(`${spec}\n${fixtures}`, /scan-add-album\.uiUpdatedMs/);
  assert.match(spec, /scanCachedLocalReport\.recordTerminalTimingOutcome\(/);
  assert.match(spec, /scanCachedLocalReport\.recordContractCompletion\(\)/);
  assert.match(spec, /scanAddAlbumLocalReport\.recordTerminalTimingOutcome\(/);
  assert.match(spec, /scanAddAlbumLocalReport\.recordContractCompletion\(\)/);
});

test('Scan Page gallery-exit readiness requires consecutive stable card signatures and finishes from the latest observed sample', () => {
  const pom = readRepoFile('tests/e2e/poms/scanPage.js');
  const observerStart = pom.indexOf('async startGalleryExitObservation(');
  const observerEnd = pom.indexOf('\n  async ', observerStart + 1);
  const observer = pom.slice(
    observerStart,
    observerEnd >= 0 ? observerEnd : pom.length,
  );

  assert.ok(observerStart >= 0, 'ScanPage must own the gallery-exit observation state machine.');
  assert.match(observer, /latestSample/);
  assert.match(observer, /candidateReadySignature/);
  assert.match(observer, /candidateReadySampleCount/);
  assert.match(
    observer,
    /JSON\.stringify\(\{[\s\S]*cardKeys:\s*cards\.map\(\(card\)\s*=>\s*card\.albumKey\)[\s\S]*headings[\s\S]*scrollTop:\s*sample\.scrollTop[\s\S]*\}\)/,
    'The stable signature must preserve ordered visible card keys, headings, and scroll position.',
  );
  assert.match(observer, /candidateReadySampleCount\s*\+=\s*1/);
  assert.match(observer, /candidateReadySampleCount\s*=\s*1/);
  assert.match(observer, /candidateReadySampleCount\s*>=\s*2/);
  assert.match(
    observer,
    /candidateReadySignature\s*=\s*null[\s\S]*candidateReadySampleCount\s*=\s*0/,
    'A changed, expanded, or invalid visible-card signature must reset candidate readiness.',
  );
  assert.match(observer, /latestSample\s*=\s*sample/);
  assert.match(observer, /finalSample:\s*latestSample/);
  assert.doesNotMatch(observer, /const finalSample\s*=\s*readSample\(\)/);
  assert.match(observer, /invalidSamples:\s*\[\.\.\.result\.invalidSamples\]/);
});

test('Scan Page gallery-exit visual readiness proves a post-action reveal or generation advance on painted frames', () => {
  const pom = readRepoFile('tests/e2e/poms/scanPage.js');
  const observerStart = pom.indexOf('async startGalleryExitObservation(');
  const observerEnd = pom.indexOf('\n  async ', observerStart + 1);
  const observer = pom.slice(
    observerStart,
    observerEnd >= 0 ? observerEnd : pom.length,
  );

  assert.ok(observerStart >= 0, 'ScanPage must own the gallery-exit observation state machine.');
  assert.match(
    observer,
    /initialRenderGeneration\s*=\s*Number\([\s\S]*__ALBUM_HAVEN_VIRTUAL_GRID__[\s\S]*latestRender[\s\S]*renderGeneration/,
    'The observer must capture the retained gallery render generation before the Browse action.',
  );
  assert.match(
    observer,
    /initialCoverGeneration\s*=\s*Number\([\s\S]*__ALBUM_HAVEN_GALLERY_COVER_SCHEDULER__[\s\S]*generation/,
    'The observer must capture the retained gallery cover generation before the Browse action.',
  );
  assert.match(
    observer,
    /renderGeneration:\s*Number\([\s\S]*__ALBUM_HAVEN_VIRTUAL_GRID__[\s\S]*latestRender[\s\S]*renderGeneration/,
  );
  assert.match(
    observer,
    /coverGeneration:\s*Number\([\s\S]*__ALBUM_HAVEN_GALLERY_COVER_SCHEDULER__[\s\S]*generation/,
  );
  assert.match(
    observer,
    /foregroundIdle:\s*[\s\S]*__ALBUM_HAVEN_GALLERY_COVER_SCHEDULER__[\s\S]*foregroundIdle/,
    'Foreground-idle state should remain in samples for failure diagnostics.',
  );
  assert.match(
    observer,
    /observedGalleryHidden/,
    'The observer must remember that the retained gallery was hidden behind Scan Page.',
  );
  const readyExpression = observer.match(
    /const ready\s*=\s*([\s\S]*?);\s*if\s*\(result\.firstReadyAt/,
  );
  assert.ok(readyExpression, 'The observer must define an explicit visual-readiness expression.');
  assert.match(
    readyExpression[1],
    /observedGalleryHidden\s*&&\s*galleryVisible/,
    'A stable hidden-to-visible retained gallery transition is post-action readiness evidence.',
  );
  assert.match(
    readyExpression[1],
    /sample\.renderGeneration\s*>\s*initialRenderGeneration[\s\S]*sample\.coverGeneration\s*>\s*initialCoverGeneration/,
    'A newly rendered gallery must still advance both render and cover generations.',
  );
  assert.doesNotMatch(
    readyExpression[1],
    /sample\.foregroundIdle/,
    'Decoded, settled post-action covers are visually ready even while unrelated scheduler work keeps foregroundIdle false.',
  );
  assert.match(
    observer,
    /JSON\.stringify\(\{[\s\S]*coverGeneration:\s*sample\.coverGeneration[\s\S]*renderGeneration:\s*sample\.renderGeneration[\s\S]*\}\)/,
    'A later render or cover generation must invalidate an in-progress readiness candidate.',
  );
  assert.match(
    observer,
    /const readSample\s*=\s*\(\s*sampleSource[\s\S]*sampleSource\s*===\s*['"]animation-frame['"][\s\S]*candidateReadySampleCount\s*\+=\s*1/,
    'Only an animation-frame sample may advance an existing readiness candidate.',
  );
  assert.match(
    observer,
    /requestAnimationFrame\([\s\S]*readSample\(\s*['"]animation-frame['"]\s*\)[\s\S]*requestAnimationFrame/,
    'Readiness must be confirmed by distinct recursively scheduled paint frames.',
  );
  assert.doesNotMatch(observer, /new MutationObserver\(\s*readSample\s*\)/);
  assert.doesNotMatch(observer, /setInterval\(\s*readSample/);
});

test('Problematic Files runtime partition accepts only one-to-one production-authenticated cover aborts', async () => {
  const moduleUrl = pathToFileURL(path.join(
    repoRoot,
    'tests/e2e/helpers/utilityPerformanceHelpers.js',
  )).href;
  const { partitionProblematicFilesRuntimeLogs } = await import(moduleUrl);
  const authenticatedAbort = {
    kind: 'requestfailed',
    type: 'net::ERR_ABORTED',
    method: 'GET',
    url: 'http://127.0.0.1:4173/cover?path=private%2Falbum&size=480&v=secret',
    coverRequestId: 'gallery-cover-session-1',
  };
  const window = {
    sequenceBefore: 8,
    sequenceAfter: 9,
    preemptions: [{
      requestId: 'gallery-cover-session-1',
      normalizedUrl: 'http://127.0.0.1:4173/cover',
      reason: 'foreground-promotion',
      sequence: 9,
    }],
  };

  assert.deepEqual(
    partitionProblematicFilesRuntimeLogs([], { sequenceBefore: 0, sequenceAfter: 0, preemptions: [] }),
    { acceptedIntentionalCoverAborts: [], acceptedIntentionalViewAborts: [], unexpectedRuntimeErrors: [] },
    'the benchmark must not require a cancellation',
  );
  const accepted = partitionProblematicFilesRuntimeLogs([authenticatedAbort], window);
  assert.equal(accepted.acceptedIntentionalCoverAborts.length, 1);
  assert.deepEqual(accepted.unexpectedRuntimeErrors, []);
  const acceptedModalPreemption = partitionProblematicFilesRuntimeLogs([authenticatedAbort], {
    ...window,
    preemptions: [{ ...window.preemptions[0], reason: 'utility-modal-preemption' }],
  });
  assert.equal(acceptedModalPreemption.acceptedIntentionalCoverAborts.length, 1);
  assert.deepEqual(acceptedModalPreemption.unexpectedRuntimeErrors, []);

  const rejectedVariants = [
    { ...authenticatedAbort, type: 'net::ERR_FAILED' },
    { ...authenticatedAbort, method: 'POST' },
    { ...authenticatedAbort, coverRequestId: 'unmatched' },
    { ...authenticatedAbort, url: 'http://127.0.0.1:4173/cover-preview?path=private' },
  ];
  for (const entry of rejectedVariants) {
    const result = partitionProblematicFilesRuntimeLogs([entry], window);
    assert.deepEqual(result.acceptedIntentionalCoverAborts, []);
    assert.deepEqual(result.unexpectedRuntimeErrors, [entry]);
  }

  const staleSequence = partitionProblematicFilesRuntimeLogs([authenticatedAbort], {
    ...window,
    sequenceBefore: 9,
  });
  assert.deepEqual(staleSequence.unexpectedRuntimeErrors, [authenticatedAbort]);
  const wrongReason = partitionProblematicFilesRuntimeLogs([authenticatedAbort], {
    ...window,
    preemptions: [{ ...window.preemptions[0], reason: 'intentional-preemption' }],
  });
  assert.deepEqual(wrongReason.unexpectedRuntimeErrors, [authenticatedAbort]);
  const wrongDiagnosticRequestId = partitionProblematicFilesRuntimeLogs([authenticatedAbort], {
    ...window,
    preemptions: [{ ...window.preemptions[0], requestId: 'gallery-cover-session-2' }],
  });
  assert.deepEqual(wrongDiagnosticRequestId.unexpectedRuntimeErrors, [authenticatedAbort]);
  const wrongDiagnosticRoute = partitionProblematicFilesRuntimeLogs([authenticatedAbort], {
    ...window,
    preemptions: [{ ...window.preemptions[0], normalizedUrl: 'http://127.0.0.1:4173/cover-preview' }],
  });
  assert.deepEqual(wrongDiagnosticRoute.unexpectedRuntimeErrors, [authenticatedAbort]);
  const duplicateFailure = partitionProblematicFilesRuntimeLogs(
    [authenticatedAbort, authenticatedAbort],
    window,
  );
  assert.equal(duplicateFailure.acceptedIntentionalCoverAborts.length, 1);
  assert.deepEqual(duplicateFailure.unexpectedRuntimeErrors, [authenticatedAbort]);
  const duplicateDiagnostic = partitionProblematicFilesRuntimeLogs([authenticatedAbort], {
    ...window,
    preemptions: [window.preemptions[0], { ...window.preemptions[0] }],
  });
  assert.deepEqual(duplicateDiagnostic.unexpectedRuntimeErrors, [authenticatedAbort]);
  const multiplyReasonedDiagnostic = partitionProblematicFilesRuntimeLogs([authenticatedAbort], {
    ...window,
    preemptions: [
      window.preemptions[0],
      { ...window.preemptions[0], reason: 'utility-modal-preemption' },
    ],
  });
  assert.deepEqual(multiplyReasonedDiagnostic.unexpectedRuntimeErrors, [authenticatedAbort]);
  const pageError = { kind: 'pageerror', type: 'error', text: 'boom' };
  assert.deepEqual(
    partitionProblematicFilesRuntimeLogs([pageError], window).unexpectedRuntimeErrors,
    [pageError],
  );

  const startupViewAbort = {
    kind: 'requestfailed',
    type: 'net::ERR_ABORTED',
    method: 'GET',
    url: 'http://127.0.0.1:4173/view-data?surface=albums&omit_sidebar=1',
  };
  const viewWindow = {
    sequenceBefore: 0,
    sequenceAfter: 1,
    preemptions: [{
      normalizedUrl: '/view-data?surface=albums&omit_sidebar=1',
      reason: 'utility-modal-preemption',
      sequence: 1,
    }],
  };
  const acceptedViewAbort = partitionProblematicFilesRuntimeLogs(
    [startupViewAbort],
    { sequenceBefore: 0, sequenceAfter: 0, preemptions: [] },
    viewWindow,
  );
  assert.deepEqual(acceptedViewAbort.acceptedIntentionalViewAborts, [startupViewAbort]);
  assert.deepEqual(acceptedViewAbort.unexpectedRuntimeErrors, []);
  assert.deepEqual(
    partitionProblematicFilesRuntimeLogs(
      [startupViewAbort],
      { sequenceBefore: 0, sequenceAfter: 0, preemptions: [] },
      {
        ...viewWindow,
        preemptions: [{ ...viewWindow.preemptions[0], normalizedUrl: '/view-data?surface=artists' }],
      },
    ).unexpectedRuntimeErrors,
    [startupViewAbort],
  );
  assert.deepEqual(
    partitionProblematicFilesRuntimeLogs(
      [startupViewAbort, startupViewAbort],
      { sequenceBefore: 0, sequenceAfter: 0, preemptions: [] },
      viewWindow,
    ).unexpectedRuntimeErrors,
    [startupViewAbort],
    'one production diagnostic may authenticate only one failed request',
  );
});

test('playback-start degradation compares repeated equal-length tracks instead of the mixed length probes', async () => {
  const moduleUrl = pathToFileURL(path.join(
    repoRoot,
    'tests/e2e/helpers/playbackStartPerformanceHelpers.js',
  )).href;
  const { summarizePlaybackStartAttempts } = await import(moduleUrl);
  const attempts = [
    { label: 'cold short', elapsedMs: 100, diagnostics: {} },
    { label: 'cold long', elapsedMs: 5000, diagnostics: {} },
    { label: 'medium A', cohort: 'repeated-use', elapsedMs: 200, diagnostics: {} },
    { label: 'medium B', cohort: 'repeated-use', elapsedMs: 220, diagnostics: {} },
    { label: 'medium C', cohort: 'repeated-use', elapsedMs: 240, diagnostics: {} },
    { label: 'medium D', cohort: 'repeated-use', elapsedMs: 400, diagnostics: {} },
    { label: 'medium E', cohort: 'repeated-use', elapsedMs: 420, diagnostics: {} },
    { label: 'medium F', cohort: 'repeated-use', elapsedMs: 440, diagnostics: {} },
  ];

  const summary = summarizePlaybackStartAttempts(attempts);

  assert.equal(summary.maximumMs, 5000);
  assert.equal(summary.earlyMedianMs, 220);
  assert.equal(summary.lateMedianMs, 420);
  assert.equal(summary.degradationMs, 200);

  assert.throws(
    () => summarizePlaybackStartAttempts(attempts.slice(0, -1)),
    /requires at least 6 repeated-use samples, received 5/,
  );
});

test('playback-start approved budget separates target, grace, hard failure, and repeated-use degradation', async () => {
  const moduleUrl = pathToFileURL(path.join(
    repoRoot,
    'tests/e2e/helpers/playbackStartPerformanceHelpers.js',
  )).href;
  const {
    MAX_PLAYBACK_START_DEGRADATION_MS,
    PLAYBACK_START_TIMING_BUDGET,
    evaluatePlaybackStartBudget,
  } = await import(moduleUrl);

  assert.deepEqual({ ...PLAYBACK_START_TIMING_BUDGET }, {
    contractName: 'local',
    metricId: 'playback-start.maximumStartMs',
    targetMaximum: 900,
    graceMs: 200,
    hardCeiling: 1100,
  });
  assert.equal(MAX_PLAYBACK_START_DEGRADATION_MS, 400);

  const targetMet = evaluatePlaybackStartBudget({
    maximumMs: 900,
    degradationMs: 400,
  });
  const graceUsed = evaluatePlaybackStartBudget({
    maximumMs: 1000,
    degradationMs: -25,
  });
  const hardFailure = evaluatePlaybackStartBudget({
    maximumMs: 1101,
    degradationMs: 401,
  });
  const missingDegradation = evaluatePlaybackStartBudget({
    maximumMs: 900,
    degradationMs: null,
  });

  assert.equal(targetMet.maximumStart.status, 'target-met');
  assert.equal(targetMet.degradation.status, 'target-met');
  assert.equal(targetMet.passed, true);
  assert.equal(graceUsed.maximumStart.status, 'grace-used');
  assert.equal(graceUsed.degradation.status, 'target-met');
  assert.equal(graceUsed.passed, true);
  assert.equal(hardFailure.maximumStart.status, 'hard-fail');
  assert.equal(hardFailure.degradation.status, 'hard-fail');
  assert.equal(hardFailure.passed, false);
  assert.equal(missingDegradation.degradation.status, 'hard-fail');
  assert.equal(missingDegradation.passed, false);
});

test('playback-start spec and report retain the owner-approved budget without the intentional gate', () => {
  const spec = readRepoFile('tests/e2e/performance/playbackStart.spec.js');
  const fixtures = readRepoFile('tests/e2e/support/performanceFixtures.js');

  assert.match(spec, /evaluatePlaybackStartBudget\(summary\)/);
  assert.match(spec, /expectTimingBudgetOutcome/);
  assert.doesNotMatch(spec, /Intentional RED diagnostic/);
  assert.match(fixtures, /recordBudget\(nextBudget\)/);
  assert.match(
    fixtures,
    /Target \$\{maximumBudget\.targetMaximum\} ms \| hard ceiling \$\{maximumBudget\.hardCeiling\} ms/,
  );
  assert.doesNotMatch(fixtures, /pending-owner-approval/);
});

test('playback-start timing ends at exact rendered sample evidence after UI readiness', async () => {
  const moduleUrl = pathToFileURL(path.join(
    repoRoot,
    'tests/e2e/helpers/playbackStartPerformanceHelpers.js',
  )).href;
  const { measureAlbumTrackPlaybackStart } = await import(moduleUrl);
  const track = { path: 'generated/album/track.mp3', title: 'Measured track' };
  let waitForFunctionCalls = 0;
  let browserCompletion = null;
  const originalState = globalThis.state;
  const originalSnapshot = globalThis.getPlayerPlaybackSnapshot;
  const originalStreamingSnapshot = globalThis.getStreamingPlaybackSnapshot;
  const setPlayback = ({ path = track.path, title = track.title, paused = false, currentTime = 0.02 } = {}) => {
    globalThis.state = {
      player: {
        current: { path, title },
        streaming: {
          limits: { currentSeconds: 12, continuitySeconds: 5 },
          roles: { current: { streamId: 1 }, continuity: null },
          pendingPromotion: null,
        },
      },
    };
    globalThis.getPlayerPlaybackSnapshot = () => ({ paused, currentTime, duration: 60 });
    globalThis.getStreamingPlaybackSnapshot = () => ({
      mode: paused ? 'paused' : 'playing',
      generation: 1,
      currentTime,
      paused,
      sampleRate: 48_000,
      diagnostics: {
        activeRoles: ['current'],
        bufferedFrames: { current: 0, continuity: 0 },
        inFlightFrames: { current: 0, continuity: 0 },
        firstFrameAtMs: 10,
        roleOpenedAtMs: { current: 1, continuity: 0 },
      },
    });
  };

  const page = {
    async evaluate(callback) {
      return callback();
    },
    async waitForFunction(callback, expected) {
      waitForFunctionCalls += 1;
      setPlayback({ path: 'generated/album/wrong.mp3' });
      assert.equal(callback(expected), false);
      setPlayback({ title: 'Wrong title' });
      assert.equal(callback(expected), false);
      setPlayback({ paused: true });
      assert.equal(callback(expected), false);
      setPlayback({ currentTime: 0.019 });
      assert.equal(callback(expected), false);
      setPlayback();
      browserCompletion = callback(expected);
      assert.equal(typeof browserCompletion?.completedAtMs, 'number');
      return {
        async jsonValue() {
          return browserCompletion;
        },
        async dispose() {},
      };
    },
  };

  try {
    const result = await measureAlbumTrackPlaybackStart({
      page,
      trackModalActions: {
        async playTrackAt(_rowIndex, options) {
          await options.recordClickBoundary();
          return track;
        },
      },
      globalPlayerActions: {
        async waitForCurrentTrack() {
          throw new Error('Current-track and playback-state waits must be one browser condition.');
        },
        async waitForPlaybackState() {
          throw new Error('Current-track and playback-state waits must be one browser condition.');
        },
      },
      traffic: {
        mark() {
          return 0;
        },
        async playbackMark() {
          return { eventIndex: 0, renderedFrame: 0 };
        },
        async waitForTrackPlaybackEvidence() {
          return {
            pcmFrames: 1,
            finiteSamples: 2,
            nonZeroSamples: 2,
            peakSample: 0.5,
            renderedFrameDelta: 128,
            observedAtMs: browserCompletion.completedAtMs + 25,
          };
        },
        snapshotSince() {
          return [];
        },
      },
      rowIndex: 3,
      label: 'measured track',
      minimumCurrentTime: 0.02,
    });

    assert.equal(waitForFunctionCalls, 1);
    assert.equal(result.completedAtMs, browserCompletion.completedAtMs + 25);
  } finally {
    if (originalState === undefined) delete globalThis.state;
    else globalThis.state = originalState;
    if (originalSnapshot === undefined) delete globalThis.getPlayerPlaybackSnapshot;
    else globalThis.getPlayerPlaybackSnapshot = originalSnapshot;
    if (originalStreamingSnapshot === undefined) delete globalThis.getStreamingPlaybackSnapshot;
    else globalThis.getStreamingPlaybackSnapshot = originalStreamingSnapshot;
  }
});

test('playback-start eager-role classification uses browser monotonic role timing', async () => {
  const moduleUrl = pathToFileURL(path.join(
    repoRoot,
    'tests/e2e/helpers/playbackStartPerformanceHelpers.js',
  )).href;
  const { classifyEagerPlaybackRoles } = await import(moduleUrl);
  const openControls = [{
    type: 'open',
    role: 'continuity',
    path: 'generated/album/next.mp3',
    sentAtEpochMs: 1000,
  }];
  const selectedPath = 'generated/album/current.mp3';

  assert.deepEqual(classifyEagerPlaybackRoles({
    openControls,
    selectedPath,
    firstFrameAtMs: 1001,
    roleOpenedAtMs: { current: 900, continuity: 1002 },
  }), []);
  assert.deepEqual(classifyEagerPlaybackRoles({
    openControls,
    selectedPath,
    firstFrameAtMs: 1001,
    roleOpenedAtMs: { current: 900, continuity: 999 },
  }), ['continuity']);
});

test('shared cover-preemption partition accepts only one authenticated render-generation abort', async () => {
  const moduleUrl = pathToFileURL(path.join(
    repoRoot,
    'tests/e2e/helpers/utilityPerformanceHelpers.js',
  )).href;
  const helperModule = await import(moduleUrl);
  assert.equal(
    typeof helperModule.partitionAuthenticatedCoverPreemptionRuntimeLogs,
    'function',
    'the strict cover-abort partition must be shared beyond Problematic Files',
  );
  const { partitionAuthenticatedCoverPreemptionRuntimeLogs } = helperModule;
  const authenticatedAbort = {
    kind: 'requestfailed',
    type: 'net::ERR_ABORTED',
    method: 'GET',
    url: 'http://127.0.0.1:4173/cover?path=private%2Falbum&size=480&v=secret',
    coverRequestId: 'gallery-cover-render-1',
  };
  const window = {
    sequenceBefore: 40,
    sequenceAfter: 42,
    preemptions: [{
      requestId: 'gallery-cover-render-1',
      normalizedUrl: 'http://127.0.0.1:4173/cover',
      reason: 'render-generation-preemption',
      sequence: 41,
    }],
  };

  const accepted = partitionAuthenticatedCoverPreemptionRuntimeLogs([authenticatedAbort], window);
  assert.deepEqual(accepted.acceptedIntentionalCoverAborts, [authenticatedAbort]);
  assert.deepEqual(accepted.unexpectedRuntimeErrors, []);

  const rejectedCases = [
    {
      label: 'wrong reason',
      runtimeLogs: [authenticatedAbort],
      coverPreemptionWindow: {
        ...window,
        preemptions: [{ ...window.preemptions[0], reason: 'intentional-preemption' }],
      },
      unexpected: [authenticatedAbort],
    },
    {
      label: 'wrong request route',
      runtimeLogs: [{ ...authenticatedAbort, url: 'http://127.0.0.1:4173/cover-preview?path=private' }],
      coverPreemptionWindow: window,
      unexpected: [{ ...authenticatedAbort, url: 'http://127.0.0.1:4173/cover-preview?path=private' }],
    },
    {
      label: 'wrong diagnostic route',
      runtimeLogs: [authenticatedAbort],
      coverPreemptionWindow: {
        ...window,
        preemptions: [{ ...window.preemptions[0], normalizedUrl: 'http://127.0.0.1:4173/cover-preview' }],
      },
      unexpected: [authenticatedAbort],
    },
    {
      label: 'wrong method',
      runtimeLogs: [{ ...authenticatedAbort, method: 'POST' }],
      coverPreemptionWindow: window,
      unexpected: [{ ...authenticatedAbort, method: 'POST' }],
    },
    {
      label: 'duplicate failures',
      runtimeLogs: [authenticatedAbort, authenticatedAbort],
      coverPreemptionWindow: window,
      unexpected: [authenticatedAbort],
      acceptedCount: 1,
    },
    {
      label: 'duplicate diagnostics',
      runtimeLogs: [authenticatedAbort],
      coverPreemptionWindow: {
        ...window,
        preemptions: [window.preemptions[0], { ...window.preemptions[0] }],
      },
      unexpected: [authenticatedAbort],
    },
    {
      label: 'unmatched request id',
      runtimeLogs: [{ ...authenticatedAbort, coverRequestId: 'gallery-cover-render-2' }],
      coverPreemptionWindow: window,
      unexpected: [{ ...authenticatedAbort, coverRequestId: 'gallery-cover-render-2' }],
    },
    {
      label: 'sequence at the excluded lower bound',
      runtimeLogs: [authenticatedAbort],
      coverPreemptionWindow: { ...window, sequenceBefore: 41 },
      unexpected: [authenticatedAbort],
    },
    {
      label: 'sequence beyond the upper bound',
      runtimeLogs: [authenticatedAbort],
      coverPreemptionWindow: { ...window, sequenceAfter: 40 },
      unexpected: [authenticatedAbort],
    },
  ];
  for (const rejectedCase of rejectedCases) {
    const result = partitionAuthenticatedCoverPreemptionRuntimeLogs(
      rejectedCase.runtimeLogs,
      rejectedCase.coverPreemptionWindow,
    );
    assert.equal(
      result.acceptedIntentionalCoverAborts.length,
      rejectedCase.acceptedCount || 0,
      rejectedCase.label,
    );
    assert.deepEqual(result.unexpectedRuntimeErrors, rejectedCase.unexpected, rejectedCase.label);
  }
});

test('App Open uses the shared strict cover partition before its separate benchmark assertion', () => {
  const spec = readRepoFile('tests/e2e/syntheticLargeLibrary/appOpenAllArtists.spec.js');
  const assignedPartition = spec.match(
    /const\s+([A-Za-z_$][\w$]*)\s*=\s*partitionAuthenticatedCoverPreemptionRuntimeLogs\(\s*testArtifacts\.getRuntimeLogs\(\),\s*coverPreemptionWindow,?\s*\)/,
  );
  const destructuredPartition = spec.match(
    /const\s+\{[^}]*\bunexpectedRuntimeErrors\b[^}]*\}\s*=\s*partitionAuthenticatedCoverPreemptionRuntimeLogs\(\s*testArtifacts\.getRuntimeLogs\(\),\s*coverPreemptionWindow,?\s*\)/,
  );
  const partitionCall = spec.indexOf('partitionAuthenticatedCoverPreemptionRuntimeLogs(');
  const runtimeAssertion = spec.indexOf('expectNoUnexpectedRuntimeFailures(', partitionCall);
  const benchmarkAssertion = spec.indexOf('benchmarkEvaluation.failures', runtimeAssertion);

  assert.ok(
    assignedPartition || destructuredPartition,
    'App Open must retain the shared partition result for its runtime-failure assertion',
  );
  if (assignedPartition) {
    assert.match(
      spec,
      new RegExp(`expectNoUnexpectedRuntimeFailures\\(\\s*${assignedPartition[1]}\\.unexpectedRuntimeErrors,`),
    );
  } else {
    assert.match(spec, /expectNoUnexpectedRuntimeFailures\(\s*unexpectedRuntimeErrors,/);
  }
  assert.ok(partitionCall >= 0, 'App Open must use the shared strict cover-preemption partition');
  assert.ok(runtimeAssertion > partitionCall, 'App Open must assert the partitioned runtime failures');
  assert.ok(
    benchmarkAssertion > runtimeAssertion,
    'benchmark failures must remain a separate assertion after runtime-error partitioning',
  );
  assert.match(
    spec,
    /expect\(\s*benchmarkEvaluation\.failures,\s*benchmarkEvaluation\.failures\.join\('\\n'\),\s*\)\.toEqual\(\[\]\)/,
  );
});

test('Root Album Browse authenticates cover preemption before strict runtime validation', () => {
  const spec = readRepoFile('tests/e2e/syntheticLargeLibrary/rootAlbumBrowse.spec.js');
  const importedNames = [...spec.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*['"][^'"]+['"];/g)]
    .map((match) => match[1])
    .join('\n');
  const snapshots = [...spec.matchAll(
    /const\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+readGalleryCoverPreemptionSnapshot\(page\)/g,
  )];
  const gotoCall = spec.indexOf("galleryActions.goto('/')");
  const visibleReadinessCall = spec.indexOf('waitForVisibleGalleryCoversLoaded(');
  const assignedPartition = spec.match(
    /const\s+([A-Za-z_$][\w$]*)\s*=\s*partitionAuthenticatedCoverPreemptionRuntimeLogs\(\s*testArtifacts\.getRuntimeLogs\(\),\s*([A-Za-z_$][\w$]*),?\s*\)/,
  );
  const timingCheckpoint = spec.indexOf('recordTimingCheckpoint({');
  const partitionCall = spec.indexOf('partitionAuthenticatedCoverPreemptionRuntimeLogs(');
  const runtimeAssertion = spec.indexOf('expectNoUnexpectedRuntimeFailures(', partitionCall);

  assert.match(importedNames, /\breadGalleryCoverPreemptionSnapshot\b/);
  assert.match(importedNames, /\bpartitionAuthenticatedCoverPreemptionRuntimeLogs\b/);
  assert.equal(snapshots.length, 2, 'Root Album Browse must capture one pre-navigation and one post-readiness snapshot');
  assert.ok(snapshots[0].index < gotoCall, 'the preemption baseline must be captured before root navigation');
  assert.ok(
    snapshots[1].index > visibleReadinessCall,
    'the closing preemption snapshot must be captured after visible root readiness',
  );
  assert.ok(
    assignedPartition,
    'Root Album Browse must retain the shared partition result for its runtime-failure assertion',
  );
  assert.ok(partitionCall > snapshots[1].index, 'runtime logs must be partitioned after the closing snapshot');
  assert.ok(runtimeAssertion > partitionCall, 'strict runtime validation must follow authenticated partitioning');
  assert.match(
    spec,
    new RegExp(`expectNoUnexpectedRuntimeFailures\\(\\s*${assignedPartition?.[1] || 'missingPartition'}\\.unexpectedRuntimeErrors,`),
  );
  assert.ok(timingCheckpoint >= 0, 'Root Album Browse must keep its timing checkpoint');
  assert.ok(timingCheckpoint < runtimeAssertion, 'timing evidence must remain separate from runtime-error validation');
  assert.match(spec, /timingMs:\s*rootAlbumBrowseApiMs/);
});

test('Problematic Files records timing classification before strict runtime-error partitioning', () => {
  const spec = readRepoFile('tests/e2e/utilityProblematicFiles/utilityProblematicFiles.spec.js');
  const helper = readRepoFile('tests/e2e/helpers/utilityPerformanceHelpers.js');
  const fixture = readRepoFile('tests/e2e/support/baseFixtures.js');
  const timingCheckpoint = spec.indexOf('recordTimingCheckpoint({');
  const readinessClassification = spec.indexOf('recordTextCheckpoint({');
  const retainedMetrics = spec.indexOf('setMetricsPayload({');
  const hardAssertion = spec.indexOf('expectTimingBudgetOutcome(');
  const runtimePartition = spec.indexOf('partitionProblematicFilesRuntimeLogs(');

  assert.ok(timingCheckpoint >= 0);
  assert.ok(readinessClassification > timingCheckpoint);
  assert.ok(runtimePartition > readinessClassification);
  assert.ok(retainedMetrics > readinessClassification);
  assert.ok(hardAssertion > retainedMetrics, 'hard failure must retain structured timing evidence before throwing');
  assert.match(spec, /performanceTimingBudget\('problematic-files-focused\.readyMs'\)/);
  assert.match(spec, /const READY_TARGET_MS = READY_BUDGET\.targetMaximum;/);
  assert.match(spec, /const READY_GRACE_MS = READY_BUDGET\.graceMs;/);
  assert.match(spec, /evaluateTimingBudget\(readyMs, READY_BUDGET\)/);
  assert.match(spec, /readinessPerformanceStatus: readinessOutcome\.status/);
  assert.match(spec, /formatTimingBudgetOutcome\(/);
  assert.match(helper, /preemptionBefore = await readGalleryCoverPreemptionSnapshot\(page\)/);
  assert.match(helper, /preemptionAfter = await readGalleryCoverPreemptionSnapshot\(page\)/);
  assert.match(fixture, /coverRequestId: String\(headers\['x-album-haven-cover-request-id'\] \|\| ''\)/);
});

test('broad Problematic Files benchmark retains timing classification before its direct hard assertion', () => {
  const spec = readRepoFile('tests/e2e/utilityProblematicFiles/utilitiesResponsiveness.spec.js');
  const evaluation = spec.indexOf('const problematicReadyOutcome = evaluateTimingBudget(');
  const retainedMetrics = spec.indexOf('utilityProblematicFilesLocalReport.setMetricsPayload({');
  const hardAssertion = spec.indexOf('expectTimingBudgetOutcome(');

  assert.ok(evaluation >= 0);
  assert.ok(retainedMetrics > evaluation);
  assert.ok(hardAssertion > retainedMetrics, 'hard failure must retain the benchmark payload before throwing');
  assert.match(spec, /problematicReadyPerformanceStatus: problematicReadyOutcome\.status/);
  assert.match(spec, /page\.goto\(PROBLEMATIC_FILES_PATHNAME/);
  assert.doesNotMatch(spec, /page\.request\.get/);
});

test('replacement evidence follows the promoted open when an earlier same-track stream was superseded', async () => {
  const helperUrl = pathToFileURL(
    path.join(repoRoot, 'tests/e2e/helpers/gaplessPlaybackHelpers.js'),
  ).href;
  const { findPromotedReplacementOpen } = await import(helperUrl);
  const pathValue = 'C:/Music/replacement.flac';
  const events = [
    { direction: 'sent', type: 'open', role: 'continuity', path: pathValue, generation: 1, streamId: 2 },
    { direction: 'sent', type: 'close', generation: 1, streamId: 2, reason: 'replacement-target' },
    { direction: 'sent', type: 'open', role: 'continuity', path: pathValue, generation: 1, streamId: 3 },
    { direction: 'sent', type: 'promote', generation: 1, streamId: 3 },
  ];

  assert.deepEqual(findPromotedReplacementOpen(events, pathValue), {
    open: events[2],
    promotionIndex: 3,
  });
});
