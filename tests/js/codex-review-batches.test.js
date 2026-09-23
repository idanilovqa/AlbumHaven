const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const test = require('node:test');

const plannerPath = path.resolve(__dirname, '../../scripts/ci/plan-codex-review.cjs');
const validatorPath = path.resolve(__dirname, '../../scripts/ci/validate-codex-review-batches.cjs');
function engine() {
  assert.ok(fs.existsSync(plannerPath), 'complete Git review planner must exist');
  assert.ok(fs.existsSync(validatorPath), 'complete review result validator must exist');
  return { ...require(plannerPath), ...require(validatorPath) };
}
function git(repositoryPath, args) {
  const result = cp.spawnSync('git', args, { cwd: repositoryPath, encoding: 'utf8',
    windowsHide: true, timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function fixture(t, before, after, baseOnly = null) {
  const parent = fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(parent, 'album-haven-review-batches-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), parent);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const repositoryPath = path.join(directory, 'repo');
  fs.mkdirSync(repositoryPath);
  git(repositoryPath, ['init', '--initial-branch=main']);
  git(repositoryPath, ['config', 'user.name', 'Review Test']);
  git(repositoryPath, ['config', 'user.email', 'review@example.invalid']);
  git(repositoryPath, ['config', 'commit.gpgsign', 'false']);
  git(repositoryPath, ['config', 'core.autocrlf', 'false']);
  const write = entries => {
    for (const [filename, contents] of Object.entries(entries)) {
      const target = path.join(repositoryPath, filename);
      if (contents === null) fs.unlinkSync(target);
      else { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, contents); }
    }
  };
  write(before);
  git(repositoryPath, ['add', '.']);
  git(repositoryPath, ['commit', '-m', 'base']);
  let baseSha = git(repositoryPath, ['rev-parse', 'HEAD']);
  git(repositoryPath, ['checkout', '-b', 'review']);
  write(after);
  git(repositoryPath, ['add', '-A']);
  git(repositoryPath, ['commit', '-m', 'review changes']);
  const headSha = git(repositoryPath, ['rev-parse', 'HEAD']);
  git(repositoryPath, ['checkout', 'main']);
  if (baseOnly) {
    write(baseOnly);
    git(repositoryPath, ['add', '-A']);
    git(repositoryPath, ['commit', '-m', 'base branch advanced']);
    baseSha = git(repositoryPath, ['rev-parse', 'HEAD']);
  }
  git(repositoryPath, ['merge', '--no-ff', 'review', '-m', 'test merge']);
  return { repositoryPath, outputDir: path.join(directory, 'plan'), baseSha, headSha,
    mergeSha: git(repositoryPath, ['rev-parse', 'HEAD']), repository: 'owner/repo',
    runId: '42', runAttempt: 2, pullRequestNumber: 1, reviewMode: 'full',
    codexVersion: '0.153.4', actionVersion: '86365089eb2b84e0a8fb0717b304f8bdcb13b20e' };
}
function resultFor(manifest, batch, overrides = {}) {
  return { schemaVersion: 1, reviewUnitId: batch.id, manifestDigest: manifest.digest,
    headSha: manifest.context.headSha,
    items: batch.itemIds.map(id => ({ id, status: 'reviewed', notes: 'Inspected supplied patch and callers.' })),
    findings: [], integrationRisks: [], ...overrides };
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key =>
    JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function rehash(manifest) {
  const { digest, ...content } = manifest;
  return { ...content, digest: crypto.createHash('sha256').update(canonical(content)).digest('hex') };
}
function runCli(script, args, options) {
  return cp.spawnSync(process.execPath, [script, ...args], {
    cwd: options.repositoryPath, encoding: 'utf8', windowsHide: true, timeout: 15000,
    env: { ...process.env, BASE_SHA: options.baseSha, HEAD_SHA: options.headSha,
      REVIEW_MODE: options.reviewMode, GITHUB_SHA: options.mergeSha,
      GITHUB_REPOSITORY: options.repository, GITHUB_RUN_ID: options.runId,
      GITHUB_RUN_ATTEMPT: String(options.runAttempt), REVIEW_PR_NUMBER: String(options.pullRequestNumber),
      REVIEW_CODEX_VERSION: options.codexVersion, REVIEW_ACTION_VERSION: options.actionVersion,
      GITHUB_OUTPUT: path.join(path.dirname(options.repositoryPath), 'github-output') },
  });
}

test('planner supplies every changed source, documentation and generated bundle patch', t => {
  const { createReviewPlan, validateManifest } = engine();
  const options = fixture(t, { 'source.js': 'old\n', 'README.md': 'old docs\n',
    'music_app/static/js/runtime-bundle.js': 'old generated\n' },
  { 'source.js': 'new source\n', 'README.md': 'new docs\n',
    'music_app/static/js/runtime-bundle.js': 'new generated\n' });
  const manifest = createReviewPlan(options);
  assert.deepEqual(manifest.files.map(file => file.path).sort(), [
    'README.md', 'music_app/static/js/runtime-bundle.js', 'source.js']);
  assert.deepEqual(manifest.batches.flatMap(batch => batch.itemIds).sort(), manifest.items.map(item => item.id).sort());
  for (const file of manifest.files) {
    const patch = manifest.items.filter(item => item.fileId === file.id).map(item => item.patch).join('');
    assert.match(patch, /^diff --git /);
    assert.match(patch, /\n-old/);
    assert.match(patch, /\n\+new/);
    assert.equal(crypto.createHash('sha256').update(patch).digest('hex'), file.patchHash);
    assert.equal(patch.length, file.patchChars);
  }
  assert.doesNotThrow(() => validateManifest(manifest, options));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(options.outputDir, 'manifest.json'))), manifest);
  const usage = JSON.parse(fs.readFileSync(path.join(options.outputDir, 'usage-units.json')));
  assert.equal(usage.manifestDigest, manifest.digest);
  assert.equal(usage.headSha, options.headSha);
  assert.equal(usage.runAttempt, options.runAttempt);
  assert.deepEqual(usage.units.filter(unit => unit.reviewer === 'codex').map(unit => unit.reviewUnitId),
    [...manifest.batches.map(batch => batch.id), 'integration']);
  assert.equal(usage.units.find(unit => unit.reviewer === 'pr-agent').artifactName, 'private-review-usage-pr-agent-42-2');
});

test('large file sections account for every changed line without silently exceeding a batch limit', t => {
  const { createReviewPlan } = engine();
  const lines = Array.from({ length: 420 }, (_, index) => `changed_marker_${index}_${'x'.repeat(40)}`);
  const options = fixture(t, { 'large.js': 'original\n' }, { 'large.js': lines.join('\n') + '\n' });
  const manifest = createReviewPlan({ ...options, limits: { maxItems: 2, maxChars: 5000, maxBatches: 64 } });
  assert.ok(manifest.items.length > 1);
  const sections = manifest.items.filter(item => item.path === 'large.js').sort((a, b) => a.section.startOffset - b.section.startOffset);
  const patch = sections.map(item => item.patch).join('');
  for (const line of lines) assert.equal(patch.split('+' + line + '\n').length - 1, 1);
  let offset = 0;
  for (const item of sections) {
    assert.equal(item.section.startOffset, offset);
    offset = item.section.endOffset;
    assert.equal(item.patch.length, item.section.endOffset - item.section.startOffset);
  }
  assert.equal(offset, sections[0].section.totalChars);
  assert.ok(manifest.batches.every(batch => batch.itemIds.length <= 2 && batch.diffChars <= 5000));
  assert.throws(() => createReviewPlan({ ...options, limits: { maxItems: 1, maxChars: 5000, maxBatches: 1 } }), /batch|limit|overflow/i);
});

test('validator rejects omitted source even when an attacker refreshes the manifest digest', t => {
  const { createReviewPlan, validateManifest } = engine();
  const options = fixture(t, { 'a.js': 'old\n', 'b.js': 'old\n' }, { 'a.js': 'changed\n', 'b.js': 'changed\n' });
  const manifest = createReviewPlan(options);
  const omitted = structuredClone(manifest);
  const removedFile = omitted.files.pop();
  const removedItems = new Set(omitted.items.filter(item => item.fileId === removedFile.id).map(item => item.id));
  omitted.items = omitted.items.filter(item => !removedItems.has(item.id));
  omitted.batches.forEach(batch => { batch.itemIds = batch.itemIds.filter(id => !removedItems.has(id)); });
  assert.throws(() => validateManifest(rehash(omitted), options));
  assert.throws(() => validateManifest(manifest, { ...options, headSha: options.baseSha }));
  assert.throws(() => validateManifest(manifest, { ...options, runAttempt: 3 }));
});

test('complete batches with findings still prepare integration and the final verdict blocks tests', t => {
  const { createReviewPlan, validateBatchResults, prepareIntegration, finalizeReview } = engine();
  const options = fixture(t, { 'a.js': 'old\n' }, { 'a.js': 'new\n' });
  const manifest = createReviewPlan(options);
  const finding = { priority: 'P2', kind: 'bug', file: 'a.js', line: 1, side: 'right',
    title: 'Preserve the prior selection', body: 'A second pending action drops the first user selection.' };
  const results = manifest.batches.map(batch => resultFor(manifest, batch, { findings: [finding] }));
  assert.equal(validateBatchResults(manifest, results).length, manifest.batches.length);
  const prepared = prepareIntegration(manifest, results);
  assert.match(prepared.preliminaryMarkdown, /Preserve the prior selection/);
  assert.ok(prepared.prompt.includes(manifest.batches[0].id));
  assert.ok(prepared.schema);
  const integration = resultFor(manifest, { id: 'integration', itemIds: manifest.batches.map(batch => batch.id) });
  const verdict = finalizeReview(manifest, results, integration);
  assert.equal(verdict.hasFindings, true);
  assert.equal(verdict.findings.length, 1);
  assert.match(verdict.markdown, /Preserve the prior selection/);
});

test('full review uses the incoming merge-base delta while binding the actual advanced base and merge tree', t => {
  const { createReviewPlan, validateManifest } = engine();
  const options = fixture(t, { 'shared.js': 'base\n' }, { 'feature.js': 'incoming feature\n' },
    { 'base-only.js': 'unrelated base update\n' });
  const manifest = createReviewPlan(options);
  assert.deepEqual(manifest.files.map(file => file.path), ['feature.js']);
  assert.equal(manifest.context.baseSha, options.baseSha);
  assert.equal(manifest.context.diffBaseSha, git(options.repositoryPath, ['merge-base', options.baseSha, options.headSha]));
  assert.notEqual(manifest.context.diffBaseSha, options.baseSha);
  assert.equal(manifest.context.mergeTree, git(options.repositoryPath, ['rev-parse', `${options.mergeSha}^{tree}`]));
  assert.doesNotThrow(() => validateManifest(manifest, options));
  git(options.repositoryPath, ['checkout', options.headSha]);
  assert.throws(() => validateManifest(manifest, options));
});

test('incremental review assigns only changes after the successfully reviewed ancestor', t => {
  const { createReviewPlan } = engine();
  const options = fixture(t, { 'existing.js': 'original\n' }, { 'existing.js': 'first repair\n' });
  git(options.repositoryPath, ['checkout', 'review']);
  fs.writeFileSync(path.join(options.repositoryPath, 'second.js'), 'second repair\n');
  git(options.repositoryPath, ['add', '.']);
  git(options.repositoryPath, ['commit', '-m', 'second repair']);
  const newHead = git(options.repositoryPath, ['rev-parse', 'HEAD']);
  git(options.repositoryPath, ['checkout', 'main']);
  git(options.repositoryPath, ['merge', '--no-ff', 'review', '-m', 'updated merge']);
  const incremental = { ...options, baseSha: options.headSha, headSha: newHead,
    mergeSha: git(options.repositoryPath, ['rev-parse', 'HEAD']), reviewMode: 'incremental' };
  const manifest = createReviewPlan(incremental);
  assert.deepEqual(manifest.files.map(file => file.path), ['second.js']);
  assert.equal(manifest.context.diffBaseSha, options.headSha);
  assert.throws(() => createReviewPlan({ ...incremental, baseSha: incremental.mergeSha }));
});

test('rename identities and deleted base content remain assigned with real before and after PNG bytes', t => {
  const { createReviewPlan } = engine();
  const left = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1cAAAAASUVORK5CYII=', 'base64');
  const right = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const renamed = Array.from({ length: 20 }, (_, index) => `retained_${index}\n`).join('');
  const options = fixture(t, { 'old name.js': renamed, 'deleted.js': 'deleted_secret_logic\n', 'image.png': left, 'deleted.png': right },
    { 'old name.js': null, 'new name.js': renamed, 'deleted.js': null, 'image.png': right, 'deleted.png': null });
  const manifest = createReviewPlan(options);
  const moved = manifest.files.find(file => file.path === 'new name.js');
  assert.equal(moved.oldPath, 'old name.js');
  assert.equal(moved.oldBlob, moved.newBlob);
  assert.match(manifest.items.filter(item => item.path === 'deleted.js').map(item => item.patch).join(''), /-deleted_secret_logic/);
  const visual = manifest.items.find(item => item.path === 'image.png');
  assert.equal(visual.kind, 'image');
  assert.deepEqual(visual.images.map(image => image.side).sort(), ['left', 'right']);
  for (const image of visual.images) {
    const bytes = fs.readFileSync(path.join(options.outputDir, image.path));
    assert.deepEqual(bytes, image.side === 'left' ? left : right);
    const objectBytes = Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]);
    assert.equal(crypto.createHash('sha1').update(objectBytes).digest('hex'), image.blob);
  }
  const batch = manifest.batches.find(candidate => candidate.itemIds.includes(visual.id));
  assert.equal(batch.kind, 'image');
  const args = typeof batch.codexArgs === 'string' ? JSON.parse(batch.codexArgs) : batch.codexArgs;
  assert.ok(args.filter(value => value === '--image').length >= 2);
  for (const image of visual.images) assert.ok(args.includes(image.path));
  const deletedImage = manifest.items.find(item => item.path === 'deleted.png');
  assert.deepEqual(deletedImage.images.map(image => image.side), ['left']);
  assert.deepEqual(fs.readFileSync(path.join(options.outputDir, deletedImage.images[0].path)), right);
});

