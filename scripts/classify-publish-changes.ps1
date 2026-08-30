param(
    [string]$RepoRoot = ".",
    [Parameter(Mandatory = $true)]
    [string]$BaseRef,
    [Parameter(Mandatory = $true)]
    [string]$HeadRef
)

$ErrorActionPreference = "Stop"

function Normalize-RepoPath {
    param(
        [string]$PathValue
    )

    return ($PathValue -replace "\\", "/").Trim("/")
}

function Get-ChangeClass {
    param(
        [string]$RelativePath
    )

    $normalized = Normalize-RepoPath -PathValue $RelativePath

    if ($normalized -in @("README.md", "CHANGELOG.md", "package.json", "package-lock.json", "version.py")) {
        return "metadata"
    }

    if ($normalized.StartsWith("docs/")) {
        return "docs"
    }

    if ($normalized.StartsWith("tests/")) {
        return "test"
    }

    if ($normalized.StartsWith("scripts/")) {
        return "script"
    }

    if ($normalized -eq "app.py" -or
        $normalized.StartsWith("music_app/static/") -or
        $normalized.StartsWith("music_app/templates/")) {
        return "runtime"
    }

    if ($normalized -eq "config.py" -or
        $normalized.StartsWith(".github/") -or
        $normalized.EndsWith(".yml") -or
        $normalized.EndsWith(".yaml") -or
        $normalized.EndsWith(".toml") -or
        $normalized.EndsWith(".ini")) {
        return "config"
    }

    if ($normalized.StartsWith("music_app/")) {
        return "source"
    }

    return "source"
}

$resolvedRepoRoot = [System.IO.Path]::GetFullPath($RepoRoot)
if (-not (Test-Path -LiteralPath $resolvedRepoRoot -PathType Container)) {
    throw "RepoRoot does not exist: $resolvedRepoRoot"
}

Push-Location $resolvedRepoRoot
try {
    $diffOutput = & git diff --name-only $BaseRef $HeadRef 2>&1
    if ($LASTEXITCODE -ne 0) {
        $joinedOutput = ($diffOutput -join [Environment]::NewLine).Trim()
        throw "Could not classify publish changes for $BaseRef..$HeadRef.`n$joinedOutput"
    }

    $changedFiles = @(
        $diffOutput |
            ForEach-Object { "$_".Trim() } |
            Where-Object { $_ } |
            ForEach-Object { Normalize-RepoPath -PathValue $_ } |
            Sort-Object -Unique
    )

    $orderedClasses = @("source", "test", "runtime", "script", "config", "docs", "metadata")
    $classSet = [System.Collections.Generic.HashSet[string]]::new()

    foreach ($path in $changedFiles) {
        $null = $classSet.Add((Get-ChangeClass -RelativePath $path))
    }

    $classes = @($orderedClasses | Where-Object { $classSet.Contains($_) })
    $metadataOnly = $classes.Count -eq 0 -or (($classes | Where-Object { $_ -notin @("docs", "metadata") }).Count -eq 0)

    $payload = [ordered]@{
        metadataOnly = $metadataOnly
        changedFiles = $changedFiles
        classes = $classes
        requiresPerformanceE2E = -not $metadataOnly
    }

    $payload | ConvertTo-Json -Depth 4
} finally {
    Pop-Location
}
