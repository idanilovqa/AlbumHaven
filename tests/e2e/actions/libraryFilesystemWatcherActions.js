import { expect } from '@playwright/test';

import { authenticatedPageGet } from '../helpers/authenticatedPageRequest.js';
import { watcherRecoveryTextContainsPrivateIdentity } from '../helpers/libraryFilesystemWatcherFixture.js';
import {
  readWatcherRecoverySnapshot,
  waitForWatcherRecoverySnapshot,
} from '../helpers/postgresWatcherRecoveryHelpers.js';

export class LibraryFilesystemWatcherActions {
  constructor(libraryWatchStatus, options = {}) {
    this.libraryWatchStatus = libraryWatchStatus;
    this.appBarActions = options.appBarActions;
    this.scanPage = options.scanPage;
    this.scanPageActions = options.scanPageActions;
    this.getWatcherRecovery = options.getWatcherRecovery;
    this.recovery = null;
    this.baselineSnapshot = null;
    this.firstIncident = null;
  }

  async readStatus() {
    const response = await authenticatedPageGet(this.libraryWatchStatus.page, '/status');
    expect(response.ok()).toBe(true);
    return response.json();
  }

  async waitForRevisionAfter(previousRevision, options = {}) {
    let observed = null;
    await expect.poll(async () => {
      observed = await this.readStatus();
      return Number(observed.inventory_mutation_revision || 0);
    }, {
      timeout: options.timeout || 60000,
      intervals: [100, 250, 500, 1000],
      message: `Expected inventory revision to advance beyond ${previousRevision}`,
    }).toBeGreaterThan(Number(previousRevision || 0));
    return observed;
  }

  async _getRecovery() {
    if (!this.recovery) {
      if (typeof this.getWatcherRecovery !== 'function') {
        throw new Error('Watcher recovery actions require the recovery fixture.');
      }
      this.recovery = await this.getWatcherRecovery();
    }
    return this.recovery;
  }

  _diagnosticOptions(recovery, options = {}) {
    return {
      ...options,
      roots: {
        failureRootId: recovery.manifest.failureRootId,
        healthyRootId: recovery.manifest.healthyRootId,
      },
    };
  }

  _root(snapshot, rootId) {
    const root = snapshot?.roots?.[rootId];
    if (!root) throw new Error(`Watcher recovery diagnostics omitted root ${rootId}.`);
    return root;
  }

  async _readRecoverySnapshot() {
    const recovery = await this._getRecovery();
    return readWatcherRecoverySnapshot(this._diagnosticOptions(recovery).roots);
  }

  async _waitForRecoverySnapshot(predicate, options = {}) {
    const recovery = await this._getRecovery();
    return waitForWatcherRecoverySnapshot(
      predicate,
      this._diagnosticOptions(recovery, options),
    );
  }

  async _openProductionGallery() {
    await this.libraryWatchStatus.page.goto('/?surface=albums');
    await expect(this.scanPage.appShell).toBeVisible();
  }

  async _openStatusPage() {
    await this.appBarActions.openStatusMenu();
    await this.scanPageActions.openStatusPageFromMenu();
  }

  async failOwnedRootAndAdvanceHealthyRoot() {
    const recovery = await this._getRecovery();
    await this._openProductionGallery();
    this.baselineSnapshot = await this._readRecoverySnapshot();
    const baselineHealthy = this._root(
      this.baselineSnapshot,
      recovery.manifest.healthyRootId,
    );

    await recovery.makeFailureRootUnavailable();
    recovery.removeOneUnavailableFile();
    recovery.createHealthyFile('healthy-during-root-outage');

    await this._waitForRecoverySnapshot((snapshot) => {
      const healthy = this._root(snapshot, recovery.manifest.healthyRootId);
      const incident = snapshot.incidents.find((candidate) => (
        candidate.rootId === recovery.manifest.failureRootId
        && candidate.reasonCode === 'root_unavailable'
        && candidate.resolved === false
      ));
      return Boolean(incident)
        && Number(snapshot.inventoryRevision) > Number(this.baselineSnapshot.inventoryRevision)
        && Number(healthy.acceptedSequence) > Number(baselineHealthy.acceptedSequence)
        && Number(healthy.appliedSequence) > Number(baselineHealthy.appliedSequence);
    }, {
      timeout: 120000,
      message: 'Expected the unavailable-root incident and independent healthy-root progress.',
      timeoutDiagnostic: (snapshot) => {
        const healthy = this._root(snapshot, recovery.manifest.healthyRootId);
        return {
          incidentMatched: snapshot.incidents.some((candidate) => (
            candidate.rootId === recovery.manifest.failureRootId
            && candidate.reasonCode === 'root_unavailable'
            && candidate.resolved === false
          )),
          inventoryRevision: {
            baseline: Number(this.baselineSnapshot.inventoryRevision),
            current: Number(snapshot.inventoryRevision),
          },
          healthyAcceptedSequence: {
            baseline: Number(baselineHealthy.acceptedSequence),
            current: Number(healthy.acceptedSequence),
          },
          healthyAppliedSequence: {
            baseline: Number(baselineHealthy.appliedSequence),
            current: Number(healthy.appliedSequence),
          },
        };
      },
    });
    await this._openProductionGallery();
    await expect(this.scanPage.healthWarningToast).toBeVisible();
  }

