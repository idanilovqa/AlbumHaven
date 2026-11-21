import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';

import { authenticatedPageGet } from './authenticatedPageRequest.js';
import { resolveWritableFixtureMediaRoot } from './fixtureMediaRoot.js';

const require = createRequire(import.meta.url);
const { resolvePlaywrightPython } = require('../../../scripts/playwright-python.cjs');
const execFileAsync = promisify(execFile);
const OWNED_DIRECTORY = 'waveform-prefetch-priority';

// An hour of CBR audio keeps a prefetch waveform build busy for several seconds on any runner.
// Five encoded minutes are joined by stream copy, so generating it stays cheap.
const GENERATE_LONG_MP3_SCRIPT = `
import subprocess
import sys
from pathlib import Path

from music_app.services.ffmpeg_runtime import resolve_ffmpeg_executable

destination = Path(sys.argv[1])
segment = destination.with_name("segment.mp3")
ffmpeg = resolve_ffmpeg_executable()
if not ffmpeg:
    raise RuntimeError("ffmpeg is required for the waveform prefetch fixture")
common = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y"]
subprocess.run(
    [*common, "-f", "lavfi", "-i", "sine=frequency=330:duration=300:sample_rate=44100",
     "-ac", "2", "-codec:a", "libmp3lame", "-b:a", "64k",
     "-write_xing", "0", "-id3v2_version", "0", str(segment)],
    check=True,
)
subprocess.run(
    [*common, "-i", "concat:" + "|".join([str(segment)] * 12), "-c", "copy",
     "-write_xing", "0", "-id3v2_version", "0", str(destination)],
    check=True,
)
segment.unlink()
`;

function ownedRoot() {
  return path.join(
    resolveWritableFixtureMediaRoot(process.env),
    'cases',
    OWNED_DIRECTORY,
  );
}

export async function createLongPrefetchTrack() {
  const root = ownedRoot();
  if (fs.existsSync(root)) fs.rmSync(root, { recursive: true });
  fs.mkdirSync(root, { recursive: true });
  const trackPath = path.join(root, 'hour-long-prefetch.mp3');
  await execFileAsync(resolvePlaywrightPython(process.env), [
    '-c', GENERATE_LONG_MP3_SCRIPT, trackPath,
  ], { encoding: 'utf8', windowsHide: true });
  return fs.realpathSync(trackPath);
}

export function removeLongPrefetchTrack() {
  const root = ownedRoot();
  if (fs.existsSync(root)) fs.rmSync(root, { recursive: true });
}

// Sends the exact request the player makes to prefetch a queued track's waveform. Its status
// stays null until the build answers, so a spec can tell whether the playing song waited for it.
export function startWaveformPrefetch(page, trackPath) {
  const prefetch = { status: null };
  const query = new URLSearchParams({ path: trackPath, bins: '280' });
  prefetch.done = authenticatedPageGet(page, `/playback/waveform?${query}`, { timeout: 180000 })
    .then((response) => {
      prefetch.status = response.status();
      return prefetch.status;
    });
  return prefetch;
}
