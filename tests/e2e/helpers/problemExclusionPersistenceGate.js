import { spawn } from 'node:child_process';

import { resolveIsolatedE2ESetupConnection } from './isolatedPostgresConnection.js';
import { resolvePreferredPsqlCommand } from './postgresClientCommand.js';

const READY_MARKER = 'ALBUM_HAVEN_PROBLEM_EXCLUSION_GATE_READY';
const EXIT_TIMEOUT_MS = 15000;
const TERMINATION_TIMEOUT_MS = 5000;

function resolvePsqlConnection(environment) {
  const databaseUrl = String(
    environment.ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL || '',
  ).trim();
  if (!databaseUrl) {
    throw new Error(
      'ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL is required to gate Problem Exclusion persistence.',
    );
  }

  return resolveIsolatedE2ESetupConnection(databaseUrl);
}

function createExitPromise(child, output) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdin.once('error', (error) => { output.stdinError = error; });
    child.once('exit', (code, signal) => {
      resolve({
        code,
        signal,
        stdout: output.stdout,
        stderr: output.stderr,
        stdinError: output.stdinError,
      });
    });
  });
}

function waitWithTimeout(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function childIsRunning(child) {
  return child.exitCode === null && child.signalCode === null;
}

async function terminateAndVerifyExit(child, exitPromise, operation) {
  if (childIsRunning(child) && !child.kill() && childIsRunning(child)) {
    throw new Error(
      `Problem Exclusion persistence gate could not terminate after ${operation}.`,
    );
  }
  return waitWithTimeout(
    exitPromise,
    TERMINATION_TIMEOUT_MS,
    `Problem Exclusion persistence gate did not exit after scoped termination during ${operation}.`,
  );
}

function waitForReady(child, output) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error(
        `Timed out waiting for the Problem Exclusion persistence gate. stderr: ${output.stderr}`,
      ));
    }, EXIT_TIMEOUT_MS);

    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.off('data', onStdout);
      child.off('exit', onExit);
      child.off('error', onError);
      if (error) reject(error);
      else resolve();
    };
    const onStdout = () => {
      if (output.stdout.includes(READY_MARKER)) finish();
    };
    const onExit = (code, signal) => {
      finish(new Error(
        `Problem Exclusion persistence gate exited before readiness (code=${code}, signal=${signal}). stderr: ${output.stderr}`,
      ));
    };
    const onError = (error) => finish(error);

    child.stdout.on('data', onStdout);
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

async function waitForCleanExit(child, exitPromise, operation) {
  let result;
  try {
    result = await waitWithTimeout(
      exitPromise,
      EXIT_TIMEOUT_MS,
      `Timed out waiting for the Problem Exclusion persistence gate to ${operation}.`,
    );
  } catch (error) {
    try {
      await terminateAndVerifyExit(child, exitPromise, operation);
    } catch (terminationError) {
      throw new AggregateError(
        [error, terminationError],
        `Problem Exclusion persistence gate failed during ${operation} and cleanup.`,
      );
    }
    throw error;
  }
  if (result.code !== 0) {
    throw new Error(
      `Problem Exclusion persistence gate failed to ${operation} `
      + `(code=${result.code}, signal=${result.signal}). stderr: ${result.stderr}`,
    );
  }
  if (result.stdinError) {
    throw new Error(
      `Problem Exclusion persistence gate stdin failed during ${operation}: ${result.stdinError.message}`,
    );
  }
  if (childIsRunning(child)) {
    throw new Error('Problem Exclusion persistence gate child did not exit cleanly.');
  }
}

export async function holdProblemExclusionPersistence({
  env = process.env,
  platform = process.platform,
  spawnProcess = spawn,
} = {}) {
  const { databaseTarget, password } = resolvePsqlConnection(env);
  const childEnv = { ...env, PGCLIENTENCODING: 'UTF8' };
  delete childEnv.PGDATABASE;
  if (password) childEnv.PGPASSWORD = password;

  const command = resolvePreferredPsqlCommand(env, platform);
  const child = spawnProcess(command, [
    '--no-psqlrc',
    '--quiet',
    `--dbname=${databaseTarget}`,
    '--set=ON_ERROR_STOP=1',
  ], {
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const output = { stdout: '', stderr: '', stdinError: null };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output.stdout += chunk; });
  child.stderr.on('data', (chunk) => { output.stderr += chunk; });
  const exitPromise = createExitPromise(child, output);

  child.stdin.write(
    `BEGIN;\nLOCK TABLE library.ignored_repairs IN SHARE MODE;\n\\echo ${READY_MARKER}\n`,
  );
  try {
    await waitForReady(child, output);
  } catch (error) {
    try {
      await terminateAndVerifyExit(child, exitPromise, 'readiness');
    } catch (terminationError) {
      throw new AggregateError(
        [error, terminationError],
        'Problem Exclusion persistence gate failed readiness and cleanup.',
      );
    }
    throw error;
  }

  let closed = false;
  const close = async (sql, operation) => {
    if (closed) return;
    closed = true;
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.end(`${sql}\n\\quit\n`);
    }
    await waitForCleanExit(child, exitPromise, operation);
  };

  return {
    async release() {
      await close('COMMIT;', 'release');
    },
    async dispose() {
      await close('ROLLBACK;', 'dispose');
    },
  };
}
