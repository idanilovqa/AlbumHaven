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

const LINE = "Offline. Can't load more albums, check your network or try again later";
const DETAIL = "Can't load the details, check your network or try again later";

test('a line is the small cloud and one plain line; a message is the cloud and a title over the detail; never an alert box', () => {
  const { buildOfflineNoticeHtml, buildOfflineCloudHtml } = load();
  const cloud = `<span class="offline-notice__cloud">${buildOfflineCloudHtml()}</span>`;

  assert.equal(buildOfflineNoticeHtml({ variant: 'line', message: LINE }),
    `<div class="offline-notice offline-notice--line" role="status" data-offline-notice="line">${cloud}<p class="offline-notice__text">Offline. Can&#39;t load more albums, check your network or try again later</p></div>`);
  assert.equal(buildOfflineNoticeHtml({ variant: 'message', title: 'Offline', message: DETAIL }),
    `<div class="offline-notice offline-notice--message" role="status" data-offline-notice="message"><p class="offline-notice__title">${cloud}Offline</p><p class="offline-notice__text">Can&#39;t load the details, check your network or try again later</p></div>`);
  for (const variant of ['line', 'message']) assert.doesNotMatch(buildOfflineNoticeHtml({ variant, message: 'x' }), /alert/);
  assert.match(buildOfflineNoticeHtml({ variant: 'unknown', message: 'x' }), /offline-notice--line/);
  assert.match(buildOfflineNoticeHtml({ message: '<b>' }), /&lt;b>/);
});

test('the Jinja renderer draws the same cloud, classes and variants', () => {
  const { buildOfflineCloudHtml } = load();
  const template = fs.readFileSync(templatePath, 'utf8');
  assert.ok(template.includes(`<span class="offline-notice__cloud">${buildOfflineCloudHtml()}</span>`), 'same crossed-out cloud');
  assert.match(template, /class="offline-notice offline-notice--\{\{ variant \}\}/);
  assert.match(template, /role="status" data-offline-notice="\{\{ variant \}\}"/);
  assert.match(template, /variant in \('line', 'message'\) else 'line'/);
  assert.match(template, /\{% if variant == 'message' %\}<p class="offline-notice__title">\{\{ cloud \}\}\{\{ title \}\}<\/p>\{% else %\}\{\{ cloud \}\}\{% endif %\}<p class="offline-notice__text">\{\{ message \}\}<\/p>/);
});

test('the stylesheet gives no box, border or tint, and the cloud the text line\'s height (one centerline)', () => {
  const css = fs.readFileSync(path.join(root, 'static', 'css', 'runtime', 'offline-notice.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /border|background|box-shadow/);
  assert.match(css, /\.offline-notice \{[^}]*align-items: center;[^}]*line-height: 1\.35;/);
  assert.match(css, /\.offline-notice__cloud \{[^}]*width: 1\.35em; height: 1\.35em;[^}]*color: var\(--muted\)/);
  assert.match(css, /\.offline-notice--message \.offline-notice__title \{[^}]*align-items: center;[^}]*font-weight: 700;/);
});
