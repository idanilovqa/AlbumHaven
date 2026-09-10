import { expect } from '@playwright/test';
import { LoginPage } from '../poms/authPages.js';

export const OWNER = Object.freeze({
  username: 'rendref',
  password: 'Phase Seven Owner Passphrase 2026!',
});

export async function signIn(page, credentials = OWNER, returnTo = '/') {
  const login = new LoginPage(page);
  await login.open(returnTo);
  await login.signIn(credentials.username, credentials.password);
  await expect(page).not.toHaveURL(/\/login/);
}

export function resetLinkFrom(message) {
  const match = String(message?.body || '').match(/https:\/\/[^\s<]+\/reset-password\?purpose=password-reset&token=[A-Za-z0-9_-]+/);
  if (!match) throw new Error('Captured message did not contain a reset link.');
  const url = new URL(match[0]);
  return `${url.pathname}${url.search}`;
}

export function invitationPathFrom(message) {
  const source = String(message?.body ?? message ?? '')
    .replaceAll('&amp;', '&')
    .replaceAll('&#38;', '&')
    .replaceAll('&#x26;', '&');
  const candidates = source.match(/https?:\/\/[^\s<>"']+/gi) || [];
  for (const candidate of candidates) {
    const normalizedCandidate = candidate.replace(/[),.;]+$/, '');
    if (!URL.canParse(normalizedCandidate)) continue;
    const url = new URL(normalizedCandidate);
    if (
      url.pathname === '/accept-invitation'
      && url.searchParams.get('purpose') === 'account-invitation'
      && /^[A-Za-z0-9_-]+$/.test(url.searchParams.get('token') || '')
    ) {
      return `${url.pathname}${url.search}`;
    }
  }
  throw new Error('Captured message did not contain an invitation link.');
}
