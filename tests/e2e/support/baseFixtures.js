import { expect, test as base } from '@playwright/test';
import { warmFunctionalBrowser } from '../../../scripts/playwright-functional-browser-warmup.mjs';
import {
  ArtistFamilyActions,
  ArtistPageSettingsActions,
  AppBarActions,
  CoverLookupActions,
  GalleryActions,
  GlobalPlayerActions,
  LibrarySettingsActions,
  NavigationPanelActions,
  ScanPageActions,
  SettingsModalAppBarActions,
  SearchToolbarActions,
  TagEditorActions,
  TrackModalActions,
  UtilityAppearanceActions,
  UtilityIntegrationsActions,
  UtilityLogHistoryActions,
  UtilityLoopsActions,
  UtilityProblematicFilesActions,
  UtilityRulesActions,
  UtilityTabBarActions,
} from '../actions/index.js';
import {
  ArtistFamily,
  ArtistPageSettings,
  AppBar,
  CoverLookup,
  GalleryPage,
  GlobalPlayer,
  LibrarySettings,
  NavigationPanel,
  ScanPage,
  SettingsModalAppBar,
  SearchToolbar,
  TagEditor,
  TrackModal,
  UtilityAppearanceTab,
  UtilityIntegrationsTab,
  UtilityLogHistoryTab,
  UtilityLoopsTab,
  UtilityProblematicFilesTab,
  UtilityRulesTab,
  UtilityTabBar,
} from '../poms/index.js';
import { installContextRequestInterceptionGuard } from './requestInterceptionGuard.js';
import { createManagedAppLifecycle } from '../helpers/managedAppLifecycle.js';
import { readStartupRelationProjectionReadiness } from '../helpers/startupRelationProjectionReadiness.js';
import { observeNonLoopbackHttpRequests } from '../helpers/thirdPartyRequestEvidence.js';
import { observePlaybackPcmTraffic } from '../helpers/gaplessPlaybackHelpers.js';

const ANSI = {
  cyan: '\u001b[36m',
  dim: '\u001b[2m',
  green: '\u001b[32m',
  red: '\u001b[31m',
  yellow: '\u001b[33m',
  reset: '\u001b[0m',
};

function colorize(color, text) {
  return `${ANSI[color]}${text}${ANSI.reset}`;
}

function formatStepLine(level, marker, label) {
  return `${'  '.repeat(level)}${marker} ${label}`;
}

function createAttachmentCollector(testInfo) {
  const attachments = [];
  let stepLoggerState = null;

  return {
    queueAttachment(attachment) {
      attachments.push(attachment);
    },
    queueJsonAttachment(name, value) {
      this.queueAttachment({
        name,
        body: JSON.stringify(value, null, 2),
        contentType: 'application/json',
      });
    },
    queueTextAttachment(name, text) {
      this.queueAttachment({
        name,
        body: text,
        contentType: 'text/plain',
      });
    },
    queuePathAttachment(name, path, contentType) {
      this.queueAttachment({
        name,
        path,
        contentType,
      });
    },
    outputPath(name) {
      return testInfo.outputPath(name);
    },
    setStepLoggerState(logger) {
      stepLoggerState = logger;
    },
    getStepLoggerState() {
      return stepLoggerState;
    },
    async flush() {
      for (const attachment of attachments) {
        if (attachment.path) {
          await testInfo.attach(attachment.name, {
            path: attachment.path,
            contentType: attachment.contentType,
          });
          continue;
        }
        await testInfo.attach(attachment.name, {
          body: attachment.body,
          contentType: attachment.contentType,
        });
      }
    },
  };
}

