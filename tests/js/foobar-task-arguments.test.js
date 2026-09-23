const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const helperPath = path.resolve(__dirname, '../../docs/future-feature-plans/foobar-reference-assets/register_foobar_db_task.ps1');
const psQuote = (value) => `'${String(value).replaceAll("'", "''")}'`;

test('scheduled backup quoting preserves native drive roots and trailing separators', {
  skip: process.platform !== 'win32' ? 'Exercises the Windows powershell.exe native argument parser.' : false,
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'album-haven-task-argv-'));
  const fixture = path.join(root, 'argv fixture.ps1');
  const launcher = path.join(root, 'check.ps1');
  fs.writeFileSync(fixture, 'param([string]$FoobarRoot, [string]$DestinationRoot)\n@($FoobarRoot, $DestinationRoot) | ConvertTo-Json -Compress');
  fs.writeFileSync(launcher, [
    "$ErrorActionPreference = 'Stop'",
    '$tokens = $null; $parseErrors = $null',
    `$ast = [System.Management.Automation.Language.Parser]::ParseFile(${psQuote(helperPath)}, [ref]$tokens, [ref]$parseErrors)`,
    'if ($parseErrors.Count) { throw "Reference helper does not parse." }',
    '$definition = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq "Quote-Argument" }, $true)',
    // Dot-source just the function definition: never execute task registration.
    '. ([scriptblock]::Create($definition.Extent.Text))',
    `$fixturePath = ${psQuote(fixture)}`,
    String.raw`$cases = @('D:\', 'D:\Music Library\', 'D:\Music Library\\')`,
    'foreach ($value in $cases) {',
    '  $info = [Diagnostics.ProcessStartInfo]::new()',
    '  $info.FileName = (Get-Command powershell.exe).Source',
    '  $info.UseShellExecute = $false; $info.CreateNoWindow = $true',
    '  $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true',
    '  $info.Arguments = "-NoProfile -NonInteractive -File " + (Quote-Argument $fixturePath) + " -FoobarRoot " + (Quote-Argument $value) + " -DestinationRoot " + (Quote-Argument $value)',
    '  $child = [Diagnostics.Process]::Start($info)',
    '  try {',
    '    $stdout = $child.StandardOutput.ReadToEnd(); $stderr = $child.StandardError.ReadToEnd()',
    '    $child.WaitForExit()',
    '    if ($child.ExitCode -ne 0) { throw $stderr }',
    '    $actual = ConvertFrom-Json -InputObject $stdout',
    '    if ($actual.Count -ne 2 -or $actual[0] -cne $value -or $actual[1] -cne $value) { throw "Native argv mismatch for [$value]: $stdout" }',
    '  } finally { $child.Dispose() }',
    '}',
  ].join('\n'));
  try {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', launcher],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