test('unsupported binary changes fail visibly rather than producing incomplete review coverage', t => {
  const { createReviewPlan } = engine();
  const options = fixture(t, { 'safe.js': 'old\n' }, { 'safe.js': 'new\n', 'archive.bin': Buffer.from([0, 1, 0, 2]) });
  assert.throws(() => createReviewPlan(options), /binary|unsupported/i);
});

test('batch attestation rejects missing duplicate malformed stale wrong-hash and omitted results', t => {
  const { createReviewPlan, validateBatchResult, validateBatchResults, prepareIntegration } = engine();
  const options = fixture(t, { 'a.js': 'old\n', 'b.js': 'old\n' }, { 'a.js': 'new\n', 'b.js': 'new\n' });
  const manifest = createReviewPlan({ ...options, limits: { maxItems: 1, maxChars: 5000, maxBatches: 64 } });
  const valid = manifest.batches.map(batch => resultFor(manifest, batch));
  const first = valid[0];
  for (const invalid of [null, {}, { ...first, schemaVersion: 2 },
    { ...first, headSha: options.baseSha }, { ...first, manifestDigest: 'b'.repeat(64) },
    { ...first, reviewUnitId: 'batch-999' }, { ...first, items: [] },
    { ...first, items: [...first.items, first.items[0]] },
    { ...first, items: [{ ...first.items[0], status: 'omitted' }] },
    { ...first, items: [{ ...first.items[0], id: 'unassigned' }] },
    { ...first, findings: 'All clear' }, { ...first, integrationRisks: null },
    { ...first, findings: [{ priority: 'P4', kind: 'bug', file: 'a.js', line: 1, side: 'right', title: 'Bad', body: 'Invalid priority.' }] },
  ]) assert.throws(() => validateBatchResult(manifest, invalid, first.reviewUnitId));
  for (const invalid of [valid.slice(1), [...valid, valid[0]], [...valid, { ...first, reviewUnitId: 'batch-999' }]]) {
    assert.throws(() => validateBatchResults(manifest, invalid));
    assert.throws(() => prepareIntegration(manifest, invalid));
  }
});

