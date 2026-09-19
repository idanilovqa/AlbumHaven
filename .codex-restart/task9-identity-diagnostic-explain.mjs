import fs from 'node:fs';
import { captureIdentityDiagnostic } from './task9-identity-diagnostic.mjs';
const session = JSON.parse(fs.readFileSync(new URL('./settings-validation-session.json', import.meta.url), 'utf8').replace(/^\uFEFF/, ''));
for (const line of fs.readFileSync(session.envPath, 'utf8').split(/\r?\n/)) {
  const separator = line.indexOf('=');
  if (separator < 0) continue;
  const key = line.slice(0, separator).replace(/^\uFEFF/, '').trim();
  if (['PGPASSFILE', 'ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL'].includes(key)) {
    process.env[key] = line.slice(separator + 1).trim();
  }
}
const result = await captureIdentityDiagnostic({ album: 'Студийные записи', explainOnly: true });
if (!result.explained) throw new Error('Expected read-only diagnostic EXPLAIN plan.');
console.log('Diagnostic SQL EXPLAIN passed in READ ONLY transaction; rolled back.');
