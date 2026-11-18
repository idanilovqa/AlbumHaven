import net from 'node:net';
import { Transform } from 'node:stream';

/**
 * A loopback TCP relay in front of the app, so a test can lose the network for real: `stall()`
 * refuses new connections and freezes the open ones without closing them, as Wi-Fi going off
 * does, and `restore()` accepts and resumes them again. Nothing in the page is intercepted or mocked: the browser simply reaches the
 * app through this port. Cookies are per host, not per port, so the signed-in session carries over.
 *
 * `playbackBytesPerSecond` caps what the playback socket (`/playback/pcm`) delivers, as a slow
 * mobile network does, so only part of a song has arrived when the network goes.
 */
export async function startNetworkRelay(targetPort, { playbackBytesPerSecond = 0 } = {}) {
  const sockets = new Set();
  let server = null;
  let port = 0;

  const throttle = () => {
    let allowance = playbackBytesPerSecond;
    let last = Date.now();
    return new Transform({
      transform(chunk, _encoding, done) {
        const forward = (offset) => {
          const now = Date.now();
          allowance = Math.min(playbackBytesPerSecond, allowance + ((now - last) / 1000) * playbackBytesPerSecond);
          last = now;
          const size = Math.min(chunk.length - offset, Math.max(0, Math.floor(allowance)));
          if (size > 0) {
            this.push(chunk.subarray(offset, offset + size));
            allowance -= size;
          }
          if (offset + size >= chunk.length) done();
          else setTimeout(() => forward(offset + size), 50);
        };
        forward(0);
      },
    });
  };

  const accept = (client) => {
    const upstream = net.connect(targetPort, '127.0.0.1');
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => {});
    }
    client.pipe(upstream);
    // The request line says whether this connection is the playback socket.
    client.once('data', (head) => {
      const playback = playbackBytesPerSecond > 0 && head.toString('latin1', 0, 64).includes('/playback/pcm');
      if (!playback) return upstream.pipe(client);
      const limiter = throttle();
      limiter.on('error', () => {});
      sockets.add(limiter);
      return upstream.pipe(limiter).pipe(client);
    });
  };

  const listen = () => new Promise((resolve, reject) => {
    server = net.createServer(accept);
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
  });
  await listen();

  return {
    get origin() { return `http://127.0.0.1:${port}`; },
    /**
     * Refuses new connections and freezes the open ones without closing them, as a laptop's Wi-Fi
     * going off does: the page sees no close, its sockets just stop delivering.
     */
    stall() {
      server?.close();
      server = null;
      for (const socket of sockets) socket.pause?.();
    },
    /** Accepts connections again on the same port; stalled ones carry on where they stopped. */
    restore: async () => {
      if (!server) await listen();
      for (const socket of sockets) socket.resume?.();
    },
    close() {
      server?.close();
      server = null;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    },
  };
}
