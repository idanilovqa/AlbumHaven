import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { resolveIsolatedE2ESetupConnection } from './isolatedPostgresConnection.js';
import { resolvePsqlCommands } from './postgresClientCommand.js';

const execFileAsyncDefault = promisify(execFile);
const ALLOWED_DELETE_RELATIONS = new Set([
  'library.ignored_repairs',
  'library.ignored_versions',
  'library.manual_versions',
]);
const ALLOWED_INSERT_RELATIONS = new Set([
  'library.ignored_repairs',
]);

function normalizeAllowedRelations(tableNames, allowedRelations, privilege) {
  if (!Array.isArray(tableNames) || tableNames.length < 1) {
    throw new Error('At least one Postgres relation is required.');
  }
  const normalized = [...new Set(
    tableNames.map((tableName) => String(tableName || '').trim()),
  )];
  for (const tableName of normalized) {
    if (!allowedRelations.has(tableName)) {
      throw new Error(
        `Postgres ${privilege} privilege fault injection rejects ${tableName || '(empty relation)'}.`,
      );
    }
  }
  return normalized.sort();
}

async function executePsql({
  args,
  env,
  execFileAsync,
  platform,
}) {
  const commands = resolvePsqlCommands(env, platform);
  for (let index = 0; index < commands.length; index += 1) {
    try {
      return await execFileAsync(commands[index], args, {
        encoding: 'utf8',
        env,
        windowsHide: true,
      });
    } catch (error) {
      const canTryFallback = error?.code === 'ENOENT' && index < commands.length - 1;
      if (!canTryFallback) throw error;
    }
  }
  throw new Error('No PostgreSQL client command was available.');
}

function psqlEnvironment(env, password, platform) {
  const childEnv = {
    ...env,
    PGCLIENTENCODING: 'UTF8',
  };
  delete childEnv.PGDATABASE;
  if (password) childEnv.PGPASSWORD = password;
  return childEnv;
}

function privilegeQuery(tableNames, privilege, runtimeRoleName) {
  const values = tableNames.map((tableName) => `('${tableName}')`).join(', ');
  return [
    "select requested.relation_name || '|' ||",
    `  has_table_privilege('${runtimeRoleName}', requested.relation_name, '${privilege}')::text`,
    `from (values ${values}) as requested(relation_name)`,
    'order by requested.relation_name',
  ].join(' ');
}

function parseGrantedRelations(stdout, requestedRelations) {
  const requested = new Set(requestedRelations);
  const granted = [];
  for (const rawLine of String(stdout || '').split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    const [relationName, value, ...extra] = line.split('|');
    if (
      extra.length
      || !requested.has(relationName)
      || !['true', 'false', 't', 'f'].includes(value)
    ) {
      throw new Error(`Unexpected Postgres privilege probe output: ${line}`);
    }
    if (value === 'true' || value === 't') granted.push(relationName);
  }
  if (granted.length > requestedRelations.length) {
    throw new Error('Postgres privilege probe returned duplicate relations.');
  }
  return [...new Set(granted)].sort();
}

async function temporarilyRevokeRuntimePrivileges(
  tableNames,
  privilege,
  allowedRelations,
  {
    env = process.env,
    execFileAsync = execFileAsyncDefault,
    platform = process.platform,
  } = {},
) {
  const databaseUrl = String(
    env.ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL || '',
  ).trim();
  if (!databaseUrl) {
    throw new Error(
      'ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL is required for Postgres privilege fault injection.',
    );
  }
  const relations = normalizeAllowedRelations(tableNames, allowedRelations, privilege);
  const {
    databaseTarget,
    password,
    privilegeRoleName,
    runtimeRoleName,
  } = resolveIsolatedE2ESetupConnection(databaseUrl);
  const childEnv = psqlEnvironment(env, password, platform);
  const baseArgs = [
    '--no-psqlrc',
    '--quiet',
    '--tuples-only',
    '--no-align',
    `--dbname=${databaseTarget}`,
    '--set=ON_ERROR_STOP=1',
  ];
  const { stdout } = await executePsql({
    args: [...baseArgs, `--command=${privilegeQuery(relations, privilege, privilegeRoleName)}`],
    env: childEnv,
    execFileAsync,
    platform,
  });
  const revokedRelations = parseGrantedRelations(stdout, relations);
  if (revokedRelations.length !== relations.length) {
    const granted = new Set(revokedRelations);
    const missing = relations.filter((relation) => !granted.has(relation));
    throw new Error(
      `Expected ${runtimeRoleName} to have ${privilege} on every requested relation; missing ${missing.join(', ')}.`,
    );
  }
  if (revokedRelations.length) {
    await executePsql({
      args: [
        ...baseArgs,
        `--command=revoke ${privilege.toLowerCase()} on table ${revokedRelations.join(', ')} from ${privilegeRoleName}`,
      ],
      env: childEnv,
      execFileAsync,
      platform,
    });
  }

  let restored = false;
  return {
    async restore() {
      if (restored) return;
      if (revokedRelations.length) {
        await executePsql({
          args: [
            ...baseArgs,
            `--command=grant ${privilege.toLowerCase()} on table ${revokedRelations.join(', ')} to ${privilegeRoleName}`,
          ],
          env: childEnv,
          execFileAsync,
          platform,
        });
      }
      restored = true;
    },
  };
}

export async function temporarilyRevokeRuntimeDeletePrivileges(tableNames, options = {}) {
  return temporarilyRevokeRuntimePrivileges(
    tableNames,
    'DELETE',
    ALLOWED_DELETE_RELATIONS,
    options,
  );
}

export async function temporarilyRevokeRuntimeInsertPrivileges(tableNames, options = {}) {
  return temporarilyRevokeRuntimePrivileges(
    tableNames,
    'INSERT',
    ALLOWED_INSERT_RELATIONS,
    options,
  );
}