  async waitForStableIncident() {
    const recovery = await this._getRecovery();
    const snapshot = await this._waitForRecoverySnapshot((candidate) => (
      candidate.incidents.some((incident) => (
        incident.rootId === recovery.manifest.failureRootId
        && incident.reasonCode === 'root_unavailable'
        && incident.resolved === false
      ))
    ), {
      message: 'Expected a stable unresolved unavailable-root incident.',
    });
    const incident = snapshot.incidents.find((candidate) => (
      candidate.rootId === recovery.manifest.failureRootId
      && candidate.reasonCode === 'root_unavailable'
      && candidate.resolved === false
    ));
    this.firstIncident = incident;
    return incident;
  }

  async expectInventoryPreservedAndPathFreeWarning() {
    const recovery = await this._getRecovery();
    const snapshot = await this._readRecoverySnapshot();
    const baselineFailure = this._root(
      this.baselineSnapshot,
      recovery.manifest.failureRootId,
    );
    const currentFailure = this._root(snapshot, recovery.manifest.failureRootId);
    expect(currentFailure.inventoryFileCount).toBe(baselineFailure.inventoryFileCount);

    const warning = this.scanPage.healthWarningToast;
    await expect(warning).toBeVisible();
    const warningText = String(await warning.textContent() || '');
    const containsPrivateIdentity = watcherRecoveryTextContainsPrivateIdentity(
      warningText,
      recovery.manifest,
    );
    expect(containsPrivateIdentity, 'Watcher warning must not expose an owned root identity.')
      .toBe(false);
  }

  async expectDestructiveChangeBlocked() {
    const recovery = await this._getRecovery();
    const snapshot = await this._readRecoverySnapshot();
    expect(this._root(snapshot, recovery.manifest.failureRootId).inventoryFileCount)
      .toBe(this._root(
        this.baselineSnapshot,
        recovery.manifest.failureRootId,
      ).inventoryFileCount);
  }

  async expectHealthyRootRevisionAdvance() {
    const recovery = await this._getRecovery();
    const current = await this._readRecoverySnapshot();
    const baseline = this._root(this.baselineSnapshot, recovery.manifest.healthyRootId);
    const healthy = this._root(current, recovery.manifest.healthyRootId);
    expect(Number(current.inventoryRevision)).toBeGreaterThan(
      Number(this.baselineSnapshot.inventoryRevision),
    );
    expect(Number(healthy.acceptedSequence)).toBeGreaterThan(Number(baseline.acceptedSequence));
    expect(Number(healthy.appliedSequence)).toBeGreaterThan(Number(baseline.appliedSequence));
  }

  async waitForScanActive() {
    await expect.poll(async () => Boolean((await this.readStatus()).scan_in_progress), {
      timeout: 60000,
      intervals: [100, 250, 500, 1000],
      message: 'Expected the watcher repair scan to become active.',
    }).toBe(true);
  }

  async createDuringRepair() {
    const recovery = await this._getRecovery();
    const before = await this._readRecoverySnapshot();
    const beforeHealthy = this._root(before, recovery.manifest.healthyRootId);
    const inventoryPath = recovery.createHealthyFile('healthy-during-repair');
    const accepted = await this._waitForRecoverySnapshot((snapshot) => (
      Number(this._root(snapshot, recovery.manifest.healthyRootId).acceptedSequence)
        > Number(beforeHealthy.acceptedSequence)
    ), {
      message: 'Expected an event to be durably accepted during watcher repair.',
    });
    return {
      healthyRootId: recovery.manifest.healthyRootId,
      acceptedSequence: Number(
        this._root(accepted, recovery.manifest.healthyRootId).acceptedSequence,
      ),
      inventoryEntry: { fileName: inventoryPath.split(/[\\/]/).at(-1) },
    };
  }

