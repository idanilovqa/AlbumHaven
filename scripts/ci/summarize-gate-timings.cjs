#!/usr/bin/env node
'use strict';

// Summarizes budgeted timings retained under test-results/playwright-performance-targets/<target>.
// Sources: history metrics.json files (benchmarkValidation results, else raw metrics named by
// tests/ci/performance-times.json) and Playwright report.json timing attachments.
// Budgets come from tests/ci/performance-times.json; this script never changes them.

const fs = require('node:fs');
const path = require('node:path');
const { loadPerformanceTimesContract } = require('../performance-times-contract.cjs');

const METRIC_PREFIX_SUFFIX = /-(?:local-managed-chrome|isolated-postgres)$/u;

function budgetsByTarget(contract) {
  const byTarget = new Map();
  for (const [metricId, entry] of Object.entries(contract)) {
    const separator = metricId.lastIndexOf('.');
    const target = metricId.slice(0, separator).replace(METRIC_PREFIX_SUFFIX, '');
    if (!byTarget.has(target)) byTarget.set(target, []);
    byTarget.get(target).push({ metricId, metric: metricId.slice(separator + 1) });
  }
  return byTarget;
}

function findFiles(root, names) {
  const found = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(entryPath);
      else if (names.has(entry.name)) found.push(entryPath);
    }
  };
  if (fs.existsSync(root)) walk(root);
  return found;
}

function targetFromPath(filePath) {
  const parts = path.resolve(filePath).split(path.sep);
  const index = parts.lastIndexOf('playwright-performance-targets');
  return index >= 0 ? parts[index + 1] : null;
}

function metricsJsonObservations(run, targetBudgets) {
  const results = run.rawMetrics?.benchmarkValidation?.results;
  if (Array.isArray(results) && results.length > 0) {
    return results.map((result) => ({ metricId: result.metricId, actual: Number(result.actual) }));
  }
  return targetBudgets.map((budget) => ({
    metricId: budget.metricId,
    actual: Number(run.rawMetrics?.[budget.metric]),
  }));
}

function reportJsonObservations(report) {
  const observations = [];
  const walk = (suite) => {
    for (const child of suite.suites || []) walk(child);
    for (const spec of suite.specs || []) {
      for (const test of spec.tests || []) {
        for (const result of test.results || []) {
          for (const attachment of result.attachments || []) {
            if (attachment.contentType !== 'application/json' || !attachment.body) continue;
            let body;
            try {
              body = JSON.parse(Buffer.from(attachment.body, 'base64').toString('utf8'));
            } catch {
              continue;
            }
            if (typeof body?.metricId === 'string' && Number.isFinite(Number(body.actualMs))) {
              observations.push({ metricId: body.metricId, actual: Number(body.actualMs) });
            }
          }
        }
      }
    }
  };
  walk(report);
  return observations;
}

function classify(actual, budget) {
  if (actual <= budget.targetMs) return 'target-met';
  if (actual <= budget.hardCeilingMs) return 'grace-used';
  return 'hard-fail';
}

function collectRows(roots, { contractName = 'local', contract = loadPerformanceTimesContract() } = {}) {
  const budgets = budgetsByTarget(contract);
  const rows = [];
  for (const root of roots) {
    for (const filePath of findFiles(root, new Set(['metrics.json', 'report.json']))) {
      const target = targetFromPath(filePath);
      const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const observations = path.basename(filePath) === 'metrics.json'
        ? metricsJsonObservations(payload, budgets.get(target) || [])
        : reportJsonObservations(payload);
      for (const { metricId, actual } of observations) {
        const selected = contract[metricId]?.[contractName];
        if (!selected || !Number.isFinite(actual)) continue;
        rows.push({
          target,
          metricId,
          actualMs: Math.round(actual),
          targetMs: selected.targetMs,
          hardCeilingMs: selected.hardCeilingMs,
          status: classify(actual, selected),
          source: filePath,
        });
      }
    }
  }
  return rows;
}

function toMarkdown(rows) {
  const lines = [
    '| Target | Metric | Actual ms | Target ms | Ceiling ms | Status |',
    '| --- | --- | ---: | ---: | ---: | --- |',
  ];
  for (const row of rows) {
    lines.push(`| ${row.target} | ${row.metricId} | ${row.actualMs} | ${row.targetMs} | ${row.hardCeilingMs} | ${row.status} |`);
  }
  return `${lines.join('\n')}\n`;
}

function parseArguments(argv) {
  const options = { roots: [], contractName: 'local', json: null, markdown: null };
  for (const argument of argv) {
    const [name, value] = argument.split(/=(.*)/su);
    if (name === '--root') options.roots.push(value);
    else if (name === '--contract') options.contractName = value;
    else if (name === '--json') options.json = value;
    else if (name === '--markdown') options.markdown = value;
    else throw new Error(`Unknown argument: ${argument}`);
  }
  if (options.roots.length === 0) throw new Error('At least one --root is required.');
  return options;
}

if (require.main === module) {
  const options = parseArguments(process.argv.slice(2));
  const rows = collectRows(options.roots, { contractName: options.contractName });
  if (options.json) fs.writeFileSync(options.json, `${JSON.stringify(rows, null, 2)}\n`);
  const markdown = toMarkdown(rows);
  if (options.markdown) fs.appendFileSync(options.markdown, markdown);
  else process.stdout.write(markdown);
}

module.exports = { collectRows, toMarkdown };
