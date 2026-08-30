import { measureActionTime } from './performanceHelpers.js';

export async function waitForUtilitiesBenchmarkWarmRoot(galleryActions, navigationPanelActions) {
  const timeout = 120000;
  await navigationPanelActions.waitForSidebarFullyHydrated({ timeout });
  await galleryActions.waitForInitialAllArtistsSections({ timeout });
  await galleryActions.waitForInitialRefreshCompleted({ timeout });
  await galleryActions.waitForVisibleGalleryCoversLoaded({
    minimumCount: 2,
    timeout,
  });
}

export async function measureProblematicFilesOpen(
  settingsModalAppBarActions,
  utilityTabBarActions,
  utilityProblematicFilesActions,
  options = {},
) {
  const timeout = Number(options.timeout || 120000);
  return measureActionTime(
    async () => {
      await settingsModalAppBarActions.openSettings();
      await utilityTabBarActions.openTab('problematic-files');
    },
    async () => {
      await utilityProblematicFilesActions.waitForReady({
        timeout,
        requirePopulated: true,
      });
    },
  );
}

export async function measureProblematicFilesSettingsOpen(
  settingsModalAppBarActions,
  utilityProblematicFilesActions,
  options = {},
) {
  const timeout = Number(options.timeout || 120000);
  await settingsModalAppBarActions.prepareToOpenSettings();
  return measureActionTime(
    async () => {
      await settingsModalAppBarActions.openSettings();
    },
    async () => {
      await utilityProblematicFilesActions.waitForReady({
        timeout,
        requirePopulated: true,
      });
    },
  );
}

export async function readGalleryCoverPreemptionSnapshot(page) {
  // parity-check: allow-read-only-measurement-evaluate -- intentional cover-preemption diagnostics only
  return page.evaluate(() => {
    const diagnostics = globalThis.__ALBUM_HAVEN_GALLERY_COVER_CACHE__ || {};
    return {
      sequence: Number(diagnostics.preemptionSequence || 0),
      preemptions: Array.isArray(diagnostics.preemptions)
        ? diagnostics.preemptions.map((entry) => ({
          requestId: String(entry?.requestId || ''),
          normalizedUrl: String(entry?.normalizedUrl || ''),
          reason: String(entry?.reason || ''),
          sequence: Number(entry?.sequence || 0),
        }))
        : [],
    };
  });
}

export async function readStartupViewPreemptionSnapshot(page) {
  // parity-check: allow-read-only-measurement-evaluate -- authenticate startup-view deferral around Utilities
  return page.evaluate(() => {
    const ui = typeof state !== 'undefined' ? state.ui : null;
    return {
      sequence: Number(ui?.utilityViewPreemptionSequence || 0),
      preemptions: Array.isArray(ui?.utilityViewPreemptions)
        ? ui.utilityViewPreemptions.map((entry) => ({
          normalizedUrl: String(entry?.normalizedUrl || ''),
          reason: String(entry?.reason || ''),
          sequence: Number(entry?.sequence || 0),
        }))
        : [],
    };
  });
}

export async function measureProblematicFilesSettingsOpenWithNetworkEvidence(
  page,
  settingsModalAppBarActions,
  utilityProblematicFilesActions,
  options = {},
) {
  const summaryPathname = String(options.summaryPathname || '/utilities/problematic-files');
  const detailPathname = String(options.detailPathname || '/utilities/problematic-files/detail');
  const detailRequests = [];
  const recordDetailRequest = (request) => {
    if (new URL(request.url()).pathname === detailPathname) {
      detailRequests.push(request);
    }
  };
  page.on('request', recordDetailRequest);
  try {
    const timeout = Number(options.timeout || 120000);
    const preemptionBefore = await readGalleryCoverPreemptionSnapshot(page);
    const viewPreemptionBefore = await readStartupViewPreemptionSnapshot(page);
    const summaryResponsePromise = page.waitForResponse((response) => (
      new URL(response.url()).pathname === summaryPathname
    ), { timeout });
    const readyPromise = options.utilityTabBarActions
      ? measureProblematicFilesOpen(
        settingsModalAppBarActions,
        options.utilityTabBarActions,
        utilityProblematicFilesActions,
        { ...options, timeout },
      )
      : measureProblematicFilesSettingsOpen(
        settingsModalAppBarActions,
        utilityProblematicFilesActions,
        { ...options, timeout },
      );
    const [readyResult, summaryResponseResult] = await Promise.allSettled(
      [readyPromise, summaryResponsePromise],
    );
    if (readyResult.status === 'rejected') {
      throw readyResult.reason;
    }
    if (summaryResponseResult.status === 'rejected') {
      throw summaryResponseResult.reason;
    }
    const preemptionAfter = await readGalleryCoverPreemptionSnapshot(page);
    const viewPreemptionAfter = await readStartupViewPreemptionSnapshot(page);
    return {
      readyMs: readyResult.value,
      summaryResponse: summaryResponseResult.value,
      detailRequestCount: detailRequests.length,
      coverPreemptionWindow: {
        sequenceBefore: preemptionBefore.sequence,
        sequenceAfter: preemptionAfter.sequence,
        preemptions: preemptionAfter.preemptions,
      },
      viewPreemptionWindow: {
        sequenceBefore: viewPreemptionBefore.sequence,
        sequenceAfter: viewPreemptionAfter.sequence,
        preemptions: viewPreemptionAfter.preemptions,
      },
    };
  } finally {
    page.off('request', recordDetailRequest);
  }
}

