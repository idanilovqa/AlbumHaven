import { expect } from '@playwright/test';
import { AppBar } from '../poms/appBar.js';
import { ScanPage } from '../poms/scanPage.js';
import { AppBarActions } from '../actions/appBarActions.js';
import { ScanPageActions } from '../actions/scanPageActions.js';

export async function acknowledgeSavedNotification(tagEditor, expectedMessage, { timeout }) {
  await expect(tagEditor.repairAlertMessage).toHaveText(expectedMessage, { timeout });
  await expect(tagEditor.repairAlert).toBeVisible({ timeout });
  expect(await tagEditor.readRepairAlertOverlap()).toEqual({ rendered: true, withinViewport: true, overlaps: [] });
  await tagEditor.repairAlertDismiss.click();
  await expect(tagEditor.repairAlert).toBeHidden({ timeout });
}

// A completed save shows a timed toast that can close at any moment, even mid-click, so it is
// confirmed without clicking: one of the presentations recorded while it was shown must carry its
// message and a clear on-screen placement, and it must then close on its own.
export async function confirmTimedSavedNotification(tagEditor, presentations, expectedMessage, { timeout }) {
  await expect.poll(() => presentations.jsonValue(), { timeout })
    .toContainEqual({ message: expectedMessage, rendered: true, withinViewport: true, overlaps: [] });
  await expect(tagEditor.repairAlert).toBeHidden({ timeout });
}

export async function deliverSavedNotificationThroughStatus(tagEditor, expectedMessage, { timeout, autoDismisses, beforeNavigation }) {
  const appBar = new AppBarActions(new AppBar(tagEditor.page));
  const scan = new ScanPageActions(new ScanPage(tagEditor.page));
  await expect(tagEditor.overlay).toBeHidden({ timeout });
  await expect(tagEditor.confirmOverlay).toBeHidden({ timeout });
  const previous = await tagEditor.readLibraryReturnState();
  await beforeNavigation?.();
  await appBar.openStatusMenu();
  let deliveryError;
  try {
    if (autoDismisses) {
      // Attach before navigation because Status can render and dismiss the toast before its ready wait returns.
      const presentations = await tagEditor.recordRepairAlertPresentations();
      try {
        await scan.scanPage.openStatusPage.click();
        // Navigation changes overlap geometry without mutating the alert, so sample both transition boundaries.
        await tagEditor.captureRepairAlertPresentation(presentations);
        await scan.waitForVisible({ timeout });
        await tagEditor.captureRepairAlertPresentation(presentations);
        await scan.waitForDedicatedPageVisible({ timeout });
        await confirmTimedSavedNotification(tagEditor, presentations, expectedMessage, { timeout });
      } finally {
        await tagEditor.stopRecordingRepairAlertPresentations(presentations);
      }
    } else {
      await scan.scanPage.openStatusPage.click();
      await scan.waitForVisible({ timeout });
      await scan.waitForDedicatedPageVisible({ timeout });
      await acknowledgeSavedNotification(tagEditor, expectedMessage, { timeout });
    }
  } catch (error) {
    deliveryError = error;
  }
  try {
    await scan.clickBack();
    await scan.waitForDedicatedPageHidden({ timeout });
    await expect.poll(() => tagEditor.readLibraryReturnState(), { timeout }).toEqual(previous);
  } catch (restoreError) {
    if (deliveryError) {
      throw new AggregateError([deliveryError, restoreError], 'Saved notification delivery and library restoration failed');
    }
    throw restoreError;
  }
  if (deliveryError) throw deliveryError;
}
