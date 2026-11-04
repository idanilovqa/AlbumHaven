const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const repoRoot = path.resolve(__dirname, '..', '..');
const moduleUrl = pathToFileURL(path.join(
  repoRoot,
  'tests',
  'e2e',
  'helpers',
  'authenticatedPageRequest.js',
)).href;

test('authenticated POST preserves payload and sends the browser session cookies', async () => {
  const { authenticatedPagePost } = await import(moduleUrl);
  const response = { status: () => 200 };
  let captured = null;
  const page = {
    url: () => 'http://127.0.0.1:5101/library',
    context: () => ({
      cookies: async () => [
        {
          name: '__Host-album_haven_session',
          value: 'session-token',
          domain: '127.0.0.1',
          path: '/',
        },
        {
          name: '__Host-album_haven_csrf',
          value: 'csrf-token',
          domain: '127.0.0.1',
          path: '/',
        },
      ],
    }),
    request: {
      post: async (target, options) => {
        captured = { target, options };
        return response;
      },
    },
  };
  const data = { album: { name: 'Target' }, manual_urls: [] };

  assert.equal(
    await authenticatedPagePost(page, '/utilities/cover-lookup/start', { data, timeout: 1200 }),
    response,
  );
  assert.equal(captured.target, 'http://127.0.0.1:5101/utilities/cover-lookup/start');
  assert.deepEqual(captured.options.data, data);
  assert.equal(captured.options.timeout, 1200);
  assert.equal(
    captured.options.headers.Cookie,
    '__Host-album_haven_session=session-token; __Host-album_haven_csrf=csrf-token',
  );
  assert.equal(captured.options.headers.Origin, 'http://127.0.0.1:5101');
  assert.equal(captured.options.headers['X-Album-Haven-CSRF'], 'csrf-token');
});
