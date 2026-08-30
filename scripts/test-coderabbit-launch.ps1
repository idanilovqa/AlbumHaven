param(
    [string]$Command = "gh"
)

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false

function Resolve-CommandPath {
    param(
        [string]$CommandName
    )

    if ([System.IO.Path]::IsPathRooted($CommandName) -and (Test-Path -LiteralPath $CommandName)) {
        return [System.IO.Path]::GetFullPath($CommandName)
    }

    $resolved = Get-Command -Name $CommandName -ErrorAction SilentlyContinue
    if ($resolved -and -not [string]::IsNullOrWhiteSpace($resolved.Source)) {
        return $resolved.Source
    }

    return ""
}

function ConvertTo-NormalizedOutput {
    param(
        [string]$Text
    )

    if ($null -eq $Text) {
        return ""
    }

    return ($Text -replace [char]0, "").Trim()
}

function Build-Result {
    param(
        [string]$Status,
        [bool]$Ready,
        [string]$ResolvedCommandPath,
        [string]$LauncherKind,
        [string]$Notes,
        [int]$AuthStatusExitCode,
        [string]$Account,
        [bool]$ActiveAccount,
        [string[]]$TokenScopes,
        [string]$AuthStdout,
        [string]$AuthStderr
    )

    return [ordered]@{
        status = $Status
        ready = $Ready
        resolvedCommandPath = $ResolvedCommandPath
        launcherKind = $LauncherKind
        notes = $Notes
        authStatusExitCode = $AuthStatusExitCode
        account = $Account
        activeAccount = $ActiveAccount
        tokenScopes = @($TokenScopes)
        recommendedPreflightCommand = 'powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-coderabbit-launch.ps1'
        recommendedCommonReviewCommand = 'powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-coderabbit-branch-review.ps1'
        authStdout = $AuthStdout
        authStderr = $AuthStderr
    }
}

$resolvedCommandPath = Resolve-CommandPath -CommandName $Command
if ([string]::IsNullOrWhiteSpace($resolvedCommandPath)) {
    Build-Result `
        -Status "command_not_found" `
        -Ready $false `
        -ResolvedCommandPath "" `
        -LauncherKind "missing" `
        -Notes "Could not resolve the GitHub CLI command. Install or expose 'gh' before running the PR review wrapper." `
        -AuthStatusExitCode -1 `
        -Account "" `
        -ActiveAccount $false `
        -TokenScopes @() `
        -AuthStdout "" `
        -AuthStderr "" | ConvertTo-Json -Depth 6
    exit 0
}

$authOutput = & $resolvedCommandPath auth status 2>&1
$authExitCode = $LASTEXITCODE
$authText = [string]::Join("`n", @($authOutput | ForEach-Object { $_.ToString() }))
$normalizedAuthStdout = if ($authExitCode -eq 0) { ConvertTo-NormalizedOutput -Text $authText } else { "" }
$normalizedAuthStderr = if ($authExitCode -eq 0) { "" } else { ConvertTo-NormalizedOutput -Text $authText }

if ($authExitCode -ne 0) {
    Build-Result `
        -Status "auth_unavailable" `
        -Ready $false `
        -ResolvedCommandPath $resolvedCommandPath `
        -LauncherKind "host_gh" `
        -Notes "The GitHub CLI auth check failed. Fix 'gh auth status' on the host before running the PR review wrapper." `
        -AuthStatusExitCode $authExitCode `
        -Account "" `
        -ActiveAccount $false `
        -TokenScopes @() `
        -AuthStdout $normalizedAuthStdout `
        -AuthStderr $normalizedAuthStderr | ConvertTo-Json -Depth 6
    exit 0
}

$account = ""
$activeAccount = $false
$tokenScopes = @()
foreach ($line in @($normalizedAuthStdout -split "(`r`n|`n|`r)")) {
    $trimmedLine = $line.Trim()
    if ($trimmedLine -match "Logged in to github\.com account ([^\s]+)") {
        $account = $matches[1]
        continue
    }
    if ($trimmedLine -match "Active account:\s*(true|false)") {
        $activeAccount = $matches[1].ToLowerInvariant() -eq "true"
        continue
    }
    if ($trimmedLine -match "Token scopes:\s*(.+)$") {
        $tokenScopes = @(
            $matches[1] -split ",\s*" |
                ForEach-Object { $_.Trim().Trim("'") } |
                Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
        )
    }
}

$ready = -not [string]::IsNullOrWhiteSpace($account) -and $activeAccount
$status = if ($ready) { "ready" } else { "auth_incomplete" }
$notes = if ($ready) {
    "The host GitHub CLI is authenticated and ready for the GitHub PR CodeRabbit workflow."
}
else {
    "The GitHub CLI is reachable, but 'gh auth status' does not show an active authenticated account. Reconnect the host GitHub CLI before running the PR review wrapper."
}

Build-Result `
    -Status $status `
    -Ready $ready `
    -ResolvedCommandPath $resolvedCommandPath `
    -LauncherKind "host_gh" `
    -Notes $notes `
    -AuthStatusExitCode $authExitCode `
    -Account $account `
    -ActiveAccount $activeAccount `
    -TokenScopes $tokenScopes `
    -AuthStdout $normalizedAuthStdout `
    -AuthStderr $normalizedAuthStderr | ConvertTo-Json -Depth 6
