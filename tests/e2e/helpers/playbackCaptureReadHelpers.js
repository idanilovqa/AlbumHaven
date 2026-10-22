import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { resolveIsolatedE2ESetupConnection } from './isolatedPostgresConnection.js';
import { resolvePsqlCommands } from './postgresClientCommand.js';

const execFileAsync = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CHECKPOINT = '/playback/capture/checkpoint';
const MAX_CHECKPOINTS = 128;

// Passive normal-network observation. Never retain cookies, CSRF or scope headers.
export function observePlaybackCapture(page) {
  const accepted = [];
  const pending = new Set();
  let failure = null;
  const onResponse = (response) => {
    const request = response.request();
    if (new URL(response.url()).pathname !== CHECKPOINT || request.method() !== 'POST') return;
    const job = (async () => {
      if (accepted.length >= MAX_CHECKPOINTS) throw new Error('Capture observation exceeded its bounded scenario budget.');
      const body = request.postDataJSON();
      if (response.status() !== 200) throw new Error(`Capture checkpoint failed with HTTP ${response.status()}.`);
      const receipt = await response.json();
      if (!UUID.test(body.device_uuid) || !UUID.test(body.capture_uuid)
          || receipt.capture_uuid !== body.capture_uuid || receipt.sequence !== body.sequence) {
        throw new Error('Capture request/receipt identity mismatch.');
      }
      accepted.push({ body, receipt });
    })().catch(() => { failure = new Error('Normal playback capture failed or exceeded its observation bound.'); });
    pending.add(job);
    job.finally(() => pending.delete(job));
  };
  page.on('response', onResponse);
  const stop = () => page.off('response', onResponse);
  page.once('close', stop);
  return {
    async snapshot() {
      await Promise.all([...pending]);
      if (failure) throw failure;
      return structuredClone(accepted);
    },
    stop,
  };
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// An exact fixture login plus UUIDs observed from this page, never a catalog-wide scan.
export async function readPlaybackCapture({ username, deviceUuid, captureUuid }) {
  if (!/^[a-z0-9_-]{1,64}$/.test(username) || !UUID.test(deviceUuid) || !UUID.test(captureUuid)) {
    throw new Error('Capture read requires an exact scenario actor and observed canonical UUIDs.');
  }
  const { databaseTarget, password } = resolveIsolatedE2ESetupConnection(
    process.env.ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL,
  );
  // Strict input alphabets above make interpolation literal-only. Read-only transaction,
  // timeouts, row limits and process output cap fail closed rather than truncate evidence.
  const sql = `begin read only;
    set local statement_timeout='3000ms';
    set local lock_timeout='1000ms';
    with parent as (
      select s.* from integration.playback_capture_session s
      join app.accounts a on a.id=s.account_id
      where a.username_normalized='${username}'
        and s.device_uuid='${deviceUuid}'::uuid and s.capture_uuid='${captureUuid}'::uuid
      limit 2
    ), batches as (
      select c.* from integration.playback_capture_checkpoint c
      join parent p on p.id=c.session_id order by c.sequence limit 129
    ), runs as (
      select c.sequence,r.run_index,r.source_start48,r.frames,r.output_start,r.ordinal_start,r.epoch,r.quality
      from integration.playback_capture_run r join batches c on c.id=r.checkpoint_id
      order by c.sequence,r.run_index limit 32769
    )
    select json_build_object(
      'parents',(select count(*) from parent),
      'known_frames',(select accepted_known_frames from parent),
      'lost_frames',(select accepted_lost_frames from parent),
      'terminal_reason',(select terminal_reason from parent),
      'last_sequence',(select last_sequence from parent),
      'batches',coalesce((select json_agg(json_build_object(
        'sequence',sequence,'digest',digest,'evidence',evidence,'receipt',receipt_body)
        order by sequence) from batches),'[]'::json),
      'runs',coalesce((select json_agg(runs order by sequence,run_index) from runs),'[]'::json)
    ); rollback;`;
  const env = { ...process.env, PGCLIENTENCODING: 'UTF8', PGCONNECT_TIMEOUT: '3' };
  delete env.PGDATABASE;
  if (password) env.PGPASSWORD = password;
  const commands = resolvePsqlCommands(env, process.platform);
  for (let index = 0; index < commands.length; index += 1) {
    try {
      const { stdout } = await execFileAsync(commands[index], [
        '--no-psqlrc', '--quiet', '--tuples-only', '--no-align',
        `--dbname=${databaseTarget}`, '--set=ON_ERROR_STOP=1', '--command', sql,
      ], { env, encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
      const result = JSON.parse(stdout.trim());
      if (result.parents !== 1 || result.batches.length > 128 || result.runs.length > 32768) {
        throw new Error('Capture read did not resolve one bounded scenario parent.');
      }
      return result;
    } catch (error) {
      if (error?.code === 'ENOENT' && index + 1 < commands.length) continue;
      // Child-process failures can embed connection arguments; do not leak those.
      throw new Error('Bounded read-only isolated capture inspection failed.');
    }
  }
  throw new Error('No PostgreSQL client command was available.');
}

export function captureForPath(observations, path) {
  const first = observations.filter(item => item.body.initial_path === path && item.body.sequence === 1);
  const identities = new Map(first.map(item => [item.body.capture_uuid, item]));
  if (identities.size !== 1) throw new Error('Expected exactly one admitted capture for the selected playback.');
  return [...identities.values()][0];
}

export function assertCaptureStored(expect, stored, observations, identity) {
  const checkpoints = observations.filter(item => item.body.device_uuid === identity.body.device_uuid
    && item.body.capture_uuid === identity.body.capture_uuid);
  expect(stored.known_frames).toBeGreaterThan(0);
  expect(stored.lost_frames).toBe(0);
  expect(stored.batches.length).toBeGreaterThan(0);
  expect(stored.batches.map(batch => batch.sequence)).toEqual(
    Array.from({ length: stored.batches.length }, (_, index) => index + 1),
  );
  let previousEnd = 0;
  let frames = 0;
  for (const run of stored.runs) {
    expect(run.frames).toBeGreaterThan(0);
    expect(run.ordinal_start).toBeGreaterThanOrEqual(previousEnd);
    previousEnd = run.ordinal_start + run.frames;
    frames += run.frames;
  }
  expect(frames).toBe(stored.known_frames);
  expect(stored.last_sequence).toBe(stored.batches.length);
  for (const batch of stored.batches) {
    const observed = checkpoints.find(item => item.body.sequence === batch.sequence);
    expect(observed, 'Every persisted sequence came from this page and received its normal receipt').toBeTruthy();
    expect(batch.evidence).toEqual(observed.body.evidence);
    expect(stored.runs.filter(run => run.sequence === batch.sequence)).toEqual(
      batch.evidence.runs.map((run, run_index) => ({
        sequence: batch.sequence, run_index, source_start48: run.source_start48,
        frames: run.frames, output_start: run.output_start, ordinal_start: run.ordinal_start,
        epoch: run.epoch, quality: run.quality,
      })),
    );
    expect(Object.keys(batch.evidence).sort()).toEqual(['anchors', 'gaps', 'runs', 'terminal', 'terminal_reason']);
    expect(Object.keys(batch.receipt).sort()).toEqual([
      'accepted_known_frames', 'accepted_lost_frames', 'digest', 'sequence', 'terminal',
    ]);
    expect(Object.keys(observed.receipt).sort()).toEqual([
      'accepted_known_frames', 'accepted_lost_frames', 'capture_uuid', 'digest', 'ok', 'sequence', 'terminal',
    ]);
    expect(batch.digest).toBe(createHash('sha256').update(
      `app-rendered-position-v1\n${batch.sequence}\n${canonical(batch.evidence)}`,
    ).digest('hex'));
    expect(batch.receipt).toEqual(Object.fromEntries(
      Object.entries(observed.receipt).filter(([key]) => !['ok', 'capture_uuid'].includes(key)),
    ));
    for (const run of batch.evidence.runs) expect(Object.keys(run).sort()).toEqual([
      'anchor_after', 'anchor_before', 'epoch', 'frames', 'ordinal_start', 'output_start', 'quality', 'source_start48',
    ]);
    for (const anchor of batch.evidence.anchors) expect(Object.keys(anchor).sort()).toEqual([
      'epoch', 'max_quantum_frames', 'monotonic_probe_span_ms', 'output_frame', 'probe_id',
      'quality', 'utc_lower_ms', 'utc_upper_ms',
    ]);
    for (const gap of batch.evidence.gaps) expect(Object.keys(gap).sort()).toEqual([
      'epoch', 'ordinal_end', 'ordinal_start', 'output_end', 'output_start', 'positive_frames', 'reasons',
    ]);
    const child = JSON.stringify(batch);
    for (const value of [identity.body.device_uuid, identity.body.capture_uuid, identity.body.initial_path]) {
      expect(child).not.toContain(value);
    }
  }
  expect(stored.batches.at(-1).receipt.accepted_known_frames).toBe(stored.known_frames);
  expect(stored.batches.at(-1).receipt.accepted_lost_frames).toBe(stored.lost_frames);
}

export function repeatedSourceFrames(runs) {
  const intervals = runs.map(run => [run.source_start48, run.source_start48 + run.frames])
    .sort((a, b) => a[0] - b[0]);
  let union = 0;
  let end = 0;
  let total = 0;
  for (const [start, nextEnd] of intervals) {
    total += nextEnd - start;
    union += Math.max(0, nextEnd - Math.max(start, end));
    end = Math.max(end, nextEnd);
  }
  return total - union;
}

export async function waitForCaptureAdmission(expect, observer, path) {
  await expect.poll(async () => (await observer.snapshot()).some(item =>
    item.body.initial_path === path && item.body.sequence === 1), {
    message: 'Real served playback must produce an acknowledged positive capture',
    timeout: 10000,
  }).toBe(true);
  return captureForPath(await observer.snapshot(), path);
}

export async function inspectPlaybackCapture(expect, observer, identity, username) {
  const stored = await readPlaybackCapture({
    username,
    deviceUuid: identity.body.device_uuid,
    captureUuid: identity.body.capture_uuid,
  });
  assertCaptureStored(expect, stored, await observer.snapshot(), identity);
  return stored;
}


export async function waitForCaptureTerminal(expect, observer, identity) {
  await expect.poll(async () => (await observer.snapshot()).some(item =>
    item.body.device_uuid === identity.body.device_uuid
      && item.body.capture_uuid === identity.body.capture_uuid && item.receipt.terminal), {
    timeout: 10000,
  }).toBe(true);
}
