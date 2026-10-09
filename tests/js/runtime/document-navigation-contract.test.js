const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..', '..', '..');

function source(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('full-document JavaScript navigation is limited to authentication and fatal startup recovery', () => {
  const allowed = new Map([
    ['music_app/static/js/startup-progress.js', ["window.location.reload()"]],
    ['music_app/static/js/settings-navigation.js', ["window.location.assign('/login')"]],
    ['music_app/static/js/admin-members.js', ["window.location.assign('/login')"]],
    ['music_app/static/js/runtime/discovery-center-navigation.js', ["window.location.assign('/login')"]],
    ['music_app/static/js/runtime/gallery-refresh-and-status.js', ["window.location.assign('/login')"]],
  ]);
  const roots = [
    path.join(repoRoot, 'music_app', 'static', 'js'),
    path.join(repoRoot, 'music_app', 'static', 'app.js'),
  ];
  const files = [];
  const collect = (entry) => {
    const stat = fs.statSync(entry);
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(entry)) collect(path.join(entry, child));
    } else if (entry.endsWith('.js') && !entry.endsWith('runtime-bundle.js')) files.push(entry);
  };
  roots.forEach(collect);

  const found = new Map();
  const pattern = /(?:window\.)?location\.(?:reload|assign|replace)\s*\([^)]*\)|(?:window\.)?location\.href\s*=|document\.location\s*=/g;
  for (const file of files) {
    const matches = source(path.relative(repoRoot, file)).match(pattern) || [];
    if (matches.length) found.set(path.relative(repoRoot, file).replaceAll('\\', '/'), matches);
  }

  assert.deepEqual(found, allowed);
});
