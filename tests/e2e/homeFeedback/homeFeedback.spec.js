import { test } from '../fixtures/homeFeedbackTest.js';

test.describe('Home Friends and Playlists feedback', { tag: ['@home-feedback', '@area:home-friends-playlists'] }, () => {
  test('FTC-HFP-FB-001 keeps explicit Queue on own signed-in Home', async ({ home }) => {
    await home.ownQueueOnly();
  });
  test('FTC-HFP-FB-002 preserves explicit occurrence order and native queue timing', async ({ home }) => {
    await home.explicitOccurrenceOrder();
  });
  test('FTC-HFP-FB-003 guards queue activation reorder and confirmed Clear', async ({ home }) => {
    await home.queueMutationGuards();
  });
  test('FTC-HFP-FB-004 retains native Album and Artist inspection across Queue changes', async ({ home }) => {
    await home.nativeInspectionRetention();
  });
  test('FTC-HFP-FB-005 preserves canonical selection and subject-owned taste', async ({ home }) => {
    await home.consensusAndSubjectTaste();
  });
  test('FTC-HFP-FB-006 hides playback for readable missing occurrences', async ({ home }) => {
    await home.unavailableRows();
  });
  test('FTC-HFP-FB-007 admits existing Playlist Inspect only for confirmed missing sources', async ({ home }) => {
    await home.inspectMissingEntry();
  });
  test('FTC-HFP-FB-008 preserves compact native responsive Playlist and Inspect composition', async ({ home }) => {
    await home.responsiveNativeTables();
  });
  test('FTC-HFP-FB-009 preserves native Period Choice anchoring keyboard and focus', async ({ home }) => {
    await home.anchoredPeriodChoice();
  });
  test('FTC-HFP-FB-010 creates selected Playlists only after explicit commit and current authority', async ({ home }) => {
    await home.selectedPlaylistCreation();
  });
  test('FTC-HFP-FB-013 pins only fresh authorized friend playback without listen credit', async ({ home }) => {
    await home.liveFriendPresence();
  });
});
