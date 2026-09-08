const FUNCTIONAL_SHARDS = Object.freeze({
  'gallery-search-visual': {
    displayName: 'Gallery, Search & Visual',
    portBase: 5200,
  },
  'cover-providers': {
    displayName: 'Cover Providers',
    portBase: 5300,
  },
  'metadata-mutations': {
    displayName: 'Metadata Mutations',
    portBase: 5400,
  },
  'playback-utilities': {
    displayName: 'Playback & Utilities',
    portBase: 5500,
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
      'selected-artist', 'search-browse', 'root-album-browse', 'app-open-all-artists',
      'rules-focused',
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
    targets: ['scan-cold', 'scan-cached', 'scan-add-album', 'scan-metadata', 'scan-page'],
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
  for (let index = 0; index < 10; index += 1) {
    entries.push([`target${index + 1}`, config.targets[index] || 'none']);
  }
  return entries;
}

function runCli(args = process.argv.slice(2), write = (text) => process.stdout.write(text)) {
  const [kind, shard] = args;
  if (!['functional', 'performance'].includes(kind) || !shard) {
    throw new Error('Usage: resolve-ci-shard.cjs <functional|performance> <shard>');
  }
  const config = kind === 'functional'
    ? resolveFunctionalShard(shard)
    : resolvePerformanceShard(shard);
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
  runCli,
};