test('integration attests every completed batch, preserves missing-test findings and cannot claim a false clear', t => {
  const { createReviewPlan, finalizeReview } = engine();
  const options = fixture(t, { 'a.js': 'old\n' }, { 'a.js': 'new\n' });
  const manifest = createReviewPlan(options);
  const results = manifest.batches.map(batch => resultFor(manifest, batch));
  const integration = resultFor(manifest, { id: 'integration', itemIds: manifest.batches.map(batch => batch.id) });
  const clear = finalizeReview(manifest, results, integration);
  assert.equal(clear.hasFindings, false);
  assert.match(clear.markdown, /ALBUM_HAVEN_REVIEW_VERDICT=pass\s*$/);
  assert.throws(() => finalizeReview(manifest, results, { ...integration, items: [] }));
  const finding = { priority: 'P2', kind: 'missing_test', file: 'a.js', line: 1, side: 'right',
    title: 'Cover the second action', body: 'The interaction currently has no delayed-settlement regression.' };
  const blocked = finalizeReview(manifest, results, { ...integration, findings: [finding] });
  assert.equal(blocked.hasFindings, true);
  assert.match(blocked.markdown, /Cover the second action/);
  assert.match(blocked.markdown, /ALBUM_HAVEN_REVIEW_VERDICT=block\s*$/);
});

