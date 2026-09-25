import { CapabilityPage } from '../poms/capabilityPage.js';
import { signInCapabilityMember } from '../actions/capabilityActions.js';
import { signIn } from '../actions/authActions.js';
import { authenticatedPageGet } from '../../helpers/authenticatedPageRequest.js';
import { expect, test } from '../support/baseFixtures.js';

const MISSING_TRACK = '/track?path=capability-audit-no-such-track.mp3';

// Additive production-app scenarios. Existing permission and functional specs
// remain unchanged; accounts are created and configured through the real UI.
test('FTC-CAP-AUDIT-001 Viewer browses but has no playback or privileged sections', async ({ page, freshBrowserSession }) => {
  const memberPage = await signInCapabilityMember(page, freshBrowserSession, 'viewer', ['View library', 'View virtual discography']);
  const ui = new CapabilityPage(memberPage);
  await ui.openSettings();
  await expect(ui.tab('problematic-files')).toBeHidden();
  await expect(ui.tab('rules')).toBeHidden();
  await expect(ui.tab('loops')).toBeHidden();
  await expect(ui.tab('appearance')).toBeVisible();
  await expect(ui.player).toBeHidden();
  const actions = await ui.allowedActions();
  expect(actions['library.virtual_discography.read']).toBe(true);
  expect(actions).not.toHaveProperty('library.media.read');
  const denied = await authenticatedPageGet(memberPage, MISSING_TRACK);
  expect(denied.status()).toBe(403);
  expect(await denied.json()).toEqual({ detail: 'Action not permitted.' });
});

test('FTC-CAP-AUDIT-002 Listener retains playback and Appearance without Problems Rules or Loops', async ({ page, freshBrowserSession }) => {
  const memberPage = await signInCapabilityMember(page, freshBrowserSession, 'listener', ['View library', 'Play and download files']);
  const ui = new CapabilityPage(memberPage);
  await ui.openSettings();
  await expect(ui.tab('problematic-files')).toBeHidden();
  await expect(ui.tab('rules')).toBeHidden();
  await expect(ui.tab('loops')).toBeHidden();
  await ui.tab('appearance').click();
  await expect(ui.tab('appearance')).toHaveAttribute('aria-selected', 'true');
  await expect(ui.notice).toBeHidden();
  expect((await ui.allowedActions())['library.media.read']).toBe(true);
  expect((await authenticatedPageGet(memberPage, MISSING_TRACK)).status()).toBe(404);
});

test('FTC-CAP-AUDIT-003 Practice-only grants expose saved loops without creation', async ({ page, freshBrowserSession }) => {
  const memberPage = await signInCapabilityMember(page, freshBrowserSession, 'practice', ['View library', 'View saved loops', 'Play saved loop media']);
  const ui = new CapabilityPage(memberPage);
  await ui.openSettings();
  await ui.tab('loops').click();
  await expect(ui.tab('loops')).toHaveAttribute('aria-selected', 'true');
  await expect(ui.tab('problematic-files')).toBeHidden();
  const actions = await ui.allowedActions();
  expect(actions['library.loops.read']).toBe(true);
  expect(actions['library.loops.media.read']).toBe(true);
  expect(actions).not.toHaveProperty('library.loops.create');
  expect((await authenticatedPageGet(memberPage, '/utilities/loops')).status()).toBe(200);
});

test('FTC-CAP-AUDIT-004 protected Owner retains every desktop-web section', async ({ page }) => {
  await signIn(page);
  const ui = new CapabilityPage(page);
  await ui.openSettings();
  await expect(ui.tab('problematic-files')).toBeVisible();
  await expect(ui.tab('rules')).toBeVisible();
  await expect(ui.tab('loops')).toBeVisible();
  await expect(ui.tab('appearance')).toBeVisible();
  const actions = await ui.allowedActions();
  expect(actions['library.files.edit_tags']).toBe(true);
  expect(actions['library.inventory.manage']).toBe(true);
  expect(actions['library.loops.create']).toBe(true);
  expect(actions['accounts.read']).toBe(true);
});

test.describe('mobile client ceiling', () => {
  test.use({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148' });
  test('FTC-CAP-AUDIT-005 Owner keeps Practice and playback but cannot edit delete or create loops', async ({ page }) => {
    await signIn(page);
    const ui = new CapabilityPage(page);
    await ui.openSettings();
    await expect(ui.tab('loops')).toBeVisible();
    const actions = await ui.allowedActions();
    expect(actions['library.media.read']).toBe(true);
    expect(actions['library.loops.read']).toBe(true);
    expect(actions).not.toHaveProperty('library.files.edit_tags');
    expect(actions).not.toHaveProperty('library.inventory.manage');
    expect(actions).not.toHaveProperty('library.loops.create');
  });
});

test.describe('TV client ceiling', () => {
  test.use({ userAgent: 'Mozilla/5.0 (SMART-TV; Linux; Tizen 8.0) AppleWebKit/537.36 TV Safari/537.36' });
  test('FTC-CAP-AUDIT-006 Owner has no Admin or Practice on TV and direct routes also deny', async ({ page }) => {
    await signIn(page);
    const ui = new CapabilityPage(page);
    await ui.menu.settingsButton.click();
    await expect(ui.menu.adminPanelMenuItem).toHaveCount(0);
    await ui.menu.settingsMenuItem.click();
    await expect(ui.tab('loops')).toBeHidden();
    await expect(ui.tab('appearance')).toBeVisible();
    const actions = await ui.allowedActions();
    expect(actions['library.media.read']).toBe(true);
    expect(actions).not.toHaveProperty('accounts.read');
    expect(actions).not.toHaveProperty('library.loops.read');
    expect(actions).not.toHaveProperty('library.loops.create');
    expect(actions).not.toHaveProperty('library.files.edit_tags');
    expect(actions).not.toHaveProperty('library.inventory.manage');
    expect((await authenticatedPageGet(page, '/utilities/loops')).status()).toBe(403);
    expect((await authenticatedPageGet(page, '/admin/members')).status()).toBe(403);
  });
});
