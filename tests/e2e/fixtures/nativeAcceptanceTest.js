import fs from 'node:fs/promises';
import { test as base, expect } from '../support/mobileFixtures.js';
import { NativeAcceptancePage } from '../poms/nativeAcceptancePage.js';
import { NativeAcceptanceActions } from '../actions/nativeAcceptanceActions.js';

export const NATIVE_CASE_KEYS = Object.freeze(['NA001', 'NA002', 'NA003', 'NA004', 'NA005']);
const summaries = Object.freeze({
  NA001: 'Synthetic own preferences and friend read-only taste',
  NA002: 'Empty Goals period and dismissed admission',
  NA003: 'Synthetic Top order and explicit manual completion',
  NA004: 'Native popularity search sibling matches and Advanced draft',
  NA005: 'Synthetic Artist bookmark admission and touch sheet navigation',
});
const requiredCaptures = Object.freeze({ NA001: ['own-preferences'], NA002: ['empty-goals'],
  NA003: ['top-order-progress'], NA004: ['two-matches', 'one-match'], NA005: ['artist-sheet', 'returned-parent'] });
const captureLabels = new Set(['friend-taste', 'own-preferences', 'empty-goals', 'top-order-progress',
  'two-matches', 'one-match', 'artist-sheet', 'returned-parent', 'mobile-home', 'failure']);

export function validateNativeManifest(manifest) {
  if (manifest?.scenario !== 'native-acceptance' || manifest.version !== 1
      || JSON.stringify(Object.keys(manifest.cases || {}).sort()) !== JSON.stringify(NATIVE_CASE_KEYS)) {
    throw new Error('Native acceptance requires the exact scenario version and five owned cases.');
  }
  return manifest;
}

export function publicNativeCase(manifest, caseKey) {
  if (!NATIVE_CASE_KEYS.includes(caseKey)) throw new Error('Unknown native acceptance case.');
  const source = manifest.cases[caseKey]?.public;
  const text = value => {
    if (typeof value !== 'string' || !value || value.length > 512) throw new Error('Incomplete native public identity.');
    return value;
  };
  if (source?.caseKey !== caseKey) throw new Error('Native case ownership does not match.');
  const albums = Object.fromEntries(['first', 'second'].map(key => {
    const value = source.catalog?.albums?.[key];
    return [key, { key: text(value?.key), ref: text(value?.ref), title: text(value?.title), artist: text(value?.artist) }];
  }));
  const tracks = Object.fromEntries(['one', 'two', 'quiet', 'three', 'four', 'still'].map(key =>
    [key, { title: text(source.catalog?.tracks?.[key]?.title) }]));
  for (const value of [...Object.values(albums), ...Object.values(tracks)]) {
    if (!value.title.startsWith(`Native ${caseKey} `)) throw new Error('Native labels must belong to the selected case.');
  }
  return { caseKey, catalog: { albums, tracks },
    friend: { accountRef: text(source.friend?.accountRef), displayName: text(source.friend?.displayName) },
    ...(['NA003', 'NA005'].includes(caseKey) ? { top: { ref: text(source.top?.ref), title: text(source.top?.title) } } : {}) };
}

export async function signInNative(view, credentials) {
  // Keep credentials inside this helper and replace authentication diagnostics.
  try {
    if (typeof credentials?.username !== 'string' || typeof credentials?.password !== 'string') throw new Error();
    await view.page.goto('/?surface=home');
    await expect(view.login).toBeVisible();
    await view.username.fill(credentials.username); await view.password.fill(credentials.password);
    await view.signIn.click(); await expect(view.shell).toBeVisible(); await expect(view.login).toBeHidden();
    await view.page.goto('/?surface=home'); await expect(view.home).toBeVisible(); await expect(view.sections).toBeVisible();
  } catch { throw new Error('Native acceptance normal sign-in failed.'); }
}

export function nativeOutcome({ caseKey, sourceCommit, viewport, passed, errors, screenshot }) {
  return { ftcId: `FTC-NATIVE-ACCEPT-${caseKey.slice(2)}`, sourceCommit, scenarioVersion: 1,
    viewport: { width: viewport.width, height: viewport.height },
    visibleSummary: summaries[caseKey], assertionsCompleted: passed === true,
    unexpectedErrorCount: errors, screenshot };
}

