import { expect } from '@playwright/test';
import { AppBar } from '../poms/appBar.js';
import { ScanPage } from '../poms/scanPage.js';
import { AppBarActions } from '../actions/appBarActions.js';
import { ScanPageActions } from '../actions/scanPageActions.js';

export async function acknowledgeSavedNotification(tagEditor, expectedMessage, { timeout }) {
  await expect(tagEditor.repairAlertMessage).toHaveText(expectedMessage, { timeout });
  await expect(tagEditor.repairAlert).toBeVisible({ timeout });
  expect(await tagEditor.readRepairAlertOverlap()).toEqual({ withinViewport: true, overlaps: [] });
  await tagEditor.repairAlertDismiss.click();
  await expect(tagEditor.repairAlert).toBeHidden({ timeout });
}

export async function deliverSavedNotificationThroughStatus(tagEditor, expectedMessage, { timeout, beforeNavigation }) {
  const appBar = new AppBarActions(new AppBar(tagEditor.page));
  const scan = new ScanPageActions(new ScanPage(tagEditor.page));
  await expect(tagEditor.overlay).toBeHidden({ timeout });
  await expect(tagEditor.confirmOverlay).toBeHidden({ timeout });
  const previous = await tagEditor.readLibraryReturnState();
  await beforeNavigation?.();
  await appBar.openStatusMenu();
  let deliveryError;
  try {
    await scan.openStatusPageFromMenu();
    await acknowledgeSavedNotification(tagEditor, expectedMessage, { timeout });
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
