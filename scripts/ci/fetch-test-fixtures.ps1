[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Release,
    [Parameter(Mandatory = $true)]
    [ValidateSet('functional-core', 'synthetic-large-library', 'utility-problematic-files', 'scan-library', 'playback-media')]
    [string]$Profile,
    [Parameter(Mandatory = $true)][string]$ManifestSha256,
    [string]$Repository = 'idanilovqa/album-haven-test-data',
    [string]$ApiBaseUrl = 'https://api.github.com',
    [string]$RunnerTemp = $env:RUNNER_TEMP,
    [string]$GithubEnv = $env:GITHUB_ENV
)

$ErrorActionPreference = 'Stop'
$supportedProfiles = @('functional-core', 'synthetic-large-library', 'utility-problematic-files', 'scan-library', 'playback-media')

function Get-Sha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Assert-NoEnvironmentControlCharacters {
    param([Parameter(Mandatory = $true)][string]$Value, [Parameter(Mandatory = $true)][string]$Name)
    if ($Value.IndexOfAny([char[]]@("`r", "`n", "`0")) -ge 0) {
        throw "$Name contains forbidden environment-file control characters."
    }
}

function Assert-SafeRelativePath {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Description)
    $normalized = $Path.Replace('\', '/').TrimEnd('/')
    if ([string]::IsNullOrWhiteSpace($normalized) -or [IO.Path]::IsPathRooted($Path) -or $normalized.StartsWith('/')) {
        throw "Unsafe archive path in $Description."
    }
    foreach ($segment in $normalized.Split('/')) {
        if (
            [string]::IsNullOrWhiteSpace($segment) -or $segment -eq '.' -or $segment -eq '..' -or
            $segment -match '[<>:"|?*\x00-\x1f]' -or $segment.EndsWith('.') -or $segment.EndsWith(' ')
        ) {
            throw "Unsafe Windows archive path in $Description."
        }
        if ($segment.Split('.')[0] -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$') {
            throw "Unsafe Windows device path in $Description."
        }
    }
    return $normalized
}

function Assert-ManifestObject {
    param([object]$Value, [string]$Description)
    if ($null -eq $Value -or $Value -is [string] -or $Value -is [System.Collections.IEnumerable]) {
        throw "Manifest schema is missing a valid $Description object."
    }
}

function Assert-AssetUri {
    param([string]$Value, [uri]$ApiBase)
    try { $assetUri = [uri]$Value } catch { throw 'Release asset URL is invalid.' }
    if (-not $assetUri.IsAbsoluteUri) { throw 'Release asset URL is invalid.' }
    if ($assetUri.Scheme -ne 'https' -and -not ($ApiBase.IsLoopback -and $assetUri.Scheme -eq 'http')) {
        throw 'Release asset URL has an unsafe scheme.'
    }
    if ($assetUri.Scheme -cne $ApiBase.Scheme -or $assetUri.Host -cne $ApiBase.Host -or $assetUri.Port -ne $ApiBase.Port) {
        throw 'Release asset URL has an unsafe origin.'
    }
    return $assetUri
}

function Receive-Asset {
    param([uri]$Uri, [hashtable]$Headers, [string]$Destination, [string]$FailureMessage)
    $parameters = @{ Uri = $Uri; Headers = $Headers; Method = 'Get'; OutFile = $Destination; UseBasicParsing = $true }
    if ((Get-Command Invoke-WebRequest).Parameters.ContainsKey('PreserveAuthorizationOnRedirect')) {
        $parameters.PreserveAuthorizationOnRedirect = $false
    }
    try { Invoke-WebRequest @parameters } catch { throw $FailureMessage }
}

