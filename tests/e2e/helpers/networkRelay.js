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
  let tunnelDown = false;

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

  // Cloudflare's answer while its tunnel has no server: an HTML error page with status 530.
  const answerTunnelDown = (client) => {
    client.on('error', () => {});
    client.once('data', () => client.end([
      'HTTP/1.1 530 <none>', 'Content-Type: text/html; charset=UTF-8', 'Connection: close', '',
      '<!DOCTYPE html><title>Error 1033</title><h1>Cloudflare Tunnel error</h1>',
    ].join('\r\n')));
  };

  const accept = (client) => {
    if (tunnelDown) return answerTunnelDown(client);
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
    /**
     * Accepts connections again on the same port. Stalled ones carry on where they stopped, or,
     * with `revive: false`, stay dead without closing, as connections do when the network that
     * returns is not the one they were made on: only new connections work.
     */
    restore: async ({ revive = true } = {}) => {
      tunnelDown = false;
      const stalled = [...sockets];
      if (!server) await listen();
      if (revive) for (const socket of stalled) socket.resume?.();
    },
    /**
     * The network is back but the server is not: every request, the playback socket's included, is
     * answered with Cloudflare's 530 error page, as the owner's tunnel does for about a minute after
     * the laptop that serves it gets its Wi-Fi back. `restore()` ends it.
     */
    serverUnreachable: async () => {
      tunnelDown = true;
      if (!server) await listen();
    },
    close() {
      server?.close();
      server = null;
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    },
  };
}
