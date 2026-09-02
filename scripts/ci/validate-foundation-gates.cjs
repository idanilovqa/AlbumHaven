const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MINIMUM_PYTEST_CASES = 3037;
const MINIMUM_PYTEST_MODULES = 147;
const EXPECTED_COMPONENT_CASES = 5;

function jobSource(workflow, jobName, nextJobName) {
  const start = workflow.indexOf(`  ${jobName}:`);
  const end = workflow.indexOf(`\n  ${nextJobName}:`, start);
  if (start === -1 || end === -1) return '';
  return workflow.slice(start, end);
}

function discoverNodeTestFiles(repoRoot) {
  const testRoot = path.join(repoRoot, 'tests', 'js');
  const visit = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return visit(entryPath);
    return entry.isFile() && entry.name.endsWith('.test.js') ? [entryPath] : [];
  });
  return visit(testRoot)
    .map((filePath) => path.relative(repoRoot, filePath).replaceAll('\\', '/'))
    .sort();
}

function runNodeTests(repoRoot, options = {}) {
  const spawnSyncFn = options.spawnSyncFn || spawnSync;
  const testFiles = discoverNodeTestFiles(repoRoot);
  if (testFiles.length === 0) throw new Error('Node test discovery is empty');
  const result = spawnSyncFn(process.execPath, [
    '--test',
    '--test-concurrency=1',
    ...testFiles,
  ], {
    cwd: repoRoot,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`Node test process terminated by ${result.signal}`);
  return Number(result.status || 0);
}

function parsePlaywrightList(output) {
  return String(output || '').split(/\r?\n/).filter(
    (line) => /^\s*(?:\[[^\]]+\]\s+›\s+)?[^:]+:\d+:\d+\s+›\s+.+/.test(line),
  );
}

function discoverComponentCases(repoRoot, options = {}) {
  const spawnSyncFn = options.spawnSyncFn || spawnSync;
  const cliPath = path.join(repoRoot, 'node_modules', '@playwright', 'test', 'cli.js');
  const result = spawnSyncFn(process.execPath, [
    cliPath,
    'test',
    '--list',
    '--reporter=line',
    '--config=playwright.component.config.js',
  ], {
    cwd: repoRoot,
    env: { ...process.env, ALBUM_HAVEN_PLAYWRIGHT_INVENTORY_DISCOVERY: '1' },
    encoding: 'utf8',
    stdio: 'pipe',
    windowsHide: true,
  });
  if (result.error || result.signal || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message || '').trim();
    throw new Error(`Playwright component discovery failed${detail ? `: ${detail}` : ''}`);
  }
  return parsePlaywrightList(result.stdout);
}

function validateDependencyContract(requirements) {
  const lines = String(requirements || '').split(/\r?\n/).map((line) => line.trim().toLowerCase());
  return lines.includes('imageio-ffmpeg==0.6.0')
    ? []
    : ['CI requires imageio-ffmpeg 0.6.0 for the approved bundled FFmpeg contract'];
}

function skipAllowed(skip, allowedSkips) {
  return (allowedSkips || []).some((allowed) => {
    if (typeof allowed === 'string') return allowed === skip.nodeId;
    if (!allowed || typeof allowed !== 'object') return false;
    const nodePattern = new RegExp(allowed.nodeIdPattern || '^$');
    const reasonPattern = new RegExp(allowed.reasonPattern || '.*');
    return nodePattern.test(skip.nodeId) && reasonPattern.test(skip.reason || '');
  });
}

function validatePytestCollection(observed, policy) {
  const errors = [];
  const cases = Number(observed?.collectedCases);
  const modules = Number(observed?.collectedModules);
  if (!Number.isInteger(cases) || cases < MINIMUM_PYTEST_CASES
    || !Number.isInteger(modules) || modules < MINIMUM_PYTEST_MODULES) {
    errors.push(`pytest collection must retain at least 3,037 cases across 147 modules`);
  }
  for (const skip of observed?.skipped || []) {
    if (!skipAllowed(skip, policy?.allowedSkips || [])) {
      errors.push(`unexpected skip: ${skip.nodeId}${skip.reason ? ` (${skip.reason})` : ''}`);
    }
  }
  return errors;
}

function requirePatterns(source, patterns, label, errors) {
  for (const [pattern, description] of patterns) {
    if (!pattern.test(source)) errors.push(`${label} is missing ${description}`);
  }
}

