[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$BaseFixtureRoot,

    [Parameter(Mandatory = $true)]
    [string]$GeneratorCheckout,

    [Parameter(Mandatory = $true)]
    [string]$Destination,

    [Parameter(Mandatory = $true)]
    [string]$ProvenancePath,

    [Parameter(Mandatory = $true)]
    [string]$ExpectedRelease,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-fA-F]{64}$')]
    [string]$BaseManifestSha256,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-f]{40}$')]
    [string]$GeneratorCommit,

    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 1000000)]
    [int]$VariantCount,

    [Parameter(Mandatory = $true)]
    [ValidateRange(1, 1000000)]
    [int]$SourceMaxEdge,

    [Parameter(Mandatory = $true)]
    [string]$PythonPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$profileName = 'synthetic-large-library'
$derivedReleaseSuffix = '-distinct-artwork-diagnostic'
$pathComparison = if ($env:OS -eq 'Windows_NT') {
    [StringComparison]::OrdinalIgnoreCase
} else {
    [StringComparison]::Ordinal
}

function Get-NormalizedPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    $fullPath = [IO.Path]::GetFullPath($Path)
    $pathRoot = [IO.Path]::GetPathRoot($fullPath)
    if ($fullPath.Equals($pathRoot, $pathComparison)) {
        return $fullPath
    }
    return $fullPath.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
}

function Resolve-AbsoluteDirectory {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [string]$Label
    )

    if (-not [IO.Path]::IsPathRooted($Path)) {
        throw "$Label must be an absolute path."
    }
    $resolved = Resolve-Path -LiteralPath $Path -ErrorAction Stop
    if (-not (Test-Path -LiteralPath $resolved.Path -PathType Container)) {
        throw "$Label must identify a directory."
    }
    return Get-NormalizedPath -Path $resolved.Path
}

function Test-PathInside {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Candidate,

        [Parameter(Mandatory = $true)]
        [string]$Root
    )

    if ($Candidate.Equals($Root, $pathComparison)) {
        return $true
    }
    $prefix = $Root + [IO.Path]::DirectorySeparatorChar
    return $Candidate.StartsWith($prefix, $pathComparison)
}

function Get-FileSha256 {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )

    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Convert-HexToBytes {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Hex
    )

    $bytes = New-Object byte[] ($Hex.Length / 2)
    for ($index = 0; $index -lt $bytes.Length; $index += 1) {
        $bytes[$index] = [Convert]::ToByte($Hex.Substring($index * 2, 2), 16)
    }
    return $bytes
}

function Get-LogicalTreeSha256 {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Root
    )

    $relativePaths = [string[]]@(
        Get-ChildItem -LiteralPath $Root -Recurse -File | ForEach-Object {
            $relative = $_.FullName.Substring($Root.Length).TrimStart(
                [IO.Path]::DirectorySeparatorChar,
                [IO.Path]::AltDirectorySeparatorChar
            ).Replace([IO.Path]::DirectorySeparatorChar, '/')
            if ($relative -ne 'manifest.json') {
                $relative
            }
        }
    )
    [Array]::Sort($relativePaths, [StringComparer]::Ordinal)

    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        foreach ($relative in $relativePaths) {
            $relativeBytes = [Text.Encoding]::UTF8.GetBytes($relative + [char]0)
            [void]$sha256.TransformBlock(
                $relativeBytes,
                0,
                $relativeBytes.Length,
                $relativeBytes,
                0
            )
            $filePath = Join-Path $Root ($relative.Replace('/', [IO.Path]::DirectorySeparatorChar))
            $fileHashBytes = Convert-HexToBytes -Hex (Get-FileSha256 -Path $filePath)
            [void]$sha256.TransformBlock(
                $fileHashBytes,
                0,
                $fileHashBytes.Length,
                $fileHashBytes,
                0
            )
        }
        $empty = New-Object byte[] 0
        [void]$sha256.TransformFinalBlock($empty, 0, 0)
        return ([BitConverter]::ToString($sha256.Hash)).Replace('-', '').ToLowerInvariant()
    } finally {
        $sha256.Dispose()
    }
}

