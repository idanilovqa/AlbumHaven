// The saved player never keeps a music file's path on the device. The player names songs by path in
// memory; what is written to storage names each song by its resume token instead (signed by the
// server, account-bound, path-free) beside what the player shows, and the paths come back from the
// server when the page restores it (`/playback/refs/resume` with `includePath`).
//
// Tokens come from `/playback/refs` answers. A song saved before its token arrived is asked for in
// one batch (`prepare: false`, so the server reads no audio for it), and the player is saved again
// once the tokens are in; until then the last saved player stays as it was.
const playbackResumeTokens = new Map();
// The saved player and app queue of earlier versions named paths: they are not kept.
try {
  for (const key of ['albumhaven.playerState.v1', 'albumhaven.androidNativeQueue.v1']) window.localStorage?.removeItem(key);
} catch (_error) {
  // Storage is switched off.
}
const playbackResumeTokenFailures = new Set();
let playbackResumeTokenRequest = null;

function rememberPlaybackResumeToken(path, token) {
  const key = String(path || '');
  if (key && typeof token === 'string' && token) playbackResumeTokens.set(key, token);
}

function requestPlaybackResumeTokens(paths) {
  const missing = [...new Set(paths.map(value => String(value || '')))]
    .filter(path => path && !playbackResumeTokens.has(path) && !playbackResumeTokenFailures.has(path))
    .slice(0, 100);
  if (!missing.length || playbackResumeTokenRequest || typeof fetch !== 'function') return;
  playbackResumeTokenRequest = fetch('/playback/refs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ protocol: 1, prepare: false,
      tracks: missing.map((path, index) => ({ clientKey: String(index), path })) }),
  })
    .then(response => (response.ok ? response.json() : null))
    .catch(() => null)
    .then((answer) => {
      for (const issued of Array.isArray(answer?.tracks) ? answer.tracks : []) {
        rememberPlaybackResumeToken(missing[Number(issued?.clientKey)], issued?.resumeToken);
      }
      // A batch the server refused (a song no longer in the library) is not asked for again.
      for (const path of missing) if (!playbackResumeTokens.has(path)) playbackResumeTokenFailures.add(path);
    })
    .finally(() => {
      playbackResumeTokenRequest = null;
      if (typeof persistPlayerState === 'function') persistPlayerState();
    });
}

function savedPlayerTrack(track) {
  const resumeToken = playbackResumeTokens.get(String(track?.path || ''));
  if (!resumeToken) return null;
  const { src: _src, path: _path, ...shown } = track;
  return { ...shown, resumeToken };
}

// Saved songs as the player keeps them in memory, each with its path from the server; null in place
// of a song no longer in the library. Null when any song names a path (saved before this rule) or
// the server refuses the tokens; a network failure rejects, so the caller can ask again later.
async function playerTracksFromDevice(saved) {
  if (!saved.every(track => typeof track?.resumeToken === 'string' && track.resumeToken && !('path' in track))) return null;
  const response = await fetch('/playback/refs/resume', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ protocol: 1, includePath: true,
      tracks: saved.map((track, index) => ({ clientKey: String(index), resumeToken: track.resumeToken })) }),
  });
  if (!response.ok) return null;
  const answer = await response.json();
  const paths = new Map((answer?.tracks || []).map(item => [Number(item?.clientKey), item?.path]));
  return saved.map((track, index) => {
    const path = paths.get(index);
    if (typeof path !== 'string' || !path) return null;
    rememberPlaybackResumeToken(path, track.resumeToken);
    const { resumeToken: _token, ...shown } = track;
    return { ...shown, src: `/track?path=${encodeURIComponent(path)}`, path };
  });
}

// [payload] (buildPersistedPlayerState) as the device keeps it, or null while the current song's
// token is still on its way.
function playerStateForDevice(payload) {
  const queue = payload.playbackQueue;
  requestPlaybackResumeTokens([payload.track?.path, ...(queue?.tracks || []).map(track => track?.path)]);
  const track = savedPlayerTrack(payload.track);
  if (!track) return null;
  let playbackQueue = null;
  if (queue) {
    const current = queue.tracks[queue.currentIndex];
    const kept = queue.tracks.map(item => ({ item, saved: savedPlayerTrack(item) })).filter(entry => entry.saved);
    const currentIndex = kept.findIndex(entry => entry.item === current);
    const albumRef = String(queue.albumRef || '');
    if (currentIndex >= 0) {
      playbackQueue = {
        tracks: kept.map(entry => entry.saved),
        currentIndex,
        // An album named by its folder or files is not kept; the restored song finds its album again.
        ...(albumRef && !/[\\/]/.test(albumRef)
          && !(typeof isPathLikeAlbumKey === 'function' && isPathLikeAlbumKey(albumRef)) ? { albumRef } : {}),
      };
    }
  }
  return { ...payload, track, playbackQueue };
}

// A saved player as the player keeps it in memory: each song's path from the server, songs no longer
// in the library left out. Null when the current song is gone or the server cannot be asked; a record
// that names paths (saved before this rule) is never used.
async function playerStateFromDevice(record) {
  const queueTracks = Array.isArray(record?.playbackQueue?.tracks) ? record.playbackQueue.tracks : [];
  const all = await playerTracksFromDevice([record?.track, ...queueTracks]);
  const track = all?.[0];
  if (!track) return null;
  const restored = all.slice(1);
  const currentIndex = restored.slice(0, record.playbackQueue?.currentIndex + 1).filter(Boolean).length - 1;
  const tracks = restored.filter(Boolean);
  const playbackQueue = tracks[currentIndex]?.path === track.path
    ? { ...record.playbackQueue, tracks, currentIndex } : null;
  return { ...record, track, playbackQueue };
}
