import { test, expect } from '../support/baseFixtures.js';
import { enrollCapabilityProfile } from '../actions/capabilityProfileEnrollment.js';
import { assertCapabilityBoundary } from '../actions/capabilityBoundaryActions.js';
import { ROLE_PROFILES, CAPABILITY_PROFILES, UNION_PROFILES, CLIENT_PROFILES } from '../actions/capabilityProfiles.js';
import { prepareOwnedBoundaryLoop, assertOwnedLoopBoundary } from '../actions/capabilityLoopBoundaryActions.js';
import { openCapabilityFixtureAlbum } from '../actions/capabilityEditorActions.js';

for (const [id, profiles] of [['016', ROLE_PROFILES], ['017', CAPABILITY_PROFILES], ['018', UNION_PROFILES], ['019', CLIENT_PROFILES]]) {
  for (const profile of profiles) {
    test.describe(profile.name, () => {
      if (profile.userAgent) test.use({ userAgent: profile.userAgent });
      test(`FTC-CAP-AUDIT-${id} ${profile.name} shows allowed UI and hides forbidden controls`, async ({
        page, freshBrowserSession, galleryActions, trackModalActions, globalPlayerActions, playbackEvidence,
        utilityLoopsActions, settingsModalAppBarActions, utilityTabBarActions, utilityAppearanceActions,
      }, testInfo) => {
        const { editor, identity } = await enrollCapabilityProfile(page, freshBrowserSession, profile);
        if (profile.visible.includes('practice') || profile.providerOnly) {
          await prepareOwnedBoundaryLoop({ page, freshBrowserSession, identity, testInfo }, editor, profile);
        }
        if (profile.visible.includes('play') || profile.visible.includes('practice')) {
          await settingsModalAppBarActions.openSettings();
          await utilityTabBarActions.openTab('appearance');
          await utilityAppearanceActions.waitForReady();
          await utilityAppearanceActions.saveSeekbarMode('waveform');
          await settingsModalAppBarActions.closeSettings();
        }
        await assertCapabilityBoundary(page, profile, testInfo);
        if (profile.visible.includes('play')) {
          await page.goto('/');
          await openCapabilityFixtureAlbum(galleryActions);
          const mark = await playbackEvidence.playbackMark();
          const track = await trackModalActions.playTrackAt(0);
          await globalPlayerActions.waitForCurrentTrack({ path: track.path, trackTitle: track.title });
          const evidence = await playbackEvidence.waitForTrackPlaybackEvidence({ after: mark, path: track.path });
          expect(evidence.nonZeroSamples).toBeGreaterThan(0);
          expect(evidence.renderedFrameDelta).toBeGreaterThan(0);
          await expect(globalPlayerActions.globalPlayer.player).toBeVisible();
          await globalPlayerActions.pauseIfPlaying();
          await trackModalActions.close();
          if (profile.visible.includes('create')) {
            await globalPlayerActions.openLoopEditor();
            await globalPlayerActions.cancelLoopEditorWithEscape();
          } else {
            await expect(globalPlayerActions.globalPlayer.expandedPlaybackControls.loopActions).toBeHidden();
          }
        }
        if (profile.visible.includes('practice')) await assertOwnedLoopBoundary(page, utilityLoopsActions, profile);
      });
    });
  }
}
