const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { discoverFunctionalCases } = require('./validate-functional-shards.cjs');

const repoRoot = path.resolve(__dirname, '..', '..');
const playwrightCli = path.join(repoRoot, 'node_modules', '@playwright', 'test', 'cli.js');

const surfaces = [
  { config: 'playwright.mobile-layout.config.js', category: 'mobile', testDirectory: 'tests/e2e/mobile-layout' },
  { config: 'playwright.mobile-feedback.config.js', category: 'mobile', testDirectory: 'tests/e2e/mobile-feedback' },
  { config: 'playwright.config.js', category: 'browserFunctional' },
  { config: 'playwright.autoplay-allowed.config.js', category: 'browserFunctional' },
  { config: 'playwright.cover-rescan.config.js', category: 'browserFunctional' },
  { config: 'playwright.lastfm-auto-timezone.config.js', category: 'browserFunctional' },
  { config: 'playwright.non-album-rescan.config.js', category: 'browserFunctional' },
  { config: 'playwright.component.config.js', category: 'component', testDirectory: 'tests/components' },
  { config: 'playwright.synthetic-large-library.config.cjs', category: 'performance', testDirectory: 'tests/e2e/syntheticLargeLibrary' },
  { config: 'playwright.utility-problematic-files.config.cjs', category: 'performance', testDirectory: 'tests/e2e/utilityProblematicFiles' },
  { config: 'playwright.performance.config.cjs', category: 'performance', testDirectory: 'tests/e2e/performance' },
  { config: 'playwright.scan-performance.config.cjs', category: 'performance', testDirectory: 'tests/e2e/scanPerformance' },
];

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'));
}

function listSurface(surface) {
  const result = spawnSync(
    process.execPath,
    [playwrightCli, 'test', '--list', '--reporter=line', `--config=${surface.config}`],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        PLAYWRIGHT_MANAGED_APP: '1',
        PLAYWRIGHT_MANAGED_SCAN_APP: '1',
        ALBUM_HAVEN_PLAYWRIGHT_INVENTORY_DISCOVERY: '1',
      },
      windowsHide: true,
    },
  );
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`Playwright discovery failed for ${surface.config}: ${detail}`);
  }

  const totalMatch = result.stdout.match(/Total:\s+(\d+)\s+tests?/);
  if (!totalMatch) throw new Error(`Playwright discovery did not report a total for ${surface.config}`);
  const identities = [...result.stdout.matchAll(/^\s*(?:\[([^\]]*)\]\s*›\s*)?(.+?):\d+:\d+\s*›\s*(.+)$/gm)].map(match => {
    const listedPath = match[2].replaceAll('\\', '/');
    return {
      config: surface.config,
      project: match[1] || '',
      test: listedPath.startsWith('tests/') ? listedPath : path.posix.join(surface.testDirectory || 'tests/e2e/specs', listedPath),
      case: match[3].trim(),
    };
  });
  if (identities.length !== Number(totalMatch[1])) throw new Error(`Incomplete case identity discovery for ${surface.config}`);
  return describeSurface(surface, identities);
}

function describeSurface(surface, identities) {
  const projects = identities.map(entry => entry.project);
  return {
    config: surface.config,
    category: surface.category,
    projects: projects.length > 0 ? [...new Set(projects)] : [''],
    cases: identities.length,
    identities,
  };
}

// Functional ownership and execution use native leaf titles, not line-reporter
// display paths (which include describe labels separated by presentation glyphs).
const functionalCases = discoverFunctionalCases({ repoRoot });
const discovered = surfaces.map(surface => surface.category === 'browserFunctional'
  ? describeSurface(surface, functionalCases.filter(entry => entry.config === surface.config)
    .map(({ config, project, test, case: title }) => ({ config, project, test, case: title })))
  : listSurface(surface));
const categories = {
  browserFunctional: 0,
  mobile: 0,
  component: 0,
  performance: 0,
  total: 0,
};
for (const surface of discovered) {
  categories[surface.category] += surface.cases;
  categories.total += surface.cases;
}

const matrix = readJson('tests/ci/test-data-matrix.json');
const functionalShards = readJson('tests/ci/functional-shards.json');
const performanceTargets = readJson('tests/ci/performance-targets.json');
const ownership = {
  testDataMatrix: matrix.length,
  functionalShards: functionalShards.shards
    .flatMap((shard) => shard.invocations)
    .flatMap((invocation) => invocation.cases).length,
  performanceTargets: performanceTargets.targets.flatMap((target) => target.cases).length,
};

const inventory = {
  configuredSurfaces: discovered.length,
  categories,
  ownership,
  surfaces: discovered,
  caseIdentities: discovered.flatMap(surface => surface.identities),
};

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(inventory)}\n`);
} else {
  for (const surface of discovered) {
    const projects = surface.projects.map((project) => project || '<implicit>').join(', ');
    process.stdout.write(`${surface.config}: ${surface.cases} cases (${projects})\n`);
  }
  process.stdout.write(`total: ${categories.total} cases\n`);
  process.stdout.write(`ownership: matrix=${ownership.testDataMatrix}, functional=${ownership.functionalShards}, performance=${ownership.performanceTargets}\n`);
}