function normalizeFailedCoverUrl(value) {
  const rawUrl = String(value || '');
  if (!URL.canParse(rawUrl)) return '';
  const url = new URL(rawUrl);
  return url.pathname === '/cover' ? `${url.origin}${url.pathname}` : '';
}

const AUTHENTICATED_COVER_PREEMPTION_REASONS = new Set([
  'utility-modal-preemption',
  'foreground-promotion',
  'render-generation-preemption',
]);

export function partitionAuthenticatedCoverPreemptionRuntimeLogs(
  runtimeLogs,
  coverPreemptionWindow,
) {
  const sequenceBefore = Number(coverPreemptionWindow?.sequenceBefore || 0);
  const sequenceAfter = Number(coverPreemptionWindow?.sequenceAfter || 0);
  const candidatesByKey = new Map();
  for (const entry of coverPreemptionWindow?.preemptions || []) {
    const requestId = String(entry?.requestId || '');
    const normalizedUrl = String(entry?.normalizedUrl || '');
    const sequence = Number(entry?.sequence || 0);
    if (
      !requestId
      || !normalizedUrl
      || !AUTHENTICATED_COVER_PREEMPTION_REASONS.has(entry?.reason)
      || sequence <= sequenceBefore
      || sequence > sequenceAfter
    ) continue;
    const key = `${requestId}\n${normalizedUrl}`;
    const candidates = candidatesByKey.get(key) || [];
    candidates.push(entry);
    candidatesByKey.set(key, candidates);
  }

  const usedKeys = new Set();
  const acceptedIntentionalCoverAborts = [];
  const unexpectedRuntimeErrors = [];
  for (const entry of runtimeLogs || []) {
    const isRuntimeError = entry?.kind === 'pageerror'
      || entry?.kind === 'requestfailed'
      || entry?.kind === 'httpresponse'
      || (entry?.kind === 'console' && ['error', 'assert'].includes(entry?.type));
    if (!isRuntimeError) continue;
    const requestId = String(entry?.coverRequestId || '');
    const normalizedUrl = normalizeFailedCoverUrl(entry?.url);
    const key = `${requestId}\n${normalizedUrl}`;
    const candidates = candidatesByKey.get(key) || [];
    const isAuthenticatedIntentionalAbort = entry.kind === 'requestfailed'
      && entry.type === 'net::ERR_ABORTED'
      && entry.method === 'GET'
      && requestId
      && normalizedUrl
      && candidates.length === 1
      && !usedKeys.has(key);
    if (isAuthenticatedIntentionalAbort) {
      usedKeys.add(key);
      acceptedIntentionalCoverAborts.push(entry);
    } else {
      unexpectedRuntimeErrors.push(entry);
    }
  }
  return { acceptedIntentionalCoverAborts, unexpectedRuntimeErrors };
}

function normalizeFailedViewUrl(value) {
  const rawUrl = String(value || '');
  if (!URL.canParse(rawUrl, 'http://album-haven.local')) return '';
  const url = new URL(rawUrl, 'http://album-haven.local');
  return url.pathname === '/view-data' ? `${url.pathname}${url.search}` : '';
}

