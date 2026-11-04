import fs from 'node:fs';
import path from 'node:path';

export function resolveWritableFixtureMediaRoot(environment = process.env, options = {}) {
  const profile = String(environment.ALBUM_HAVEN_FIXTURE_PROFILE || '').trim();
  if (profile) {
    const allowedProfiles = new Set(options.allowedProfiles || ['functional-core']);
    if (!allowedProfiles.has(profile)) {
      throw new Error(`Physical fixture helper does not allow the ${profile} fixture profile.`);
    }
    const fixtureRootValue = String(environment.ALBUM_HAVEN_FIXTURE_ROOT || '').trim();
    const mediaRootValue = String(environment.ALBUM_HAVEN_MEDIA_ROOT || '').trim();
    if (!fixtureRootValue || !mediaRootValue) {
      throw new Error('Physical functional helpers require fixture and media roots.');
    }
    const fixtureRoot = fs.realpathSync(fixtureRootValue);
    const mediaRoot = fs.realpathSync(mediaRootValue);
    const expectedMediaRoot = fs.realpathSync(path.join(fixtureRoot, 'media'));
    if (mediaRoot !== expectedMediaRoot) {
      throw new Error('Physical functional helpers require the exact functional fixture media directory.');
    }
    const writableMediaRootValue = String(
      environment.ALBUM_HAVEN_E2E_WRITABLE_MEDIA_ROOT || '',
    ).trim();
    if (writableMediaRootValue) {
      const tempRootValue = String(environment.ALBUM_HAVEN_E2E_TEMP_ROOT || '').trim();
      if (!tempRootValue) {
        throw new Error('A target-owned writable media root requires ALBUM_HAVEN_E2E_TEMP_ROOT.');
      }
      const tempRoot = fs.realpathSync(tempRootValue);
      const writableMediaRoot = fs.realpathSync(writableMediaRootValue);
      const relativePath = path.relative(tempRoot, writableMediaRoot);
      if (!relativePath || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
        throw new Error('The target-owned writable media root must stay inside the temporary E2E root.');
      }
      return writableMediaRoot;
    }
    return mediaRoot;
  }

  const tempRootValue = String(environment.ALBUM_HAVEN_E2E_TEMP_ROOT || '').trim();
  if (!tempRootValue) {
    throw new Error('ALBUM_HAVEN_E2E_TEMP_ROOT is required for generated fixture media.');
  }
  return fs.realpathSync(path.join(fs.realpathSync(tempRootValue), 'media'));
}
