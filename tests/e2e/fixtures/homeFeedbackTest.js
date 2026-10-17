import fs from 'node:fs/promises';
import { test as base, expect } from '../support/mobileFixtures.js';
import { HomeFeedbackPage } from '../poms/homeFeedbackPage.js';
import { HomeFeedbackActions } from '../actions/homeFeedbackActions.js';
import { observePlaybackPcmTraffic } from '../helpers/gaplessPlaybackHelpers.js';

export const test = base.extend({
  homeManifest: [async ({}, use, workerInfo) => {
    const file = workerInfo.config.metadata.homeFeedbackManifest;
    if (process.env.PLAYWRIGHT_MANAGED_APP !== '1' || !file) {
      throw new Error('Home feedback requires the runner-owned app and manifest; use npm run test:e2e:home-feedback.');
    }
    const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
    if (!manifest.cases || !manifest.catalog) throw new Error('Home feedback pre-start setup is incomplete.');
    await use(manifest);
  }, { scope: 'worker' }],
  home: async ({ page, homeManifest, mobileBrowserSessions }, use, testInfo) => {
    const matched = testInfo.title.match(/FTC-HFP-FB-(\d{3})/);
    const caseKey = matched && `FB${matched[1]}`;
    if (!caseKey || !homeManifest.cases[caseKey]) throw new Error('Each Home case requires its own seeded account pair.');
    const owned = [], errors = [], requests = [];
    const create = (target, credentials) => {
      const pcm = observePlaybackPcmTraffic(target);
      const onError = error => errors.push(error.stack || error.message);
      const onRequest = request => {
        const url = new URL(request.url());
        if (url.origin === new URL(testInfo.project.use.baseURL).origin && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
          requests.push({ method: request.method(), pathname: url.pathname });
        }
      };
      target.on('pageerror', onError); target.on('request', onRequest);
      owned.push({ target, pcm, onError, onRequest });
      return new HomeFeedbackActions(new HomeFeedbackPage(target), {
        data: homeManifest.cases[caseKey], catalog: homeManifest.catalog,
        credentials, pcm, requests, step: (name, action) => test.step(name, action),
      });
    };
    const data = homeManifest.cases[caseKey], home = create(page, data.actor);
    home.newSession = async (credentials = data.friend, options = {}) => {
      const session = await mobileBrowserSessions.create(options);
      const actions = create(session.page, credentials);
      actions.closeSession = () => session.close();
      await actions.signIn();
      return actions;
    };
    try { await use(home); }
    finally {
      for (const item of owned) {
        item.target.off('pageerror', item.onError); item.target.off('request', item.onRequest);
        item.pcm.stop();
      }
      await testInfo.attach('home-feedback-browser-evidence', {
        body: JSON.stringify({ case: caseKey, account: data.actor.username, errors, writes: requests }, null, 2),
        contentType: 'application/json',
      });
    }
  },
});
export { expect };
