import { InvitationPage, MembersPage } from '../poms/authPages.js';
import { invitationPathFrom, OWNER, signIn } from './authActions.js';

/** Create, configure, invite and sign in a real managed account through the UI. */
export async function signInCapabilityMember(ownerPage, freshBrowserSession, name, labels) {
  const member = {
    username: `capability.${name}`,
    email: `capability.${name}@example.test`,
    password: 'Cobalt Orchard 47! Glass River',
  };
  await signIn(ownerPage, OWNER, '/admin/members');
  const members = new MembersPage(ownerPage);
  await members.openAddUser();
  await members.fillCreateUser({ ...member, sendInvitation: false });
  await members.submitCreateUser();
  await members.openEditUser(member.username);
  const count = await members.capabilitySwitches.count();
  for (let index = 0; index < count; index += 1) {
    await members.capabilitySwitches.nth(index).uncheck();
  }
  for (const label of labels) await members.capabilitySwitch(label).check();
  await members.submitAccountChanges();
  await ownerPage.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const invitation = await members.copyInviteLink(member.username);
  const recipient = await freshBrowserSession.create();
  await recipient.page.goto(invitationPathFrom(invitation));
  await new InvitationPage(recipient.page).complete(member.password);
  await signIn(recipient.page, member);
  return recipient.page;
}
