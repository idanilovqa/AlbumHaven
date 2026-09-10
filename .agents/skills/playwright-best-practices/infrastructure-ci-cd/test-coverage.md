# Test Coverage

## Table of Contents

1. [Coverage Setup](#coverage-setup)
2. [Collecting Coverage](#collecting-coverage)
3. [Coverage Reports](#coverage-reports)
4. [Coverage Thresholds](#coverage-thresholds)
5. [Advanced Patterns](#advanced-patterns)
6. [CI Integration](#ci-integration)

## Coverage Setup

[Playwright coverage](https://playwright.dev/docs/api/class-coverage) is available only on Chromium. JavaScript entries contain `source` and V8 `functions` with execution counts; CSS entries contain `text` and used `ranges`. Keep these formats separate. JavaScript ranges can nest and include unexecuted blocks, so summing their lengths does not produce line or byte coverage.

### Install Dependencies

```bash
npm install -D @playwright/test v8-to-istanbul istanbul-lib-coverage nyc
```

Collection needs no instrumentation package. The reporting examples use [v8-to-istanbul](https://github.com/istanbuljs/v8-to-istanbul) for JavaScript conversion and Istanbul coverage maps for merging execution counts.

### Basic Configuration

```typescript
// playwright.config.ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  outputDir: "test-results",
  use: { baseURL: "http://127.0.0.1:3000" },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "firefox", use: { browserName: "firefox" } },
  ],
});
```

### V8 Coverage Fixture

Use the test's actual `page`; creating a separate worker page would measure an unused tab. The automatic test fixture starts before the test and stops before Playwright tears down its page. Other browser projects still execute their tests without invoking unsupported coverage APIs.

```typescript
// fixtures/coverage.ts
import { test as base, expect } from "@playwright/test";
import fs from "node:fs/promises";

export const test = base.extend<{ collectCoverage: void }>({
  collectCoverage: [async ({ page, browserName }, use, testInfo) => {
    if (browserName !== "chromium") {
      await use();
      return;
    }
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
    await page.coverage.startCSSCoverage({ resetOnNavigation: false });
    try {
      await use();
    } finally {
      // Tests using this fixture must leave their page open for collection.
      const [js, css] = await Promise.all([
        page.coverage.stopJSCoverage(), page.coverage.stopCSSCoverage(),
      ]);
      await fs.writeFile(testInfo.outputPath("js-coverage.json"), JSON.stringify(js));
      await fs.writeFile(testInfo.outputPath("css-coverage.json"), JSON.stringify(css));
    }
  }, { auto: true }],
});
export { expect };
```

Import this fixture in coverage-enabled tests. It instruments only the supplied page, not popups, manually created pages or service workers. `resetOnNavigation: false` does not guarantee retention across browser process changes: collect each document's coverage before navigating away when that coverage is required, and merge those snapshots. For broader cross-browser coverage use build-time Istanbul instrumentation instead.

## Collecting Coverage

### Per-Test Coverage

```typescript
import { test, expect } from "../fixtures/coverage";

test("checkout succeeds", async ({ page }) => {
  await page.goto("/checkout");
  await page.getByRole("button", { name: "Pay" }).click();
  await expect(page.getByText("Payment complete")).toBeVisible();
  // The fixture saves coverage during teardown; do not start it a second time.
});
```

### Coverage for Specific Files

Use the merged Istanbul map below to inspect a module after the run. Missing expected modules must fail the check, rather than silently skipping a threshold. V8 reports scripts loaded by tested pages; a completely unloaded module is absent. For repository-wide coverage, supply a build-generated source inventory and include unloaded files with zero coverage, or use instrumentation with an explicit include-all-sources policy.

### CSS Coverage

CSS remains a separate diagnostic. Its used ranges are sorted and non-overlapping within one entry, so their lengths can be added for that entry. This is text-offset coverage, not JavaScript line coverage. Missing or empty source text cannot yield a useful percentage.

```javascript
// Inspect one css-coverage.json produced by the fixture.
const fs = require("node:fs");
const cssCoverage = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
for (const entry of cssCoverage) {
  if (typeof entry.text !== "string" || entry.text.length === 0) {
    console.warn(`${entry.url}: CSS coverage unavailable`);
    continue;
  }
  const used = entry.ranges.reduce((sum, range) => sum + range.end - range.start, 0);
  const unused = 100 * (1 - used / entry.text.length);
  if (unused > 50) console.warn(`${entry.url}: ${unused.toFixed(1)}% unused CSS`);
}
```

Exercise relevant responsive, hover, focus and dialog states before collection. Never concatenate CSS ranges across snapshots and sum them; overlapping offsets must be unioned for identical stylesheet content.

## Coverage Reports

### Converting to Istanbul Format

This example assumes the test server serves original JavaScript directly from the checkout's `/src/` directory. Set `COVERAGE_ORIGIN` to its exact origin. Adapt the URL-to-file mapping for your build; transpiled bundles need matching source maps and original sources. Do not treat generated bundle percentages as TypeScript source coverage.

The converter reads only `js-coverage.json`, provides the captured `source`, and merges every converted map. `Object.assign` would overwrite earlier test coverage for the same file. All inputs must come from the same build and revision; conflicting source content fails explicitly.

```javascript
// scripts/convert-coverage.cjs
const fs = require("node:fs/promises");
const path = require("node:path");
const v8ToIstanbul = require("v8-to-istanbul");
const { createCoverageMap } = require("istanbul-lib-coverage");

async function rawFiles(directory) {
  const result = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await rawFiles(filename));
    else if (entry.isFile() && entry.name === "js-coverage.json") result.push(filename);
  }
  return result;
}

async function convertCoverage(directories, origin) {
  if (!origin) throw new Error("Set COVERAGE_ORIGIN to the test server origin.");
  const expectedOrigin = new URL(origin).origin;
  const sourceRoot = path.resolve("src");
  const map = createCoverageMap({});
  const sources = new Map();
  for (const directory of directories) {
    for (const filename of await rawFiles(directory)) {
      const entries = JSON.parse(await fs.readFile(filename, "utf8"));
      for (const entry of entries) {
        if (!entry.url || !/^https?:/.test(entry.url)) continue;
        const url = new URL(entry.url);
        if (url.origin !== expectedOrigin || !url.pathname.startsWith("/src/")) continue;
        const filePath = path.resolve(sourceRoot, decodeURIComponent(url.pathname.slice(5)));
        const relative = path.relative(sourceRoot, filePath);
        if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
          throw new Error("Coverage source lies outside src.");
        }
        if (typeof entry.source !== "string" || !Array.isArray(entry.functions)) {
          throw new Error(`Missing JavaScript source/functions: ${url.pathname}`);
        }
        if (sources.has(filePath) && sources.get(filePath) !== entry.source) {
          throw new Error(`Mixed source revisions: ${url.pathname}`);
        }
        sources.set(filePath, entry.source);
        const converter = v8ToIstanbul(filePath, 0, { source: entry.source });
        await converter.load();
        converter.applyCoverage(entry.functions);
        map.merge(converter.toIstanbul());
      }
    }
  }
  if (map.files().length === 0) throw new Error("No application JavaScript coverage collected.");
  return map;
}

async function main() {
  const directories = process.argv.slice(2);
  if (!directories.length) throw new Error("Pass at least one raw coverage directory.");
  const map = await convertCoverage(directories, process.env.COVERAGE_ORIGIN);
  await fs.mkdir("coverage/istanbul", { recursive: true });
  await fs.writeFile("coverage/istanbul/coverage-final.json", JSON.stringify(map.toJSON()));
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { convertCoverage };
```

### Generating HTML Report

Run conversion after all test workers finish. Keep raw files outside NYC's temporary directory so it receives only Istanbul maps. Use fresh job-owned output directories for each run, including when downloading shard artifacts.

```json
{
  "scripts": {
    "test": "playwright test",
    "test:coverage": "playwright test && npm run coverage:report",
    "coverage:report": "node scripts/convert-coverage.cjs test-results && nyc report --reporter=html --reporter=lcov --reporter=text --reporter=json-summary --temp-dir=coverage/istanbul --report-dir=coverage && nyc check-coverage --lines=80 --temp-dir=coverage/istanbul"
  }
}
```

### Custom Coverage Reporter

A custom summary should read the completed Istanbul map, not raw V8 ranges. Use this after conversion; a test-file `afterAll` can execute before other workers finish.

```javascript
const fs = require("node:fs");
const { createCoverageMap } = require("istanbul-lib-coverage");
const map = createCoverageMap(JSON.parse(fs.readFileSync("coverage/istanbul/coverage-final.json", "utf8")));
const summary = map.getCoverageSummary();
console.log(`Files: ${map.files().length}; lines: ${summary.lines.pct}%`);
```

## Coverage Thresholds

### Enforcing Minimum Coverage

The report command enforces an 80% line threshold over collected application sources. For a required module, fail on missing coverage and check its actual Istanbul line summary:

```javascript
const path = require("node:path");
// `map` is the completed coverage map from the summary example.
const filename = path.resolve("src/checkout.js");
if (!map.files().includes(filename)) throw new Error("Required checkout coverage missing.");
const lines = map.fileCoverageFor(filename).toSummary().lines;
if (!lines.total || Number(lines.pct) < 80) throw new Error("Checkout line coverage below 80%.");
```

### Per-Directory Thresholds

```javascript
const path = require("node:path");
const { createCoverageMap } = require("istanbul-lib-coverage");
// `map` is the completed coverage map from the summary example.
for (const [directory, minimum] of [["src/core", 90], ["src/utils", 85], ["src/components", 70], ["src/pages", 60]]) {
  const prefix = path.resolve(directory) + path.sep;
  const selected = createCoverageMap({});
  for (const filename of map.files()) {
    if (filename.startsWith(prefix)) selected.addFileCoverage(map.fileCoverageFor(filename));
  }
  const lines = selected.getCoverageSummary().lines;
  if (!selected.files().length || !lines.total || Number(lines.pct) < minimum) {
    throw new Error(`${directory}: missing coverage or line coverage below ${minimum}%.`);
  }
}
```

## Advanced Patterns

### Merging Coverage Across Shards

Download every expected shard's raw results from the same revision into separate directories and verify every shard completed. Run the same converter once with all inputs, then the same NYC report/threshold commands. This merges per-file execution counts before computing percentages and maps paths on the reporting machine.

```bash
node scripts/convert-coverage.cjs shard-1/test-results shard-2/test-results
npx nyc report --reporter=html --reporter=lcov --reporter=json-summary --temp-dir=coverage/istanbul --report-dir=coverage
npx nyc check-coverage --lines=80 --temp-dir=coverage/istanbul
```

### Incremental Coverage

Changed-file checks must compare normalized source paths with the merged map; substring URL matching can confuse similarly named files. This example checks directly served JavaScript. For TypeScript, use the source-mapped original file paths instead.

```javascript
const { execFileSync } = require("node:child_process");
const path = require("node:path");
// `map` is the completed coverage map from the summary example.
const changed = execFileSync("git", ["diff", "--name-only", "--diff-filter=ACMR", "-z", "HEAD~1", "--", "src"], { encoding: "utf8" })
  .split("\0").filter(filename => filename.endsWith(".js"));
for (const filename of changed) {
  const absolute = path.resolve(filename);
  if (!map.files().includes(absolute)) throw new Error(`Missing changed-file coverage: ${filename}`);
  const lines = map.fileCoverageFor(absolute).toSummary().lines;
  if (!lines.total || Number(lines.pct) < 80) throw new Error(`Insufficient line coverage: ${filename}`);
}
```

Use the authenticated PR base for a PR-wide check; `HEAD~1` above covers only the latest commit. Incremental checks supplement the full required coverage policy.

## CI Integration

```yaml
# .github/workflows/test.yml
name: Tests with Coverage
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    env:
      COVERAGE_ORIGIN: http://127.0.0.1:3000
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - run: npx playwright install --with-deps
      # Configure the project's webServer to serve /src from this revision.
      - run: npm run test:coverage
      - name: Retain coverage reports
        uses: actions/upload-artifact@v4
        with:
          name: coverage
          path: coverage
          if-no-files-found: error
```

The report command generates HTML, LCOV and JSON summaries and fails the configured threshold. Upload `coverage/lcov.info` to your coverage service if the project uses one. Retain raw results separately when diagnosing incomplete collection or aggregating shards.

## Anti-Patterns to Avoid

| Anti-Pattern | Problem | Solution |
| --- | --- | --- |
| Coverage for coverage's sake | Gaming metrics | Focus on critical paths |
| 100% coverage target | Diminishing returns, tests for getters | Set realistic thresholds |
| Ignoring coverage drops | Technical debt | Enforce thresholds in CI |
| No source map support | Wrong source line attribution | Enable matching source maps and sources |
| Coverage only in CI | Late feedback | Run focused collection locally too |
| Combining raw JS and CSS | Different formats and denominators | Convert JS; report CSS separately |
| Overwriting maps or concatenating ranges | Loses tests or double-counts offsets | Merge Istanbul maps from one revision |
| Empty inventory treated as passing | Missing collection looks green | Fail missing expected coverage |

## Related References

- **CI/CD**: See [ci-cd.md](ci-cd.md) for pipeline configuration
- **Performance**: See [performance.md](performance.md) for optimizing coverage collection
- [Playwright Coverage API](https://playwright.dev/docs/api/class-coverage)
- [Istanbul coverage map API](https://github.com/istanbuljs/istanbuljs/blob/main/packages/istanbul-lib-coverage/lib/coverage-map.js)
