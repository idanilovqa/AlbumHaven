const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');
const playwrightCli = path.join(repoRoot, 'node_modules', '@playwright', 'test', 'cli.js');
const ciRoot = path.join(repoRoot, 'tests', 'ci');

const surfaces = [
  { config: 'playwright.config.js', category: 'browserFunctional' },
  { config: 'playwright.autoplay-allowed.config.js', category: 'browserFunctional' },
  { config: 'playwright.cover-rescan.config.js', category: 'browserFunctional' },
  { config: 'playwright.lastfm-auto-timezone.config.js', category: 'browserFunctional' },
  { config: 'playwright.non-album-rescan.config.js', category: 'browserFunctional' },
  { config: 'playwright.component.config.js', category: 'component' },
  { config: 'playwright.synthetic-large-library.config.cjs', category: 'performance' },
  { config: 'playwright.utility-problematic-files.config.cjs', category: 'performance' },
  { config: 'playwright.performance.config.cjs', category: 'performance' },
  { config: 'playwright.scan-performance.config.cjs', category: 'performance' },
];

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'));
}

function listSurface(surface) {
  const result = spawnSync(
    process.execPath,
    [playwrightCli, 'test', '--list', `--config=${surface.config}`],
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
  const projects = [...result.stdout.matchAll(/^\s*\[([^\]]*)\]\s*›/gm)].map((match) => match[1]);
  return {
    config: surface.config,
    category: surface.category,
    projects: projects.length > 0 ? [...new Set(projects)] : [''],
    cases: Number(totalMatch[1]),
  };
}

const discovered = surfaces.map(listSurface);
const categories = {
  browserFunctional: 0,
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
