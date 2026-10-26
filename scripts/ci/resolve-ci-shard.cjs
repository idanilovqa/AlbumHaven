const FUNCTIONAL_SHARDS = Object.freeze({
  'gallery-search-visual': {
    displayName: 'Gallery, Search & Visual',
    portBase: 5200,
  },
  'cover-providers-1': {
    displayName: 'Cover Providers 1',
    portBase: 5300,
  },
  'cover-providers-2': {
    displayName: 'Cover Providers 2',
    portBase: 5350,
  },
  'metadata-mutations': {
    displayName: 'Metadata Mutations',
    portBase: 5400,
  },
  'playback-utilities-1': {
    displayName: 'Playback & Utilities 1',
    portBase: 5500,
  },
  'playback-utilities-2': {
    displayName: 'Playback & Utilities 2',
    portBase: 5550,
  },
  'playback-utilities-3': {
    displayName: 'Playback & Utilities 3',
    portBase: 5600,
  },
});

const PERFORMANCE_SHARDS = Object.freeze({
  'synthetic-large-library': {
    fixtureProfile: 'synthetic-large-library',
    fixtureDownloadProfile: 'synthetic-large-library',
    fixtureMode: 'preloaded-release',
    harness: 'managed-app',
    basePort: 4173,
    targets: [
      'idle-memory', 'all-artists', 'artist-family', 'search-all-artists', 'utility-rules',
      'selected-artist', 'edit-tags-post-edit', 'cover-lookup', 'album-title-search', 'track-title-search', 'search-browse', 'root-album-browse', 'artist-tree-scroll-navigation', 'app-open-all-artists', 'notification-history',
      'rules-focused', 'paired-search-calibration',
    ],
  },
  'utility-problematic-files': {
    fixtureProfile: 'utility-problematic-files',
    fixtureDownloadProfile: 'utility-problematic-files',
    fixtureMode: 'preloaded-release',
    harness: 'managed-app',
    basePort: 4253,
    targets: ['utility-problematic-files', 'problematic-files-focused'],
  },
  'playback-media': {
    fixtureProfile: 'playback-media',
    fixtureDownloadProfile: 'synthetic-large-library',
    fixtureMode: 'generated-isolated',
    harness: 'managed-app',
    basePort: 4213,
    targets: ['playback-start', 'gapless-playback'],
  },
  'scan-library': {
    fixtureProfile: 'scan-library',
    fixtureDownloadProfile: 'synthetic-large-library',
    fixtureMode: 'generated-isolated',
    harness: 'scan',
    basePort: 4293,
    targets: ['scan-cold', 'scan-cached', 'scan-add-album', 'scan-metadata', 'scan-page', 'scan-health', 'scan-error'],
  },
  'gallery-artwork-diversity': {
    fixtureProfile: 'synthetic-large-library',
    fixtureDownloadProfile: 'synthetic-large-library',
    fixtureMode: 'preloaded-derived',
    harness: 'managed-app',
    basePort: 4333,
    targets: ['gallery-artwork-diversity'],
    generatorRepository: 'idanilovqa/album-haven-test-data',
    generatorCommit: 'b7ffc6b586fd5b25a049617c5e95fbdcccfddc11',
    variantCount: 512,
    sourceMaxEdge: 960,
  },
});

function resolveFunctionalShard(shard) {
  const key = String(shard || '');
  const config = FUNCTIONAL_SHARDS[key];
  if (!config) throw new Error(`Unknown functional shard: ${key}`);
  return {
    shard: key,
    ...config,
    outputDir: `functional-output-${key}`,
    blobName: `functional-blob-${key}`,
  };
}

function resolvePerformanceShard(shard) {
  const key = String(shard || '');
  const config = PERFORMANCE_SHARDS[key];
  if (!config) throw new Error(`Unknown performance shard: ${key}`);
  return { shard: key, ...config, targets: [...config.targets] };
}

function selectFocusedPerformanceTargets(config, requestedTargets, focusedStage) {
  if (focusedStage !== 'exact' || !requestedTargets.length) return config;
  const selectedTargets = config.targets.filter((target) => requestedTargets.includes(target));
  if (!selectedTargets.length) {
    throw new Error(`Performance shard ${config.shard} does not own a requested focused target`);
  }
  return { ...config, targets: selectedTargets };
}

function outputEntries(kind, config) {
  if (kind === 'functional') {
    return [
      ['display_name', config.displayName],
      ['port_base', config.portBase],
      ['output_dir', config.outputDir],
      ['blob_name', config.blobName],
    ];
  }
  const entries = [
    ['fixture_profile', config.fixtureProfile],
    ['fixture_download_profile', config.fixtureDownloadProfile],
    ['fixture_mode', config.fixtureMode],
    ['harness', config.harness],
    ['base_port', config.basePort],
    ['targets', config.targets.join(',')],
  ];
  for (let index = 0; index < 17; index += 1) {
    entries.push([`target${index + 1}`, config.targets[index] || 'none']);
  }
  return entries;
}

function runCli(args = process.argv.slice(2), write = (text) => process.stdout.write(text)) {
  const [kind, shard] = args;
  if (!['functional', 'performance'].includes(kind) || !shard) {
    throw new Error('Usage: resolve-ci-shard.cjs <functional|performance> <shard>');
  }
  let config = kind === 'functional'
    ? resolveFunctionalShard(shard)
    : resolvePerformanceShard(shard);
  if (kind === 'performance') {
    let requestedTargets = [];
    try {
      requestedTargets = JSON.parse(process.env.FOCUSED_PERFORMANCE_TARGETS_JSON || '[]');
    } catch (error) {
      throw new Error(`FOCUSED_PERFORMANCE_TARGETS_JSON must be valid JSON: ${error.message}`);
    }
    if (!Array.isArray(requestedTargets)) {
      throw new Error('FOCUSED_PERFORMANCE_TARGETS_JSON must be an array');
    }
    config = selectFocusedPerformanceTargets(
      config,
      requestedTargets.map((target) => String(target || '').trim()).filter(Boolean),
      String(process.env.FOCUSED_STAGE || ''),
    );
  }
  const outputPath = String(process.env.GITHUB_OUTPUT || '').trim();
  const output = `${outputEntries(kind, config).map(([key, value]) => `${key}=${value}`).join('\n')}\n`;
  if (outputPath) {
    require('node:fs').appendFileSync(outputPath, output, 'utf8');
  } else {
    write(output);
  }
  return config;
}

if (require.main === module) runCli();

module.exports = {
  FUNCTIONAL_SHARDS,
  PERFORMANCE_SHARDS,
  resolveFunctionalShard,
  resolvePerformanceShard,
  selectFocusedPerformanceTargets,
  runCli,
};
