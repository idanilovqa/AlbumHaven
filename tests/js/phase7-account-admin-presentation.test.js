const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');


const readProjectFile = (...segments) => fs.readFileSync(
  path.join(__dirname, '..', '..', ...segments),
  'utf8',
);

const accountTemplate = readProjectFile('music_app', 'templates', 'account.html');
const accountCss = readProjectFile('music_app', 'static', 'css', 'account.css');
const adminCss = readProjectFile('music_app', 'static', 'css', 'admin-members.css');

test('Account navigation omits the unavailable Profile placeholder', () => {
  assert.doesNotMatch(accountTemplate, />Profile<\/span>/);
});

test('Account session list has no divider above its first session', () => {
  const sessionsRule = accountCss.match(/\.sessions\s*\{([^}]*)\}/)?.[1] || '';
  assert.doesNotMatch(sessionsRule, /border-top\s*:/);
});

for (const [surface, css] of [['Account', accountCss], ['Admin', adminCss]]) {
  test(`${surface} hides carets on static text but retains them in editable controls`, () => {
    assert.match(css, /body\s*\{[^}]*caret-color:\s*transparent/s);
    assert.match(
      css,
      /input,\s*textarea,\s*select,\s*\[contenteditable="true"\]\s*\{[^}]*caret-color:\s*auto/s,
    );
  });
}
