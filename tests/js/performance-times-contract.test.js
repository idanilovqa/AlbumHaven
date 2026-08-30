const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const authorityPath = path.join(repoRoot, 'scripts', 'performance-times-contract.cjs');

function loadAuthority() {
  assert.equal(
    fs.existsSync(authorityPath),
    true,
    'missing central performance-times contract loader',
  );
  return require(authorityPath);
}

function writeContract(t, payload) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'album-haven-performance-times-'));
  const contractPath = path.join(tempRoot, 'performance-times.json');
  fs.writeFileSync(contractPath, JSON.stringify(payload), 'utf8');
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  return contractPath;
}

function validMetric(overrides = {}) {
  return {
    local: { targetMs: 900, graceMs: 200, hardCeilingMs: 1100 },
    ci: { targetMs: 1800, graceMs: 200, hardCeilingMs: 2000 },
    ...overrides,
  };
}

test('performance timing contract defaults to local and requires trusted explicit CI selection', () => {
  const { resolvePerformanceContractName } = loadAuthority();

  assert.equal(resolvePerformanceContractName(), 'local');
  assert.equal(resolvePerformanceContractName({ requestedContract: 'local' }), 'local');
  assert.equal(resolvePerformanceContractName({ requestedContract: 'ci', trustedCi: true }), 'ci');
  assert.throws(
    () => resolvePerformanceContractName({ requestedContract: 'ci', trustedCi: false }),
    /trusted|CI/i,
  );
  assert.throws(
    () => resolvePerformanceContractName({ requestedContract: 'staging', trustedCi: true }),
    /unknown|local|ci/i,
  );
});

test('performance timing contract fails closed for missing metrics and invalid triplets', (t) => {
  const { loadPerformanceTimesContract, resolveTimingBudget } = loadAuthority();
  const missingMetricPath = writeContract(t, {
    'example.ready': validMetric(),
  });
  const missingMetricContract = loadPerformanceTimesContract({ contractPath: missingMetricPath });
  assert.throws(
    () => resolveTimingBudget('missing.metric', 'local', missingMetricContract),
    /missing\.metric|missing/i,
  );

  for (const [label, replacement, expected] of [
    ['non-finite target', { targetMs: 'not-a-number', graceMs: 200, hardCeilingMs: 1100 }, /finite|number/i],
    ['negative target', { targetMs: -1, graceMs: 200, hardCeilingMs: 199 }, /non-negative|negative/i],
    ['too-small grace', { targetMs: 900, graceMs: 199, hardCeilingMs: 1099 }, /grace|200|400/i],
    ['too-large grace', { targetMs: 900, graceMs: 401, hardCeilingMs: 1301 }, /grace|200|400/i],
    ['inconsistent ceiling', { targetMs: 900, graceMs: 200, hardCeilingMs: 1101 }, /ceiling|target.*grace/i],
  ]) {
    const contractPath = writeContract(t, {
      'example.ready': validMetric({ local: replacement }),
    });
    assert.throws(
      () => loadPerformanceTimesContract({ contractPath }),
      expected,
      label,
    );
  }
});

