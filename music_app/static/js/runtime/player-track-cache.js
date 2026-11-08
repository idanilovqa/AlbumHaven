// Recently played tracks kept in this browser, as Android's DiskTrackCache keeps them: a whole
// track exactly as the server streamed it encoded from its first frame (the file's own bytes, the
// server's sample map and its seek table), so it plays and seeks again with no server stream.
// Entries are named by a digest of their key, never by a path; the browser's own storage
// quota bounds them, and the oldest-used go first.
const TRACK_CACHE_NAME = 'album-haven-tracks-v1';
const TRACK_CACHE_FORMAT = 1;
// The share of this origin's quota that kept tracks may use.
const TRACK_CACHE_QUOTA_SHARE = 0.8;

function trackCacheAvailable() {
  return typeof caches !== 'undefined' && typeof crypto !== 'undefined' && Boolean(crypto.subtle);
}

// A re-encoded file changes its duration, and with it the key it is kept under.
function streamingTrackCacheKey(track, quality) {
  return [String(track?.path || ''), Number(track?.durationSeconds) || 0, quality || 'original'].join('\n');
}

async function trackCacheUrl(key) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  const hex = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `/__album-haven-track-cache/${hex}`;
}

function encodeCachedTrack(entry) {
  const meta = new TextEncoder().encode(JSON.stringify({
    format: TRACK_CACHE_FORMAT,
    codec: entry.codec,
    sampleRate: entry.sampleRate,
    skipFrames: entry.skipFrames,
    totalFrames: entry.totalFrames,
    authoritativeTotalFrames: entry.authoritativeTotalFrames,
    table: entry.table || null,
  }));
  const body = new Uint8Array(4 + meta.length + entry.bytes.length);
  new DataView(body.buffer).setUint32(0, meta.length, false);
  body.set(meta, 4);
  body.set(entry.bytes, 4 + meta.length);
  return body;
}

function decodeCachedTrack(buffer) {
  if (buffer.byteLength < 4) return null;
  const metaLength = new DataView(buffer).getUint32(0, false);
  if (4 + metaLength > buffer.byteLength) return null;
  const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, metaLength)));
  const counts = [meta.sampleRate, meta.skipFrames, meta.totalFrames, meta.authoritativeTotalFrames];
  if (meta.format !== TRACK_CACHE_FORMAT || typeof meta.codec !== 'string'
      || !counts.every(value => Number.isSafeInteger(value) && value >= 0)) return null;
  return { ...meta, bytes: new Uint8Array(buffer, 4 + metaLength) };
}

async function loadStreamingCachedTrack(key) {
  if (!trackCacheAvailable()) return null;
  try {
    const cache = await caches.open(TRACK_CACHE_NAME);
    const url = await trackCacheUrl(key);
    const response = await cache.match(url);
    if (!response) return null;
    const buffer = await response.arrayBuffer();
    const entry = decodeCachedTrack(buffer);
    if (!entry) {
      void cache.delete(url);
      return null;
    }
    // Written again, it is the most recently used.
    void cache.put(url, new Response(buffer)).catch(() => {});
    return entry;
  } catch (_error) {
    return null;
  }
}

async function evictStreamingCachedTracks(cache) {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return;
  const keys = await cache.keys();
  for (const request of keys) {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    if (!quota || usage <= quota * TRACK_CACHE_QUOTA_SHARE) return;
    await cache.delete(request);
  }
}

// Fire and forget: a track that cannot be kept streams again next time.
function keepStreamingCachedTrack(key, entry) {
  if (!trackCacheAvailable()) return;
  void (async () => {
    const cache = await caches.open(TRACK_CACHE_NAME);
    await cache.put(await trackCacheUrl(key), new Response(encodeCachedTrack(entry)));
    await evictStreamingCachedTracks(cache);
  })().catch(() => {});
}
