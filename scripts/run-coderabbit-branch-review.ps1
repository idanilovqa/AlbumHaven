param(
    [string]$RepoRoot = ".",
    [string]$BaseRef = "origin/main",
    [string]$HeadRef = "HEAD",
    [int]$PrNumber = 0
)

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false

function Invoke-GitCapture {
    param(
        [string[]]$Arguments
    )

    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = "git"
    $startInfo.Arguments = [string]::Join(" ", ($Arguments | ForEach-Object {
        '"' + ($_.Replace('"', '\"')) + '"'
    }))
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.UseShellExecute = $false

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    [void]$process.Start()
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    [System.Threading.Tasks.Task]::WaitAll(@($stdoutTask, $stderrTask))
    $stdout = $stdoutTask.Result
    $stderr = $stderrTask.Result

    $output = @()
    if ($stdout) {
        $output += $stdout -split "(`r`n|`n|`r)"
    }
    if ($stderr) {
        $output += $stderr -split "(`r`n|`n|`r)"
    }

    return [pscustomobject]@{
        ExitCode = $process.ExitCode
        Output = @($output | Where-Object { $_ -ne "" })
    }
}

function Invoke-CommandCapture {
    param(
        [string]$FileName,
        [string[]]$Arguments
    )

    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $FileName
    $startInfo.Arguments = [string]::Join(" ", ($Arguments | ForEach-Object {
        '"' + ($_.Replace('"', '\"')) + '"'
    }))
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.UseShellExecute = $false

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo
    [void]$process.Start()
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    $process.WaitForExit()
    [System.Threading.Tasks.Task]::WaitAll(@($stdoutTask, $stderrTask))
    $stdout = $stdoutTask.Result
    $stderr = $stderrTask.Result

    return [pscustomobject]@{
        ExitCode = $process.ExitCode
        Stdout = $stdout
        Stderr = $stderr
        Output = @(
            @($stdout -split "(`r`n|`n|`r)") +
            @($stderr -split "(`r`n|`n|`r)") |
                Where-Object { $_ -ne "" }
        )
    }
}

function Get-BranchChangedFiles {
    param(
        [string]$BaseRefValue,
        [string]$HeadRefValue
    )

    $primaryDiff = Invoke-GitCapture -Arguments @("diff", "--name-only", "$BaseRefValue...$HeadRefValue")
    if ($primaryDiff.ExitCode -eq 0) {
        return @(
            $primaryDiff.Output |
                ForEach-Object { "$_".Trim() } |
                Where-Object { $_ } |
                Sort-Object -Unique
        )
    }

    $fallbackDiff = Invoke-GitCapture -Arguments @("diff", "--name-only", "$BaseRefValue..$HeadRefValue")
    if ($fallbackDiff.ExitCode -ne 0) {
        $joinedPrimary = ($primaryDiff.Output -join [Environment]::NewLine).Trim()
        $joinedFallback = ($fallbackDiff.Output -join [Environment]::NewLine).Trim()
        throw "Could not derive branch diff.`nPrimary: git diff --name-only $BaseRefValue...$HeadRefValue`n$joinedPrimary`nFallback: git diff --name-only $BaseRefValue..$HeadRefValue`n$joinedFallback"
    }

    return @(
        $fallbackDiff.Output |
            ForEach-Object { "$_".Trim() } |
            Where-Object { $_ } |
            Sort-Object -Unique
    )
}

function Get-CurrentBranchName {
    $branchResult = Invoke-GitCapture -Arguments @("rev-parse", "--abbrev-ref", "HEAD")
    if ($branchResult.ExitCode -ne 0) {
        throw "Could not determine the current branch name."
    }

    $branchName = ($branchResult.Output | Select-Object -First 1).Trim()
    if ([string]::IsNullOrWhiteSpace($branchName) -or $branchName -eq "HEAD") {
        throw "The current checkout is detached. Switch to a branch before running the GitHub PR CodeRabbit wrapper."
    }

    return $branchName
}

$resolvedRepoRoot = [System.IO.Path]::GetFullPath($RepoRoot)
if (-not (Test-Path -LiteralPath $resolvedRepoRoot -PathType Container)) {
    throw "RepoRoot does not exist: $resolvedRepoRoot"
}

Push-Location $resolvedRepoRoot
try {
    $preflightJson = powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-coderabbit-launch.ps1
    $preflight = $preflightJson | ConvertFrom-Json

    if (-not $preflight.ready -or $preflight.status -ne "ready" -or $preflight.launcherKind -ne "host_gh") {
        throw "GitHub PR review preflight is not ready. Run .\scripts\test-coderabbit-launch.ps1 and fix host GitHub CLI auth before review. Current status=$($preflight.status) launcherKind=$($preflight.launcherKind) account=$($preflight.account) activeAccount=$($preflight.activeAccount)"
    }

    $changedFiles = @(Get-BranchChangedFiles -BaseRefValue $BaseRef -HeadRefValue $HeadRef)
    if ($changedFiles.Count -eq 0) {
        throw "The authoritative branch diff is empty for $BaseRef...$HeadRef. Do not trigger GitHub PR CodeRabbit review for an empty branch diff."
    }

    $branchName = Get-CurrentBranchName
    $prLookupArgs = if ($PrNumber -gt 0) {
        @("pr", "view", "$PrNumber", "--json", "number,url,title")
    }
    else {
        @("pr", "view", "--head", $branchName, "--json", "number,url,title")
    }

    $prLookup = Invoke-CommandCapture -FileName "gh" -Arguments $prLookupArgs
    if ($prLookup.ExitCode -ne 0) {
        $lookupMessage = ($prLookup.Output -join [Environment]::NewLine).Trim()
        throw "Could not resolve the GitHub PR for branch '$branchName'. Create or identify the PR before running the GitHub PR CodeRabbit wrapper.`n$lookupMessage"
    }

    $pr = $prLookup.Stdout | ConvertFrom-Json
    $commentResult = Invoke-CommandCapture -FileName "gh" -Arguments @("pr", "comment", "$($pr.number)", "--body", "@coderabbitai review")
    if ($commentResult.ExitCode -ne 0) {
        $commentMessage = ($commentResult.Output -join [Environment]::NewLine).Trim()
        throw "Failed to trigger CodeRabbit review on PR #$($pr.number).`n$commentMessage"
    }

    [ordered]@{
        status = "review_triggered"
        repoRoot = $resolvedRepoRoot
        branch = $branchName
        baseRef = $BaseRef
        headRef = $HeadRef
        changedFileCount = $changedFiles.Count
        prNumber = $pr.number
        prTitle = $pr.title
        prUrl = $pr.url
        triggerComment = "@coderabbitai review"
        pollCommand = "gh pr view $($pr.number) --json reviews,comments,statusCheckRollup"
    } | ConvertTo-Json -Depth 6
}
finally {
    Pop-Location
}