function createStepLogger(testInfo) {
  const testHeader = `[TEST] ${testInfo.title}`;
  const transcript = [testHeader];
  const events = [];
  console.log(colorize('cyan', testHeader));

  async function runStep(label, fn, level) {
    const startLine = formatStepLine(level, '[STEP]', label);
    console.log(colorize('dim', startLine));
    transcript.push(startLine);

    const startedAt = Date.now();
    try {
      const result = await fn();
      const durationMs = Date.now() - startedAt;
      const successLine = formatStepLine(level, '[PASS]', `${label} (${durationMs} ms)`);
      console.log(colorize('green', successLine));
      transcript.push(successLine);
      events.push({
        type: 'step',
        level,
        label,
        status: 'passed',
        durationMs,
        recordedAt: new Date().toISOString(),
      });
      return result;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      const message = error?.message || String(error);
      const failureLine = formatStepLine(level, '[FAIL]', `${label} :: ${message} (${durationMs} ms)`);
      console.log(colorize('red', failureLine));
      transcript.push(failureLine);
      events.push({
        type: 'step',
        level,
        label,
        status: 'failed',
        durationMs,
        message,
        recordedAt: new Date().toISOString(),
      });
      throw error;
    }
  }

  return {
    title: testInfo.title,
    transcript,
    events,
    step(label, fn) {
      return runStep(label, fn, 1);
    },
    substep(label, fn) {
      return runStep(label, fn, 2);
    },
    note(label, level = 1) {
      const line = formatStepLine(level, '[NOTE]', label);
      console.log(colorize('yellow', line));
      transcript.push(line);
      events.push({
        type: 'note',
        level,
        label,
        status: 'note',
        durationMs: null,
        recordedAt: new Date().toISOString(),
      });
    },
  };
}

function didTestFail(testInfo) {
  return testInfo.status !== testInfo.expectedStatus;
}

function formatRuntimeLogEntry(entry) {
  const location = entry.location
    ? ` @ ${entry.location.url || 'unknown'}:${entry.location.lineNumber ?? 0}:${entry.location.columnNumber ?? 0}`
    : '';
  return `[${entry.timestamp}] ${entry.kind}/${entry.type}: ${entry.text}${location}`;
}

function formatRuntimeLogs(entries) {
  if (!entries.length) {
    return 'No runtime logs captured.';
  }
  return entries.map(formatRuntimeLogEntry).join('\n');
}

function observePageRuntimeLogs(page, configuredOrigin = '') {
  const entries = [];
  const push = (entry) => {
    entries.push({
      ...entry,
      timestamp: new Date().toISOString(),
    });
    if (entries.length > 200) entries.shift();
  };
  const onConsole = (message) => {
    push({
      kind: 'console',
      type: message.type(),
      text: message.text(),
      location: message.location(),
    });
  };
  const onPageError = (error) => {
    push({
      kind: 'pageerror',
      type: 'error',
      text: error?.stack || error?.message || String(error),
    });
  };
  const onRequestFailed = (request) => {
    const headers = request.headers();
    push({
      kind: 'requestfailed',
      type: request.failure()?.errorText || 'requestfailed',
      method: request.method(),
      url: request.url(),
      coverRequestId: String(headers['x-album-haven-cover-request-id'] || ''),
      text: `${request.method()} ${request.url()}`,
    });
  };
  const onResponse = (response) => {
    if (response.status() < 400) return;
    const responseUrl = new URL(response.url());
    const pageUrl = page.url();
    const currentOrigin = pageUrl.startsWith('http') ? new URL(pageUrl).origin : configuredOrigin;
    if (!currentOrigin || responseUrl.origin !== currentOrigin) return;
    push({
      kind: 'httpresponse',
      type: String(response.status()),
      text: `${response.request().method()} ${response.status()} ${response.url()}`,
    });
  };

  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  page.on('requestfailed', onRequestFailed);
  page.on('response', onResponse);

  return {
    snapshot() {
      return [...entries];
    },
    stop() {
      page.off('console', onConsole);
      page.off('pageerror', onPageError);
      page.off('requestfailed', onRequestFailed);
      page.off('response', onResponse);
    },
  };
}

function formatStacktrace(errors) {
  if (!errors.length) {
    return 'No stacktrace captured.';
  }
  return errors
    .map((error, index) => {
      const heading = `Error ${index + 1}`;
      const stack = error.stack || error.message || String(error.value || error);
      return `${heading}\n${stack}`;
    })
    .join('\n\n');
}

