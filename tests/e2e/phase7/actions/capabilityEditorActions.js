import { randomUUID } from 'node:crypto';
import { CapabilityEditorPage } from '../poms/capabilityEditorPage.js';
import { InvitationPage } from '../poms/authPages.js';
import { invitationPathFrom, signIn } from './authActions.js';

// The test page remains the recipient so the normal playback evidence fixture
// observes that user's real player. Administration uses a separate session.
export async function enrollCapabilityMember(page, freshBrowserSession, labels, sessionOptions = {}) {
  const administrator = await freshBrowserSession.create(sessionOptions);
  await signIn(administrator.page, undefined, '/admin/members');
  const editor = new CapabilityEditorPage(administrator.page);
  const username = `cap-${randomUUID().slice(0, 12)}`;
  const identity = { username, email: `${username}@example.test`, password: 'Cobalt Orchard 47! Glass River' };
  await editor.openAddUser();
  await editor.fillCreateUser({ ...identity, sendInvitation: false });
  await editor.chooseIndividualCapabilities(labels);
  await editor.submitCreateUser();
  await administrator.page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const invitation = await editor.copyInviteLink(username);
  await page.goto(invitationPathFrom(invitation));
  await new InvitationPage(page).complete(identity.password);
  await signIn(page, identity);
  await editor.openEditUser(username);
  return editor;
}

export async function openCapabilityFixtureAlbum(galleryActions) {
  await galleryActions.waitForGalleryReady();
  await galleryActions.selectAlbumDetailsByIdentity({
    artist: 'Settings Navigation Fixture', album: 'Uninterrupted Session', year: '2026',
  });
}
