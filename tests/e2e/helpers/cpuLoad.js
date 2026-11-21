import os from 'node:os';
import { Worker } from 'node:worker_threads';

/**
 * Loads the machine as the owner's was (a VM importing photos held the CPU at 100%; owner: "Long
 * cpu 100% is no execuse"): a busy thread on every core, which the app server and the browser
 * compete with, and each page's own CPU slowed `slowdown` times by Chromium's throttling.
 */
export async function startCpuLoad(pages, { slowdown = 4, threads = os.cpus().length } = {}) {
  const workers = Array.from({ length: threads }, () => new Worker('for (;;) {}', { eval: true }));
  const sessions = [];
  const throttle = async (page) => {
    const session = await page.context().newCDPSession(page);
    await session.send('Emulation.setCPUThrottlingRate', { rate: slowdown });
    sessions.push(session);
  };
  await Promise.all(pages.map(throttle));
  return {
    /** Slows a page opened after the load started as much as the others. */
    throttle,
    async stop() {
      await Promise.all(workers.map((worker) => worker.terminate()));
      await Promise.all(sessions.map((session) => session.detach()));
    },
  };
}
