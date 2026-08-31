const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const INCREMENTAL_LINE_LIMIT = 250;

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

function classifyReviewScope({ action, baseSha, lastReviewedSha, headSha, numstat }) {
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

  let mode = 'full';
  if (hasSuccessfulBaseline) {
    mode = functionalChange
      && !hasBinaryFunctionalChange
      && functionalLines <= INCREMENTAL_LINE_LIMIT
      ? 'incremental'
      : functionalChange ? 'full' : 'none';
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
  const diffBase = action === 'synchronize' && lastReviewedSha ? lastReviewedSha : baseSha;
  const numstat = execFileSync(
    'git',
    ['diff', '--numstat', '--no-renames', diffBase, headSha],
    { encoding: 'utf8' },
  );
  const result = classifyReviewScope({ action, baseSha, lastReviewedSha, headSha, numstat });
  const outputPath = requireValue(env.GITHUB_OUTPUT, 'GITHUB_OUTPUT');
  const output = [
    `mode=${result.mode}`,
    `base_sha=${result.baseSha}`,
    `head_sha=${result.headSha}`,
    `functional_change=${String(result.functionalChange)}`,
    `functional_lines=${result.functionalLines}`,
    `binary_functional_change=${String(result.hasBinaryFunctionalChange)}`,
  ].join('\n');
  fs.appendFileSync(outputPath, `${output}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

if (require.main === module) runCli();

module.exports = {
  INCREMENTAL_LINE_LIMIT,
  isDocumentationPath,
  parseNumstat,
  classifyReviewScope,
  isUsableBaseline,
  runCli,
};
