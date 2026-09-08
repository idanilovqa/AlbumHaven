const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const INCREMENTAL_LINE_LIMIT = 250;
const FOCUSED_E2E_LABEL = 'ci:focused-e2e';
const FORCE_FULL_REVIEW_LABEL = 'ci:full-review';
const FOCUSED_RELATED_LABEL = 'ci:focused-related';
const FOCUSED_REQUEST_PATTERN = /<!--\s*album-haven-focused-e2e:({[\s\S]*?})\s*-->/gi;
const SUPPORTED_FOCUSED_AREAS = Object.freeze([
  'gallery-search',
  'album-details',
  'cover-providers',
  'tag-edit',
  'problematic-files',
  'utility-rules',
  'playback',
  'loops',
  'responsive-visual',
]);
const FUNCTIONAL_SHARDS = [
  'gallery-search-visual',
  'cover-providers',
  'metadata-mutations',
  'playback-utilities',
];
const PHASE7_TARGETS = ['phase7-auth', 'phase7-admin'];
const PERFORMANCE_SHARDS = [
  'synthetic-large-library',
  'utility-problematic-files',
  'playback-media',
  'scan-library',
];

function normalizePath(filePath) {
  return String(filePath || '').replaceAll('\\', '/').replace(/^\.\//, '');
}

function isDocumentationPath(filePath) {
  const normalized = normalizePath(filePath);
  const lower = normalized.toLowerCase();
  return lower.startsWith('docs/') || (!normalized.includes('/') && lower.endsWith('.md'));
}

function parseNumstat(numstat) {
  return String(numstat || '')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const firstTab = line.indexOf('\t');
      const secondTab = line.indexOf('\t', firstTab + 1);
      if (firstTab < 1 || secondTab <= firstTab + 1 || secondTab === line.length - 1) {
        throw new Error(`Invalid git numstat line: ${line}`);
      }
      const additionsText = line.slice(0, firstTab);
      const deletionsText = line.slice(firstTab + 1, secondTab);
      const binary = additionsText === '-' || deletionsText === '-';
      if (!binary && (!/^\d+$/.test(additionsText) || !/^\d+$/.test(deletionsText))) {
        throw new Error(`Invalid git numstat counts: ${line}`);
      }
      return {
        additions: binary ? 0 : Number(additionsText),
        deletions: binary ? 0 : Number(deletionsText),
        binary,
        path: normalizePath(line.slice(secondTab + 1)),
      };
    });
}

function requireValue(value, name) {
  if (!String(value || '').trim()) throw new Error(`${name} is required`);
  return String(value).trim();
}

function classifyReviewScope({
  action,
  baseSha,
  lastReviewedSha,
  headSha,
  numstat,
  forceFullReview = false,
}) {
  const eventAction = requireValue(action, 'action');
  const prBaseSha = requireValue(baseSha, 'baseSha');
  const prHeadSha = requireValue(headSha, 'headSha');
  const successfulBaselineSha = String(lastReviewedSha || '').trim();
  const hasSuccessfulBaseline = eventAction === 'synchronize' && successfulBaselineSha.length > 0;
  const comparisonBaseSha = hasSuccessfulBaseline ? successfulBaselineSha : prBaseSha;
  const functionalFiles = parseNumstat(numstat).filter((entry) => !isDocumentationPath(entry.path));
  const functionalChange = functionalFiles.length > 0;
  const functionalLines = functionalFiles.reduce(
    (total, entry) => total + entry.additions + entry.deletions,
    0,
  );
  const hasBinaryFunctionalChange = functionalFiles.some((entry) => entry.binary);

  let mode = 'none';
  if (functionalChange) {
    mode = hasSuccessfulBaseline
      && !forceFullReview
      && !hasBinaryFunctionalChange
      && functionalLines < INCREMENTAL_LINE_LIMIT
      ? 'incremental'
      : 'full';
  }

  return {
    mode,
    baseSha: mode === 'full' ? prBaseSha : comparisonBaseSha,
    headSha: prHeadSha,
    functionalChange,
    functionalLines,
    hasBinaryFunctionalChange,
  };
}

function normalizeLabels(labels) {
  if (!Array.isArray(labels)) throw new Error('labels must be an array');
  return [...new Set(labels.map((label) => String(label || '').trim()).filter(Boolean))];
}

