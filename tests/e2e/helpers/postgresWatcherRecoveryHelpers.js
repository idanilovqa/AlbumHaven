import { Buffer } from 'node:buffer';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { expect } from '@playwright/test';

import { resolveIsolatedE2ESetupConnection } from './isolatedPostgresConnection.js';
import { resolvePsqlCommands } from './postgresClientCommand.js';

const execFileAsyncDefault = promisify(execFile);

const REPAIR_STATES = new Set(['scanning', 'catch_up', 'complete', 'running']);
const WATCHER_STATES = new Set(['healthy', 'degraded', 'repair_required']);
const FULL_SCAN_TERMINAL_FAILURE_REASONS = new Set([
  'full_scan_failed',
  'full_scan_publication_file_scope_invalid',
  'full_scan_publication_hierarchy_invalid',
  'full_scan_publication_input_invalid',
  'full_scan_publication_integrity_failed',
  'full_scan_publication_recovery_cutoff_invalid',
  'full_scan_revision_conflict',
  'full_scan_semantic_album_conflict',
  'full_scan_storage_unavailable',
  'none',
]);

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function safeEnum(value, allowed) {
  return allowed.has(value) ? value : 'unknown';
}

function sanitizeWatermark(value) {
  return {
    acceptedSequence: finiteNumber(value?.acceptedSequence),
    appliedSequence: finiteNumber(value?.appliedSequence),
    capturedAcceptedSequence: finiteNumber(value?.capturedAcceptedSequence),
    dirtyGeneration: finiteNumber(value?.dirtyGeneration),
    capturedDirtyGeneration: finiteNumber(value?.capturedDirtyGeneration),
    repairedDirtyGeneration: finiteNumber(value?.repairedDirtyGeneration),
    caughtUp: value?.caughtUp === true,
  };
}

function sanitizeRepairWatermarkDiagnostic(diagnostic) {
  return {
    repairMatched: diagnostic.repairMatched === true,
    repairState: safeEnum(diagnostic.repairState, REPAIR_STATES),
    repairCompleted: diagnostic.repairCompleted === true,
    terminalFailureReason: safeEnum(
      diagnostic.terminalFailureReason,
      FULL_SCAN_TERMINAL_FAILURE_REASONS,
    ),
    incidentResolved: diagnostic.incidentResolved === true,
    duringRepairAppliedThroughFence: diagnostic.duringRepairAppliedThroughFence === true,
    inventoryEntryMatched: diagnostic.inventoryEntryMatched === true,
    aggregates: {
      scanInProgress: diagnostic.aggregates?.scanInProgress === true,
      watcherState: safeEnum(diagnostic.aggregates?.watcherState, WATCHER_STATES),
      repairRequired: diagnostic.aggregates?.repairRequired === true,
      failedJobCount: finiteNumber(diagnostic.aggregates?.failedJobCount),
      readyGenerationCount: finiteNumber(diagnostic.aggregates?.readyGenerationCount),
      dirtyLaneCount: finiteNumber(diagnostic.aggregates?.dirtyLaneCount),
    },
    watermarks: {
      failure: sanitizeWatermark(diagnostic.watermarks?.failure),
      healthy: sanitizeWatermark(diagnostic.watermarks?.healthy),
    },
  };
}