function validateWorkflowContract(workflow) {
  const errors = [];
  if (!/^on:\r?\n\s+pull_request:/m.test(workflow)
    || /^\s{2}(?:push|schedule|workflow_dispatch|pull_request_target):/m.test(workflow)) {
    errors.push('foundation workflow must remain pull_request-only');
  }
  requirePatterns(workflow, [
    [/ExpectedMajorVersion\s+17/, 'PostgreSQL 17'],
    [/7\.1-essentials_build-www\.gyan\.dev/, 'FFmpeg 7.1-essentials_build-www.gyan.dev'],
  ], 'foundation workflow', errors);

  const jobs = {
    portable: jobSource(workflow, 'test_js', 'test_components'),
    components: jobSource(workflow, 'test_components', 'test_node_windows'),
    windowsNode: jobSource(workflow, 'test_node_windows', 'test_python'),
    python: jobSource(workflow, 'test_python', 'e2e_production_parity'),
    parity: jobSource(workflow, 'e2e_production_parity', 'e2e_phase7_auth'),
    phase7Auth: jobSource(workflow, 'e2e_phase7_auth', 'e2e_phase7_admin'),
    phase7Admin: jobSource(workflow, 'e2e_phase7_admin', 'e2e_functional'),
    functional: jobSource(workflow, 'e2e_functional', 'e2e_performance_ci'),
    performance: jobSource(workflow, 'e2e_performance_ci', 'pr_agent_review'),
  };
  if (!jobs.functional) errors.push('foundation workflow must preserve the functional job');
  if (!jobs.performance) errors.push('foundation workflow must preserve the performance job');

  for (const [name, source] of Object.entries(jobs)) {
    if (!source && !['functional', 'performance'].includes(name)) {
      errors.push(`foundation workflow is missing ${name} job`);
    }
  }

  for (const [name, source] of [['portable', jobs.portable], ['components', jobs.components], ['production parity', jobs.parity]]) {
    if (!source) continue;
    if (!/runs-on:\s*ubuntu-latest/.test(source)) errors.push(`${name} job must run on Ubuntu`);
    if (/github\.event\.pull_request\.head\.repo\.full_name\s*==\s*github\.repository/.test(source)) {
      errors.push(`${name} portable job must remain available to forks without secrets`);
    }
    if (/secrets\./.test(source)) errors.push(`${name} portable job must not receive secrets`);
  }

  for (const [name, source] of [['windows Node', jobs.windowsNode], ['Windows Python', jobs.python]]) {
    if (!source) continue;
    if (!/runs-on:\s*windows-2025/.test(source)) errors.push(`${name} job must run on windows-2025`);
    if (!/github\.event\.pull_request\.head\.repo\.full_name\s*==\s*github\.repository/.test(source)) {
      errors.push(`${name} job must be limited to a same-repository pull request`);
    }
    requirePatterns(source, [
      [/node-version:\s*["']22["']/, 'Node.js 22'],
      [/python-version:\s*["']3\.11["']/, 'Python 3.11'],
      [/cache:\s*npm/, 'npm cache'],
      [/cache:\s*pip/, 'pip cache'],
      [/cache-dependency-path:\s*requirements\.txt/, 'Python cache dependency path requirements.txt'],
      [/-Mode\s+Provision/, 'isolated PostgreSQL provision'],
      [/-Mode\s+Teardown/, 'isolated PostgreSQL teardown'],
      [/\$env:PGPASSWORD\s*=\s*\$null[\s\S]*write-foundation-version-manifest\.cjs\s+--profile=windows/, 'clear inherited PostgreSQL admin password before version manifest'],
      [/write-foundation-version-manifest\.cjs\s+--profile=windows/, 'Windows version manifest validation'],
      [/foundation-versions-[^\r\n]*github\.run_attempt/, 'run-attempt version manifest artifact'],
      [/if:\s*\$\{\{\s*always\(\)\s*\}\}/, 'always-running evidence upload'],
    ], name, errors);
  }

  requirePatterns(jobs.portable, [
    [/node-version:\s*["']22["']/, 'Node.js 22'],
    [/python-version:\s*["']3\.11["']/, 'Python 3.11'],
    [/cache:\s*npm/, 'npm cache'],
    [/cache-dependency-path:\s*package-lock\.json/, 'package-lock.json cache dependency path'],
    [/cache:\s*pip/, 'pip cache'],
    [/npm run test:js:all/, 'complete glob-discovered Node suite'],
    [/timeout-minutes:\s*45/, 'bounded timeout'],
    [/write-foundation-version-manifest\.cjs\s+--profile=component/, 'version manifest validation'],
    [/version-manifest/, 'version manifest artifact'],
    [/if:\s*\$\{\{\s*always\(\)\s*\}\}/, 'version manifest upload must always run'],
  ], 'portable JavaScript job', errors);
  requirePatterns(jobs.components, [
    [/node-version:\s*["']22["']/, 'Node.js 22'],
    [/chrome-version:\s*["']151\.0\.7922\.138["']/, 'published pinned Chrome 151.0.7922.138'],
    [/PLAYWRIGHT_CHROME_EXECUTABLE/, 'pinned Chrome executable handoff'],
    [/npm run test:component/, 'all component cases'],
    [/write-foundation-version-manifest\.cjs\s+--profile=component/, 'component version manifest'],
  ], 'component job', errors);
  requirePatterns(jobs.windowsNode, [
    [/npm run test:js:all/, 'complete Windows Node contract suite'],
  ], 'Windows Node job', errors);
  requirePatterns(jobs.python, [
    [/pytest\s+--collect-only\s+-q/, 'pytest collection inventory'],
    [/--pytest-collection=/, 'pytest collection-floor validation'],
    [/pytest\s+-q\s+--junitxml=/, 'complete pytest JUnit run'],
    [/--pytest-junit=/, 'unexpected-skip validation'],
    [/--allowed-skips=/, 'allowed skips option'],
    [/pytest-allowed-skips\.json/, 'explicit skip allowlist'],
  ], 'Python job', errors);
  requirePatterns(jobs.parity, [
    [/npm run check:e2e-production-parity/, 'production parity command'],
  ], 'production parity job', errors);

  for (const [name, source, command] of [
    ['Phase 7 auth', jobs.phase7Auth, 'npm run test:e2e:phase7:auth'],
    ['Phase 7 admin', jobs.phase7Admin, 'npm run test:e2e:phase7:admin'],
  ]) {
    if (!source) continue;
    if (!/runs-on:\s*windows-2025/.test(source)) errors.push(`${name} job must run on windows-2025`);
    if (!/github\.event\.pull_request\.head\.repo\.full_name\s*==\s*github\.repository/.test(source)) {
      errors.push(`${name} job must be limited to a same-repository pull request`);
    }
    for (const dependency of ['test_js', 'test_components', 'test_node_windows', 'test_python', 'e2e_production_parity']) {
      if (!new RegExp(`- ${dependency}(?:\\r?\\n|$)`).test(source)) {
        errors.push(`${name} job is missing foundation dependency ${dependency}`);
      }
    }
    requirePatterns(source, [
      [/node-version:\s*["']22["']/, 'Node.js 22'],
      [/python-version:\s*["']3\.11["']/, 'Python 3.11'],
      [/chrome-version:\s*["']151\.0\.7922\.138["']/, 'pinned Chrome'],
      [/PLAYWRIGHT_BROWSER:\s*chrome/, 'pinned Chrome selection'],
      [/PLAYWRIGHT_CHROME_EXECUTABLE/, 'pinned Chrome executable handoff'],
      [/-Mode\s+Provision/, 'isolated PostgreSQL provision'],
      [/-Mode\s+Teardown/, 'isolated PostgreSQL teardown'],
      [new RegExp(command.replaceAll(':', '\\:')), 'dedicated Playwright command'],
    ], name, errors);
  }

  for (const source of [jobs.functional, jobs.performance]) {
    if (!source) continue;
    for (const dependency of ['test_js', 'test_components', 'test_node_windows', 'test_python', 'e2e_production_parity']) {
      if (!new RegExp(`- ${dependency}(?:\\r?\\n|$)`).test(source)) {
        errors.push(`heavy browser job is missing foundation dependency ${dependency}`);
      }
    }
  }
  requirePatterns(jobs.functional, [
    [/\$env:PGPASSWORD\s*=\s*\$null[\s\S]*write-foundation-version-manifest\.cjs\s+--profile=windows/, 'clear inherited PostgreSQL admin password before version manifest'],
    [/write-foundation-version-manifest\.cjs\s+--profile=windows/, 'Windows version manifest validation'],
    [/foundation-versions-[^\r\n]*github\.run_attempt/, 'run-attempt version manifest artifact'],
    [/if:\s*\$\{\{\s*always\(\)\s*\}\}/, 'always-running version manifest upload'],
  ], 'functional browser job', errors);
  requirePatterns(jobs.performance, [
    [/run-performance-shard\.ps1/, 'shared PostgreSQL performance shard runner'],
    [/foundation-versions-performance-[^\r\n]*github\.run_attempt/, 'per-target run-attempt version manifest artifact'],
    [/if:\s*\$\{\{\s*always\(\)/, 'always-running version manifest upload'],
  ], 'performance browser job', errors);
  if (/name:\s*Write performance foundation version manifest/.test(jobs.performance)) {
    errors.push('performance browser job must not probe the PostgreSQL version before shard provisioning');
  }
  return errors;
}

function parsePytestCollectionOutput(output, repoRoot) {
  const source = String(output || '');
  const match = source.match(/(\d+) tests? collected/i);
  const modules = new Set();
  for (const line of source.split(/\r?\n/)) {
    const moduleMatch = /^\s*(tests[\\/]py[\\/]test_[^:\s]+\.py)(?:::|\s|$)/.exec(line);
    if (moduleMatch) modules.add(moduleMatch[1].replaceAll('\\', '/'));
  }
  return { collectedCases: match ? Number(match[1]) : 0, collectedModules: modules.size, skipped: [] };
}

function decodeXml(value) {
  return String(value || '')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function parsePytestJunit(xml) {
  const skipped = [];
  const testCasePattern = /<testcase\b([^>]*?)(?<!\/)>([\s\S]*?)<\/testcase>/g;
  for (const match of String(xml || '').matchAll(testCasePattern)) {
    if (!/<skipped\b/.test(match[2])) continue;
    const attributes = match[1];
    const className = /(?:^|\s)classname="([^"]*)"/.exec(attributes)?.[1] || '';
    const name = /(?:^|\s)name="([^"]*)"/.exec(attributes)?.[1] || '';
    const skipTag = /<skipped\b([^>]*)/.exec(match[2])?.[1] || '';
    const reason = /message="([^"]*)"/.exec(skipTag)?.[1] || '';
    skipped.push({ nodeId: `${decodeXml(className)}::${decodeXml(name)}`, reason: decodeXml(reason) });
  }
  return skipped;
}

module.exports = {
  discoverComponentCases,
  discoverNodeTestFiles,
  parsePlaywrightList,
  parsePytestCollectionOutput,
  parsePytestJunit,
  runNodeTests,
  validateDependencyContract,
  validatePytestCollection,
  validateWorkflowContract,
};

if (require.main === module) {
  try {
    const repoRoot = path.resolve(__dirname, '..', '..');
    const workflow = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'pr-gates.yml'), 'utf8');
    const requirements = fs.readFileSync(path.join(repoRoot, 'requirements.txt'), 'utf8');
    const errors = [
      ...validateWorkflowContract(workflow),
      ...validateDependencyContract(requirements),
    ];
    if (process.argv.includes('--list')) {
      const nodeFiles = discoverNodeTestFiles(repoRoot);
      if (nodeFiles.length === 0) errors.push('Node test discovery is empty');
      const componentCases = discoverComponentCases(repoRoot);
      if (componentCases.length !== EXPECTED_COMPONENT_CASES) {
        errors.push(`component discovery must contain ${EXPECTED_COMPONENT_CASES} cases`);
      }
    }
    if (process.argv.includes('--run-node-tests')) {
      const status = runNodeTests(repoRoot);
      if (status !== 0) process.exitCode = status;
    }
    const collectionArg = process.argv.find((arg) => arg.startsWith('--pytest-collection='));
    if (collectionArg) {
      const collectionPath = collectionArg.slice('--pytest-collection='.length);
      errors.push(...validatePytestCollection(
        parsePytestCollectionOutput(fs.readFileSync(collectionPath, 'utf8'), repoRoot),
        { allowedSkips: [] },
      ));
    }
    const junitArg = process.argv.find((arg) => arg.startsWith('--pytest-junit='));
    if (junitArg) {
      const allowlistArg = process.argv.find((arg) => arg.startsWith('--allowed-skips='));
      if (!allowlistArg) throw new Error('--allowed-skips is required with --pytest-junit');
      const allowedSkips = JSON.parse(fs.readFileSync(allowlistArg.slice('--allowed-skips='.length), 'utf8'));
      const skipped = parsePytestJunit(fs.readFileSync(junitArg.slice('--pytest-junit='.length), 'utf8'));
      errors.push(...validatePytestCollection(
        { collectedCases: MINIMUM_PYTEST_CASES, collectedModules: MINIMUM_PYTEST_MODULES, skipped },
        { allowedSkips },
      ));
    }
    if (errors.length > 0) {
      for (const error of errors) process.stderr.write(`${error}\n`);
      process.exitCode = 1;
    } else if (!process.argv.includes('--run-node-tests')) {
      process.stdout.write('foundation gates validated\n');
    }
  } catch (error) {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  }
}
