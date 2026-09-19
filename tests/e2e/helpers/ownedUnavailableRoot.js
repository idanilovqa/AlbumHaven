import { lstat, readdir, realpath, rmdir, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export async function withUnavailableOwnedPickerRoot(directory, action) {
  const resolved = await realpath(directory);
  const temporaryRoot = await realpath(os.tmpdir());
  const relative = path.relative(temporaryRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)
      || path.basename(resolved) !== 'Main additional'
      || path.basename(path.dirname(resolved)) !== 'settings-root-picker-fixture'
      || !path.basename(path.dirname(path.dirname(resolved))).startsWith('album-haven-e2e-')) {
    throw new Error('Unavailable-root check requires its uniquely owned temporary picker directory.');
  }
  const details = await lstat(directory);
  if (details.isSymbolicLink() || !details.isDirectory() || (await readdir(resolved)).length) {
    throw new Error('Unavailable-root check requires an empty, direct directory.');
  }
  await rmdir(resolved);
  try { return await action(); }
  finally { await mkdir(resolved); }
}
