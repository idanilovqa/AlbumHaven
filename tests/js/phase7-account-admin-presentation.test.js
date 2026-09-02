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
const adminNavigation = readProjectFile('music_app', 'templates', 'partials', 'admin-settings-nav.html');

test('Account and Admin navigation keep Users discoverable and omit redundant links', () => {
  assert.doesNotMatch(accountTemplate, /href="#active-sessions"|>Back to library</);
  assert.match(accountTemplate, /include ["']partials\/admin-settings-nav.html["']/);
  assert.match(adminNavigation, /<button class="settings-nav-item" type="submit">.*Sign Out<\/button>/);
  assert.match(adminNavigation, /href="\/admin\/members"[^\n]*aria-current="page"[^\n]*Users/);
  assert.doesNotMatch(adminNavigation, /settings-back|Back to library/);
});

test('Admin navigation offers My account instead of unavailable placeholders', () => {
  assert.match(adminNavigation, /href="\/account"[^\n]*My account<\/a>/);
  assert.doesNotMatch(adminNavigation, /is-future|aria-disabled|Email delivery|Security|Audit log/);
});

test('Account navigation identifies the current user settings as My account', () => {
  assert.match(accountTemplate, /set settings_section = 'account'/);
  assert.match(adminNavigation, /settings_section == 'account'[^\n]*aria-current="page"[^\n]*My account/);
});

test('Account navigation omits the unavailable Profile placeholder', () => {
  assert.doesNotMatch(accountTemplate, />Profile<\/span>/);
});

test('Account session list has no divider above its first session', () => {
  const sessionsRule = accountCss.match(/\.sessions\s*\{([^}]*)\}/)?.[1] || '';
  assert.doesNotMatch(sessionsRule, /border-top\s*:/);
});

for (const [surface, css] of [['Account', accountCss], ['Admin', adminCss]]) {
  test(`${surface} hides carets on static text but retains them in editable controls`, () => {
    assert.match(adminCss, /\.settings-host\s*\{[^}]*caret-color:\s*transparent/s);
    assert.match(
      css,
      /input,\s*\.settings-host(?: \.account-main)? textarea,\s*\.settings-host(?: \.account-main)? select,\s*\.settings-host(?: \.account-main)? \[contenteditable="true"\]\s*\{[^}]*caret-color:\s*auto/s,
    );
  });
}

test('library and direct Settings pages own one shared host and navigation entry point', () => {
  for (const templateName of ['index.html', 'account.html', 'admin-members.html', 'admin-account-detail.html']) {
    const template = readProjectFile('music_app', 'templates', templateName);
    assert.equal((template.match(/data-settings-host/g) || []).length, 1, templateName);
    assert.equal((template.match(/include ["']partials\/admin-settings-nav.html["']/g) || []).length, 1, templateName);
    assert.equal((template.match(/\/static\/js\/settings-navigation.js/g) || []).length, 1, templateName);
  }
});
