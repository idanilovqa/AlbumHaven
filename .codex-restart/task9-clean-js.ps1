param([Parameter(Mandatory=$true)][string]$RepositoryRoot, [Parameter(Mandatory=$true)][string]$EvidenceRoot)
$ErrorActionPreference = 'Stop'
$taskRepo = (Resolve-Path -LiteralPath $RepositoryRoot).Path
$taskEvidence = [IO.Path]::GetFullPath($EvidenceRoot)
if ($taskEvidence.StartsWith($taskRepo + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Evidence must be outside the checkout' }
if (Test-Path -LiteralPath $taskEvidence) { throw 'Evidence directory must be new' }
Set-Location -LiteralPath $taskRepo
if (@(& git status --porcelain).Count) { throw 'Committed clean checkout required' }
$taskHead = (& git rev-parse HEAD).Trim()
$taskNode = 'C:\Program Files\nodejs\node.exe'
if ((& $taskNode --version) -ne 'v22.22.2') { throw 'Pinned Node 22.22.2 is required.' }
$env:PATH = (Split-Path $taskNode) + ';' + $env:PATH
$env:PLAYWRIGHT_CHROME_EXECUTABLE = 'C:\Users\Rendref\.cache\album-haven\chrome-for-testing-151.0.7922.138\chrome.exe'
$env:PLAYWRIGHT_PYTHON = 'C:\Users\Rendref\.cache\album-haven\python-3.11\python.exe'
New-Item -ItemType Directory -Path $taskEvidence | Out-Null
& $taskNode scripts/build-runtime-bundle.cjs *> (Join-Path $taskEvidence 'build.log')
if ($LASTEXITCODE -ne 0) { throw 'Runtime build failed' }
& $taskNode scripts/check-e2e-production-parity.cjs *> (Join-Path $taskEvidence 'parity.log')
if ($LASTEXITCODE -ne 0) { throw 'Production parity failed' }
if (@(& git status --porcelain).Count) { throw 'Committed runtime bundle was stale' }
$taskProcess = Start-Process -FilePath $taskNode -ArgumentList @('scripts/ci/validate-foundation-gates.cjs','--run-node-tests') -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskEvidence 'javascript.stdout.log') -RedirectStandardError (Join-Path $taskEvidence 'javascript.stderr.log')
$null = $taskProcess.Handle
$taskIds = @($taskProcess.Id)
$taskTracked = @{}
do {
    $taskProcesses = @(Get-CimInstance Win32_Process)
    do {
        $taskNew = @($taskProcesses | Where-Object { $_.ParentProcessId -in $taskIds -and $_.ProcessId -notin $taskIds } | ForEach-Object ProcessId)
        $taskIds += $taskNew
    } while ($taskNew.Count)
    foreach ($taskEntry in $taskProcesses | Where-Object ProcessId -in $taskIds) { $taskTracked[[string]$taskEntry.ProcessId] = $taskEntry.CreationDate }
    @{head=$taskHead;wrapper=$PID;owned=$taskTracked;updated=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $taskEvidence 'active.json')
    if (-not $taskProcess.WaitForExit(30000)) { Write-Output ('JavaScript suite active: ' + [DateTime]::UtcNow.ToString('o')) }
} while (-not $taskProcess.HasExited)
$taskProcess.WaitForExit()
$taskCode = $taskProcess.ExitCode
$taskRemaining = @(Get-CimInstance Win32_Process | Where-Object { $taskTracked.ContainsKey([string]$_.ProcessId) -and $_.CreationDate -eq $taskTracked[[string]$_.ProcessId] })
@{head=$taskHead;exitCode=$taskCode;remaining=@($taskRemaining | Select-Object ProcessId,ParentProcessId,Name);finished=[DateTime]::UtcNow.ToString('o')} | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $taskEvidence 'result.json')
if ($taskRemaining.Count) { throw 'Owned descendants remain; inspect exact tree before another suite' }
if ((& git rev-parse HEAD).Trim() -ne $taskHead -or @(& git status --porcelain).Count) { throw 'Source changed during verification' }
exit $taskCode
