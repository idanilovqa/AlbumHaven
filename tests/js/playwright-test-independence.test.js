const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..', '..');

function walkFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) return walkFiles(absolutePath);
    return [absolutePath];
  });
}

test('Playwright projects and scenarios do not suppress tests behind other test results', () => {
  const configPaths = fs.readdirSync(repoRoot)
    .filter((name) => /^playwright(?:\..+)?\.config\.(?:c?js|mjs|ts)$/.test(name))
    .map((name) => path.join(repoRoot, name));
  const scenarioPaths = walkFiles(path.join(repoRoot, 'tests', 'e2e'))
    .filter((filePath) => /\.(?:c?js|mjs|ts)$/.test(filePath));
  const sources = [...configPaths, ...scenarioPaths].map((filePath) => ({
    relativePath: path.relative(repoRoot, filePath),
    source: fs.readFileSync(filePath, 'utf8'),
  }));

  for (const { relativePath, source } of sources) {
    assert.doesNotMatch(source, /\bdependencies\s*:/, `${relativePath} has a project dependency`);
    assert.doesNotMatch(source, /test\.describe\.serial\s*\(/, `${relativePath} has a serial suite`);
    assert.doesNotMatch(
      source,
      /test\.describe\.configure\s*\(\s*\{[^}]*\bmode\s*:\s*['"]serial['"]/s,
      `${relativePath} has a serial suite mode`,
    );
  }
});

test('Python tests do not declare success or order dependencies', () => {
  const pythonPaths = walkFiles(path.join(repoRoot, 'tests'))
    .filter((filePath) => filePath.endsWith('.py'));

  for (const filePath of pythonPaths) {
    const relativePath = path.relative(repoRoot, filePath);
    const source = fs.readFileSync(filePath, 'utf8');
    assert.doesNotMatch(
      source,
      /@pytest\.mark\.(?:dependency|order|run)\b/,
      `${relativePath} has a pytest success or order dependency`,
    );
  }
});
