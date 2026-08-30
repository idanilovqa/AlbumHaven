const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..', '..');
const modulePath = path.join(repoRoot, 'scripts', 'ci', 'restore-functional-media.cjs');

function loadRestoreModule() {
  assert.ok(fs.existsSync(modulePath), 'functional media restore module is required');
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

function write(root, relativePath, value) {
  const destination = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, value);
}

test('media restore repairs changed and missing files and removes only writable extras', () => {
  const restore = loadRestoreModule();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'album-haven-media-restore-'));
  const sourceRoot = path.join(tempRoot, 'downloaded', 'media');
  const writableRoot = path.join(tempRoot, 'fixture-work', 'shared', 'media');
  const outsidePath = path.join(tempRoot, 'owner-file.txt');
  try {
    write(sourceRoot, 'Artist/Album/01.mp3', 'baseline-one');
    write(sourceRoot, 'Artist/Album/02.mp3', 'baseline-two');
    fs.cpSync(sourceRoot, writableRoot, { recursive: true });
    write(writableRoot, 'Artist/Album/01.mp3', 'mutated');
    fs.rmSync(path.join(writableRoot, 'Artist', 'Album', '02.mp3'));
    write(writableRoot, 'Artist/Album/generated.tmp', 'extra');
    fs.writeFileSync(outsidePath, 'owner', 'utf8');

    const result = restore.restoreMediaTree({ sourceMediaRoot: sourceRoot, writableMediaRoot: writableRoot });

    assert.deepEqual(result, { restored: 2, removed: 1, unchanged: 0 });
    assert.equal(fs.readFileSync(path.join(writableRoot, 'Artist', 'Album', '01.mp3'), 'utf8'), 'baseline-one');
    assert.equal(fs.readFileSync(path.join(writableRoot, 'Artist', 'Album', '02.mp3'), 'utf8'), 'baseline-two');
    assert.equal(fs.existsSync(path.join(writableRoot, 'Artist', 'Album', 'generated.tmp')), false);
    assert.equal(fs.readFileSync(outsidePath, 'utf8'), 'owner');
    assert.deepEqual(restore.verifyMediaTree(sourceRoot, writableRoot), { files: 2 });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('media restore leaves identical files untouched', () => {
  const restore = loadRestoreModule();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'album-haven-media-clean-'));
  const sourceRoot = path.join(tempRoot, 'downloaded', 'media');
  const writableRoot = path.join(tempRoot, 'fixture-work', 'shared', 'media');
  try {
    write(sourceRoot, 'Artist/Album/01.mp3', 'same');
    fs.cpSync(sourceRoot, writableRoot, { recursive: true });
    const before = fs.statSync(path.join(writableRoot, 'Artist', 'Album', '01.mp3')).mtimeMs;

    assert.deepEqual(
      restore.restoreMediaTree({ sourceMediaRoot: sourceRoot, writableMediaRoot: writableRoot }),
      { restored: 0, removed: 0, unchanged: 1 },
    );
    assert.equal(fs.statSync(path.join(writableRoot, 'Artist', 'Album', '01.mp3')).mtimeMs, before);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('media restore rejects aliases, non-media roots, and links before mutation', () => {
  const restore = loadRestoreModule();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'album-haven-media-safety-'));
  const sourceRoot = path.join(tempRoot, 'downloaded', 'media');
  const writableRoot = path.join(tempRoot, 'fixture-work', 'shared', 'media');
  try {
    write(sourceRoot, 'Artist/Album/01.mp3', 'same');
    fs.cpSync(sourceRoot, writableRoot, { recursive: true });
    assert.throws(
      () => restore.restoreMediaTree({ sourceMediaRoot: sourceRoot, writableMediaRoot: sourceRoot }),
      /distinct/,
    );
    assert.throws(
      () => restore.restoreMediaTree({ sourceMediaRoot: path.dirname(sourceRoot), writableMediaRoot: writableRoot }),
      /media roots/,
    );
    assert.throws(
      () => restore.restoreMediaTree({ sourceMediaRoot: sourceRoot, writableMediaRoot: path.dirname(writableRoot) }),
      /media roots/,
    );
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('media verification reports byte drift without repairing it', () => {
  const restore = loadRestoreModule();
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'album-haven-media-verify-'));
  const sourceRoot = path.join(tempRoot, 'downloaded', 'media');
  const writableRoot = path.join(tempRoot, 'fixture-work', 'shared', 'media');
  try {
    write(sourceRoot, 'Artist/Album/01.mp3', 'baseline');
    fs.cpSync(sourceRoot, writableRoot, { recursive: true });
    write(writableRoot, 'Artist/Album/01.mp3', 'changed');

    assert.throws(() => restore.verifyMediaTree(sourceRoot, writableRoot), /differs/);
    assert.equal(fs.readFileSync(path.join(writableRoot, 'Artist', 'Album', '01.mp3'), 'utf8'), 'changed');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
