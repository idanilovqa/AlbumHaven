import { test as base, expect } from '@playwright/test';
import { installContextRequestInterceptionGuard } from './requestInterceptionGuard.js';

export function createMobileBrowserSessions(browser, context, defaults = {}) {
  const owned = new Set();
  const closeEntry = entry => {
    if (!entry.closing) entry.closing = Promise.resolve().then(() => entry.resource.close());
    return entry.closing;
  };
  const releaseEntry = entry => {
    try { entry.restore?.(); } finally { owned.delete(entry); }
  };
  const sessionFor = (entry, page, sessionContext) => ({
    page,
    context: sessionContext,
    async close() {
      try { await closeEntry(entry); } finally { releaseEntry(entry); }
    },
  });
  return {
    async create(options = {}) {
      const freshContext = await browser.newContext({ ...defaults, ...options });
      const entry = { resource: freshContext, restore: installContextRequestInterceptionGuard(freshContext) };
      owned.add(entry);
      try {
        const page = await freshContext.newPage();
        return sessionFor(entry, page, freshContext);
      } catch (error) {
        try { await closeEntry(entry); } finally { releaseEntry(entry); }
        throw error;
      }
    },
    async createPage() {
      const page = await context.newPage();
      const entry = { resource: page };
      owned.add(entry);
      return sessionFor(entry, page, context);
    },
    async closeAll() {
      const entries = [...owned];
      const results = await Promise.allSettled(entries.map(closeEntry));
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      for (const entry of entries) {
        try { releaseEntry(entry); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, 'Failed to close owned mobile browser sessions');
    },
  };
}

export const test = base.extend({
  requestInterceptionGuard: [async ({ page, context }, use) => {
    const restore = installContextRequestInterceptionGuard(context);
    try { await use(); } finally { restore(); }
  }, { auto: true }],
  mobileBrowserSessions: async ({ browser, context, requestInterceptionGuard }, use, testInfo) => {
    const sessions = createMobileBrowserSessions(browser, context, {
      baseURL: String(testInfo.project.use?.baseURL || ''),
    });
    try { await use(sessions); } finally { await sessions.closeAll(); }
  },
});
export { expect };