function parseFocusedE2eRequest(body) {
  const matches = [...String(body || '').matchAll(FOCUSED_REQUEST_PATTERN)];
  if (!matches.length) return { exactCases: [], areas: [] };
  if (matches.length !== 1) throw new Error('Focused E2E request must contain exactly one marker');
  const match = matches[0];
  if (match[1].length > 4096) throw new Error('Focused E2E request exceeds 4096 characters');
  let parsed;
  try {
    parsed = JSON.parse(match[1]);
  } catch (error) {
    throw new Error(`Focused E2E request must contain valid JSON: ${error.message}`);
  }
  const exactCases = [...new Set((Array.isArray(parsed.exactCases) ? parsed.exactCases : [])
    .map((value) => String(value || '').trim()).filter(Boolean))];
  const areas = [...new Set((Array.isArray(parsed.areas) ? parsed.areas : [])
    .map((value) => String(value || '').trim()).filter(Boolean))];
  const unsupported = areas.find((area) => !SUPPORTED_FOCUSED_AREAS.includes(area));
  if (unsupported) throw new Error(`Unsupported focused E2E area: ${unsupported}`);
  const invalidCase = exactCases.find((caseId) => !/^FTC-[A-Z0-9-]+$/.test(caseId));
  if (invalidCase) throw new Error(`Focused E2E case must be an exact FTC ID: ${invalidCase}`);
  return { exactCases, areas };
}

function classifyPipelineLabels(labels, request = { exactCases: [], areas: [] }) {
  const normalized = normalizeLabels(labels);
  const labelSet = new Set(normalized);
  const focused = labelSet.has(FOCUSED_E2E_LABEL);
  const focusedStage = focused
    ? labelSet.has(FOCUSED_RELATED_LABEL) ? 'related' : 'exact'
    : 'full';
  const focusedFunctionalShards = FUNCTIONAL_SHARDS.filter((shard) => (
    labelSet.has(`ci:e2e:${shard}`)
  ));
  const focusedPhase7Targets = PHASE7_TARGETS.filter((target) => (
    labelSet.has(`ci:e2e:${target}`)
  ));
  const focusedPerformanceShards = PERFORMANCE_SHARDS.filter((shard) => (
    labelSet.has(`ci:e2e-performance:${shard}`)
  ));

  if (focused) {
    const targetPrefixes = ['ci:e2e:', 'ci:e2e-performance:'];
    const supportedTargetLabels = new Set([
      ...FUNCTIONAL_SHARDS.map((shard) => `ci:e2e:${shard}`),
      ...PHASE7_TARGETS.map((target) => `ci:e2e:${target}`),
      ...PERFORMANCE_SHARDS.map((shard) => `ci:e2e-performance:${shard}`),
    ]);
    const unsupported = normalized.find((label) => (
      targetPrefixes.some((prefix) => label.startsWith(prefix))
      && !supportedTargetLabels.has(label)
    ));
    if (unsupported) throw new Error(`Unsupported focused E2E target label: ${unsupported}`);
    const markerSelection = request.exactCases.length + request.areas.length > 0;
    if (markerSelection && (!request.exactCases.length || !request.areas.length)) {
      throw new Error(`${FOCUSED_E2E_LABEL} marker requires both exact cases and related areas`);
    }
    if (
      focusedFunctionalShards.length
      + focusedPhase7Targets.length
      + focusedPerformanceShards.length === 0
      && request.exactCases.length + request.areas.length === 0
    ) {
      throw new Error(`${FOCUSED_E2E_LABEL} requires at least one supported target label`);
    }
  }

  return {
    pipelineMode: focused ? 'focused-e2e' : 'full',
    focusedStage,
    focusedExactCases: focused ? request.exactCases : [],
    focusedAreas: focused ? request.areas : [],
    forceFullReview: !focused && labelSet.has(FORCE_FULL_REVIEW_LABEL),
    focusedFunctionalShards: focused ? focusedFunctionalShards : [],
    focusedPhase7Targets: focused ? focusedPhase7Targets : [],
    focusedPerformanceShards: focused ? focusedPerformanceShards : [],
  };
}

function requireSha(value, name) {
  const sha = requireValue(value, name);
  if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error(`${name} must be a 40-character Git SHA`);
  return sha;
}