export const test = base.extend({
  nativeManifest: [async ({}, use, workerInfo) => {
    const file = workerInfo.config.metadata.homeFeedbackManifest;
    if (process.env.PLAYWRIGHT_MANAGED_APP !== '1' || !file) {
      throw new Error('Native acceptance requires the runner-owned app and manifest.');
    }
    let manifest;
    try { manifest = JSON.parse(await fs.readFile(file, 'utf8')); }
    catch { throw new Error('Native acceptance manifest is unavailable.'); }
    await use(validateNativeManifest(manifest));
  }, { scope: 'worker' }],
  native: async ({ page, context, nativeManifest, mobileBrowserSessions }, use, testInfo) => {
    const match = testInfo.title.match(/^FTC-NATIVE-ACCEPT-(00[1-5]) /);
    const caseKey = match && `NA${match[1]}`;
    const data = publicNativeCase(nativeManifest, caseKey);
    if (nativeManifest.cases[caseKey].actor?.username !== `native-${caseKey.toLowerCase()}-actor`) {
      throw new Error('Native credentials must belong to the selected synthetic actor.');
    }
    const sourceCommit = String(process.env.ALBUM_HAVEN_NATIVE_ACCEPTANCE_COMMIT || process.env.GITHUB_SHA || '');
    if (!/^[0-9a-f]{40}$/.test(sourceCommit)) throw new Error('Native evidence requires the candidate commit identity.');
    let errors = 0, captured = 0, active = null, captureState = 'withheld', completed = false;
    const pages = new Map(), contexts = new Map(), capturedLabels = new Set();
    const observePage = target => {
      if (pages.has(target)) return;
      const onError = () => { errors++; };
      target.on('pageerror', onError); pages.set(target, { onError, authenticated: false });
    };
    const observeContext = owned => {
      if (contexts.has(owned)) return;
      owned.on('page', observePage); contexts.set(owned, observePage);
      for (const target of owned.pages()) observePage(target);
    };
    observeContext(context);
    const capture = async (target, label) => {
      if (!captureLabels.has(label)) throw new Error('Unknown native screenshot label.');
      const state = pages.get(target), view = new NativeAcceptancePage(target);
      if (!state?.authenticated) { captureState = 'withheld'; throw new Error('Native screenshot withheld before synthetic authentication.'); }
      if (target.isClosed()) { captureState = 'unavailable'; throw new Error('Native screenshot page is unavailable.'); }
      // Every authenticated session here is the selected synthetic actor. No account switch or external surface is permitted.
      if (!await view.shell.isVisible() || await view.login.isVisible()
          || new URL(target.url()).origin !== new URL(testInfo.project.use.baseURL).origin) {
        captureState = 'withheld'; throw new Error('Native screenshot withheld outside its authenticated product surface.');
      }
      try {
        await testInfo.attach(`${caseKey}-${label}-${captured + 1}.png`, { body: await target.screenshot({ fullPage: true }), contentType: 'image/png' });
        captured++; capturedLabels.add(label); captureState = 'captured';
      } catch { captureState = 'unavailable'; throw new Error('Native screenshot capture is unavailable.'); }
    };
    const actionsFor = target => {
      observePage(target); active = target;
      const view = new NativeAcceptancePage(target);
      return new NativeAcceptanceActions(view, { data,
        signIn: async () => {
          await signInNative(view, nativeManifest.cases[caseKey].actor);
          pages.get(target).authenticated = true;
        }, capture: label => capture(target, label) });
    };
    const native = actionsFor(page);
    native.mobileSession = async () => {
      if (caseKey !== 'NA005') throw new Error('Only the mobile case owns a fresh touch session.');
      const session = await mobileBrowserSessions.create({ viewport: { width: 390, height: 844 },
        deviceScaleFactor: 1, isMobile: true, hasTouch: true });
      observeContext(session.context);
      return actionsFor(session.page);
    };
    let failure;
    try {
      await use(native);
      if (testInfo.status !== testInfo.expectedStatus) throw new Error('Native case assertions failed.');
      if (errors) throw new Error('Native case encountered unexpected browser errors.');
      if (!requiredCaptures[caseKey].every(label => capturedLabels.has(label))) {
        throw new Error('Native case is missing mandatory success screenshot evidence.');
      }
      completed = true;
    } catch (error) { failure = error; }
    finally {
      if (!completed) {
        try { await capture(active, 'failure'); } catch { /* Original failure remains authoritative; outcome reports unavailable/withheld. */ }
      }
      const secondaryFailure = (type, message) => {
        // Fixed diagnostics only: never serialize a teardown error, stack or path.
        testInfo.annotations.push({ type, description: message });
        if (!failure) failure = new Error(message);
        completed = false;
      };
      try {
        for (const [target, state] of pages) target.off('pageerror', state.onError);
        for (const [owned, listener] of contexts) owned.off('page', listener);
      } catch { secondaryFailure('native-observer-cleanup', 'Native browser observer cleanup failed.'); }
      try { await mobileBrowserSessions.closeAll(); }
      catch { secondaryFailure('native-session-cleanup', 'Native owned-session cleanup failed.'); }
      try {
        const viewport = caseKey === 'NA005' ? { width: 390, height: 844 } : testInfo.project.use.viewport;
        await testInfo.attach(`${caseKey}-outcome.json`, { body: JSON.stringify(nativeOutcome({
          caseKey, sourceCommit, viewport, passed: completed, errors, screenshot: captureState,
        })), contentType: 'application/json' });
      } catch { secondaryFailure('native-outcome-attachment', 'Native outcome attachment failed.'); }
    }
    if (failure) throw failure;
  },
});
export { expect };
