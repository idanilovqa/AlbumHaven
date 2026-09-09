[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$FoobarRoot,
    [Parameter(Mandatory = $true)][string]$DestinationRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-NormalizedDirectoryPath([string]$Value) {
    $absolute = [IO.Path]::GetFullPath($Value)
    $root = [IO.Path]::GetPathRoot($absolute)
    $trimmed = $absolute.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    if ($trimmed.Length -lt $root.Length) { return $root }
    return $trimmed
}
$source = Get-NormalizedDirectoryPath $FoobarRoot
$destination = Get-NormalizedDirectoryPath $DestinationRoot
$sourcePrefix = $source.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
if (-not (Test-Path -LiteralPath $source -PathType Container)) {
    throw "Foobar root not found: $source"
}
if ($destination -eq $source -or $destination.StartsWith($sourcePrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'DestinationRoot must be outside FoobarRoot.'
}

# Copying SQLite files is safe only while Foobar stays closed and its WALs are empty.
if (@(Get-Process -Name 'foobar2000' -ErrorAction SilentlyContinue).Count -gt 0) {
    throw 'Close Foobar2000 before backing up its state, and keep it closed until the copy finishes.'
}
$pendingWal = Get-ChildItem -LiteralPath $source -Filter '*-wal' -File -Recurse |
    Where-Object { $_.Length -gt 0 } | Select-Object -First 1
if ($pendingWal) {
    throw 'Foobar state contains a non-empty SQLite WAL. Use Foobar to close and checkpoint its databases before retrying; this helper does not modify them.'
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