function isUsableBaseline(lastReviewedSha, headSha, runGit = execFileSync) {
  try {
    runGit('git', ['cat-file', '-e', `${lastReviewedSha}^{commit}`], { stdio: 'ignore' });
    runGit('git', ['merge-base', '--is-ancestor', lastReviewedSha, headSha], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function runCli(env = process.env) {
  const action = requireValue(env.PR_EVENT_ACTION, 'PR_EVENT_ACTION');
  const baseSha = requireSha(env.PR_BASE_SHA, 'PR_BASE_SHA');
  const headSha = requireSha(env.PR_HEAD_SHA, 'PR_HEAD_SHA');
  let lastReviewedSha = String(env.PR_LAST_REVIEWED_SHA || '').trim();
  if (lastReviewedSha) {
    lastReviewedSha = requireSha(lastReviewedSha, 'PR_LAST_REVIEWED_SHA');
    if (!isUsableBaseline(lastReviewedSha, headSha)) {
      process.stderr.write('The last reviewed commit is unavailable or not an ancestor; forcing a whole-PR review.\n');
      lastReviewedSha = '';
    }
  }
  let labels;
  try {
    labels = JSON.parse(String(env.PR_LABELS_JSON || '[]'));
  } catch (error) {
    throw new Error(`PR_LABELS_JSON must be valid JSON: ${error.message}`);
  }
  const focusedRequest = parseFocusedE2eRequest(env.PR_BODY || '');
  const pipeline = classifyPipelineLabels(labels, focusedRequest);
  const diffBase = action === 'synchronize' && lastReviewedSha ? lastReviewedSha : baseSha;
  const numstat = execFileSync(
    'git',
    ['diff', '--numstat', '--no-renames', diffBase, headSha],
    { encoding: 'utf8' },
  );
  const review = classifyReviewScope({
    action,
    baseSha,
    lastReviewedSha,
    headSha,
    numstat,
    forceFullReview: pipeline.forceFullReview,
  });
  if (pipeline.pipelineMode === 'focused-e2e') review.mode = 'none';
  let focusedSelection = { shards: [], selectedCases: [] };
  if (pipeline.pipelineMode === 'focused-e2e' && (pipeline.focusedExactCases.length || pipeline.focusedAreas.length)) {
    const { selectFunctionalCases } = require('./validate-functional-shards.cjs');
    const contract = JSON.parse(fs.readFileSync(require('node:path').join(__dirname, '..', '..', 'tests', 'ci', 'functional-shards.json'), 'utf8'));
    focusedSelection = selectFunctionalCases(contract, pipeline.focusedStage === 'exact'
      ? { exactCases: pipeline.focusedExactCases }
      : { areas: pipeline.focusedAreas });
  }
  const functionalShards = pipeline.pipelineMode === 'full'
    ? FUNCTIONAL_SHARDS
    : focusedSelection.shards.length
      ? focusedSelection.shards.map((shard) => shard.name)
      : pipeline.focusedFunctionalShards;
  const performanceShards = pipeline.pipelineMode === 'full'
    ? PERFORMANCE_SHARDS
    : pipeline.focusedPerformanceShards;
  const result = { ...review, ...pipeline };
  const outputPath = requireValue(env.GITHUB_OUTPUT, 'GITHUB_OUTPUT');
  const output = [
    `mode=${result.mode}`,
    `base_sha=${result.baseSha}`,
    `head_sha=${result.headSha}`,
    `functional_change=${String(result.functionalChange)}`,
    `functional_lines=${result.functionalLines}`,
    `binary_functional_change=${String(result.hasBinaryFunctionalChange)}`,
    `pipeline_mode=${pipeline.pipelineMode}`,
    `focused_stage=${pipeline.focusedStage}`,
    `focused_exact_cases_json=${JSON.stringify(pipeline.focusedExactCases)}`,
    `focused_areas_json=${JSON.stringify(pipeline.focusedAreas)}`,
    `focused_run_cases_json=${JSON.stringify(focusedSelection.selectedCases.map((ownedCase) => ownedCase.case))}`,
    `functional_shards_json=${JSON.stringify(functionalShards)}`,
    `performance_shards_json=${JSON.stringify(performanceShards)}`,
    `run_functional=${String(functionalShards.length > 0)}`,
    `run_performance=${String(performanceShards.length > 0)}`,
    `run_phase7_auth=${String(pipeline.pipelineMode === 'full' || pipeline.focusedPhase7Targets.includes('phase7-auth'))}`,
    `run_phase7_admin=${String(pipeline.pipelineMode === 'full' || pipeline.focusedPhase7Targets.includes('phase7-admin'))}`,
    `selected_families_json=${JSON.stringify([
      ...(functionalShards.length ? ['e2e_functional'] : []),
      ...(pipeline.pipelineMode === 'full' || pipeline.focusedPhase7Targets.includes('phase7-auth') ? ['e2e_phase7_auth'] : []),
      ...(pipeline.pipelineMode === 'full' || pipeline.focusedPhase7Targets.includes('phase7-admin') ? ['e2e_phase7_admin'] : []),
      ...(performanceShards.length ? ['e2e_performance_ci'] : []),
    ])}`,
  ].join('\n');
  fs.appendFileSync(outputPath, `${output}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

if (require.main === module) runCli();

module.exports = {
  FOCUSED_E2E_LABEL,
  FOCUSED_RELATED_LABEL,
  FORCE_FULL_REVIEW_LABEL,
  FUNCTIONAL_SHARDS,
  INCREMENTAL_LINE_LIMIT,
  PERFORMANCE_SHARDS,
  PHASE7_TARGETS,
  classifyPipelineLabels,
  parseFocusedE2eRequest,
  isDocumentationPath,
  parseNumstat,
  classifyReviewScope,
  isUsableBaseline,
  runCli,
};
