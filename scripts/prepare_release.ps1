param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Version
)

$ErrorActionPreference = "Stop"

function Test-PythonCommand {
    param(
        [string]$CommandPath
    )

    try {
        & $CommandPath --version *> $null
        return $LASTEXITCODE -eq 0
    } catch {
        return $false
    }
}

function Get-PythonCommand {
    $commands = @(
        "py",
        "python",
        "python3"
    )

    foreach ($commandName in $commands) {
        try {
            if ($commandName -match "\\.exe$") {
                if ((Test-Path -LiteralPath $commandName) -and (Test-PythonCommand -CommandPath $commandName)) {
                    return $commandName
                }
                continue
            }

            $null = Get-Command $commandName -ErrorAction Stop
            if (Test-PythonCommand -CommandPath $commandName) {
                return $commandName
            }
        } catch {
            continue
        }
    }

    throw "Could not find a usable Python interpreter. Install Python or update scripts/prepare_release.ps1 with the correct path."
}

$pythonCommand = Get-PythonCommand
$repoRoot = Split-Path -Parent $PSScriptRoot
$previousPyPath = $env:PYTHONPATH

try {
    $env:PYTHONPATH = if ($previousPyPath) { "$repoRoot;$previousPyPath" } else { $repoRoot }
    & $pythonCommand (Join-Path $PSScriptRoot "prepare_release.py") $Version
    exit $LASTEXITCODE
} finally {
    $env:PYTHONPATH = $previousPyPath
}
