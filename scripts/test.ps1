param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$PytestArgs
)

$ErrorActionPreference = "Stop"

function Test-PythonCommand {
    param(
        [string[]]$CommandParts
    )

    try {
        & $CommandParts[0] --version *> $null
        return $LASTEXITCODE -eq 0
    } catch {
        return $false
    }
}

function Get-PythonCommand {
    $commands = @(
        @("python", "-m", "pytest"),
        @("python3", "-m", "pytest"),
        @("py", "-m", "pytest")
    )

    foreach ($commandParts in $commands) {
        $commandName = $commandParts[0]
        try {
            if ($commandName -match "\\.exe$") {
                if ((Test-Path -LiteralPath $commandName) -and (Test-PythonCommand -CommandParts $commandParts)) {
                    return $commandParts
                }
                continue
            }

            $resolvedCommand = Get-Command $commandName -ErrorAction Stop
            if (Test-PythonCommand -CommandParts $commandParts) {
                $commandParts[0] = $resolvedCommand.Source
                return $commandParts
            }
        } catch {
            continue
        }
    }

    throw "Could not find a usable Python interpreter. Install Python or update scripts/test.ps1 with the correct path."
}

function ConvertTo-ProcessArgument {
    param(
        [string]$Value
    )

    if ($Value -notmatch '[\s"]' -and $Value -notmatch '\\$') {
        return $Value
    }

    $builder = [System.Text.StringBuilder]::new()
    $null = $builder.Append('"')
    $backslashCount = 0

    foreach ($character in $Value.ToCharArray()) {
        if ($character -eq '\') {
            $backslashCount += 1
            continue
        }

        if ($character -eq '"') {
            $null = $builder.Append('\' * (($backslashCount * 2) + 1))
            $null = $builder.Append('"')
            $backslashCount = 0
            continue
        }

        if ($backslashCount -gt 0) {
            $null = $builder.Append('\' * $backslashCount)
            $backslashCount = 0
        }
        $null = $builder.Append($character)
    }

    if ($backslashCount -gt 0) {
        $null = $builder.Append('\' * ($backslashCount * 2))
    }

    $null = $builder.Append('"')
    return $builder.ToString()
}

$pytestCommand = Get-PythonCommand
$repoRoot = (Resolve-Path -LiteralPath ".").Path
$timeoutSeconds = 600

if ($env:ALBUM_HAVEN_PYTEST_TIMEOUT_SECONDS) {
    if (-not [int]::TryParse($env:ALBUM_HAVEN_PYTEST_TIMEOUT_SECONDS, [ref]$timeoutSeconds)) {
        throw "ALBUM_HAVEN_PYTEST_TIMEOUT_SECONDS must be an integer number of seconds."
    }
}

$argumentList = @($pytestCommand[1], $pytestCommand[2]) + $PytestArgs

try {
    $processInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $processInfo.FileName = $pytestCommand[0]
    $processInfo.WorkingDirectory = $repoRoot
    $processInfo.UseShellExecute = $false
    $processInfo.RedirectStandardOutput = $true
    $processInfo.RedirectStandardError = $true
    $processInfo.Arguments = ($argumentList | ForEach-Object { ConvertTo-ProcessArgument $_ }) -join " "

    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $processInfo
    $null = $process.Start()
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()

    if ($timeoutSeconds -gt 0) {
        $completed = $process.WaitForExit($timeoutSeconds * 1000)
    } else {
        $process.WaitForExit()
        $completed = $true
    }

    if (-not $completed) {
        $process.Kill()
        $stdoutTask.Wait()
        $stderrTask.Wait()
        Write-Output $stdoutTask.Result
        if ($stderrTask.Result) {
            [Console]::Error.Write($stderrTask.Result)
        }
        [Console]::Error.WriteLine("pytest timed out after $timeoutSeconds seconds. Increase ALBUM_HAVEN_PYTEST_TIMEOUT_SECONDS for unusually long full-suite runs.")
        exit 124
    }

    $stdoutTask.Wait()
    $stderrTask.Wait()
    Write-Output $stdoutTask.Result
    if ($stderrTask.Result) {
        [Console]::Error.Write($stderrTask.Result)
    }
    exit $process.ExitCode
} finally {
    if ($process) {
        $process.Dispose()
    }
}
