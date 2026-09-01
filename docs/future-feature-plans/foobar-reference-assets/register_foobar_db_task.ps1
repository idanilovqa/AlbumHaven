[CmdletBinding()]
param(
    [string]$TaskName = 'Foobar DB Backup',
    [Parameter(Mandatory = $true)][string]$BackupScriptPath,
    [Parameter(Mandatory = $true)][string]$FoobarRoot,
    [Parameter(Mandatory = $true)][string]$DestinationRoot,
    [string]$StartTime = '03:00',
    [switch]$ReplaceExisting
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$scriptPath = [IO.Path]::GetFullPath($BackupScriptPath)
if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
    throw "Backup script not found: $scriptPath"
}
$runTime = [DateTime]::ParseExact($StartTime, 'HH:mm', [Globalization.CultureInfo]::InvariantCulture)
$powerShellExe = (Get-Command powershell.exe -ErrorAction Stop).Source
$existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existingTask -and -not $ReplaceExisting) {
    throw "Scheduled task already exists: $TaskName. Pass -ReplaceExisting to replace it."
}

function Quote-Argument([string]$Value) {
    if ($Value.Contains('"')) { throw 'Task arguments cannot contain double quotes.' }
    return '"' + $Value + '"'
}

$arguments = @(
    '-NoProfile',
    '-File', (Quote-Argument $scriptPath),
    '-FoobarRoot', (Quote-Argument ([IO.Path]::GetFullPath($FoobarRoot))),
    '-DestinationRoot', (Quote-Argument ([IO.Path]::GetFullPath($DestinationRoot)))
) -join ' '

$action = New-ScheduledTaskAction -Execute $powerShellExe -Argument $arguments
$trigger = New-ScheduledTaskTrigger -Daily -At $runTime
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2)
$registerArguments = @{
    TaskName = $TaskName
    Action = $action
    Trigger = $trigger
    Settings = $settings
    Description = 'Creates a timestamped copy of selected Foobar2000 portable state.'
}
if ($ReplaceExisting) { $registerArguments.Force = $true }
Register-ScheduledTask @registerArguments | Out-Null

Write-Host "Registered scheduled task '$TaskName' for $StartTime"
