import { randomUUID } from 'node:crypto';
import { CapabilityEditorPage } from '../poms/capabilityEditorPage.js';
import { InvitationPage } from '../poms/authPages.js';
import { invitationPathFrom, signIn } from './authActions.js';
import { CAPABILITY_LABELS } from './capabilityProfiles.js';
import { expect } from '../support/baseFixtures.js';

// Separate additive setup; the legacy role/fine-grained scenarios retain their approved flows.
export async function enrollCapabilityProfile(page, freshBrowserSession, profile) {
  const administrator = await freshBrowserSession.create({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
  });
  await signIn(administrator.page, undefined, '/admin/members');
  const editor = new CapabilityEditorPage(administrator.page);
  const username = `boundary-${randomUUID().slice(0, 12)}`;
  const identity = { username, email: `${username}@example.test`, password: 'Cobalt Orchard 47! Glass River' };
  await editor.openAddUser();
  await editor.fillCreateUser({ ...identity, sendInvitation: false });
  await assignCapabilityProfile(editor, profile);
  await editor.submitCreateUser();
  await administrator.page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const invitation = await editor.copyInviteLink(username);
  await page.goto(invitationPathFrom(invitation));
  await new InvitationPage(page).complete(identity.password);
  await signIn(page, identity, profile.noView ? '/admin/members' : '/');
  await editor.openEditUser(username);
  await administrator.page.reload();
  await expectExactCapabilityProfile(editor, profile);
  return { editor, identity };
}

export async function assignCapabilityProfile(editor, profile) {
  if (profile.roles) {
    for (const role of ['Viewer', 'Listener', 'Musician', 'Owner', 'Admin']) {
      await editor.role(role).setChecked(profile.roles.includes(role));
    }
    await editor.rolesOnly.click();
  } else {
    await editor.chooseIndividualCapabilities(profile.capabilities.map((key) => CAPABILITY_LABELS[key]));
  }
}

export async function expectExactCapabilityProfile(editor, profile) {
  for (const role of ['Viewer', 'Listener', 'Musician', 'Owner', 'Admin']) {
    await expect(editor.role(role)).toBeChecked({ checked: (profile.roles || []).includes(role) });
  }
  for (const [key, label] of Object.entries(CAPABILITY_LABELS)) {
    await expect(editor.capability(label)).toHaveAttribute(
      'data-explicit-grant', (profile.capabilities || []).includes(key) ? 'true' : 'false',
    );
  }
}
