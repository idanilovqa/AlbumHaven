const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const moduleUrl = pathToFileURL(path.resolve(__dirname, '../e2e/helpers/ownedUnavailableRoot.js')).href;

test('unavailable-root fixture restores only its empty owned directory after an action failure', async () => {
  const { withUnavailableOwnedPickerRoot } = await import(moduleUrl);
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'album-haven-e2e-'));
  const directory = path.join(fixture, 'settings-root-picker-fixture', 'Main additional');
  await fs.mkdir(directory, { recursive: true });
  try {
    await assert.rejects(withUnavailableOwnedPickerRoot(directory, async () => {
      await assert.rejects(fs.stat(directory), { code: 'ENOENT' });
      throw new Error('owned action failed');
    }), /owned action failed/);
    assert.equal((await fs.stat(directory)).isDirectory(), true);
  } finally { await fs.rm(fixture, { recursive: true }); }
});

test('unavailable-root fixture rejects foreign paths and nonempty owned directories without removing them', async () => {
  const { withUnavailableOwnedPickerRoot } = await import(moduleUrl);
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'album-haven-e2e-'));
  const directory = path.join(fixture, 'settings-root-picker-fixture', 'Main additional');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'owned.txt'), 'preserve');
  try {
    await assert.rejects(withUnavailableOwnedPickerRoot(fixture, async () => {}), /uniquely owned/);
    await assert.rejects(withUnavailableOwnedPickerRoot(directory, async () => {}), /empty, direct directory/);
    assert.equal(await fs.readFile(path.join(directory, 'owned.txt'), 'utf8'), 'preserve');
  } finally { await fs.rm(fixture, { recursive: true }); }
});