test('real planner and validator CLI bind event identities and reject altered generated prompts', t => {
  engine();
  const options = fixture(t, { 'a.js': 'old\n' }, { 'a.js': 'new\n' });
  const planned = runCli(plannerPath, ['--output-dir', options.outputDir], options);
  assert.equal(planned.status, 0, planned.stderr);
  const manifest = JSON.parse(fs.readFileSync(path.join(options.outputDir, 'manifest.json')));
  const outputs = fs.readFileSync(path.join(path.dirname(options.repositoryPath), 'github-output'), 'utf8');
  assert.ok(outputs.includes(`manifest_digest=${manifest.digest}`));
  const matrix = JSON.parse(outputs.split('\n').find(line => line.startsWith('matrix_json=')).slice('matrix_json='.length));
  assert.deepEqual(matrix.include.map(row => row.id), manifest.batches.map(batch => batch.id));
  const batch = manifest.batches[0];
  const preflight = ['preflight', '--plan-dir', options.outputDir, '--unit', batch.id, '--manifest-digest', manifest.digest];
  assert.equal(runCli(validatorPath, preflight, options).status, 0);
  assert.notEqual(runCli(validatorPath, [...preflight.slice(0, -1), 'b'.repeat(64)], options).status, 0);
  const input = path.join(path.dirname(options.repositoryPath), 'result.json');
  fs.writeFileSync(input, JSON.stringify(resultFor(manifest, batch)));
  const args = ['batch', '--plan-dir', options.outputDir, '--unit', batch.id, '--input', input];
  assert.equal(runCli(validatorPath, args, options).status, 0);
  assert.notEqual(runCli(validatorPath, args, { ...options, runId: '43' }).status, 0);
  fs.appendFileSync(path.join(options.outputDir, `${batch.id}.prompt.md`), '\nUnassigned instructions\n');
  assert.notEqual(runCli(validatorPath, preflight, options).status, 0);
  assert.notEqual(runCli(validatorPath, args, options).status, 0);
});

