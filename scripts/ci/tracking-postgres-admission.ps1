[CmdletBinding()]
param(
    [ValidateSet('Inspect', 'SealReceipt')][string]$Mode,
    [ValidateSet('tracking-rollback', 'historical-0153')][string]$Cohort
)
$ErrorActionPreference = 'Stop'
$script:TrackingRepository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$script:TrackingPowerShell = 'C:\Program Files\PowerShell\7\pwsh.exe'
$script:TrackingInventory = 'd15a9dd4a4b942b0c6ead1494505b6508a711ac630c99bd5ce24eb9ef03953f0'

# Only handle opening, identity and final-path inspection need native APIs.
if (-not ('TrackingFileHandle' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class TrackingFileHandle {
    [StructLayout(LayoutKind.Sequential)] public struct Info {
        public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh,
            WriteLow, WriteHigh, Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafeFileHandle CreateFileW(string path, uint access, uint share,
        IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GetFileInformationByHandle(SafeFileHandle handle, out Info info);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern uint GetFinalPathNameByHandleW(SafeFileHandle handle, StringBuilder path, uint count, uint flags);
    public static SafeFileHandle Open(string path, bool directory, bool write) {
        uint access = directory ? 0x80u : (write ? 0xC0000000u : 0x80000000u);
        var h = CreateFileW(path, access, directory ? 3u : 1u, IntPtr.Zero, 3,
            0x00200000u | (directory ? 0x02000000u : 0), IntPtr.Zero);
        if (h.IsInvalid) { h.Dispose(); throw new IOException("Protected file open failed."); }
        return h;
    }
    public static Info Metadata(SafeFileHandle h) {
        Info info;
        if (!GetFileInformationByHandle(h, out info)) throw new IOException("Protected file identity unavailable.");
        return info;
    }
    public static string FinalPath(SafeFileHandle h) {
        var b = new StringBuilder(32768);
        uint n = GetFinalPathNameByHandleW(h, b, (uint)b.Capacity, 0);
        if (n == 0 || n >= b.Capacity) throw new IOException("Protected final path unavailable.");
        string p = b.ToString();
        if (!p.StartsWith(@"\\?\") || p.StartsWith(@"\\?\UNC\")) throw new IOException("Nonlocal protected path.");
        return p.Substring(4);
    }
}
'@
}

function Assert-TrackingKeys($Value, [string[]]$Keys) {
    if ($Value -isnot [Collections.IDictionary] -or $Value.Count -ne $Keys.Count) { throw 'Invalid tracking object schema.' }
    foreach ($key in $Keys) { if (-not $Value.Contains($key)) { throw 'Invalid tracking object keys.' } }
}

function Assert-TrackingInteger($Value, [long]$Minimum, [long]$Maximum = [long]::MaxValue) {
    if (($Value -isnot [int] -and $Value -isnot [long]) -or $Value -lt $Minimum -or $Value -gt $Maximum) { throw 'Invalid tracking integer.' }
}

function Assert-TrackingString($Value) {
    if ($Value -isnot [string] -or [string]::IsNullOrEmpty($Value) -or $Value -match '[\r\n\x00]') { throw 'Invalid tracking string.' }
}

function Get-TrackingContext([string]$Cohort) {
    if (-not $IsWindows -or $env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_OS -cne 'Windows' -or
        $env:GITHUB_REPOSITORY -cne 'idanilovqa/AlbumHaven' -or $env:GITHUB_JOB -cne 'test_python' -or
        $env:GITHUB_EVENT_NAME -cne 'pull_request') { throw 'Tracking requires the hosted same-repository Windows Python job.' }
    if ($Cohort -cnotin @('tracking-rollback', 'historical-0153')) { throw 'Invalid tracking cohort.' }
    foreach ($value in @($env:GITHUB_RUN_ID, $env:GITHUB_RUN_ATTEMPT)) {
        if ($value -cnotmatch '^[1-9][0-9]{0,19}$') { throw 'Invalid tracking run identity.' }
    }
    if ([Environment]::ProcessPath -ine $script:TrackingPowerShell) { throw 'Untrusted tracking PowerShell executable.' }
    if ([IO.Path]::GetFullPath($env:GITHUB_WORKSPACE) -ine $script:TrackingRepository) { throw 'Tracking checkout root mismatch.' }
    $checkout = (& git -C $script:TrackingRepository rev-parse HEAD 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $checkout -cnotmatch '^[0-9a-f]{40}$' -or $checkout -cne $env:GITHUB_SHA) { throw 'Tracking checkout SHA mismatch.' }
    $event = [IO.File]::ReadAllText($env:GITHUB_EVENT_PATH) | ConvertFrom-Json -AsHashtable
    if ($event.pull_request.head.repo.full_name -cne $env:GITHUB_REPOSITORY -or
        $event.pull_request.base.repo.full_name -cne $env:GITHUB_REPOSITORY) { throw 'Tracking requires a same-repository pull request.' }
    foreach ($sha in @($event.pull_request.head.sha, $event.pull_request.base.sha)) {
        if ($sha -cnotmatch '^[0-9a-f]{40}$') { throw 'Invalid tracking event SHA.' }
    }
    $temp = [IO.Path]::GetFullPath($env:RUNNER_TEMP)
    if ($temp -notmatch '^[A-Za-z]:\\' -or $temp -match '[\r\n\x00]' -or $temp.TrimEnd('\') -eq [IO.Path]::GetPathRoot($temp).TrimEnd('\')) { throw 'Invalid runner temporary directory.' }
    $root = Join-Path $temp "album-haven-tracking-$Cohort-$($env:GITHUB_RUN_ID)-$($env:GITHUB_RUN_ATTEMPT)"
    $prefix = if ($Cohort -ceq 'tracking-rollback') { 'ALBUM_HAVEN_TRACKING_MIGRATION_' } else { 'ALBUM_HAVEN_TRACKING_HISTORICAL_' }
    $suffix = if ($Cohort -ceq 'tracking-rollback') { "tr169_$($env:GITHUB_RUN_ID)_$($env:GITHUB_RUN_ATTEMPT)" } else { "hist153_$($env:GITHUB_RUN_ID)_$($env:GITHUB_RUN_ATTEMPT)" }
    return [ordered]@{
        repository=$env:GITHUB_REPOSITORY; workflow=$env:GITHUB_WORKFLOW; job=$env:GITHUB_JOB
        run_id=$env:GITHUB_RUN_ID; run_attempt=$env:GITHUB_RUN_ATTEMPT; github_sha=$env:GITHUB_SHA
        checkout_sha=$checkout; event_pr_head_sha=$event.pull_request.head.sha
        event_pr_base_sha=$event.pull_request.base.sha; event_pr_repository=$event.pull_request.head.repo.full_name
        runner_sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        root=$root; prefix=$prefix; suffix=$suffix; receipt_path=(Join-Path $root 'receipt.json')
        pgpass_path=(Join-Path $root 'pgpass.conf'); state_path=(Join-Path $root 'state.json')
    }
}

function Assert-TrackingAcl($Acl, [string]$Sid) {
    if (-not $Acl.AreAccessRulesProtected -or $Acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $Sid) { throw 'Tracking file owner or DACL protection mismatch.' }
    $allowed = @($Sid, 'S-1-5-18', 'S-1-5-32-544')
    $runnerAllowed = $false
    foreach ($rule in $Acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
        if ($rule.IsInherited -or $rule.IdentityReference.Value -cnotin $allowed -or $rule.AccessControlType -ne 'Allow') { throw 'Unexpected tracking file access rule.' }
        if ($rule.IdentityReference.Value -ceq $Sid -and ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl) { $runnerAllowed = $true }
    }
    if (-not $runnerAllowed) { throw 'Tracking runner file access is missing.' }
}

function New-TrackingSecurity([string]$Sid, [switch]$Directory) {
    $acl = if ($Directory) { [Security.AccessControl.DirectorySecurity]::new() } else { [Security.AccessControl.FileSecurity]::new() }
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner([Security.Principal.SecurityIdentifier]::new($Sid))
    foreach ($principal in @($Sid, 'S-1-5-18', 'S-1-5-32-544')) {
        $sidObject = [Security.Principal.SecurityIdentifier]::new($principal)
        $rule = [Security.AccessControl.FileSystemAccessRule]::new($sidObject, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow)
        $acl.AddAccessRule($rule)
    }
    return $acl
}

function Open-TrackingAncestors([string]$Path) {
    $handles = [Collections.Generic.List[IDisposable]]::new()
    try {
        $paths = [Collections.Generic.List[string]]::new()
        $directory = [IO.DirectoryInfo]::new([IO.Path]::GetDirectoryName($Path))
        while ($null -ne $directory) { $paths.Insert(0, $directory.FullName); $directory = $directory.Parent }
        foreach ($item in $paths) {
            $h = [TrackingFileHandle]::Open($item, $true, $false)
            $handles.Add($h)
            $info = [TrackingFileHandle]::Metadata($h)
            if (($info.Attributes -band 0x400) -ne 0 -or [TrackingFileHandle]::FinalPath($h).TrimEnd('\') -ine $item.TrimEnd('\')) { throw 'Tracking ancestor is a reparse point or substituted path.' }
        }
        return ,$handles
    } catch { foreach ($h in $handles) { $h.Dispose() }; throw }
}

function Open-TrackingFile([string]$Path, [string]$Sid, [switch]$Write) {
    $handle = [TrackingFileHandle]::Open($Path, $false, $Write.IsPresent)
    try {
        $info = [TrackingFileHandle]::Metadata($handle)
        if (($info.Attributes -band 0x410) -ne 0 -or $info.Links -ne 1 -or [TrackingFileHandle]::FinalPath($handle) -ine [IO.Path]::GetFullPath($Path)) { throw 'Tracking file is linked or substituted.' }
        $access = if ($Write) { [IO.FileAccess]::ReadWrite } else { [IO.FileAccess]::Read }
        $stream = [IO.FileStream]::new($handle, $access)
        try { Assert-TrackingAcl ([IO.FileSystemAclExtensions]::GetAccessControl($stream)) $Sid } catch { $stream.Dispose(); throw }
        return $stream
    } catch { $handle.Dispose(); throw }
}

function Get-TrackingFileIdentity([IO.FileStream]$Stream) {
    $i = [TrackingFileHandle]::Metadata($Stream.SafeFileHandle)
    return [ordered]@{
        volume_serial=([string]$i.Volume)
        file_id=([string](([uint64]$i.IndexHigh -shl 32) -bor $i.IndexLow))
        size=([long](([uint64]$i.SizeHigh -shl 32) -bor $i.SizeLow))
        last_write_filetime=([string](([uint64]$i.WriteHigh -shl 32) -bor $i.WriteLow))
    }
}

function Read-TrackingJson([IO.FileStream]$Stream) {
    if ($Stream.Length -gt 32768 -or $Stream.Length -lt 2) { throw 'Tracking JSON size is invalid.' }
    $reader = [IO.StreamReader]::new($Stream, [Text.UTF8Encoding]::new($false, $true), $false, 4096, $true)
    try {
        $raw = $reader.ReadToEnd()
        $document = [Text.Json.JsonDocument]::Parse($raw)
        try {
            # ConvertFrom-Json otherwise accepts duplicate keys. Check every object first.
            function Assert-UniqueJson($Element) {
                if ($Element.ValueKind -eq [Text.Json.JsonValueKind]::Object) {
                    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
                    foreach ($property in $Element.EnumerateObject()) {
                        if (-not $seen.Add($property.Name)) { throw 'Duplicate tracking JSON key.' }
                        Assert-UniqueJson $property.Value
                    }
                } elseif ($Element.ValueKind -eq [Text.Json.JsonValueKind]::Array) {
                    foreach ($child in $Element.EnumerateArray()) { Assert-UniqueJson $child }
                }
            }
            Assert-UniqueJson $document.RootElement
        } finally { $document.Dispose() }
        return ($raw | ConvertFrom-Json -AsHashtable)
    } finally { $reader.Dispose() }
}

function New-TrackingRoot([string]$Cohort) {
    $c = Get-TrackingContext $Cohort
    if (Test-Path -LiteralPath $c.root) { throw 'Tracking protected root already exists.' }
    $ancestors = Open-TrackingAncestors $c.root
    try { [IO.FileSystemAclExtensions]::Create([IO.DirectoryInfo]::new($c.root), (New-TrackingSecurity $c.runner_sid -Directory)) } finally { foreach ($h in $ancestors) { $h.Dispose() } }
    Assert-TrackingAcl (Get-Acl -LiteralPath $c.root) $c.runner_sid
}

function Write-TrackingFile([string]$Cohort, [string]$Leaf, [byte[]]$Bytes) {
    if ($Leaf -cnotin @('state.json', 'receipt.json', 'pgpass.conf')) { throw 'Invalid tracking leaf.' }
    $c = Get-TrackingContext $Cohort
    $path = Join-Path $c.root $Leaf
    $ancestors = Open-TrackingAncestors $path
    $stream = $null
    try {
        Assert-TrackingAcl (Get-Acl -LiteralPath $c.root) $c.runner_sid
        if (Test-Path -LiteralPath $path) {
            $stream = Open-TrackingFile $path $c.runner_sid -Write
            $stream.SetLength(0)
        } else {
            $stream = [IO.FileSystemAclExtensions]::Create([IO.FileInfo]::new($path), [IO.FileMode]::CreateNew,
                [Security.AccessControl.FileSystemRights]::FullControl, [IO.FileShare]::Read, 4096,
                [IO.FileOptions]::None, (New-TrackingSecurity $c.runner_sid))
        }
        $stream.Write($Bytes, 0, $Bytes.Length)
        $stream.Flush($true)
    } finally { if ($stream) { $stream.Dispose() }; foreach ($h in $ancestors) { $h.Dispose() } }
}

function Assert-TrackingIdentity($Identity, $Context) {
    foreach ($key in @('repository','workflow','job','run_id','run_attempt','github_sha','checkout_sha','event_pr_head_sha','event_pr_base_sha','event_pr_repository','runner_sid','root')) {
        if ($Identity[$key] -isnot [string] -or $Identity[$key] -cne $Context[$key]) { throw 'Tracking receipt identity mismatch.' }
    }
}

function Get-TrackingState([string]$Cohort) {
    $c = Get-TrackingContext $Cohort
    $ancestors = Open-TrackingAncestors $c.state_path
    $stream = $null
    try {
        Assert-TrackingAcl (Get-Acl -LiteralPath $c.root) $c.runner_sid
        $stream = Open-TrackingFile $c.state_path $c.runner_sid
        $state = Read-TrackingJson $stream
        Assert-TrackingKeys $state @('schema_version','identity','roles_status','database_status','roles','database')
        Assert-TrackingInteger $state.schema_version 2 2
        Assert-TrackingKeys $state.identity @('repository','workflow','job','run_id','run_attempt','github_sha','checkout_sha','event_pr_head_sha','event_pr_base_sha','event_pr_repository','runner_sid','root','host','port','server_version_num','server_start_epoch','server_system_identifier')
        Assert-TrackingIdentity $state.identity $c
        Assert-TrackingString $state.identity.host
        Assert-TrackingString $state.identity.server_system_identifier
        if ($state.identity.host -cne '127.0.0.1' -or $state.identity.server_system_identifier -cnotmatch '^[1-9][0-9]*$') { throw 'Invalid tracking state endpoint.' }
        Assert-TrackingInteger $state.identity.port 1024 65535
        Assert-TrackingInteger $state.identity.server_version_num 170000 179999
        Assert-TrackingInteger $state.identity.server_start_epoch 1
        Assert-TrackingString $state.roles_status
        Assert-TrackingString $state.database_status
        Assert-TrackingKeys $state.roles @('setup','app','readonly')
        foreach ($key in @('setup','app','readonly')) {
            Assert-TrackingKeys $state.roles[$key] @('name','oid')
            Assert-TrackingString $state.roles[$key].name
            if ($state.roles_status -ceq 'created') { Assert-TrackingInteger $state.roles[$key].oid 1 4294967295 }
            elseif ($null -ne $state.roles[$key].oid) { throw 'Unconfirmed tracking role has an OID.' }
        }
        Assert-TrackingKeys $state.database @('name','oid','owner')
        Assert-TrackingString $state.database.name
        Assert-TrackingString $state.database.owner
        if ($state.database_status -ceq 'created') { Assert-TrackingInteger $state.database.oid 1 4294967295 }
        elseif ($null -ne $state.database.oid) { throw 'Unconfirmed tracking database has an OID.' }
        if ($state.roles_status -cnotin @('pending','created') -or $state.database_status -cnotin @('pending','created')) { throw 'Invalid tracking creation state.' }
        return $state
    } finally { if ($stream) { $stream.Dispose() }; foreach ($h in $ancestors) { $h.Dispose() } }
}

function With-TrackingProtectedFiles([string]$Cohort, [scriptblock]$Body) {
    $c = Get-TrackingContext $Cohort
    $ancestors = Open-TrackingAncestors $c.receipt_path
    $receiptStream = $null; $passfileStream = $null
    try {
        Assert-TrackingAcl (Get-Acl -LiteralPath $c.root) $c.runner_sid
        $receiptStream = Open-TrackingFile $c.receipt_path $c.runner_sid
        $passfileStream = Open-TrackingFile $c.pgpass_path $c.runner_sid
        $receipt = Read-TrackingJson $receiptStream
        & $Body ([pscustomobject]@{ ReceiptStream=$receiptStream; PassfileStream=$passfileStream
            ReceiptPath=$c.receipt_path; PassfilePath=$c.pgpass_path; Receipt=$receipt
            PassfileIdentity=(Get-TrackingFileIdentity $passfileStream) })
    } finally {
        if ($passfileStream) { $passfileStream.Dispose() }; if ($receiptStream) { $receiptStream.Dispose() }
        foreach ($h in $ancestors) { $h.Dispose() }
    }
}

function Assert-TrackingReceipt($Receipt, $Context, $PassfileIdentity) {
    $keys = @('schema_version','mode','cohort','repository','workflow','job','run_id','run_attempt','github_sha','checkout_sha','event_pr_head_sha','event_pr_base_sha','event_pr_repository','runner_sid','root','receipt_path','pgpass_path','pgbin','ordinary_pgpass_path','powershell_path','powershell_sha256','inspector_path','inspector_sha256','baseline','migration_through','migration_count','inventory_sha256','host','port','configured_service','server_version_num','server_start_epoch','server_system_identifier','database','database_oid','database_owner','roles','urls','ordinary_databases','pgpass_identity')
    Assert-TrackingKeys $Receipt $keys
    $integerKeys = @('schema_version','migration_through','migration_count','port','server_version_num','server_start_epoch','database_oid')
    foreach ($key in $integerKeys) { Assert-TrackingInteger $Receipt[$key] 1 }
    foreach ($key in $keys) {
        if ($key -cnotin $integerKeys -and $key -cnotin @('roles','urls','ordinary_databases','pgpass_identity')) { Assert-TrackingString $Receipt[$key] }
    }
    Assert-TrackingInteger $Receipt.database_oid 1 4294967295
    if ($Receipt.server_system_identifier -cnotmatch '^[1-9][0-9]*$') { throw 'Invalid tracking server identifier.' }
    Assert-TrackingIdentity $Receipt $Context
    if ($Receipt.schema_version -ne 1 -or $Receipt.mode -cne 'windows-ci' -or $Receipt.cohort -cne $(if ($Context.prefix -ceq 'ALBUM_HAVEN_TRACKING_MIGRATION_') { 'tracking-rollback' } else { 'historical-0153' }) -or
        $Receipt.baseline -cne 'aad200d9' -or $Receipt.migration_through -ne 153 -or $Receipt.migration_count -ne 147 -or
        $Receipt.inventory_sha256 -cne $script:TrackingInventory -or $Receipt.host -cne '127.0.0.1' -or
        $Receipt.port -lt 1024 -or $Receipt.port -gt 65535 -or $Receipt.server_version_num -lt 170000 -or
        $Receipt.server_version_num -ge 180000 -or $Receipt.server_start_epoch -le 0 -or
        $Receipt.configured_service -cne 'postgresql-x64-17') { throw 'Invalid tracking receipt contract.' }
    foreach ($key in @('receipt_path','pgpass_path')) { if ($Receipt[$key] -cne $Context[$key]) { throw 'Tracking protected path mismatch.' } }
    if ($Receipt.pgbin -ine [IO.Path]::GetFullPath($env:PGBIN) -or $Receipt.pgbin -notmatch '(?i)\\17\\bin$' -or
        $Receipt.ordinary_pgpass_path -ine [IO.Path]::GetFullPath($env:PGPASSFILE)) { throw 'Tracking ordinary environment mismatch.' }
    $inspector = Join-Path $script:TrackingRepository 'scripts\ci\tracking-postgres-admission.ps1'
    if ($Receipt.powershell_path -cne $script:TrackingPowerShell -or $Receipt.inspector_path -ine $inspector -or
        $Receipt.powershell_sha256 -cne (Get-FileHash -LiteralPath $script:TrackingPowerShell -Algorithm SHA256).Hash.ToLowerInvariant() -or
        $Receipt.inspector_sha256 -cne (Get-FileHash -LiteralPath $inspector -Algorithm SHA256).Hash.ToLowerInvariant()) { throw 'Tracking inspector identity mismatch.' }
    Assert-TrackingKeys $Receipt.pgpass_identity @('volume_serial','file_id','size','last_write_filetime')
    Assert-TrackingInteger $Receipt.pgpass_identity.size 1 65536
    foreach ($key in @('volume_serial','file_id','last_write_filetime')) {
        Assert-TrackingString $Receipt.pgpass_identity[$key]
        if ($Receipt.pgpass_identity[$key] -cnotmatch '^[0-9]+$') { throw 'Invalid tracking file identity.' }
    }
    foreach ($key in $PassfileIdentity.Keys) { if ($Receipt.pgpass_identity[$key] -cne $PassfileIdentity[$key]) { throw 'Tracking passfile was substituted.' } }
    Assert-TrackingKeys $Receipt.roles @('setup','app','readonly')
    Assert-TrackingKeys $Receipt.urls @('setup','app','readonly')
    Assert-TrackingKeys $Receipt.ordinary_databases @('persistent','destructive')
    $database = "album_haven_ci_$($Context.suffix)"
    if ($Receipt.database -cne $database -or $Receipt.database_oid -le 0) { throw 'Tracking database mismatch.' }
    $portText = if ($Receipt.port -eq 5432) { '' } else { ":$($Receipt.port)" }
    foreach ($key in @('setup','app','readonly')) {
        Assert-TrackingKeys $Receipt.roles[$key] @('name','oid')
        Assert-TrackingString $Receipt.roles[$key].name
        Assert-TrackingInteger $Receipt.roles[$key].oid 1 4294967295
        Assert-TrackingString $Receipt.urls[$key]
        $stem = if ($key -ceq 'setup') { 'migrator' } else { $key }
        $role = "album_haven_${stem}_$($Context.suffix)"
        if ($Receipt.roles[$key].name -cne $role -or $Receipt.roles[$key].oid -le 0 -or
            $Receipt.urls[$key] -cne "postgresql://$role@127.0.0.1$portText/$database") { throw 'Tracking role or URL mismatch.' }
        $envKey = $Context.prefix + $(if ($key -ceq 'setup') { 'SETUP_URL' } else { $key.ToUpperInvariant() + '_URL' })
        if ([Environment]::GetEnvironmentVariable($envKey) -cne $Receipt.urls[$key]) { throw 'Tracking exported URL mismatch.' }
    }
    if (@($Receipt.roles.Values | ForEach-Object { $_.oid } | Sort-Object -Unique).Count -ne 3) { throw 'Tracking role OIDs must be distinct.' }
    Assert-TrackingString $Receipt.ordinary_databases.persistent
    Assert-TrackingString $Receipt.ordinary_databases.destructive
    $run = "$($Context.run_id)_$($Context.run_attempt)"
    foreach ($entry in @(@('persistent','py_contract','DATABASE_MIGRATOR_URL'), @('destructive','py','PYTEST_DESTRUCTIVE_SETUP_DATABASE_URL'))) {
        $db = "album_haven_ci_$($entry[1])_$run"
        $role = "album_haven_migrator_$($entry[1])_$run"
        if ($Receipt.ordinary_databases[$entry[0]] -cne $db -or [Environment]::GetEnvironmentVariable($entry[2]) -cne "postgresql://$role@127.0.0.1$portText/$db") { throw 'Tracking ordinary target mismatch.' }
    }
    $four = @($Receipt.ordinary_databases.persistent,$Receipt.ordinary_databases.destructive,"album_haven_ci_tr169_$run","album_haven_ci_hist153_$run")
    if (@($four | Sort-Object -Unique).Count -ne 4) { throw 'Tracking targets are not distinct.' }
    if ($Receipt.database_owner -cne $Receipt.roles.setup.name) { throw 'Tracking database owner mismatch.' }
    foreach ($entry in @(@('CI_RECEIPT','receipt_path'), @('PGPASSFILE','pgpass_path'))) {
        if ([Environment]::GetEnvironmentVariable($Context.prefix + $entry[0]) -ine $Context[$entry[1]]) { throw 'Tracking exported path mismatch.' }
    }
}

function Invoke-TrackingInspect([string]$Cohort) {
    foreach ($entry in [Environment]::GetEnvironmentVariables().GetEnumerator()) {
        $key = ([string]$entry.Key).ToUpperInvariant()
        if ($key.StartsWith('PG') -and $key -cnotin @('PGBIN','PGPASSFILE') -and -not ($key -ceq 'PGPASSWORD' -and [string]::IsNullOrEmpty([string]$entry.Value))) { throw 'Ambient PostgreSQL overrides are forbidden for tracking inspection.' }
    }
    $context = Get-TrackingContext $Cohort
    With-TrackingProtectedFiles $Cohort {
        param($files)
        Assert-TrackingReceipt $files.Receipt $context $files.PassfileIdentity
        $files.Receipt | ConvertTo-Json -Depth 8 -Compress
    }
}

function Seal-TrackingReceipt([string]$Cohort, $Receipt) {
    $context = Get-TrackingContext $Cohort
    $ancestors = Open-TrackingAncestors $context.pgpass_path
    $stream = $null
    try {
        $stream = Open-TrackingFile $context.pgpass_path $context.runner_sid
        $Receipt.pgpass_identity = Get-TrackingFileIdentity $stream
        Assert-TrackingReceipt $Receipt $context $Receipt.pgpass_identity
        Write-TrackingFile $Cohort 'receipt.json' ([Text.UTF8Encoding]::new($false).GetBytes(($Receipt | ConvertTo-Json -Depth 8 -Compress)))
    } finally { if ($stream) { $stream.Dispose() }; foreach ($h in $ancestors) { $h.Dispose() } }
}

function Assert-TrackingCleanupEvidence([string]$Cohort) {
    $context = Get-TrackingContext $Cohort
    $evidenceRoot = Join-Path $env:RUNNER_TEMP "album-haven-tracking-native-$($context.run_id)-$($context.run_attempt)"
    $path = Join-Path $evidenceRoot 'evidence\result.json'
    # This is nonsecret test evidence, not a credential file. A bounded read and
    # exact run binding are required even when the native test failed or stopped.
    $stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try { $result = Read-TrackingJson $stream } finally { $stream.Dispose() }
    Assert-TrackingCleanupPayload $result $context
}

function Assert-TrackingCleanupPayload($Result, $Context) {
    Assert-TrackingKeys $result @('schema_version','repository','run_id','run_attempt','github_sha','exit_code','results','native_windows','credential_output','unsafe_process_tree','cleanup_safe')
    Assert-TrackingInteger $result.schema_version 1 1
    Assert-TrackingInteger $result.exit_code -2147483648 2147483647
    foreach ($key in @('repository','run_id','run_attempt','github_sha')) {
        Assert-TrackingString $result[$key]
        if ($result[$key] -cne $context[$key]) { throw 'Native tracking cleanup evidence identity mismatch.' }
    }
    foreach ($key in @('native_windows','credential_output','unsafe_process_tree','cleanup_safe')) {
        if ($result[$key] -isnot [bool]) { throw 'Invalid native tracking cleanup evidence type.' }
    }
    if (-not $result.native_windows -or $result.credential_output -or
        $result.unsafe_process_tree -or -not $result.cleanup_safe) { throw 'Native tracking cleanup is quarantined; process retirement is not established.' }
    if ($result.results -isnot [array]) { throw 'Invalid native tracking case evidence.' }
    foreach ($case in $result.results) {
        Assert-TrackingKeys $case @('node','stage','outcome')
        foreach ($key in @('node','stage','outcome')) { Assert-TrackingString $case[$key] }
    }
}

function Remove-TrackingFiles([string]$Cohort) {
    $context = Get-TrackingContext $Cohort
    $null = Get-TrackingState $Cohort
    $children = @(Get-ChildItem -LiteralPath $context.root -Force)
    foreach ($child in $children) {
        if ($child.Name -cnotin @('state.json','receipt.json','pgpass.conf')) { throw 'Unexpected tracking cleanup child.' }
        $ancestors = Open-TrackingAncestors $child.FullName
        $stream = $null
        try { $stream = Open-TrackingFile $child.FullName $context.runner_sid }
        finally { if ($stream) { $stream.Dispose() }; foreach ($h in $ancestors) { $h.Dispose() } }
    }
    foreach ($child in $children) { [IO.File]::Delete($child.FullName) }
    [IO.Directory]::Delete($context.root, $false)
}

if ($MyInvocation.InvocationName -ne '.') {
    if (-not $Mode -or -not $Cohort) { throw 'Tracking mode and cohort are required.' }
    if ($Mode -ceq 'Inspect') { Invoke-TrackingInspect $Cohort }
    else { throw 'SealReceipt is bootstrap-owned; use the in-process Seal-TrackingReceipt operation.' }
}