const functionalBrowserWarmupFixtures = (
  process.env.ALBUM_HAVEN_FUNCTIONAL_BROWSER_WARMUP === '1'
    ? {
      functionalBrowserWarmup: [async ({ browser, startupRelationProjectionReadiness }, use, workerInfo) => {
        await warmFunctionalBrowser({
          browser,
          baseURL: String(workerInfo.project.use?.baseURL || ''),
          viewport: workerInfo.project.use?.viewport,
        });
        await use();
      }, { scope: 'worker', auto: true }],
    }
    : {}
);

export const test = base.extend({
  managedAppLifecycle: [async ({}, use) => {
    await use(createManagedAppLifecycle());
  }, { scope: 'worker' }],

  freshBrowserSession: async ({ browser, testArtifacts }, use, testInfo) => {
    let session = null;
    try {
      await use({
        async create() {
          if (session) {
            throw new Error('Only one fresh browser session may be created per test.');
          }
          const configuredBaseUrl = String(testInfo.project.use?.baseURL || '');
          const context = await browser.newContext({
            baseURL: configuredBaseUrl,
            viewport: testInfo.project.use?.viewport || { width: 1440, height: 960 },
          });
          const restoreInterceptionGuard = installContextRequestInterceptionGuard(context);
          try {
            const page = await context.newPage();
            const configuredOrigin = configuredBaseUrl ? new URL(configuredBaseUrl).origin : '';
            const runtimeLogObserver = observePageRuntimeLogs(page, configuredOrigin);
            session = {
              context,
              page,
              runtimeLogObserver,
              restoreInterceptionGuard,
              galleryActions: new GalleryActions(new GalleryPage(page, testInfo)),
              coverLookupActions: new CoverLookupActions(new CoverLookup(page, testInfo)),
              searchToolbarActions: new SearchToolbarActions(new SearchToolbar(page, testInfo)),
              tagEditorActions: new TagEditorActions(new TagEditor(page, testInfo)),
              trackModalActions: new TrackModalActions(new TrackModal(page, testInfo)),
            };
            return session;
          } catch (error) {
            try {
              restoreInterceptionGuard();
            } finally {
              await context.close();
            }
            throw error;
          }
        },
      });
    } finally {
      if (session) {
        session.runtimeLogObserver.stop();
        if (didTestFail(testInfo)) {
          testArtifacts.queueTextAttachment(
            'fresh-browser-session-runtime-log.txt',
            formatRuntimeLogs(session.runtimeLogObserver.snapshot()),
          );
          try {
            const screenshot = await session.page.screenshot({ fullPage: true });
            testArtifacts.queueAttachment({
              name: 'fresh-browser-session-failure-screenshot.png',
              body: screenshot,
              contentType: 'image/png',
            });
          } catch (error) {
            testArtifacts.queueTextAttachment(
              'fresh-browser-session-screenshot-error.txt',
              `Failed to capture screenshot: ${error?.message || error}`,
            );
          }
        }
        try {
          session.restoreInterceptionGuard();
        } finally {
          await session.context.close();
        }
      }
    }
  },

  startupRelationProjectionReadiness: [async ({}, use, workerInfo) => {
    const baseURL = String(workerInfo.project.use?.baseURL || '');
    await use(await readStartupRelationProjectionReadiness({ baseURL }));
  }, { scope: 'worker', auto: true }],

  ...functionalBrowserWarmupFixtures,

  requestInterceptionGuard: [async ({ page, context }, use) => {
    const restoreInterceptionGuard = installContextRequestInterceptionGuard(context);
    try {
      await use();
    } finally {
      restoreInterceptionGuard();
    }
  }, { auto: true }],

  thirdPartyRequestEvidence: async ({ page }, use) => {
    const observer = observeNonLoopbackHttpRequests(page);
    try {
      await use(observer);
    } finally {
      observer.stop();
    }
  },

  playbackEvidence: async ({ page }, use) => {
    const observer = observePlaybackPcmTraffic(page);
    try {
      await use(observer);
    } finally {
      observer.stop();
    }
  },

  galleryActions: async ({ page }, use, testInfo) => {
    await use(new GalleryActions(new GalleryPage(page, testInfo)));
  },

  appBarActions: async ({ page }, use, testInfo) => {
    await use(new AppBarActions(new AppBar(page, testInfo)));
  },

  coverLookupActions: async ({ page }, use, testInfo) => {
    const actions = new CoverLookupActions(new CoverLookup(page, testInfo));
    try {
      await use(actions);
    } finally {
      const cleanupErrors = [];
      try {
        await actions.releaseLaterProviderFixture();
      } catch (error) {
        cleanupErrors.push({ stage: 'release', error });
      }
      try {
        await actions.resetProviderFixture();
      } catch (error) {
        cleanupErrors.push({ stage: 'reset', error });
      }
      if (cleanupErrors.length) {
        const stagedErrors = cleanupErrors.map(({ stage, error }) => {
          const detail = error?.stack || error?.message || String(error);
          const stagedError = new Error(`Cover lookup provider cleanup failed during ${stage}: ${detail}`);
          stagedError.cause = error;
          return stagedError;
        });
        if (!didTestFail(testInfo)) {
          if (stagedErrors.length === 1) throw stagedErrors[0];
          throw new AggregateError(stagedErrors, 'Cover lookup provider cleanup failed.');
        }
        const cleanupMessage = stagedErrors
          .map((error) => error.stack || error.message)
          .join('\n\n');
        try {
          await testInfo.attach('cover-lookup-provider-gate-cleanup-error.txt', {
            body: Buffer.from(cleanupMessage),
            contentType: 'text/plain',
          });
        } catch (attachmentError) {
          console.error(
            `Failed to attach the cover lookup provider gate cleanup error: ${attachmentError?.message || attachmentError}`,
          );
        }
      }
    }
  },

  globalPlayerActions: async ({ page }, use, testInfo) => {
    await use(new GlobalPlayerActions(new GlobalPlayer(page, testInfo)));
  },

  librarySettingsActions: async ({ page }, use, testInfo) => {
    await use(new LibrarySettingsActions(new LibrarySettings(page, testInfo)));
  },

  navigationPanelActions: async ({ page }, use, testInfo) => {
    await use(new NavigationPanelActions(new NavigationPanel(page, testInfo)));
  },

  scanPageActions: async ({ page }, use, testInfo) => {
    await use(new ScanPageActions(new ScanPage(page, testInfo)));
  },

  searchToolbarActions: async ({ page }, use, testInfo) => {
    await use(new SearchToolbarActions(new SearchToolbar(page, testInfo)));
  },

  tagEditorActions: async ({ page }, use, testInfo) => {
    await use(new TagEditorActions(new TagEditor(page, testInfo)));
  },

  settingsModalAppBarActions: async ({ page }, use, testInfo) => {
    await use(new SettingsModalAppBarActions(new SettingsModalAppBar(page, testInfo)));
  },

  utilityTabBarActions: async ({ page }, use, testInfo) => {
    await use(new UtilityTabBarActions(new UtilityTabBar(page, testInfo)));
  },

  utilityProblematicFilesActions: async ({ page }, use, testInfo) => {
    await use(new UtilityProblematicFilesActions(new UtilityProblematicFilesTab(page, testInfo)));
  },

  utilityRulesActions: async ({ page }, use, testInfo) => {
    await use(new UtilityRulesActions(new UtilityRulesTab(page, testInfo)));
  },

  utilityLoopsActions: async ({ page }, use, testInfo) => {
    await use(new UtilityLoopsActions(new UtilityLoopsTab(page, testInfo)));
  },

  utilityLogHistoryActions: async ({ page }, use, testInfo) => {
    await use(new UtilityLogHistoryActions(new UtilityLogHistoryTab(page, testInfo)));
  },

  utilityIntegrationsActions: async ({ page }, use, testInfo) => {
    const actions = new UtilityIntegrationsActions(new UtilityIntegrationsTab(page, testInfo));
    try {
      await use(actions);
    } finally {
      actions.stopLastfmTimeZoneSaveObservation();
    }
  },

  utilityAppearanceActions: async ({ page }, use, testInfo) => {
    await use(new UtilityAppearanceActions(new UtilityAppearanceTab(page, testInfo)));
  },

  artistFamilyActions: async ({ page }, use, testInfo) => {
    await use(new ArtistFamilyActions(new ArtistFamily(page, testInfo)));
  },

  artistPageSettingsActions: async ({ page }, use, testInfo) => {
    await use(new ArtistPageSettingsActions(new ArtistPageSettings(page, testInfo)));
  },

  trackModalActions: async ({ page }, use, testInfo) => {
    await use(new TrackModalActions(new TrackModal(page, testInfo)));
  },

  testArtifacts: async ({ page }, use, testInfo) => {
    const collector = createAttachmentCollector(testInfo);
    const runtimeLogs = [];
    const configuredBaseUrl = String(testInfo.project.use?.baseURL || '');
    const configuredOrigin = configuredBaseUrl ? new URL(configuredBaseUrl).origin : '';

    const pushRuntimeLog = (entry) => {
      runtimeLogs.push({
        ...entry,
        timestamp: new Date().toISOString(),
      });
      if (runtimeLogs.length > 200) {
        runtimeLogs.shift();
      }
    };

    const onConsole = (message) => {
      pushRuntimeLog({
        kind: 'console',
        type: message.type(),
        text: message.text(),
        location: message.location(),
      });
    };
    const onPageError = (error) => {
      pushRuntimeLog({
        kind: 'pageerror',
        type: 'error',
        text: error?.stack || error?.message || String(error),
      });
    };
    const onRequestFailed = (request) => {
      const headers = request.headers();
      pushRuntimeLog({
        kind: 'requestfailed',
        type: request.failure()?.errorText || 'requestfailed',
        method: request.method(),
        url: request.url(),
        coverRequestId: String(headers['x-album-haven-cover-request-id'] || ''),
        text: `${request.method()} ${request.url()}`,
      });
    };
    const onResponse = (response) => {
      if (response.status() < 400) return;
      const responseUrl = new URL(response.url());
      const pageUrl = page.url();
      const currentOrigin = pageUrl.startsWith('http') ? new URL(pageUrl).origin : configuredOrigin;
      if (!currentOrigin || responseUrl.origin !== currentOrigin) return;
      pushRuntimeLog({
        kind: 'httpresponse',
        type: String(response.status()),
        text: `${response.request().method()} ${response.status()} ${response.url()}`,
      });
    };

    page.on('console', onConsole);
    page.on('pageerror', onPageError);
    page.on('requestfailed', onRequestFailed);
    page.on('response', onResponse);

    collector.getRuntimeLogs = () => [...runtimeLogs];

    await use(collector);

    page.off('console', onConsole);
    page.off('pageerror', onPageError);
    page.off('requestfailed', onRequestFailed);
    page.off('response', onResponse);

    if (didTestFail(testInfo)) {
      const stepLoggerState = collector.getStepLoggerState();
      if (stepLoggerState?.transcript?.length) {
        collector.queueTextAttachment('step-transcript.txt', stepLoggerState.transcript.join('\n'));
      }
      if (stepLoggerState?.events?.length) {
        collector.queueJsonAttachment('step-events', stepLoggerState.events);
      }
      collector.queueTextAttachment('stacktrace.txt', formatStacktrace(testInfo.errors));
      collector.queueTextAttachment('runtime-log.txt', formatRuntimeLogs(runtimeLogs));

      try {
        const screenshot = await page.screenshot({ fullPage: true });
        collector.queueAttachment({
          name: 'failure-screenshot.png',
          body: screenshot,
          contentType: 'image/png',
        });
      } catch (error) {
        collector.queueTextAttachment('screenshot-error.txt', `Failed to capture screenshot: ${error?.message || error}`);
      }
    }

    await collector.flush();
  },

  stepLogger: async ({ testArtifacts }, use, testInfo) => {
    const logger = createStepLogger(testInfo);
    await use(logger);
    testArtifacts.setStepLoggerState(logger);
  },
});

export { expect };