test('paid visual preflight rejects missing or changed image bytes before any response exists', t => {
  const { createReviewPlan } = engine();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB1cAAAAASUVORK5CYII=', 'base64');
  const options = fixture(t, { 'a.js': 'old\n' }, { 'new image.png': png });
  const manifest = createReviewPlan(options);
  const visual = manifest.items.find(item => item.kind === 'image');
  const batch = manifest.batches.find(candidate => candidate.itemIds.includes(visual.id));
  const args = ['preflight', '--plan-dir', options.outputDir, '--unit', batch.id, '--manifest-digest', manifest.digest];
  assert.equal(runCli(validatorPath, args, options).status, 0);
  const imagePath = path.join(options.outputDir, visual.images[0].path);
  fs.writeFileSync(imagePath, Buffer.from('different content'));
  assert.notEqual(runCli(validatorPath, args, options).status, 0);
  fs.unlinkSync(imagePath);
  assert.notEqual(runCli(validatorPath, args, options).status, 0);
});

test('integration preflight accepts only the reserved unit with current event and manifest identities', t => {
  const { createReviewPlan } = engine();
  const options = fixture(t, { 'a.js': 'old\n' }, { 'a.js': 'new\n' });
  const manifest = createReviewPlan(options);
  const args = ['preflight', '--plan-dir', options.outputDir, '--unit', 'integration', '--manifest-digest', manifest.digest];
  const valid = runCli(validatorPath, args, options);
  assert.equal(valid.status, 0, valid.stderr);
  assert.notEqual(runCli(validatorPath, [...args.slice(0, -1), 'b'.repeat(64)], options).status, 0);
  assert.notEqual(runCli(validatorPath, args, { ...options, runAttempt: 3 }).status, 0);
  const unknown = [...args];
  unknown[unknown.indexOf('--unit') + 1] = 'integration-extra';
  assert.notEqual(runCli(validatorPath, unknown, options).status, 0);
});
