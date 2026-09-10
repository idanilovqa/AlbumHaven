#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
function validateReviewVerdict(content) {
  const lines = String(content || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const verdict = lines.at(-1) || '';
  if (verdict === 'ALBUM_HAVEN_REVIEW_VERDICT=pass') return true;
  if (verdict === 'ALBUM_HAVEN_REVIEW_VERDICT=block') throw new Error('The automated review reported actionable findings.');
  throw new Error('The automated review did not end with a valid verdict.');
}
function runCli(argv = process.argv.slice(2)) {
  if (argv.length !== 1) throw new Error('Usage: validate-codex-review-verdict.cjs <review-output>');
  validateReviewVerdict(fs.readFileSync(argv[0], 'utf8'));
}
if (require.main === module) {
  try { runCli(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
module.exports = { runCli, validateReviewVerdict };