  async repeatBeforeResolution(firstIncident) {
    const recovery = await this._getRecovery();
    const before = await this._readRecoverySnapshot();
    const existing = before.incidents.find(
      (incident) => incident.incidentId === firstIncident.incidentId,
    );
    if (!existing || existing.resolved) {
      throw new Error('Watcher recovery incident resolved before repeat evidence was captured.');
    }
    await recovery.restoreFailureRoot();
    await this._waitForRecoverySnapshot((snapshot) => {
      const repeated = snapshot.incidents.find(
        (incident) => incident.incidentId === firstIncident.incidentId,
      );
      return repeated?.warningToken === firstIncident.warningToken
        && repeated.resolved === false
&& Number(repeated.occurrenceCount) > Number(firstIncident.occurrenceCount);
    }, {
      message: 'Expected the unresolved watcher incident identity to remain stable on repetition.',
    });
    await this._openStatusPage();
  }

  async waitForRepairWatermark(duringRepairFence) {
    const recovery = await this._getRecovery();
    if (!this.firstIncident) throw new Error('Watcher repair watermark requires the first incident.');
    if (
      duringRepairFence?.healthyRootId !== recovery.manifest.healthyRootId
      || !Number.isSafeInteger(duringRepairFence.acceptedSequence)
      || duringRepairFence.acceptedSequence < 1
      || !duringRepairFence.inventoryEntry?.fileName
    ) {
      throw new Error('Watcher repair watermark requires its retained healthy-root event fence.');
    }
    const completed = await this._waitForRecoverySnapshot((snapshot) => {
      const repair = [...snapshot.repairs].reverse().find((candidate) => (
        candidate.roots.some((root) => root.incidentId === this.firstIncident.incidentId)
      ));
      if (!repair || repair.state !== 'complete' || !repair.completed) return false;
      const incident = snapshot.incidents.find(
        (candidate) => candidate.incidentId === this.firstIncident.incidentId,
      );
      if (!incident?.resolved) return false;
      const healthy = this._root(snapshot, duringRepairFence.healthyRootId);
      if (
        Number(healthy.appliedSequence) < duringRepairFence.acceptedSequence
        || !healthy.inventoryEntries.some((entry) => (
          entry.fileName === duringRepairFence.inventoryEntry.fileName
          && Number.isSafeInteger(Number(entry.albumId))
          && Number(entry.albumId) > 0
        ))
      ) return false;
      return repair.roots.every((rootFence) => {
        const lane = this._root(snapshot, rootFence.rootId);
        return Number(lane.appliedSequence) >= Number(rootFence.capturedAcceptedSequence)
          && Number(lane.repairedDirtyGeneration) >= Number(rootFence.capturedDirtyGeneration)
          && Number(lane.appliedSequence) === Number(lane.acceptedSequence)
          && Number(lane.repairedDirtyGeneration) === Number(lane.dirtyGeneration);
      });
    }, {
      timeout: 180000,
      message: 'Expected watcher repair completion through its newest durable watermark.',
      timeoutDiagnostic: (snapshot) => {
        const repair = [...(snapshot?.repairs || [])].reverse().find((candidate) => (
          candidate.roots.some((root) => root.incidentId === this.firstIncident.incidentId)
        ));
        const incident = snapshot?.incidents?.find(
          (candidate) => candidate.incidentId === this.firstIncident.incidentId,
        );
        const healthy = snapshot?.roots?.[duringRepairFence.healthyRootId] || {};
        const finiteNumber = (value) => (
          typeof value === 'number' && Number.isFinite(value) ? value : null
        );
        const watermark = (rootId) => {
          const lane = snapshot?.roots?.[rootId] || {};
          const rootFence = repair?.roots?.find((candidate) => candidate.rootId === rootId) || {};
          const acceptedSequence = finiteNumber(lane.acceptedSequence);
          const appliedSequence = finiteNumber(lane.appliedSequence);
          const capturedAcceptedSequence = finiteNumber(rootFence.capturedAcceptedSequence);
          const dirtyGeneration = finiteNumber(lane.dirtyGeneration);
          const capturedDirtyGeneration = finiteNumber(rootFence.capturedDirtyGeneration);
          const repairedDirtyGeneration = finiteNumber(lane.repairedDirtyGeneration);
          return {
            acceptedSequence,
            appliedSequence,
            capturedAcceptedSequence,
            dirtyGeneration,
            capturedDirtyGeneration,
            repairedDirtyGeneration,
            caughtUp: appliedSequence !== null
              && capturedAcceptedSequence !== null
              && repairedDirtyGeneration !== null
              && capturedDirtyGeneration !== null
              && acceptedSequence !== null
              && dirtyGeneration !== null
              && appliedSequence >= capturedAcceptedSequence
              && repairedDirtyGeneration >= capturedDirtyGeneration
              && appliedSequence === acceptedSequence
              && repairedDirtyGeneration === dirtyGeneration,
          };
        };
        const healthyAppliedSequence = finiteNumber(healthy.appliedSequence);
        return {
          repairMatched: Boolean(repair),
          repairState: ['scanning', 'catch_up', 'complete', 'running'].includes(repair?.state)
            ? repair.state
            : 'unknown',
          repairCompleted: repair?.completed === true,
          terminalFailureReason: repair?.terminalFailureReason,
          incidentResolved: incident?.resolved === true,
          duringRepairAppliedThroughFence: healthyAppliedSequence !== null
            && healthyAppliedSequence >= duringRepairFence.acceptedSequence,
          inventoryEntryMatched: Array.isArray(healthy.inventoryEntries)
            && healthy.inventoryEntries.some((entry) => (
              entry.fileName === duringRepairFence.inventoryEntry.fileName
              && Number.isSafeInteger(Number(entry.albumId))
              && Number(entry.albumId) > 0
            )),
          aggregates: {
            scanInProgress: snapshot?.aggregates?.scanInProgress === true,
            watcherState: ['healthy', 'degraded', 'repair_required'].includes(
              snapshot?.aggregates?.watcherState,
            ) ? snapshot.aggregates.watcherState : 'unknown',
            repairRequired: snapshot?.aggregates?.repairRequired === true,
            failedJobCount: finiteNumber(snapshot?.aggregates?.failedJobCount),
            readyGenerationCount: finiteNumber(snapshot?.aggregates?.readyGenerationCount),
            dirtyLaneCount: finiteNumber(snapshot?.aggregates?.dirtyLaneCount),
          },
          watermarks: {
            failure: watermark(recovery.manifest.failureRootId),
            healthy: watermark(recovery.manifest.healthyRootId),
          },
        };
      },
    });
    await this._openProductionGallery();
    return completed;
  }

