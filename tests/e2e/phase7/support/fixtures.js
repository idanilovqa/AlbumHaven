import { expect, test as base } from '@playwright/test';

const controlURL = String(process.env.PHASE7_AUTH_CONTROL_URL || '').replace(/\/$/, '');

async function control(path) {
  const response = await fetch(`${controlURL}${path}`, { method: 'POST' });
  if (!response.ok) {
    throw new Error(`Phase 7 E2E control ${path} failed: ${await response.text()}`);
  }
}

export const test = base.extend({
  resetPhase7State: [
    async ({}, use) => {
      await control('/reset');
      await use();
      await control('/smtp/release');
    },
    { auto: true },
  ],
});

export async function messages() {
  const response = await fetch(`${controlURL}/messages`);
  if (!response.ok) throw new Error('Could not read Phase 7 SMTP capture.');
  return (await response.json()).messages;
}

export async function databaseState() {
  const response = await fetch(`${controlURL}/state`);
  if (!response.ok) throw new Error('Could not read Phase 7 database state.');
  return response.json();
}

export async function waitForMessage(recipient, matcher = () => true) {
  let matched;
  await expect.poll(async () => {
    matched = (await messages()).find(
      (message) => message.to === recipient && matcher(message),
    );
    return Boolean(matched);
  }).toBe(true);
  return matched;
}

export async function holdMail() {
  await control('/smtp/hold');
}

export async function releaseMail() {
  await control('/smtp/release');
}

export async function databaseAction(action) {
  await control(`/database/${action}`);
}

export { expect } from '@playwright/test';
