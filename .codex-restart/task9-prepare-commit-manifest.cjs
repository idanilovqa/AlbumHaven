const fs = require('node:fs');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const git = (...args) => cp.execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const branch = git('branch', '--show-current');
if (branch !== '2026-09-08-settings-refactor') throw new Error(`Unexpected branch: ${branch}`);
const tracked = git('diff', '--name-only', '--diff-filter=ACDMRT').split('\n').filter(Boolean);
const untracked = git('ls-files', '--others', '--exclude-standard').split('\n').filter(Boolean);
const approved = name => name !== 'music_app/static/css/gallery-main.css' && (
  /^(music_app\/|migrations\/postgres\/|tests\/|scripts\/|\.github\/workflows\/)/.test(name)
  || name === 'config.py'
  || name.startsWith('docs/superpowers/plans/2026-09-09-settings-refactor')
  || name === 'docs/future-feature-plans/foobar-reference-assets/how-to-modal-copy.md'
);
const candidates = [...new Set([...tracked, ...untracked].filter(approved))].sort();
const manifest = { branch, base: git('rev-parse', 'HEAD'), prepared: new Date().toISOString(),
  candidates: candidates.map(name => ({ path: name, sha256: fs.existsSync(name) ? crypto.createHash('sha256').update(fs.readFileSync(name)).digest('hex') : null })),
  excludedTracked: tracked.filter(name => !approved(name)),
  excludedUntracked: untracked.filter(name => !approved(name)),
};
fs.writeFileSync('.codex-restart/task9-prepared-commit-manifest.json', JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ branch, candidates: candidates.length, excludedTracked: manifest.excludedTracked, excludedUntracked: manifest.excludedUntracked.length }));