if ([string]::IsNullOrWhiteSpace($env:ALBUM_HAVEN_FIXTURES_TOKEN)) {
    throw 'ALBUM_HAVEN_FIXTURES_TOKEN is required before fixture HTTP requests can be made.'
}
if ($Release -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$') { throw 'Release tag is invalid.' }
if ($Repository -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { throw 'Repository name is invalid.' }
if ($ManifestSha256 -notmatch '^[A-Fa-f0-9]{64}$') { throw 'Manifest sha must be a hexadecimal SHA-256 value.' }
if ([string]::IsNullOrWhiteSpace($RunnerTemp) -or [string]::IsNullOrWhiteSpace($GithubEnv)) { throw 'RunnerTemp and GithubEnv are required.' }
Assert-NoEnvironmentControlCharacters -Value $Release -Name 'Release'
Assert-NoEnvironmentControlCharacters -Value $RunnerTemp -Name 'RunnerTemp'
Assert-NoEnvironmentControlCharacters -Value $GithubEnv -Name 'GithubEnv'

try { $apiBase = [uri]$ApiBaseUrl } catch { throw 'ApiBaseUrl is invalid.' }
if (-not $apiBase.IsAbsoluteUri) { throw 'ApiBaseUrl is invalid.' }
if ($apiBase.Host -cne 'api.github.com' -and -not $apiBase.IsLoopback) { throw 'ApiBaseUrl host is not permitted.' }
if ($apiBase.Scheme -ne 'https' -and -not ($apiBase.IsLoopback -and $apiBase.Scheme -eq 'http')) { throw 'ApiBaseUrl scheme is not permitted.' }

$headers = @{
    Authorization = "Bearer $($env:ALBUM_HAVEN_FIXTURES_TOKEN)"
    Accept = 'application/vnd.github+json'
    'X-GitHub-Api-Version' = '2022-11-28'
    'User-Agent' = 'album-haven-fixture-downloader'
}
$assetHeaders = $headers.Clone()
$assetHeaders.Accept = 'application/octet-stream'

[IO.Directory]::CreateDirectory($RunnerTemp) | Out-Null
$workRoot = Join-Path $RunnerTemp ('.fixture-download-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($workRoot) | Out-Null
$manifestPath = Join-Path $workRoot 'manifest.json'
$extractionRoot = $null
$exportCommitted = $false

try {
    $releaseUri = $ApiBaseUrl.TrimEnd('/') + '/repos/' + $Repository + '/releases/tags/' + [uri]::EscapeDataString($Release)
    try { $releaseResponse = Invoke-RestMethod -Uri $releaseUri -Headers $headers -Method Get } catch { throw 'GitHub release request failed.' }
    if ([string]$releaseResponse.tag_name -cne $Release) { throw 'GitHub release tag does not match the requested release.' }

    $manifestAsset = @($releaseResponse.assets | Where-Object { $_.name -ceq 'manifest.json' })
    if ($manifestAsset.Count -ne 1) { throw 'Missing manifest asset in GitHub release.' }
    $manifestUri = Assert-AssetUri -Value ([string]$manifestAsset[0].url) -ApiBase $apiBase
    Receive-Asset -Uri $manifestUri -Headers $assetHeaders -Destination $manifestPath -FailureMessage 'Manifest asset download failed.'
    if ((Get-Sha256 -Path $manifestPath) -cne $ManifestSha256.ToLowerInvariant()) { throw 'Manifest sha verification failed.' }

    try { $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json } catch { throw 'Manifest schema is invalid JSON.' }
    if ($manifest.manifestVersion -ne 1) { throw 'Manifest schema version is unsupported.' }
    if ([string]$manifest.release -cne $Release) { throw 'Manifest release does not match the requested release.' }
    if ([string]$manifest.generatorCommit -notmatch '^[A-Fa-f0-9]{40}$') { throw 'Manifest schema has an invalid generatorCommit.' }
    Assert-ManifestObject -Value $manifest.profiles -Description 'profiles'
    $actualProfiles = @($manifest.profiles.PSObject.Properties.Name | Sort-Object)
    $expectedProfiles = @($supportedProfiles | Sort-Object)
    if (($actualProfiles -join "`n") -cne ($expectedProfiles -join "`n")) { throw 'Manifest schema must contain exactly the five supported profiles.' }

    foreach ($profileName in $supportedProfiles) {
        $definition = $manifest.profiles.PSObject.Properties[$profileName].Value
        if ($definition.schemaVersion -ne 1) { throw 'Fixture profile schema version is unsupported.' }
        if ([string]$definition.sha256 -notmatch '^[A-Fa-f0-9]{64}$') { throw 'Archive sha in manifest is invalid.' }
        [void](Assert-SafeRelativePath -Path ([string]$definition.archive) -Description 'manifest archive name')
        [void](Assert-SafeRelativePath -Path ([string]$definition.databaseSeed) -Description 'databaseSeed')
        [void](Assert-SafeRelativePath -Path ([string]$definition.mediaRoot) -Description 'mediaRoot')
        Assert-ManifestObject -Value $definition.counts -Description "$profileName counts"
        Assert-ManifestObject -Value $definition.namedScenarioAssertions -Description "$profileName namedScenarioAssertions"
    }

    $profileDefinition = $manifest.profiles.PSObject.Properties[$Profile].Value
    $archiveName = Assert-SafeRelativePath -Path ([string]$profileDefinition.archive) -Description 'manifest archive name'
    $databaseSeed = Assert-SafeRelativePath -Path ([string]$profileDefinition.databaseSeed) -Description 'databaseSeed'
    $mediaRootRelative = Assert-SafeRelativePath -Path ([string]$profileDefinition.mediaRoot) -Description 'mediaRoot'
    $archiveAsset = @($releaseResponse.assets | Where-Object { $_.name -ceq $archiveName })
    if ($archiveAsset.Count -ne 1) { throw 'Missing archive asset in GitHub release.' }
    $archiveUri = Assert-AssetUri -Value ([string]$archiveAsset[0].url) -ApiBase $apiBase

    $archiveSha = ([string]$profileDefinition.sha256).ToLowerInvariant()
    $cacheRoot = Join-Path $RunnerTemp (Join-Path 'album-haven-fixture-cache' (Join-Path $Release (Join-Path $Profile $archiveSha)))
    [IO.Directory]::CreateDirectory($cacheRoot) | Out-Null
    $cacheArchive = Join-Path $cacheRoot ([IO.Path]::GetFileName($archiveName))
    if (Test-Path -LiteralPath $cacheArchive -PathType Leaf) {
        if ((Get-Sha256 -Path $cacheArchive) -cne $archiveSha) { throw 'Cached archive sha verification failed.' }
    } else {
        $downloadPath = Join-Path $workRoot ('archive-' + [guid]::NewGuid().ToString('N') + '.download')
        Receive-Asset -Uri $archiveUri -Headers $assetHeaders -Destination $downloadPath -FailureMessage 'Archive asset download failed.'
        if ((Get-Sha256 -Path $downloadPath) -cne $archiveSha) { throw 'Downloaded archive sha verification failed.' }
        try { [IO.File]::Move($downloadPath, $cacheArchive) } catch [IO.IOException] {
            if (-not (Test-Path -LiteralPath $cacheArchive -PathType Leaf) -or (Get-Sha256 -Path $cacheArchive) -cne $archiveSha) {
                throw 'Concurrent archive cache publication failed verification.'
            }
            Remove-Item -LiteralPath $downloadPath -Force -ErrorAction SilentlyContinue
        }
    }

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($cacheArchive)
    try {
        $entries = New-Object 'System.Collections.Generic.Dictionary[string,bool]' ([StringComparer]::OrdinalIgnoreCase)
        $validationRoot = [IO.Path]::GetFullPath((Join-Path $RunnerTemp '.fixture-validation-root'))
        $validationPrefix = $validationRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
        foreach ($entry in $zip.Entries) {
            $normalized = Assert-SafeRelativePath -Path $entry.FullName -Description 'ZIP archive entry'
            if ($normalized -ieq 'manifest.json') { throw 'Archive contains reserved manifest.json member.' }
            $destination = [IO.Path]::GetFullPath((Join-Path $validationRoot ($normalized.Replace('/', [IO.Path]::DirectorySeparatorChar))))
            if (-not $destination.StartsWith($validationPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe canonical destination in ZIP archive.' }
            $unixType = (($entry.ExternalAttributes -shr 16) -band 0xF000)
            if ($unixType -eq 0xA000 -or ($entry.ExternalAttributes -band 0x400) -ne 0) { throw 'Archive symlink or reparse entry is forbidden.' }
            $isDirectory = $entry.FullName.EndsWith('/') -or $entry.FullName.EndsWith('\') -or [string]::IsNullOrEmpty($entry.Name)
            if ($entries.ContainsKey($normalized)) { throw 'Archive contains a duplicate or canonical-collision entry.' }
            $entries.Add($normalized, $isDirectory)
        }
        foreach ($entryName in @($entries.Keys)) {
            $parent = $entryName
            while ($parent.Contains('/')) {
                $parent = $parent.Substring(0, $parent.LastIndexOf('/'))
                if ($entries.ContainsKey($parent) -and -not $entries[$parent]) { throw 'Archive contains a file/directory canonical collision.' }
            }
        }
        if (-not $entries.ContainsKey($databaseSeed) -or $entries[$databaseSeed]) { throw 'Missing required regular databaseSeed member in archive.' }
        $mediaFound = $entries.ContainsKey($mediaRootRelative) -and $entries[$mediaRootRelative]
        if (-not $mediaFound) {
            $mediaPrefix = $mediaRootRelative + '/'
            $mediaFound = @($entries.Keys | Where-Object { $_.StartsWith($mediaPrefix, [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0
        }
        if (-not $mediaFound) { throw 'Missing required mediaRoot directory in archive.' }
    } finally { $zip.Dispose() }

    $extractionRoot = Join-Path $RunnerTemp ('album-haven-fixtures-' + [guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($extractionRoot) | Out-Null
    [IO.Compression.ZipFile]::ExtractToDirectory($cacheArchive, $extractionRoot)
    Get-ChildItem -LiteralPath $extractionRoot -Recurse -Force | ForEach-Object { if ($_.IsReadOnly) { $_.IsReadOnly = $false } }
    [IO.File]::Copy($manifestPath, (Join-Path $extractionRoot 'manifest.json'), $false)

    $mediaRoot = Join-Path $extractionRoot ($mediaRootRelative.Replace('/', [IO.Path]::DirectorySeparatorChar))
    foreach ($value in @($Release, $Profile, $extractionRoot, $mediaRoot)) { Assert-NoEnvironmentControlCharacters -Value $value -Name 'Export value' }
    $exports = @(
        "ALBUM_HAVEN_FIXTURE_RELEASE=$Release",
        "ALBUM_HAVEN_FIXTURE_PROFILE=$Profile",
        "ALBUM_HAVEN_FIXTURE_ROOT=$extractionRoot",
        "ALBUM_HAVEN_MEDIA_ROOT=$mediaRoot"
    )
    $utf8 = New-Object Text.UTF8Encoding($false)
    [IO.File]::AppendAllText($GithubEnv, (($exports -join [Environment]::NewLine) + [Environment]::NewLine), $utf8)
    $exportCommitted = $true
} finally {
    if (Test-Path -LiteralPath $workRoot) { Remove-Item -LiteralPath $workRoot -Recurse -Force }
    if (-not $exportCommitted -and $null -ne $extractionRoot -and (Test-Path -LiteralPath $extractionRoot)) {
        Remove-Item -LiteralPath $extractionRoot -Recurse -Force
    }
}