const SNAPSHOT_SQL = String.raw`
with requested as (
  select
    pg_catalog.convert_from(pg_catalog.decode(:'failure_root_id_b64', 'base64'), 'UTF8')
      as failure_root_id,
    pg_catalog.convert_from(pg_catalog.decode(:'healthy_root_id_b64', 'base64'), 'UTF8')
      as healthy_root_id
), selected_roots as materialized (
  select root.id, root.library_id, root.metadata ->> 'root_id' as logical_root_id
  from library.library_roots as root
  cross join requested
  where root.metadata ->> 'root_id' in (
    requested.failure_root_id,
    requested.healthy_root_id
  )
), selected_library as materialized (
  select library.id, library.metadata
  from library.libraries as library
  where library.id = (select min(root.library_id) from selected_roots as root)
    and (select count(*) from selected_roots) = 2
    and (select count(distinct root.library_id) from selected_roots as root) = 1
), root_snapshots as materialized (
  select root.logical_root_id,
         pg_catalog.jsonb_build_object(
           'databaseRootId', root.id,
           'acceptedSequence', coalesce(lane.accepted_sequence, 0),
           'appliedSequence', coalesce(lane.applied_sequence, 0),
           'dirtyGeneration', coalesce(lane.dirty_generation, 0),
           'repairedDirtyGeneration', coalesce(lane.repaired_dirty_generation, 0),
           'runningGenerationId', lane.running_generation_id,
           'successorGenerationId', lane.successor_generation_id,
           'inventoryFileCount', (
             select count(*)
             from library.local_track_files as file
             where file.library_root_id = root.id
               and coalesce((file.metadata -> 'scan_cache' ->> 'stale')::boolean, false) is false
           ),
           'inventoryEntries', coalesce((
             select pg_catalog.jsonb_agg(
               pg_catalog.jsonb_build_object(
                 'fileName', pg_catalog.regexp_replace(
                  pg_catalog.replace(file.private_path, pg_catalog.chr(92), '/'),
                   '^.*/',
                   ''
                 ),
                 'albumId', track.album_id
               ) order by file.id
             )
             from library.local_track_files as file
             join library.local_tracks as track
               on track.id = file.track_id
             where file.library_root_id = root.id
               and coalesce((file.metadata -> 'scan_cache' ->> 'stale')::boolean, false) is false
           ), '[]'::jsonb)
         ) as snapshot
  from selected_roots as root
  left join library.watcher_lanes as lane
    on lane.library_id = root.library_id
   and lane.root_id = root.id
), incident_snapshots as materialized (
  select pg_catalog.jsonb_build_object(
           'incidentId', incident.incident_id,
           'warningToken', incident.warning_token,
           'rootId', root.logical_root_id,
           'reasonCode', incident.reason_code,
           'occurrenceCount', incident.occurrence_count,
           'acceptedSequence', incident.accepted_sequence,
           'dirtyGeneration', incident.dirty_generation,
           'resolved', incident.resolved_at is not null
         ) as snapshot,
         incident.first_seen_at,
         incident.incident_id
  from library.watcher_incidents as incident
  join selected_roots as root
    on root.library_id = incident.library_id
   and root.id = incident.root_id
), repair_snapshots as materialized (
  select pg_catalog.jsonb_build_object(
           'repairId', repair.id,
           'state', repair.state,
           'inventoryRevision', repair.inventory_revision,
           'completed', repair.completed_at is not null,
           'terminalFailureReason', job.outcome_code,
           'roots', coalesce((
             select pg_catalog.jsonb_agg(
               pg_catalog.jsonb_build_object(
                 'rootId', root.logical_root_id,
                 'incidentId', repair_root.incident_id,
                 'capturedAcceptedSequence', repair_root.captured_accepted_sequence,
                 'capturedDirtyGeneration', repair_root.captured_dirty_generation
               ) order by root.logical_root_id
             )
             from library.watcher_repair_roots as repair_root
             join selected_roots as root
               on root.library_id = repair_root.library_id
              and root.id = repair_root.root_id
             where repair_root.repair_id = repair.id
           ), '[]'::jsonb)
         ) as snapshot,
         repair.id
  from library.watcher_repairs as repair
  left join library.full_scan_intents as intent
    on intent.watcher_repair_id = repair.id
  left join ops.jobs as job
    on job.id = intent.job_id
  where exists (
    select 1
    from library.watcher_repair_roots as repair_root
    join selected_roots as root
      on root.library_id = repair_root.library_id
     and root.id = repair_root.root_id
    where repair_root.repair_id = repair.id
  )
)
select pg_catalog.jsonb_build_object(
  'libraryId', library.id,
  'inventoryRevision', coalesce(
    nullif(library.metadata ->> 'inventory_mutation_revision', '')::bigint,
    0
  ),
  'roots', coalesce((
    select pg_catalog.jsonb_object_agg(root.logical_root_id, root.snapshot)
    from root_snapshots as root
  ), '{}'::jsonb),
  'incidents', coalesce((
    select pg_catalog.jsonb_agg(incident.snapshot order by incident.first_seen_at, incident.incident_id)
    from incident_snapshots as incident
  ), '[]'::jsonb),
  'repairs', coalesce((
    select pg_catalog.jsonb_agg(repair.snapshot order by repair.id)
    from repair_snapshots as repair
  ), '[]'::jsonb)
)
from selected_library as library;
`;

function encodeSqlVariable(value) {
  const encoded = Buffer.from(String(value), 'utf8').toString('base64');
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) {
    throw new Error('Watcher recovery diagnostics produced invalid base64.');
  }
  return encoded;
}

