const rawArgv = process.argv.slice(2);
const DEFAULT_PLAYWRIGHT_BROWSER = 'chromium';

function consumeBooleanFlag(flagName, args) {
  let found = false;
  const passthrough = [];
  for (const arg of args) {
    if (arg === flagName) {
      found = true;
      continue;
    }
    passthrough.push(arg);
  }
  return {
    found,
    passthrough,
  };
}

function consumeValueFlag(flagName, args) {
  let value = null;
  const passthrough = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === flagName) {
      value = index + 1 < args.length ? args[index + 1] : '';
      index += 1;
      continue;
    }
    if (arg.startsWith(`${flagName}=`)) {
      value = arg.slice(flagName.length + 1);
      continue;
    }
    passthrough.push(arg);
  }

  return {
    value,
    passthrough,
  };
}

function normalizeBrowserSelection(rawValue, env = process.env) {
  const value = String(rawValue || env.PLAYWRIGHT_BROWSER || '').trim().toLowerCase();
  if (!value) {
    return DEFAULT_PLAYWRIGHT_BROWSER;
  }
  if (value === 'chromium') {
    return 'chromium';
  }
  if (value === 'chrome') {
    return 'chrome';
  }
  if (value === 'edge' || value === 'msedge') {
    return 'edge';
  }
  throw new Error(
    `Unsupported Playwright browser "${rawValue}". `
    + 'Use --browser=chromium (default, Playwright-managed), --browser=chrome, or --browser=edge.',
  );
}

function resolveBrowserProjectUse(browser, env = process.env) {
  const selectedBrowser = normalizeBrowserSelection(browser, {});
  if (selectedBrowser === 'chrome') {
    const verifiedChromeExecutable = String(env.PLAYWRIGHT_CHROME_EXECUTABLE || '').trim();
    if (verifiedChromeExecutable) {
      return {
        browserName: 'chromium',
        launchOptions: { executablePath: verifiedChromeExecutable },
      };
    }
    return { browserName: 'chromium', channel: 'chrome' };
  }
  if (selectedBrowser === 'edge') {
    return { browserName: 'chromium', channel: 'msedge' };
  }
  return { browserName: 'chromium' };
}

function resolveRuntimeFlags(argv = rawArgv, env = process.env) {
  const realAppFlag = consumeBooleanFlag('--real-app', argv);
  const serveRealAppFlag = consumeBooleanFlag('--serve-real-app', realAppFlag.passthrough);
  const realAppPortFlag = consumeValueFlag('--real-app-port', serveRealAppFlag.passthrough);
  const headlessFlag = consumeBooleanFlag('--headless', realAppPortFlag.passthrough);
  const headedFlag = consumeBooleanFlag('--headed', headlessFlag.passthrough);
  const browserFlag = consumeValueFlag('--browser', headedFlag.passthrough);
  const runTimeoutFlag = consumeValueFlag('--run-timeout-ms', browserFlag.passthrough);
  const envHeadlessRaw = String(env.PLAYWRIGHT_HEADLESS || '').trim().toLowerCase();
  const envHasHeadlessOverride = envHeadlessRaw !== '';
  const envHeadless = ['1', 'true', 'yes', 'on'].includes(envHeadlessRaw);
  const resolvedRealAppPort = Number(realAppPortFlag.value || env.PLAYWRIGHT_REAL_APP_PORT || 5001);
  const resolvedSupportAppPort = Number(env.PLAYWRIGHT_PORT || 4173);
  const resolvedProviderPort = Number(env.PLAYWRIGHT_PROVIDER_PORT || resolvedSupportAppPort + 2);
  const resolvedRunTimeoutMs = Number(runTimeoutFlag.value || env.PLAYWRIGHT_RUN_TIMEOUT_MS || 0);

  return {
    isRealApp: realAppFlag.found || env.PLAYWRIGHT_REAL_APP === '1',
    serveRealApp: serveRealAppFlag.found || env.PLAYWRIGHT_SERVE_REAL_APP === '1',
    realAppPort: Number.isFinite(resolvedRealAppPort) ? resolvedRealAppPort : 5001,
    supportAppPort: Number.isFinite(resolvedSupportAppPort) ? resolvedSupportAppPort : 4173,
    providerPort: Number.isFinite(resolvedProviderPort) ? resolvedProviderPort : 4175,
    runTimeoutMs: Number.isFinite(resolvedRunTimeoutMs) && resolvedRunTimeoutMs > 0 ? resolvedRunTimeoutMs : null,
    browser: normalizeBrowserSelection(browserFlag.value, env),
    headlessOverride: headlessFlag.found
      ? true
      : headedFlag.found
        ? false
      : (envHasHeadlessOverride ? envHeadless : null),
    passthroughArgv: runTimeoutFlag.passthrough,
  };
}

module.exports = {
  DEFAULT_PLAYWRIGHT_BROWSER,
  normalizeBrowserSelection,
  resolveBrowserProjectUse,
  resolveRuntimeFlags,
};
