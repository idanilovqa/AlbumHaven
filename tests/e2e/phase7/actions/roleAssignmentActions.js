import { InvitationPage } from '../poms/authPages.js';
import { RoleAssignmentPage } from '../poms/roleAssignmentPage.js';
import { invitationPathFrom, signIn } from './authActions.js';

/** Uses the actual administrator form, invitation and member login. */
export async function createRoleMember(administratorPage, freshBrowserSession, identity, roles) {
  const members = new RoleAssignmentPage(administratorPage);
  await members.open();
  await members.openAddUser();
  await members.fillCreateUser({ ...identity, sendInvitation: false });
  await members.setRolesOnly(roles);
  await members.submitCreateUser();
  await administratorPage.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const invitation = await members.copyInviteLink(identity.username);
  const recipient = await freshBrowserSession.create();
  await recipient.page.goto(invitationPathFrom(invitation));
  await new InvitationPage(recipient.page).complete(identity.password);
  await signIn(recipient.page, identity, '/account');
  return recipient.page;
}
