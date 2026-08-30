const path = require('node:path');

function stripAnsi(text) {
  return String(text || '').replace(/\u001b\[[0-9;]*m/g, '');
}

const ANSI = Object.freeze({
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
});

function trimDurationSuffix(text) {
  return String(text || '').replace(/\s+\((?:\d+(?:\.\d+)?s|\d+ms)\)\s*$/u, '').trim();
}

function normalizeArrowSeparators(text) {
  return String(text || '')
    .replace(/вЂє/gu, ' › ')
    .replace(/\s+[›>]\s+/gu, ' > ');
}

function normalizeStatusToken(text) {
  return String(text || '')
    .replace(/вњ“/gu, '✓')
    .replace(/вњ—/gu, '✘');
}

function formatMarker(status) {
  if (status === 'failed') {
    return `${ANSI.red}[x]${ANSI.reset}`;
  }
  return `[${ANSI.green}✓${ANSI.reset}]`;
}

function extractSuiteAndTestNames(titleSegments, filePath) {
  const cleanedSegments = titleSegments
    .map((segment) => trimDurationSuffix(segment))
    .filter(Boolean);

  if (cleanedSegments.length >= 2) {
    return {
      suiteName: cleanedSegments.slice(0, -1).join(' > '),
      testName: cleanedSegments[cleanedSegments.length - 1],
    };
  }

  if (cleanedSegments.length === 1) {
    return {
      suiteName: path.basename(String(filePath || ''), path.extname(String(filePath || ''))) || cleanedSegments[0],
      testName: cleanedSegments[0],
    };
  }

  const fallbackSuite = path.basename(String(filePath || ''), path.extname(String(filePath || ''))) || 'Playwright suite';
  return {
    suiteName: fallbackSuite,
    testName: fallbackSuite,
  };
}

function parsePlaywrightListResults(outputText) {
  const results = [];
  const lines = String(outputText || '').split(/\r?\n/);

  for (const rawLine of lines) {
    const line = normalizeStatusToken(normalizeArrowSeparators(stripAnsi(rawLine))).trim();
    if (!line) {
      continue;
    }

    const match = line.match(/^(ok|not ok|x|✓|✘)\s+\d+\s+\[([^\]]+)\]\s+>\s+(.+?):\d+:\d+\s+>\s+(.+)$/iu);
    if (!match) {
      continue;
    }

    const [, rawStatus, projectName, filePath, titleText] = match;
    const normalizedStatus = String(rawStatus || '').toLowerCase();
    const status = normalizedStatus === 'ok' || rawStatus === '✓' ? 'passed' : 'failed';
    const titleSegments = String(titleText || '')
      .split(/\s+>\s+/u)
      .map((segment) => segment.trim())
      .filter(Boolean);
    const { suiteName, testName } = extractSuiteAndTestNames(titleSegments, filePath);
    const fullName = `${suiteName} > ${testName}`;

    results.push({
      status,
      projectName,
      filePath,
      suiteName,
      testName,
      fullName,
    });
  }

  return results;
}

function groupSummaryEntries(entries = []) {
  const grouped = [];
  const groupBySuite = new Map();

  for (const entry of entries) {
    const suiteName = String(entry?.suiteName || '').trim();
    const testName = String(entry?.testName || '').trim();
    if (!suiteName || !testName) {
      continue;
    }

    let suite = groupBySuite.get(suiteName);
    if (!suite) {
      suite = {
        suiteName,
        tests: [],
      };
      groupBySuite.set(suiteName, suite);
      grouped.push(suite);
    }

    suite.tests.push({
      status: entry.status === 'failed' ? 'failed' : 'passed',
      testName,
      fullName: String(entry.fullName || `${suiteName} > ${testName}`),
    });
  }

  return grouped.map((suite) => ({
    ...suite,
    status: suite.tests.some((test) => test.status === 'failed') ? 'failed' : 'passed',
    failedTests: suite.tests
      .filter((test) => test.status === 'failed')
      .map((test) => test.fullName),
  }));
}

function formatSuiteTerminalSummary(suites = []) {
  const normalizedSuites = Array.isArray(suites) ? suites.filter(Boolean) : [];
  if (!normalizedSuites.length) {
    return '';
  }

  const totalTests = normalizedSuites.reduce((count, suite) => count + (Array.isArray(suite.tests) ? suite.tests.length : 0), 0);
  const passedTests = normalizedSuites.reduce(
    (count, suite) => count + (Array.isArray(suite.tests) ? suite.tests.filter((test) => test.status === 'passed').length : 0),
    0,
  );
  const failedTests = normalizedSuites.flatMap((suite) => Array.isArray(suite.failedTests) ? suite.failedTests : []);
  const lines = ['=== Playwright Summary ==='];

  for (const suite of normalizedSuites) {
    lines.push(`${formatMarker(suite.status)} ${suite.suiteName}`);
    for (const test of suite.tests || []) {
      lines.push(`  ${formatMarker(test.status)} ${test.testName}`);
    }
  }

  lines.push('');
  lines.push(`Overall: ${passedTests}/${totalTests} passed`);

  if (failedTests.length) {
    lines.push('Failed tests:');
    for (const failedTest of failedTests) {
      lines.push(`- ${failedTest}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function formatPlaywrightTerminalSummary(entries = []) {
  return formatSuiteTerminalSummary(groupSummaryEntries(entries));
}

module.exports = {
  _private: {
    extractSuiteAndTestNames,
    formatPlaywrightTerminalSummary,
    formatSuiteTerminalSummary,
    formatMarker,
    groupSummaryEntries,
    normalizeArrowSeparators,
    parsePlaywrightListResults,
    stripAnsi,
    trimDurationSuffix,
  },
};
