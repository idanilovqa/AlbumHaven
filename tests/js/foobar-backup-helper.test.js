const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const helperPath = path.resolve(__dirname, '..', '..', 'docs', 'future-feature-plans', 'foobar-reference-assets', 'backup_foobar_db.ps1');
const psQuote = (value) => `'${String(value).replaceAll("'", "''")}'`;

for (const scenario of ['closed', 'running', 'root-wal', 'nested-wal']) {
  test(`Foobar backup requires stopped and checkpointed source: ${scenario}`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'album-haven-foobar-backup-'));
    const source = path.join(root, 'source');
    const destination = path.join(root, 'backups');
    fs.mkdirSync(path.join(source, 'configuration'), { recursive: true });
    fs.writeFileSync(path.join(source, 'config.sqlite'), 'original database snapshot');
    if (scenario.endsWith('wal')) {
      const wal = scenario === 'root-wal' ? 'config.sqlite-wal' : 'configuration/options.sqlite-wal';
      fs.writeFileSync(path.join(source, wal), 'uncheckpointed committed database state');
    }
    const launcher = path.join(root, 'invoke.ps1');
    fs.writeFileSync(launcher, [
      "$ErrorActionPreference = 'Stop'",
      'function Get-Process {',
      '  [CmdletBinding()] param([string]$Name)',
      scenario === 'running' ? "  if ($Name -eq 'foobar2000') { [pscustomobject]@{ ProcessName = 'foobar2000' } }" : '  return',
      '}',
      `& ${psQuote(helperPath)} -FoobarRoot ${psQuote(source)} -DestinationRoot ${psQuote(destination)}`,
    ].join('\n'));
    try {
      const result = spawnSync(process.platform === 'win32' ? 'powershell.exe' : 'pwsh', [
        '-NoProfile', '-NonInteractive', '-File', launcher,
      ], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
      assert.ifError(result.error);
      const output = `${result.stdout}\n${result.stderr}`;
      if (scenario === 'closed') {
        assert.equal(result.status, 0, output);
        const copies = fs.readdirSync(destination);
        assert.equal(copies.length, 1);
        assert.equal(fs.readFileSync(path.join(destination, copies[0], 'config.sqlite'), 'utf8'), 'original database snapshot');
      } else {
        assert.notEqual(result.status, 0, 'unsafe source must be rejected before any backup is reported');
        assert.match(output, scenario === 'running' ? /close|stop|running/i : /WAL|checkpoint/i);
        assert.equal(fs.existsSync(destination), false, 'preflight must reject before creating a backup directory');
      }
      assert.equal(fs.readFileSync(path.join(source, 'config.sqlite'), 'utf8'), 'original database snapshot');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
test('Foobar backup rejects nested destination with a trailing source separator', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'album-haven-foobar-containment-'));
  const source = path.join(root, 'source'), destination = path.join(source, 'configuration', 'backups');
  fs.mkdirSync(path.join(source, 'configuration'), { recursive: true });
  const launcher = path.join(root, 'invoke.ps1');
  fs.writeFileSync(launcher, ["$ErrorActionPreference = 'Stop'", 'function Get-Process {}',
    "function Copy-Item { throw 'UNSAFE_COPY_REACHED' }",
    `& ${psQuote(helperPath)} -FoobarRoot ${psQuote(source + path.sep)} -DestinationRoot ${psQuote(destination)}`].join('\n'));
  try {
    const result = spawnSync(process.platform === 'win32' ? 'powershell.exe' : 'pwsh', ['-NoProfile', '-NonInteractive', '-File', launcher],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.ifError(result.error); assert.notEqual(result.status, 0);
    assert.match(result.stderr, /DestinationRoot must be outside FoobarRoot/);
    assert.equal(fs.existsSync(destination), false, 'unsafe output must not be created');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});