test('checked-in timing authority contains the approved local and CI triplets', () => {
  const {
    loadPerformanceTimesContract,
    resolveTimingBudget,
  } = loadAuthority();
  const contract = loadPerformanceTimesContract();
  const approved = {
    'playback-start.maximumStartMs': {
      local: [900, 200, 1100],
      ci: [1800, 200, 2000],
    },
    'app-open-all-artists.visibleUiReadyMs': {
      local: [2100, 400, 2500],
      ci: [4600, 400, 5000],
    },
    'search-browse.searchBrowseReadyMs': {
      local: [800, 400, 1200],
      ci: [2000, 400, 2400],
    },
    'artist-family.treeNealSelectionMs': {
      local: [450, 200, 650],
      ci: [650, 200, 850],
    },
    'all-artists-local-managed-chrome.selectedArtistSelectionMs': {
      local: [350, 200, 550],
      ci: [600, 200, 800],
    },
    'all-artists.startupPreviewSidebarMs': {
      local: [881, 200, 1081],
      ci: [881, 200, 1081],
    },
    'selected-artist.selectedArtistApiMs': {
      local: [1800, 400, 2200],
      ci: [1800, 400, 2200],
    },
    'selected-artist.albumDetailsOpenMs': {
      local: [1000, 400, 1400],
      ci: [1000, 400, 1400],
    },
    'root-album-browse.rootAlbumBrowseApiMs': {
      local: [6000, 400, 6400],
      ci: [6000, 400, 6400],
    },
    'scan-cached.startupReadyMs': {
      local: [3500, 400, 3900],
      ci: [3500, 400, 3900],
    },
    'scan-add-album.uiUpdatedMs': {
      local: [40000, 400, 40400],
      ci: [40000, 400, 40400],
    },
  };

  for (const [metricId, contracts] of Object.entries(approved)) {
    for (const [contractName, [targetMaximum, graceMs, hardCeiling]] of Object.entries(contracts)) {
      assert.deepEqual(resolveTimingBudget(metricId, contractName, contract), {
        contractName,
        metricId,
        targetMaximum,
        graceMs,
        hardCeiling,
      });
    }
  }

  assert.deepEqual(
    resolveTimingBudget('search-all-artists.allArtistsSelectionMs', 'local', contract),
    {
      contractName: 'local',
      metricId: 'search-all-artists.allArtistsSelectionMs',
      targetMaximum: 2500,
      graceMs: 400,
      hardCeiling: 2900,
    },
  );
  assert.deepEqual(
    resolveTimingBudget('search-all-artists.allArtistsSelectionMs', 'ci', contract),
    {
      contractName: 'ci',
      metricId: 'search-all-artists.allArtistsSelectionMs',
      targetMaximum: 2500,
      graceMs: 400,
      hardCeiling: 2900,
    },
  );
});

test('every checked-in timing metric declares explicit local and CI contracts', () => {
  const {
    listRequiredPerformanceTimingMetricIds,
    loadPerformanceTimesContract,
    resolveTimingBudget,
  } = loadAuthority();
  const contract = loadPerformanceTimesContract();
  const requiredMetricIds = listRequiredPerformanceTimingMetricIds();

  assert.ok(Object.keys(contract).length > 6, 'the authority must cover all timing metrics, not only overrides');
  assert.ok(requiredMetricIds.length > 19, 'the required inventory must cover timing metrics across the 19 targets');
  assert.equal(new Set(requiredMetricIds).size, requiredMetricIds.length, 'required timing metric ids must be unique');
  assert.deepEqual(
    Object.keys(contract).sort(),
    [...requiredMetricIds].sort(),
    'the central registry must contain every and only the timing metrics used by performance targets',
  );
  for (const [metricId, entry] of Object.entries(contract)) {
    assert.ok(entry.local, `${metricId} is missing local timing values`);
    assert.ok(entry.ci, `${metricId} is missing CI timing values`);
    assert.doesNotThrow(() => resolveTimingBudget(metricId, 'local', contract), metricId);
    assert.doesNotThrow(() => resolveTimingBudget(metricId, 'ci', contract), metricId);
  }
});

test('CI differs from local for exactly the five owner-approved metrics', () => {
  const { loadPerformanceTimesContract } = loadAuthority();
  const contract = loadPerformanceTimesContract();
  const differingMetricIds = Object.entries(contract)
    .filter(([_metricId, entry]) => JSON.stringify(entry.local) !== JSON.stringify(entry.ci))
    .map(([metricId]) => metricId)
    .sort();

  assert.deepEqual(differingMetricIds, [
    'all-artists-local-managed-chrome.selectedArtistSelectionMs',
    'app-open-all-artists.visibleUiReadyMs',
    'artist-family.treeNealSelectionMs',
    'playback-start.maximumStartMs',
    'search-browse.searchBrowseReadyMs',
  ].sort());
});
