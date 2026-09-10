const crypto = require('node:crypto');
const path = require('node:path');

const FORBIDDEN_CONTENT = [
  /[A-Za-z]:\\/,
  /\\\\[^\\\s]+\\/,
  /file:\/\//i,
  /postgres(?:ql)?:\/\//i,
  /https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?/i,
  /https?:\/\/(?:api\.)?(?:spotify|last\.fm|musicbrainz|discogs)\.[^\s"<]+/i,
  /(?:ALBUM_HAVEN_FIXTURES_TOKEN|DATABASE_APP_URL|PGPASSWORD)\s*=/i,
  /(?:^|[\\/\s])[^\\/\s]+\.log(?:$|[\s"<])/i,
  /(?:^|[\\/\s])trace\.zip(?:$|[\s"<])/i,
  /\/(?:home\/runner\/work|Users\/[^/]+|private\/var|srv\/private|var\/folders|tmp)\//i,
];

function normalizedPublicPath(name) {
  const normalized = String(name).replaceAll('\\', '/');
  return path.posix.normalize(normalized) === normalized && !normalized.startsWith('../') && !normalized.startsWith('/');
}

function validateCloudTestReport(report) {
  const errors = [];
  if (!report || report.schemaVersion !== 1 || typeof report.pagesPath !== 'string'
    || !report.verificationEvidence || !report.pagesFiles || typeof report.pagesFiles !== 'object'
    || !Array.isArray(report.publicScreenshots)) {
    return ['malformed cloud test report'];
  }
  const runId = String(report.verificationEvidence.runId || '');
  const runAttempt = String(report.verificationEvidence.runAttempt || '');
  const expectedPath = `/runs/${runId}/${runAttempt}/`;
  const runRoot = `runs/${runId}/${runAttempt}`;
  if (!/^\d+$/.test(runId) || !/^\d+$/.test(runAttempt) || report.pagesPath !== expectedPath) {
    errors.push('invalid run-attempt Pages path');
  }
  const expectedPerformancePages = new Set(
    (Array.isArray(report.publicPerformancePages) ? report.verificationEvidence.performance || [] : []).map((target) => (
      `${runRoot}/performance/${target.target}/index.html`
    )),
  );
  const declaredPerformancePages = (report.publicPerformancePages || []).map(String);
  if (declaredPerformancePages.length !== expectedPerformancePages.size
    || new Set(declaredPerformancePages).size !== declaredPerformancePages.length
    || declaredPerformancePages.some((name) => !expectedPerformancePages.has(name))) {
    errors.push('unexpected public performance page inventory');
  }
  const requiredTextFiles = new Set([
    'index.html', 'run-index.json', `${runRoot}/index.html`, `${runRoot}/report.json`,
    ...expectedPerformancePages,
  ]);
  if (Array.isArray(report.publicPerformancePages)) {
    if (report.publicPerformanceHistoryPath !== 'performance-history.json') {
      errors.push('invalid public performance history path');
    }
    requiredTextFiles.add('performance-history.json');
  }
  const allowedActionsUrl = new RegExp(`^https://github\\.com/${String(report.verificationEvidence.repository).replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}/actions/runs/\\d+$`);
  const screenshotByPath = new Map();
  for (const screenshot of report.publicScreenshots) {
    const relativePath = screenshot?.path;
    if (!/^screenshots\/[a-z0-9][a-z0-9-]*\.png$/.test(String(relativePath || ''))
      || !/^[a-f0-9]{64}$/.test(String(screenshot?.sha256 || ''))
      || !Number.isInteger(screenshot?.width) || screenshot.width <= 0
      || !Number.isInteger(screenshot?.height) || screenshot.height <= 0
      || screenshotByPath.has(relativePath)) {
      errors.push(`malformed or duplicate public screenshot ${relativePath || ''}`.trim());
      continue;
    }
    screenshotByPath.set(relativePath, screenshot);
  }

  for (const [name, content] of Object.entries(report.pagesFiles)) {
    const normalized = name.replaceAll('\\', '/');
    if (!normalizedPublicPath(normalized)) {
      errors.push(`unsafe public report file ${name}`);
      continue;
    }
    if (requiredTextFiles.has(normalized)) {
      if (typeof content !== 'string') {
        errors.push(`non-text public report file ${name}`);
        continue;
      }
      if (FORBIDDEN_CONTENT.some((pattern) => pattern.test(content))) errors.push(`forbidden public content in ${name}`);
      for (const match of content.matchAll(/https?:\/\/[^\s"'<>]+/gi)) {
        if (!allowedActionsUrl.test(match[0])) errors.push(`forbidden public content in ${name}`);
      }
      continue;
    }
    const screenshotPath = normalized.startsWith(`${runRoot}/`) ? normalized.slice(runRoot.length + 1) : '';
    const declaration = screenshotByPath.get(screenshotPath);
    if (!declaration || !Buffer.isBuffer(content)) {
      errors.push(`unexpected public report file ${name}`);
      continue;
    }
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    if (hash !== declaration.sha256) errors.push(`public screenshot hash mismatch ${screenshotPath}`);
  }
  for (const name of requiredTextFiles) {
    if (!(name in report.pagesFiles)) errors.push(`missing public report file ${name}`);
  }

  const screenshotPages = [`${runRoot}/index.html`, ...declaredPerformancePages]
    .map((name) => report.pagesFiles[name]).filter((content) => typeof content === 'string');
  for (const html of screenshotPages) {
    for (const match of html.matchAll(/<img\b[^>]*\bsrc=["']([^"']+\.png)["']/gi)) {
      const screenshotPath = match[1].replace(/^(?:\.\.\/)+/, '');
      if (!screenshotByPath.has(screenshotPath)) errors.push(`unvalidated public screenshot ${match[1]}`);
    }
  }
  for (const screenshotPath of screenshotByPath.keys()) {
    if (!screenshotPages.some((html) => html.includes(screenshotPath))) {
      errors.push(`unreferenced public screenshot ${screenshotPath}`);
    }
    const fileName = `${runRoot}/${screenshotPath}`;
    if (!(fileName in report.pagesFiles)) errors.push(`missing public screenshot file ${screenshotPath}`);
  }
  return errors;
}

module.exports = { validateCloudTestReport };