  async waitForScanIdleAndHealthy() {
    let observed = null;
    await expect.poll(async () => {
      observed = await this.readStatus();
      return !observed.scan_in_progress
        && observed.watcher_health?.state === 'healthy'
        && (observed.watcher_health?.problems || []).length === 0;
    }, {
      timeout: 120000,
      intervals: [100, 250, 500, 1000, 2000],
      message: 'Expected the repair scan to become idle with healthy watcher status.',
    }).toBe(true);
    return observed;
  }

  async failAfterResolution() {
    const recovery = await this._getRecovery();
    await recovery.makeFailureRootUnavailable();
    await this._waitForRecoverySnapshot((snapshot) => (
      snapshot.incidents.some((incident) => (
        incident.rootId === recovery.manifest.failureRootId
        && incident.resolved === false
        && incident.incidentId !== this.firstIncident.incidentId
      ))
    ), {
      message: 'Expected a later root failure to create a new incident.',
    });
    await this._openProductionGallery();
  }

  async expectNewIncidentIdentity(previousIncidentId, previousWarningToken) {
    const recovery = await this._getRecovery();
    const snapshot = await this._waitForRecoverySnapshot((candidate) => (
      candidate.incidents.some((incident) => (
        incident.rootId === recovery.manifest.failureRootId
        && incident.resolved === false
        && incident.incidentId !== previousIncidentId
        && incident.warningToken !== previousWarningToken
      ))
    ), {
      message: 'Expected a later watcher failure to issue a new incident identity and warning token.',
    });
    const later = snapshot.incidents.find((incident) => (
      incident.rootId === recovery.manifest.failureRootId
      && incident.resolved === false
    ));
    expect(later.incidentId).not.toBe(previousIncidentId);
    expect(later.warningToken).not.toBe(previousWarningToken);
  }
}
