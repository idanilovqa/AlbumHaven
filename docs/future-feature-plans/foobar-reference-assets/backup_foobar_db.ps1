[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$FoobarRoot,
    [Parameter(Mandatory = $true)][string]$DestinationRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$source = [IO.Path]::GetFullPath($FoobarRoot)
$destination = [IO.Path]::GetFullPath($DestinationRoot)
if (-not (Test-Path -LiteralPath $source -PathType Container)) {
    throw "Foobar root not found: $source"
}
if ($destination -eq $source -or $destination.StartsWith($source + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'DestinationRoot must be outside FoobarRoot.'
}

$stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
$backupRoot = Join-Path $destination "foobar-$stamp"
if (Test-Path -LiteralPath $backupRoot) {
    throw "Backup destination already exists: $backupRoot"
}
[IO.Directory]::CreateDirectory($backupRoot) | Out-Null

$items = @(
    'configuration',
    'library-v2.0',
    'playlists-v2.0',
    'index-data',
    'config.sqlite',
    'metadb.sqlite',
    'customdb_sqlite.db',
    'theme.fth',
    'portable_mode_enabled'
)

$copied = 0
foreach ($item in $items) {
    $candidate = Join-Path $source $item
    if (-not (Test-Path -LiteralPath $candidate)) { continue }
    Copy-Item -LiteralPath $candidate -Destination $backupRoot -Recurse -Force
    $copied += 1
}

if ($copied -eq 0) {
    Remove-Item -LiteralPath $backupRoot -Force
    throw 'No recognized Foobar state was found.'
}

Write-Host "Copied $copied Foobar state item(s) to $backupRoot"
