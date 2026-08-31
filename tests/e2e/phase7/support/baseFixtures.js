import { test as base } from '../../support/baseFixtures.js';
import { control } from './fixtures.js';

export const test = base.extend({
  startupRelationProjectionReadiness: [
    async ({}, use) => use(null),
    { scope: 'worker', auto: true },
  ],
  resetPhase7State: [
    async ({}, use) => {
      await control('/reset');
      await use();
      await control('/smtp/release');
    },
    { auto: true },
  ],
});

export {
  databaseAction,
  databaseState,
  expect,
  holdMail,
  messages,
  releaseMail,
  waitForMessage,
} from './fixtures.js';
