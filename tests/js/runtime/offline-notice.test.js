// OfflineNotice (owner-approved v003, unreachable server state): plain text with a muted crossed-out
// cloud and no box; the JavaScript and Jinja renderers draw the same markup.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..', '..', '..', 'music_app');
const sourcePath = path.join(root, 'static', 'js', 'runtime', 'offline-notice.js');
const templatePath = path.join(root, 'templates', 'components', 'offline-notice.html');

function load() {
  const context = vm.createContext({
    escapeHtml: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll("'", '&#39;'),
  });
  vm.runInContext(fs.readFileSync(sourcePath, 'utf8'), context, { filename: sourcePath });
  return context;
}

const MESSAGE = "Offline. Can't load more albums, check your network or try again later";

test('each variant is plain text with no alert box; only block and line draw the cloud', () => {
  const { buildOfflineNoticeHtml } = load();
  for (const variant of ['block', 'line', 'text']) {
    const html = buildOfflineNoticeHtml({ variant, message: MESSAGE });
    assert.match(html, new RegExp(`class="offline-notice offline-notice--${variant}" role="status" data-offline-notice="${variant}"`));
    assert.match(html, /<p class="offline-notice__text">Offline\. Can&#39;t load more albums, check your network or try again later<\/p>/);
    assert.doesNotMatch(html, /on-page-alert|alert/);
    assert.equal(html.includes('offline-notice__cloud'), variant !== 'text', variant);
  }
  assert.match(buildOfflineNoticeHtml({ variant: 'unknown', message: 'x' }), /offline-notice--line/);
  assert.match(buildOfflineNoticeHtml({ message: '<b>' }), /&lt;b>/);
});

test('the Jinja renderer draws the same cloud, classes and variants', () => {
  const { buildOfflineCloudHtml } = load();
  const template = fs.readFileSync(templatePath, 'utf8');
  assert.ok(template.includes(buildOfflineCloudHtml()), 'same crossed-out cloud');
  assert.match(template, /class="offline-notice offline-notice--\{\{ variant \}\}/);
  assert.match(template, /role="status" data-offline-notice="\{\{ variant \}\}"/);
  assert.match(template, /variant in \('block', 'line', 'text'\) else 'line'/);
  assert.match(template, /\{% if variant != 'text' %\}<span class="offline-notice__cloud">/);
  assert.match(template, /<p class="offline-notice__text">\{\{ message \}\}<\/p>/);
});

test('the stylesheet gives no box, border or tint', () => {
  const css = fs.readFileSync(path.join(root, 'static', 'css', 'runtime', 'offline-notice.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /border|background|box-shadow/);
  assert.match(css, /\.offline-notice__cloud \{[^}]*color: var\(--muted\)/);
});