function materializeSnapshotSql([failureRootId, healthyRootId]) {
  return SNAPSHOT_SQL
    .replace(":'failure_root_id_b64'", `'${encodeSqlVariable(failureRootId)}'`)
    .replace(":'healthy_root_id_b64'", `'${encodeSqlVariable(healthyRootId)}'`);
}

async function executePsql({ args, env, execFileAsync, platform }) {
  const commands = resolvePsqlCommands(env, platform);
  for (let index = 0; index < commands.length; index += 1) {
    try {
      return await execFileAsync(commands[index], args, {
        encoding: 'utf8', env, timeout: 15000, windowsHide: true,
      });
    } catch (error) {
      if (error?.code !== 'ENOENT' || index === commands.length - 1) throw error;
    }
  }
  throw new Error('No PostgreSQL client command was available.');
}

export async function readWatcherRecoverySnapshot(
  { failureRootId, healthyRootId },
  {
    env = process.env,
    execFileAsync = execFileAsyncDefault,
    platform = process.platform,
  } = {},
) {
  const databaseUrl = String(env.ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL || '').trim();
  if (!databaseUrl) {
    throw new Error(
      'ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL is required for watcher recovery diagnostics.',
    );
  }
  const rootIds = [failureRootId, healthyRootId].map((value) => String(value || '').trim());
  if (!rootIds[0] || !rootIds[1] || rootIds[0] === rootIds[1]) {
    throw new Error('Watcher recovery diagnostics require two distinct logical root IDs.');
  }

  const { databaseTarget, password } = resolveIsolatedE2ESetupConnection(databaseUrl);
  const childEnv = { ...env, PGCLIENTENCODING: 'UTF8' };
  delete childEnv.PGDATABASE;
  if (password) childEnv.PGPASSWORD = password;
  childEnv.PGOPTIONS = [
    String(childEnv.PGOPTIONS || '').trim(),
    '-c statement_timeout=10000',
    '-c lock_timeout=2000',
  ].filter(Boolean).join(' ');
  const { stdout } = await executePsql({
    args: [
      '--no-psqlrc', '--quiet', '--tuples-only', '--no-align',
      `--dbname=${databaseTarget}`,
      '--set=ON_ERROR_STOP=1',
      `--command=${materializeSnapshotSql(rootIds)}`,
    ],
    env: childEnv,
    execFileAsync,
    platform,
  });
  const output = String(stdout || '').trim();
  if (!output) throw new Error('Watcher recovery diagnostics found no matching isolated library.');
  const snapshot = JSON.parse(output);
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error('Watcher recovery diagnostics returned an invalid snapshot.');
  }
  if (!snapshot.roots?.[rootIds[0]] || !snapshot.roots?.[rootIds[1]]) {
    throw new Error('Watcher recovery diagnostics did not resolve both owned roots.');
  }
  return snapshot;
}

export async function waitForWatcherRecoverySnapshot(predicate, options = {}) {
  if (typeof predicate !== 'function') {
    throw new TypeError('Watcher recovery snapshot wait requires a predicate.');
  }
  let observed = null;
  const readSnapshot = options.readSnapshot || readWatcherRecoverySnapshot;
  try {
    await expect.poll(async () => {
    observed = await readSnapshot(options.roots, options);
    return Boolean(await predicate(observed));
  }, {
    timeout: options.timeout || 120000,
    intervals: options.intervals || [100, 250, 500, 1000, 2000],
    message: options.message || 'Expected watcher recovery state was not observed.',
    }).toBe(true);
  } catch (error) {
    if (error?.matcherResult && typeof options.timeoutDiagnostic === 'function') {
      const diagnostic = options.timeoutDiagnostic(observed) || {};
      const numberPair = (value) => ({
        baseline: finiteNumber(value?.baseline),
        current: finiteNumber(value?.current),
      });
      error.watcherRecoveryDiagnostic = Object.hasOwn(diagnostic, 'repairMatched')
        ? sanitizeRepairWatermarkDiagnostic(diagnostic)
        : {
          incidentMatched: diagnostic.incidentMatched === true,
          inventoryRevision: numberPair(diagnostic.inventoryRevision),
          healthyAcceptedSequence: numberPair(diagnostic.healthyAcceptedSequence),
          healthyAppliedSequence: numberPair(diagnostic.healthyAppliedSequence),
        };
      error.message += `\nWATCHER_RECOVERY_DIAGNOSTIC=${JSON.stringify(error.watcherRecoveryDiagnostic)}`;
    }
    throw error;
  }
  return observed;
}