export function partitionProblematicFilesRuntimeLogs(
  runtimeLogs,
  coverPreemptionWindow,
  viewPreemptionWindow = null,
) {
  const coverPartition = partitionAuthenticatedCoverPreemptionRuntimeLogs(
    runtimeLogs,
    coverPreemptionWindow,
  );
  const sequenceBefore = Number(viewPreemptionWindow?.sequenceBefore || 0);
  const sequenceAfter = Number(viewPreemptionWindow?.sequenceAfter || 0);
  const diagnostics = Array.isArray(viewPreemptionWindow?.preemptions)
    ? viewPreemptionWindow.preemptions.filter((entry) => (
      Number(entry?.sequence || 0) > sequenceBefore
      && Number(entry?.sequence || 0) <= sequenceAfter
      && entry?.reason === 'utility-modal-preemption'
      && normalizeFailedViewUrl(entry?.normalizedUrl)
    ))
    : [];
  const usedDiagnosticSequences = new Set();
  const acceptedIntentionalViewAborts = [];
  const unexpectedRuntimeErrors = [];
  for (const entry of coverPartition.unexpectedRuntimeErrors) {
    const failedUrl = normalizeFailedViewUrl(entry?.url);
    const matches = diagnostics.filter((diagnostic) => (
      !usedDiagnosticSequences.has(Number(diagnostic.sequence))
      && failedUrl === normalizeFailedViewUrl(diagnostic.normalizedUrl)
    ));
    const authenticated = matches.length === 1
      && entry?.kind === 'requestfailed'
      && entry?.type === 'net::ERR_ABORTED'
      && entry?.method === 'GET';
    if (authenticated) {
      usedDiagnosticSequences.add(Number(matches[0].sequence));
      acceptedIntentionalViewAborts.push(entry);
    } else {
      unexpectedRuntimeErrors.push(entry);
    }
  }
  return {
    acceptedIntentionalCoverAborts: coverPartition.acceptedIntentionalCoverAborts,
    acceptedIntentionalViewAborts,
    unexpectedRuntimeErrors,
  };
}

export async function measureRulesOpen(
  settingsModalAppBarActions,
  utilityTabBarActions,
  utilityRulesActions,
  options = {},
) {
  const timeout = Number(options.timeout || 120000);
  await settingsModalAppBarActions.prepareToOpenSettings();
  return measureActionTime(
    async () => {
      await settingsModalAppBarActions.openSettings();
      await utilityTabBarActions.openTab('rules');
    },
    async () => {
      await utilityRulesActions.waitForReady({ timeout });
    },
  );
}

export async function measureUtilityTabSwitch(tabKey, utilityTabBarActions, readyAction, options = {}) {
  const timeout = Number(options.timeout || 120000);
  return measureActionTime(
    async () => {
      await utilityTabBarActions.openTab(tabKey);
    },
    async () => {
      await readyAction({ timeout });
    },
  );
}

function formatProblematicTimingSegments(diagnostics) {
  if (!diagnostics || typeof diagnostics !== 'object') {
    return 'missing';
  }
  const segments = [
    `request=${Number(diagnostics.requestMs || 0)}ms`,
    `parse=${Number(diagnostics.parseMs || 0)}ms`,
    `state=${Number(diagnostics.stateCommitMs || 0)}ms`,
    `render=${Number(diagnostics.renderMs || 0)}ms`,
    `total=${Number(diagnostics.totalMs || 0)}ms`,
  ];
  if (diagnostics.itemCount !== undefined) {
    segments.push(`items=${Number(diagnostics.itemCount || 0)}`);
  }
  if (diagnostics.albumKey) {
    segments.push(`album=${String(diagnostics.albumKey)}`);
  }
  if (diagnostics.detailLoaded !== undefined) {
    segments.push(`detailLoaded=${diagnostics.detailLoaded ? 'true' : 'false'}`);
  }
  return segments.join(' | ');
}

export function summarizeProblematicFilesDiagnostics(diagnostics) {
  const summary = diagnostics?.summaryLoad || null;
  const detail = diagnostics?.lastDetailLoad || null;
  return [
    `summary: ${formatProblematicTimingSegments(summary)}`,
    `detail: ${formatProblematicTimingSegments(detail)}`,
  ].join(' || ');
}

export function summarizePeakBytes(memorySummaries) {
  return (memorySummaries || []).reduce((maxValue, summary) => (
    Math.max(maxValue, Number(summary?.peakBytes || 0))
  ), 0);
}