function Resolve-SafeRelativeFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Root,

        [Parameter(Mandatory = $true)]
        [string]$RelativePath,

        [Parameter(Mandatory = $true)]
        [string]$Label
    )

    if ([string]::IsNullOrWhiteSpace($RelativePath) -or [IO.Path]::IsPathRooted($RelativePath)) {
        throw "$Label must be a relative path."
    }
    $candidate = Get-NormalizedPath -Path (Join-Path $Root $RelativePath)
    if (-not (Test-PathInside -Candidate $candidate -Root $Root)) {
        throw "$Label escapes the derived fixture."
    }
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        throw "$Label is missing: $RelativePath"
    }
    return $candidate
}

function Get-ZipEntrySha256 {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ArchivePath,

        [Parameter(Mandatory = $true)]
        [string]$EntryPath
    )

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [IO.Compression.ZipFile]::OpenRead($ArchivePath)
    try {
        $normalizedEntryPath = $EntryPath.Replace('\', '/')
        $matches = @($archive.Entries | Where-Object { $_.FullName -eq $normalizedEntryPath })
        if ($matches.Count -ne 1) {
            throw "Derived archive must contain the database seed exactly once: $normalizedEntryPath"
        }
        $stream = $matches[0].Open()
        $sha256 = [Security.Cryptography.SHA256]::Create()
        try {
            return ([BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
        } finally {
            $sha256.Dispose()
            $stream.Dispose()
        }
    } finally {
        $archive.Dispose()
    }
}

if ([string]::IsNullOrWhiteSpace($ExpectedRelease)) {
    throw 'ExpectedRelease must not be empty.'
}
if (-not [IO.Path]::IsPathRooted($Destination)) {
    throw 'Destination must be an absolute path.'
}
if (-not [IO.Path]::IsPathRooted($ProvenancePath)) {
    throw 'ProvenancePath must be an absolute path.'
}

$resolvedBase = Resolve-AbsoluteDirectory -Path $BaseFixtureRoot -Label 'BaseFixtureRoot'
$resolvedGenerator = Resolve-AbsoluteDirectory -Path $GeneratorCheckout -Label 'GeneratorCheckout'
$resolvedDestination = Get-NormalizedPath -Path $Destination
$resolvedProvenance = Get-NormalizedPath -Path $ProvenancePath

if ((Test-PathInside -Candidate $resolvedDestination -Root $resolvedBase) -or
    (Test-PathInside -Candidate $resolvedDestination -Root $resolvedGenerator)) {
    throw 'Unsafe destination: derivative must be outside the verified base fixture and pinned generator checkout.'
}
if ((Test-PathInside -Candidate $resolvedProvenance -Root $resolvedBase) -or
    (Test-PathInside -Candidate $resolvedProvenance -Root $resolvedGenerator) -or
    (Test-PathInside -Candidate $resolvedProvenance -Root $resolvedDestination)) {
    throw 'Unsafe provenance path: provenance must be outside the base fixture, generator checkout, and derivative.'
}
if (Test-Path -LiteralPath $resolvedDestination) {
    if (-not (Test-Path -LiteralPath $resolvedDestination -PathType Container)) {
        throw 'Artwork-diversity destination must be an empty directory or an absent path.'
    }
    if (@(Get-ChildItem -LiteralPath $resolvedDestination -Force).Count -ne 0) {
        throw 'Artwork-diversity destination must be empty.'
    }
}
if (Test-Path -LiteralPath $resolvedProvenance) {
    throw 'Artwork-diversity provenance path must not already exist.'
}

$baseManifestPath = Join-Path $resolvedBase 'manifest.json'
if (-not (Test-Path -LiteralPath $baseManifestPath -PathType Leaf)) {
    throw 'Verified base fixture manifest.json is missing.'
}
$actualBaseManifestSha256 = Get-FileSha256 -Path $baseManifestPath
if ($actualBaseManifestSha256 -ne $BaseManifestSha256.ToLowerInvariant()) {
    throw "Base manifest SHA-256 mismatch: expected $BaseManifestSha256, found $actualBaseManifestSha256."
}
$baseManifest = Get-Content -Raw -LiteralPath $baseManifestPath | ConvertFrom-Json
if ([string]$baseManifest.release -ne $ExpectedRelease) {
    throw "Base fixture release mismatch: expected $ExpectedRelease, found $($baseManifest.release)."
}
$baseProfileProperty = $baseManifest.profiles.PSObject.Properties[$profileName]
if ($null -eq $baseProfileProperty) {
    throw "Base fixture manifest is missing profile $profileName."
}

$headOutput = @(& git -C $resolvedGenerator rev-parse HEAD 2>&1)
if ($LASTEXITCODE -ne 0) {
    throw "Unable to resolve generator checkout HEAD: $($headOutput -join [Environment]::NewLine)"
}
$generatorHead = ([string]($headOutput -join '')).Trim().ToLowerInvariant()
if ($generatorHead -ne $GeneratorCommit) {
    throw "Generator checkout HEAD mismatch: expected $GeneratorCommit, found $generatorHead."
}

if (Test-Path -LiteralPath $resolvedDestination) {
    Remove-Item -LiteralPath $resolvedDestination
}

Push-Location -LiteralPath $resolvedGenerator
try {
    & $PythonPath -m generators.artwork_diversity `
        --source $resolvedBase `
        --destination $resolvedDestination `
        --variant-count $VariantCount `
        --source-max-edge $SourceMaxEdge
    $generatorExitCode = $LASTEXITCODE
} finally {
    Pop-Location
}
if ($generatorExitCode -ne 0) {
    throw "Artwork-diversity generator failed with exit code $generatorExitCode."
}

$derivedManifestPath = Join-Path $resolvedDestination 'manifest.json'
if (-not (Test-Path -LiteralPath $derivedManifestPath -PathType Leaf)) {
    throw 'Derived manifest.json is missing.'
}
$derivedManifest = Get-Content -Raw -LiteralPath $derivedManifestPath | ConvertFrom-Json
$expectedDerivedRelease = $ExpectedRelease + $derivedReleaseSuffix
if ([string]$derivedManifest.release -ne $expectedDerivedRelease) {
    throw "Derived release mismatch: expected $expectedDerivedRelease, found $($derivedManifest.release)."
}
$profileProperty = $derivedManifest.profiles.PSObject.Properties[$profileName]
if ($null -eq $profileProperty) {
    throw "Derived manifest is missing profile $profileName."
}
$profile = $profileProperty.Value
$artworkDiversity = $profile.namedScenarioAssertions.artworkDiversity
if ($null -eq $artworkDiversity) {
    throw 'Derived manifest is missing artwork-diversity assertions.'
}

$variants = @($artworkDiversity.variants)
if ($variants.Count -ne $VariantCount -or [int]$artworkDiversity.uniquePixelCount -ne $VariantCount) {
    throw "Derived artwork variant count mismatch: expected $VariantCount, found $($variants.Count)."
}
if ([int]$artworkDiversity.sourceMaxEdge -ne $SourceMaxEdge) {
    throw "Derived source maximum edge mismatch: expected $SourceMaxEdge, found $($artworkDiversity.sourceMaxEdge)."
}

$pixelHashes = @($variants | ForEach-Object { [string]$_.pixelSha256 })
$projectionHashes = @($variants | ForEach-Object { [string]$_.thumbnail480PixelSha256 })
if (@($pixelHashes | Where-Object { $_ -notmatch '^[0-9a-fA-F]{64}$' }).Count -ne 0 -or
    @($pixelHashes | Sort-Object -Unique).Count -ne $VariantCount) {
    throw "Derived fixture must contain $VariantCount distinct decoded pixel hashes."
}
if (@($projectionHashes | Where-Object { $_ -notmatch '^[0-9a-fA-F]{64}$' }).Count -ne 0 -or
    @($projectionHashes | Sort-Object -Unique).Count -ne $VariantCount) {
    throw "Derived fixture must contain $VariantCount distinct 480-pixel projection hashes."
}
foreach ($variant in $variants) {
    $dimensions = @($variant.dimensions)
    if ($dimensions.Count -ne 2 -or
        [int]$dimensions[0] -lt 1 -or
        [int]$dimensions[1] -lt 1 -or
        [int]$dimensions[0] -gt $SourceMaxEdge -or
        [int]$dimensions[1] -gt $SourceMaxEdge) {
        throw 'Derived artwork variant dimensions violate the source maximum edge.'
    }
    [void](Resolve-SafeRelativeFile `
        -Root $resolvedDestination `
        -RelativePath ([string]$variant.path) `
        -Label 'Derived artwork variant')
}

$databaseSeedRelative = [string]$profile.databaseSeed
$databaseSeedPath = Resolve-SafeRelativeFile `
    -Root $resolvedDestination `
    -RelativePath $databaseSeedRelative `
    -Label 'Derived database seed'
$databaseSeedSha256 = Get-FileSha256 -Path $databaseSeedPath

$archiveName = [string]$profile.archive
if ([string]::IsNullOrWhiteSpace($archiveName) -or
    [IO.Path]::IsPathRooted($archiveName) -or
    [IO.Path]::GetFileName($archiveName) -ne $archiveName) {
    throw 'Derived archive must be a safe filename.'
}
$archivePath = Join-Path (Split-Path -Parent $resolvedDestination) $archiveName
if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) {
    throw "Derived archive is missing: $archiveName"
}
$archiveSha256 = Get-FileSha256 -Path $archivePath
if ($archiveSha256 -ne ([string]$profile.sha256).ToLowerInvariant()) {
    throw "Derived archive SHA-256 mismatch: expected $($profile.sha256), found $archiveSha256."
}
$archivedSeedSha256 = Get-ZipEntrySha256 `
    -ArchivePath $archivePath `
    -EntryPath $databaseSeedRelative
if ($archivedSeedSha256 -ne $databaseSeedSha256) {
    throw "Derived database seed SHA-256 mismatch between fixture and archive."
}

$logicalTreeSha256 = Get-LogicalTreeSha256 -Root $resolvedDestination
if ($logicalTreeSha256 -ne ([string]$profile.logicalSha256).ToLowerInvariant()) {
    throw "Derived logical tree SHA-256 mismatch: expected $($profile.logicalSha256), found $logicalTreeSha256."
}

$derivedManifestSha256 = Get-FileSha256 -Path $derivedManifestPath
$provenance = [ordered]@{
    schemaVersion = 1
    profile = $profileName
    base = [ordered]@{
        release = $ExpectedRelease
        manifestSha256 = $actualBaseManifestSha256
    }
    generator = [ordered]@{
        commit = $generatorHead
    }
    derivative = [ordered]@{
        release = $expectedDerivedRelease
        manifestSha256 = $derivedManifestSha256
        logicalSha256 = $logicalTreeSha256
        archive = [ordered]@{
            path = $archiveName
            sha256 = $archiveSha256
        }
        databaseSeed = [ordered]@{
            path = $databaseSeedRelative.Replace('\', '/')
            sha256 = $databaseSeedSha256
        }
    }
    diversity = [ordered]@{
        variantCount = $VariantCount
        sourceMaxEdge = $SourceMaxEdge
        distinctDecodedPixelHashes = @($pixelHashes | Sort-Object -Unique).Count
        distinctThumbnail480PixelHashes = @($projectionHashes | Sort-Object -Unique).Count
    }
}

$provenanceDirectory = Split-Path -Parent $resolvedProvenance
if ([string]::IsNullOrWhiteSpace($provenanceDirectory)) {
    throw 'ProvenancePath must have a parent directory.'
}
New-Item -ItemType Directory -Path $provenanceDirectory -Force | Out-Null
$temporaryProvenance = Join-Path $provenanceDirectory (
    ([IO.Path]::GetFileName($resolvedProvenance)) + '.tmp-' + [Guid]::NewGuid().ToString('N')
)
try {
    $provenanceJson = $provenance | ConvertTo-Json -Depth 8
    $utf8WithoutBom = New-Object Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($temporaryProvenance, $provenanceJson, $utf8WithoutBom)
    Move-Item -LiteralPath $temporaryProvenance -Destination $resolvedProvenance
} finally {
    if (Test-Path -LiteralPath $temporaryProvenance) {
        Remove-Item -LiteralPath $temporaryProvenance -Force
    }
}

Write-Output $resolvedProvenance
