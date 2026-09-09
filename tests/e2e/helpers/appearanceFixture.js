import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveIsolatedE2ESetupConnection } from './isolatedPostgresConnection.js';
import { resolvePsqlCommands } from './postgresClientCommand.js';

const execFileAsyncDefault = promisify(execFile);

export async function captureAppearanceFixtureSnapshot(username, options = {}) {
  const env = options.env || process.env;
  const connection = resolveIsolatedE2ESetupConnection(env.ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL);
  if (typeof username !== 'string' || !username.trim()) throw new Error('An authenticated fixture username is required.');
  const commands = resolvePsqlCommands(env, options.platform || process.platform);
  const childEnv = { ...env, PGCLIENTENCODING: 'UTF8' };
  delete childEnv.PGDATABASE;
  if (connection.password) childEnv.PGPASSWORD = connection.password;
  const execute = async (sql) => {
    for (let index = 0; index < commands.length; index += 1) {
      try {
        const result = await (options.execFileAsync || execFileAsyncDefault)(commands[index], [
          '--no-psqlrc', '--quiet', '--tuples-only', '--no-align',
          `--dbname=${connection.databaseTarget}`, '--set=ON_ERROR_STOP=1', '--command', sql,
        ], { encoding: 'utf8', env: childEnv, windowsHide: true });
        return result.stdout;
      } catch (error) {
        if (error?.code !== 'ENOENT' || index === commands.length - 1) throw error;
      }
    }
    throw new Error('No PostgreSQL client command was available.');
  };
  const usernameBase64 = Buffer.from(username.normalize('NFC').toLowerCase(), 'utf8').toString('base64');
  const snapshot = JSON.parse(await execute(`
    select jsonb_build_object('account_id', account.id, 'row', (
      select to_jsonb(saved) from app.user_appearance_preferences saved
      where saved.account_id = account.id and saved.client_profile = 'desktop'
    )) from app.accounts account
    where account.username_normalized = convert_from(decode('${usernameBase64}', 'base64'), 'UTF8');
  `));
  if (!Number.isSafeInteger(snapshot?.account_id) || snapshot.account_id <= 0
    || (snapshot.row !== null && (snapshot.row?.account_id !== snapshot.account_id
      || snapshot.row?.client_profile !== 'desktop'))) {
    throw new Error('Invalid appearance fixture snapshot identity.');
  }
  // Preserve the entire storage row, including revision/history and future columns.
  // A product PUT intentionally merges histories and cannot restore row absence.
  const rowsBase64 = Buffer.from(JSON.stringify(snapshot.row === null ? [] : [snapshot.row]), 'utf8').toString('base64');
  return {
    async restore() {
      await execute(`begin;
        delete from app.user_appearance_preferences
        where account_id = ${snapshot.account_id} and client_profile = 'desktop';
        insert into app.user_appearance_preferences
        select * from jsonb_populate_recordset(null::app.user_appearance_preferences,
          convert_from(decode('${rowsBase64}', 'base64'), 'UTF8')::jsonb);
        commit;`);
    },
  };
}

export async function withRestoredAppearanceFixture({ username, context, managedAppLifecycle }, use, options = {}) {
  const capture = options.captureSnapshot || captureAppearanceFixtureSnapshot;
  const snapshot = await capture(username, options);
  let originalFailure;
  try {
    await use();
  } catch (error) {
    originalFailure = error;
  }
  try {
    await context.close();
    // Acknowledgment proves the old app and accepted writes have stopped.
    // Startup preserves account preferences; new contexts read the restored row.
    await managedAppLifecycle.restart();
    await snapshot.restore();
  } catch (cleanupFailure) {
    const failures = [...(originalFailure ? [originalFailure] : []), cleanupFailure];
    try { await managedAppLifecycle.reportFailure(); } catch (reportFailure) { failures.push(reportFailure); }
    if (failures.length > 1) throw new AggregateError(failures, 'Appearance test and fixture cleanup failed.');
    throw cleanupFailure;
  }
  if (originalFailure) throw originalFailure;
}
