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
const mobileLayoutCss = readProjectFile('music_app', 'static', 'css', 'mobile-layout.css');
const adminNavigation = readProjectFile('music_app', 'templates', 'partials', 'admin-settings-nav.html');
const navigationMacro = readProjectFile('music_app', 'templates', 'components', 'navigation-tree.html');

test('Account and Admin navigation keep Users discoverable and omit redundant links', () => {
  assert.doesNotMatch(accountTemplate, /href="#active-sessions"|>Back to library</);
  assert.match(accountTemplate, /include ["']partials\/admin-settings-nav.html["']/);
  assert.match(adminNavigation, /<form[^>]*method="post"[^>]*action="\/logout">[\s\S]*name="csrf_token"[\s\S]*navigation_tree_item\('Sign Out', key='sign-out', icon='↪', action=true\)[\s\S]*<\/form>/);
  assert.match(adminNavigation, /if navigation_actions\.allows\('accounts\.read'\) %}{{ navigation_tree_item\('Users', '\/admin\/members', 'users', settings_section == 'users'/);
  assert.match(navigationMacro, /set tag = 'button' if action else 'a'/);
  assert.match(navigationMacro, /if action %}type="submit"/);
  assert.match(navigationMacro, /if selected %} aria-current="{{ 'page' if settings else 'true' }}"/);
  assert.doesNotMatch(adminNavigation, /settings-back|Back to library/);
});

test('shared page headers keep Back before the title on desktop', () => {
  assert.match(
    mobileLayoutCss,
    /@media \(min-width: 901px\)[\s\S]*?\.page-gallery-bar__back\s*\{[^}]*grid-column:\s*1;[^}]*grid-row:\s*1;[^}]*\}[\s\S]*?\.page-gallery-bar \.gallery-bar__title\s*\{[^}]*grid-column:\s*2;[^}]*grid-row:\s*1;[^}]*\}/,
  );
});

test('Admin navigation offers My account instead of unavailable placeholders', () => {
  assert.match(adminNavigation, /navigation_tree_item\('My account', '\/account', 'account'/);
  assert.doesNotMatch(adminNavigation, /is-future|aria-disabled|Email delivery|Security|Audit log/);
});

test('Account navigation identifies the current user settings as My account', () => {
  assert.match(accountTemplate, /set settings_section = 'account'/);
  assert.match(adminNavigation, /navigation_tree_item\('My account', '\/account', 'account', settings_section == 'account'/);
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

test('Account identity selector belongs to its account content, not duplicate mobile chrome', () => {
  const source = readProjectFile('tests', 'e2e', 'phase7', 'poms', 'authPages.js');
  const assignment = source.match(/this\.signedInIdentity\s*=\s*([^;]+);/)?.[1];
  assert.equal(assignment, `page.locator('.account-main [data-gallery-bar-instance="page"] .gallery-bar__summary')`);
  assert.match(accountTemplate, /<section class="settings-main account-main">\s*\{\{ page_gallery_bar\('Password', profile\.username/);
  // No first()/nth()/visibility fallback: duplicate identities within the owning
  // account surface must still fail Playwright's strict locator assertions.
  assert.doesNotMatch(assignment, /first\(|nth\(|:visible|filter\(/);
});

test('disabled shared buttons are visibly inactive and pointer-hover checkbox outlines stay neutral', () => {
  const buttons = readProjectFile('music_app/static/css/button-component.css');
  assert.match(buttons, /\.ui-button:disabled,\s*\.ui-button\[aria-disabled='true'\],[^{]+\{[^}]*opacity:\s*0\.38;[^}]*cursor:\s*not-allowed;/s);
  const appearance = readProjectFile('music_app/static/css/appearance-backgrounds.css');
  const checkboxHover = appearance.match(/:root input\[type='checkbox'\]:not\(\.global-player \*\):hover:not\(:disabled\)\s*\{([^}]*)\}/)?.[1];
  assert.ok(checkboxHover);
  assert.match(checkboxHover, /outline:\s*1px solid var\(--appearance-control-selected\)/);
  assert.doesNotMatch(checkboxHover, /--appearance-accent|--appearance-interaction-outline/);
});

test('UI-7: every Settings page script loads before settings navigation mounts the page, on both hosts', () => {
  // Settings navigation mounts the visible Settings page as soon as it runs; a page script loaded after it
  // left that page unmounted (the Server page's storage choices stayed disabled in the library document).
  const index = readProjectFile('music_app', 'templates', 'index.html');
  const navigation = index.indexOf('/static/js/settings-navigation.js');
  for (const script of ['/static/js/account.js', '/static/js/admin-members.js', '/static/js/admin-server.js']) {
    assert.ok(index.indexOf(script) >= 0 && index.indexOf(script) < navigation, `${script} loads before settings navigation`);
  }
  const server = readProjectFile('music_app', 'templates', 'admin-server.html');
  assert.ok(server.indexOf('partials/admin-ui-assets.html') < server.indexOf('/static/js/settings-navigation.js'), 'the direct Server page loads admin-server.js first');
});
