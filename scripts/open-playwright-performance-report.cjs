const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const rootDir = path.resolve(process.argv[2] || '.');
const relativeTarget = String(process.argv[3] || 'index.html').replace(/\\/g, '/').replace(/^\/+/, '');
const port = Number(process.env.PLAYWRIGHT_PERFORMANCE_REPORT_PORT || 9324);
const host = '127.0.0.1';

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.html') return 'text/html; charset=utf-8';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.js') return 'text/javascript; charset=utf-8';
  if (ext === '.css') return 'text/css; charset=utf-8';
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.txt') return 'text/plain; charset=utf-8';
  if (ext === '.zip') return 'application/zip';
  return 'application/octet-stream';
}

function openInDefaultBrowser(url) {
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref();
    return;
  }
  if (process.platform === 'darwin') {
    spawn('open', [url], {
      detached: true,
      stdio: 'ignore',
    }).unref();
    return;
  }
  spawn('xdg-open', [url], {
    detached: true,
    stdio: 'ignore',
  }).unref();
}

function resolveRequestPath(requestUrl) {
  const pathname = decodeURIComponent(String(requestUrl || '/').split('?')[0]);
  const requestedPath = pathname === '/' ? relativeTarget : pathname.replace(/^\/+/, '');
  const absolutePath = path.resolve(rootDir, requestedPath);
  const normalizedRoot = `${rootDir}${path.sep}`;
  if (absolutePath !== rootDir && !absolutePath.startsWith(normalizedRoot)) {
    return null;
  }
  return absolutePath;
}

const server = http.createServer((request, response) => {
  const filePath = resolveRequestPath(request.url);
  if (!filePath) {
    response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Forbidden');
    return;
  }

  let finalPath = filePath;
  if (fs.existsSync(finalPath) && fs.statSync(finalPath).isDirectory()) {
    finalPath = path.join(finalPath, 'index.html');
  }

  if (!fs.existsSync(finalPath) || !fs.statSync(finalPath).isFile()) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }

  response.writeHead(200, { 'Content-Type': getContentType(finalPath) });
  fs.createReadStream(finalPath).pipe(response);
});

server.on('error', (error) => {
  if (error?.code === 'EADDRINUSE') {
    openInDefaultBrowser(`http://${host}:${port}/${relativeTarget}`);
    process.exit(0);
    return;
  }
  process.exit(1);
});

server.listen(port, host, () => {
  openInDefaultBrowser(`http://${host}:${port}/${relativeTarget}`);
});
