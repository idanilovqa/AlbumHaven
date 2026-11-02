[CmdletBinding()]
param(
    [ValidateSet('Contract', 'Provision', 'Teardown')][string]$Mode,
    [string]$ServiceName = 'postgresql-x64-17',
    [ValidateSet('17', '18')][string]$ExpectedMajorVersion = '17',
    [string]$Pgbin = $env:PGBIN,
    [string]$HostName = 'localhost',
    [string]$DatabaseSuffix,
    [string]$RepositoryRoot = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)),
    [string]$RunnerTemp = $env:RUNNER_TEMP,
    [string]$GithubEnv = $env:GITHUB_ENV,
    [string]$StatePath,
    [string]$AdminRole = 'postgres',
    [string]$PythonPath = 'python',
    [int]$Port = 5432,
    [ValidateSet('Direct', 'Inherited')][string]$AppPrivilegeMode = 'Direct',
    [switch]$SkipFixtureLoad,
    [ValidateSet('tracking-rollback', 'historical-0153')][string]$TrackingCohort,
    [ValidateSet(0, 153)][int]$MigrationThrough = 0,
    [ValidateSet('before-roles','after-roles-commit','after-roles-record','before-database','after-database-create','after-database-record','before-seal','after-seal')][string]$TrackingFailurePoint
)

$ErrorActionPreference = 'Stop'
Import-Module Microsoft.PowerShell.Utility -ErrorAction Stop
$allowedHosts = @('localhost', '127.0.0.1', '::1')
$requiredExecutables = @('postgres.exe', 'psql.exe', 'pg_isready.exe')
if ($TrackingCohort) {
    $bootstrapMode = $Mode
    . (Join-Path $PSScriptRoot 'tracking-postgres-admission.ps1')
    $Mode = $bootstrapMode
}

function Assert-ContractInputs {
    if ($TrackingCohort) {
        $context = Get-TrackingContext $TrackingCohort
        if ($DatabaseSuffix -cne $context.suffix -or $StatePath -ine $context.state_path -or
            [IO.Path]::GetFullPath($RepositoryRoot) -ine $script:TrackingRepository -or
            [IO.Path]::GetFullPath($RunnerTemp) -ine [IO.Path]::GetFullPath($env:RUNNER_TEMP) -or
            $ExpectedMajorVersion -cne '17' -or $HostName -cne '127.0.0.1' -or $Port -lt 1024 -or
            $MigrationThrough -ne 153 -or $AppPrivilegeMode -cne 'Inherited' -or -not $SkipFixtureLoad) {
            throw 'Tracking bootstrap bindings are invalid.'
        }
    } elseif ($TrackingFailurePoint -or $MigrationThrough -ne 0) { throw 'Tracking options require an explicit tracking cohort.' }
    $expectedServiceName = "postgresql-x64-$ExpectedMajorVersion"
    if ($ServiceName -cne $expectedServiceName) { throw "PostgreSQL service must be $expectedServiceName." }
    $escapedMajorVersion = [regex]::Escape($ExpectedMajorVersion)
    if ([string]::IsNullOrWhiteSpace($Pgbin) -or $Pgbin -notmatch "(?i)(^|[\\/])$escapedMajorVersion([\\/])bin$") {
        throw "PGBIN must identify the PostgreSQL $ExpectedMajorVersion bin directory."
    }
    if ($HostName -cnotin $allowedHosts) { throw 'PostgreSQL host must be local loopback.' }
    if ([string]::IsNullOrWhiteSpace($DatabaseSuffix) -or $DatabaseSuffix -cnotmatch '^[a-z0-9]+(?:_[a-z0-9]+)*$') {
        throw 'Database suffix is invalid.'
    }
    if ($DatabaseSuffix.Length -gt 39) { throw 'Database suffix is too long for PostgreSQL role names.' }
    if ($Port -lt 1 -or $Port -gt 65535) { throw 'PostgreSQL port is invalid.' }
    foreach ($value in @($RepositoryRoot, $RunnerTemp, $GithubEnv, $StatePath)) {
        if ([string]::IsNullOrWhiteSpace($value) -or $value.IndexOfAny([char[]]@("`r", "`n", "`0")) -ge 0) {
            throw 'Bootstrap path contains invalid control characters.'
        }
    }
}

function Get-Names {
    $database = "album_haven_ci_$DatabaseSuffix"
    $roles = [ordered]@{
        migrator = "album_haven_migrator_$DatabaseSuffix"
        app = "album_haven_app_$DatabaseSuffix"
        readonly = "album_haven_readonly_$DatabaseSuffix"
    }
    if ($database -ceq 'album_haven_core' -or $database -cnotmatch '^album_haven_ci_[a-z0-9]+(?:_[a-z0-9]+)*$') {
        throw 'Generated database name is forbidden.'
    }
    foreach ($role in $roles.Values) {
        if ($role.Length -gt 63 -or $role -cnotmatch '^album_haven_(?:migrator|app|readonly)_[a-z0-9]+(?:_[a-z0-9]+)*$') {
            throw 'Generated role name is invalid.'
        }
    }
    return [pscustomobject]@{ Database = $database; Roles = $roles }
}

function Get-MigrationContract {
    $migrationRoot = Join-Path $RepositoryRoot 'migrations\postgres'
    $paths = @(Get-ChildItem -LiteralPath $migrationRoot -Filter '*.sql' -File | Sort-Object Name)
    if ($paths.Count -eq 0) { throw 'No PostgreSQL migrations were found.' }
    if ($MigrationThrough -eq 153) {
        $paths = @($paths | Where-Object { $_.Name -cmatch '^[0-9]{4}_[a-z0-9_]+\.sql$' -and [int]$_.Name.Substring(0,4) -le 153 })
        $inventory = [ordered]@{}
        foreach ($path in $paths) { $inventory[$path.Name] = (Get-FileHash -LiteralPath $path.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($inventory | ConvertTo-Json -Compress))
        $digest = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
        if ($paths.Count -ne 147 -or [int]$paths[-1].Name.Substring(0,4) -ne 153 -or $digest -cne $script:TrackingInventory) { throw 'Tracking predecessor inventory mismatch.' }
    }
    return @($paths | ForEach-Object {
        $isNontransactional = $_.Name -ceq '0083_add_album_raw_artist_search_index.sql'
        $arguments = @('-w', '-v', 'ON_ERROR_STOP=1')
        if (-not $isNontransactional) { $arguments += '-1' }
        $arguments += @('-f', $_.Name)
        $requiredValidIndexes = @()
        $indexDefinitionVerifier = $null
        if ($isNontransactional) {
            $requiredValidIndexes = @('library.local_albums_normalized_raw_artists_trgm_idx')
            $indexDefinitionVerifier = 'scripts\postgres\verify_0083_album_raw_artist_index.sql'
        }
        [ordered]@{
            name = $_.Name
            sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
            transactional = -not $isNontransactional
            arguments = $arguments
            requiredValidIndexes = $requiredValidIndexes
            indexDefinitionVerifier = $indexDefinitionVerifier
            recordChecksumAfterSuccess = $true
        }
    })
}

function Get-PasswordlessUrl([string]$Role, [string]$Database) {
    $portText = if ($Port -eq 5432) { '' } else { ":$Port" }
    return "postgresql://$Role@$HostName$portText/$Database"
}

function Get-Contract {
    $names = Get-Names
    $pgpassPath = Join-Path $RunnerTemp "album-haven-postgres-$DatabaseSuffix.pgpass"
    if ($TrackingCohort) { $pgpassPath = (Get-TrackingContext $TrackingCohort).pgpass_path }
    $migratorUrl = Get-PasswordlessUrl $names.Roles.migrator $names.Database
    $appUrl = Get-PasswordlessUrl $names.Roles.app $names.Database
    $readonlyUrl = Get-PasswordlessUrl $names.Roles.readonly $names.Database
    $result = [ordered]@{
        service = [ordered]@{
            name = $ServiceName
            expectedMajorVersion = [int]$ExpectedMajorVersion
            host = $HostName
            allowedHosts = $allowedHosts
        }
        preflight = [ordered]@{
            requiredExecutables = $requiredExecutables
            serverVersionProbe = 'show server_version_num'
            clientVersionProbe = 'psql --version'
            requiredMajorVersion = [int]$ExpectedMajorVersion
            readinessTimeoutSeconds = 60
        }
        database = $names.Database
        roles = $names.Roles
        appPrivilegeMode = $AppPrivilegeMode
        migrations = Get-MigrationContract
        privilegeProbes = [ordered]@{
            migrator = [ordered]@{
                allow = @('create-schema', 'temporary-table', 'select', 'insert', 'update', 'delete', 'sequence-usage')
                deny = @('superuser', 'createdb', 'createrole', 'replication', 'bypassrls')
            }
            app = [ordered]@{
                allow = @('connect', 'temporary-table', 'schema-usage', 'select', 'insert', 'update', 'sequence-usage')
                deny = @('create-schema', 'truncate', 'references', 'trigger', 'ops-write')
            }
            readonly = [ordered]@{
                allow = @('connect', 'schema-usage', 'select')
                deny = @('temporary-table', 'insert', 'update', 'delete', 'truncate', 'sequence-usage')
            }
        }
        teardown = [ordered]@{
            terminateDatabase = $names.Database
            dropDatabase = $names.Database
            dropRoles = @($names.Roles.app, $names.Roles.readonly, $names.Roles.migrator)
            stateRequired = $true
            rejectUnownedTargets = $true
        }
        pgpass = [ordered]@{
            path = $pgpassPath
            scope = 'job'
            deleteOnTeardown = $true
        }
        secrets = [ordered]@{ maskBeforeUse = $true }
        githubEnvExports = [ordered]@{
            PGPASSFILE = $pgpassPath
            ALBUM_HAVEN_CI_DATABASE = $names.Database
            DATABASE_MIGRATOR_URL = $migratorUrl
            DATABASE_APP_URL = $appUrl
            DATABASE_READONLY_URL = $readonlyUrl
            ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL = $migratorUrl
            ALBUM_HAVEN_FAKE_E2E_DATABASE_URL = $appUrl
            ALBUM_HAVEN_APP_DATABASE_URL = $appUrl
        }
        fixtureLoad = [ordered]@{
            script = 'scripts/ci/load-fixture-profile.py'
            databaseUrlEnvironment = 'ALBUM_HAVEN_FAKE_E2E_SETUP_DATABASE_URL'
            fixtureRootEnvironment = 'ALBUM_HAVEN_FIXTURE_ROOT'
            profileEnvironment = 'ALBUM_HAVEN_FIXTURE_PROFILE'
            copyRequired = $true
            analyzeRequired = $true
            beforeTestExecution = $true
        }
    }
    if ($TrackingCohort) {
        $context = Get-TrackingContext $TrackingCohort
        $result.githubEnvExports = [ordered]@{}
        foreach ($entry in @(@('SETUP_URL',$migratorUrl), @('APP_URL',$appUrl), @('READONLY_URL',$readonlyUrl), @('PGPASSFILE',$pgpassPath), @('CI_RECEIPT',$context.receipt_path))) {
            $result.githubEnvExports[$context.prefix + $entry[0]] = $entry[1]
        }
        $result.githubEnvExports['ALBUM_HAVEN_TRACKING_MIGRATION_ADMISSION'] = 'windows-ci'
        $result.githubEnvExports['ALBUM_HAVEN_TRACKING_MIGRATION_TEST'] = 'exclusive-isolated-rollback'
        $result.githubEnvExports['ALBUM_HAVEN_TRACKING_MIGRATION_BASELINE'] = 'aad200d9'
        $result.githubEnvExports['ALBUM_HAVEN_TRACKING_MIGRATION_TOPOLOGY'] = 'separate-owner'
        $result.githubEnvExports['ALBUM_HAVEN_TRACKING_MIGRATION_RUNNER'] = 'operational-function'
        $result.githubEnvExports['ALBUM_HAVEN_TRACKING_HISTORICAL_COHORT'] = '0153-aad200d9'
    }
    return $result
}

function Invoke-Checked([string]$Executable, [string[]]$Arguments) {
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Command failed: $([IO.Path]::GetFileName($Executable))" }
}

function Invoke-PsqlText([string]$Psql, [string]$Role, [string]$Database, [string]$Sql) {
    $Sql | & $Psql -X -w -v ON_ERROR_STOP=1 -h $HostName -p $Port -U $Role -d $Database
    if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL command failed.' }
}

function Write-TrackingMigrationLedgerDiagnostics(
    [string]$Psql,
    [string]$Role,
    [string]$Database,
    [object]$Contract
) {
    $migrationRoot = Join-Path $RepositoryRoot 'migrations\postgres'
    try {
        $trackingPath = Join-Path $migrationRoot '0169_install_listening_tracking_storage.sql'
        $trackingSql = [IO.File]::ReadAllText($trackingPath)
        $inventoryMatch = [regex]::Match(
            $trackingSql, '\$inventory_contract\$(.*?)\$inventory_contract\$::jsonb',
            [Text.RegularExpressions.RegexOptions]::Singleline
        )
        if (-not $inventoryMatch.Success) { throw 'Missing canonical inventory.' }
        $canonicalInventories = $inventoryMatch.Groups[1].Value | ConvertFrom-Json -AsHashtable
        $expected153 = $canonicalInventories['153']
        $expected168 = $canonicalInventories['168']
        if ($expected153 -isnot [System.Collections.IDictionary] -or $expected168 -isnot [System.Collections.IDictionary]) {
            throw 'Invalid canonical inventories.'
        }
    } catch {
        throw 'Could not read canonical tracking migration inventories.'
    }

    $allowedNames = @()
    $workingFiles = @(
        foreach ($migration in $Contract.migrations) {
            $migrationName = $migration.name
            if ($migrationName -cnotmatch '^[0-9]{4}_[a-z0-9_]+\.sql$') {
                throw 'Invalid public migration basename in tracking diagnostics.'
            }
            if ([int]$migrationName.Substring(0, 4) -ge 169) { continue }
            $allowedNames += $migrationName
            $migrationPath = Join-Path $migrationRoot $migrationName
            try {
                $bytes = [IO.File]::ReadAllBytes($migrationPath)
                # Count LF-only, CRLF and bare CR endings separately.
                $lfCount = 0
                $crlfCount = 0
                $bareCrCount = 0
                for ($index = 0; $index -lt $bytes.Length; $index++) {
                    if ($bytes[$index] -eq 13) {
                        if ($index + 1 -lt $bytes.Length -and $bytes[$index + 1] -eq 10) {
                            $crlfCount++
                            $index++
                        } else {
                            $bareCrCount++
                        }
                    } elseif ($bytes[$index] -eq 10) {
                        $lfCount++
                    }
                }
                [ordered]@{
                    migration = $migrationName
                    workingSha256 = (Get-FileHash -LiteralPath $migrationPath -Algorithm SHA256).Hash.ToLowerInvariant()
                    expected153Sha256 = $expected153[$migrationName]
                    expected168Sha256 = $expected168[$migrationName]
                    lfCount = $lfCount
                    crlfCount = $crlfCount
                    bareCrCount = $bareCrCount
                }
            } catch {
                throw 'Could not read predecessor bytes for tracking diagnostics.'
            }
        }
    )
    $workingFiles | ConvertTo-Json -Depth 4 -Compress
    $allowedSql = ($allowedNames | ForEach-Object { "'" + $_.Replace("'", "''") + "'" }) -join ','
    $ledgerSql = @"
select json_build_object(
    'count', count(*),
    'unexpectedCount', count(*) filter (where not migration_name = any(array[$allowedSql]::text[])),
    'entries', coalesce(
        json_agg(json_build_object('migration', migration_name, 'sha256', checksum) order by migration_name)
            filter (where migration_name = any(array[$allowedSql]::text[])),
        '[]'::json
    )
)
from ops.schema_migrations;
"@
    Invoke-PsqlText $Psql $Role $Database $ledgerSql
}

function Get-MigrationIndexState(
    [string]$Psql,
    [string]$Role,
    [string]$Database,
    [string]$VerifierRelativePath
) {
    if ($VerifierRelativePath -cne 'scripts\postgres\verify_0083_album_raw_artist_index.sql') {
        throw "Invalid migration index verifier: $VerifierRelativePath"
    }
    $root = [IO.Path]::GetFullPath($RepositoryRoot)
    $verifierPath = [IO.Path]::GetFullPath((Join-Path $root $VerifierRelativePath))
    if (
        -not (Test-Path -LiteralPath $verifierPath -PathType Leaf)
    ) {
        throw 'The 0083 index-definition verifier is missing or unsafe.'
    }
    $verifierSql = Get-Content -LiteralPath $verifierPath -Raw
    $state = (& $Psql -X -w -v ON_ERROR_STOP=1 -h $HostName -p $Port -U $Role -d $Database -tAc $verifierSql 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the 0083 index definition.' }
    if ($state -cnotin @('missing', 'ready', 'mismatched')) {
        throw "The 0083 index-definition verifier returned an invalid state: $state"
    }
    return $state
}

function Remove-InvalidMigrationIndexes(
    [string]$Psql,
    [string]$Role,
    [string]$Database,
    [string[]]$IndexNames,
    [string]$VerifierRelativePath
) {
    foreach ($indexName in $IndexNames) {
        if ($indexName -cnotmatch '^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$') {
            throw "Invalid migration index name: $indexName"
        }
        $indexState = Get-MigrationIndexState $Psql $Role $Database $VerifierRelativePath
        if ($indexState -ceq 'mismatched') {
            Invoke-PsqlText $Psql $Role $Database "drop index concurrently if exists $indexName;"
        }
    }
}

function New-Secret {
    return ([guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N'))
}

function Set-AdminAuthentication {
    $secret = [string]$env:POSTGRESQL_ADMIN_PASSWORD
    if ([string]::IsNullOrWhiteSpace($secret)) { $secret = 'root' }
    [Console]::Out.WriteLine("::add-mask::$secret")
    $previous = [Environment]::GetEnvironmentVariable('PGPASSWORD', 'Process')
    [Environment]::SetEnvironmentVariable('PGPASSWORD', $secret, 'Process')
    return $previous
}

function Restore-AdminAuthentication([AllowNull()][string]$Previous) {
    [Environment]::SetEnvironmentVariable('PGPASSWORD', $Previous, 'Process')
}

function Clear-AdminAuthentication {
    [Environment]::SetEnvironmentVariable('PGPASSWORD', $null, 'Process')
}

function Assert-ProvisionPreflight([object]$Contract) {
    $service = Get-Service -Name $ServiceName -ErrorAction Stop
    if ($service.Name -cne $ServiceName) { throw 'Unexpected PostgreSQL service.' }
    foreach ($name in $requiredExecutables) {
        if (-not (Test-Path -LiteralPath (Join-Path $Pgbin $name) -PathType Leaf)) {
            throw "PGBIN executable is missing: $name"
        }
    }
    if ($service.StartType -ne 'Automatic') { Set-Service -Name $ServiceName -StartupType Automatic }
    if ($service.Status -ne 'Running') { Start-Service -Name $ServiceName }
    $ready = Join-Path $Pgbin 'pg_isready.exe'
    $deadline = [DateTime]::UtcNow.AddSeconds($Contract.preflight.readinessTimeoutSeconds)
    do {
        & $ready -h $HostName -p $Port -q
        if ($LASTEXITCODE -eq 0) { break }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL readiness timeout expired.' }

    $psql = Join-Path $Pgbin 'psql.exe'
    $clientVersion = (& $psql --version 2>&1 | Out-String)
    $escapedMajorVersion = [regex]::Escape($ExpectedMajorVersion)
    if ($LASTEXITCODE -ne 0 -or $clientVersion -notmatch "^(?s).*\b$escapedMajorVersion(?:\.|\b)") {
        throw "PostgreSQL client version is not $ExpectedMajorVersion."
    }
    $serverVersion = (& $psql -X -w -h $HostName -p $Port -U $AdminRole -d postgres -tAc 'show server_version_num' 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $serverVersion -notmatch "^$escapedMajorVersion\d{4}$") {
        throw "PostgreSQL server version is not $ExpectedMajorVersion."
    }
    return $psql
}

function Invoke-TrackingQuery([string]$Psql, [string]$Database, [string]$Sql) {
    $raw = (& $Psql -X -q -A -t -w -v ON_ERROR_STOP=1 -h $HostName -p $Port -U $AdminRole -d $Database -c $Sql 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $raw.Length -gt 32768 -or -not $raw) { throw 'Tracking PostgreSQL identity query failed.' }
    return ($raw | ConvertFrom-Json -AsHashtable)
}

function Get-TrackingServer([string]$Psql) {
    return (Invoke-TrackingQuery $Psql 'postgres' "select json_build_object('host',inet_server_addr()::text,'port',inet_server_port(),'server_version_num',current_setting('server_version_num')::int,'server_start_epoch',floor(extract(epoch from pg_postmaster_start_time()))::bigint,'server_system_identifier',(select system_identifier::text from pg_control_system()));")
}

function Get-TrackingOrdinaryDatabases {
    $portText = if ($Port -eq 5432) { '' } else { ":$Port" }
    $run = "$($env:GITHUB_RUN_ID)_$($env:GITHUB_RUN_ATTEMPT)"
    $persistent = "album_haven_ci_py_contract_$run"
    $destructive = "album_haven_ci_py_$run"
    if ($env:DATABASE_MIGRATOR_URL -cne "postgresql://album_haven_migrator_py_contract_$run@127.0.0.1$portText/$persistent" -or
        $env:PYTEST_DESTRUCTIVE_SETUP_DATABASE_URL -cne "postgresql://album_haven_migrator_py_$run@127.0.0.1$portText/$destructive") { throw 'Tracking ordinary database bindings are invalid.' }
    $four = @($persistent,$destructive,"album_haven_ci_tr169_$run","album_haven_ci_hist153_$run")
    if (@($four | Sort-Object -Unique).Count -ne 4) { throw 'Tracking requires four distinct database targets.' }
    return [ordered]@{persistent=$persistent; destructive=$destructive}
}

function New-TrackingCreationState([string]$Psql, $Names) {
    $context = Get-TrackingContext $TrackingCohort
    $null = Get-TrackingOrdinaryDatabases
    $server = Get-TrackingServer $Psql
    if ($server.host -cne '127.0.0.1' -or $server.port -ne $Port -or $server.server_version_num -lt 170000 -or $server.server_version_num -ge 180000) { throw 'Tracking endpoint is not the expected loopback PostgreSQL 17 server.' }
    $identity = [ordered]@{}
    foreach ($key in @('repository','workflow','job','run_id','run_attempt','github_sha','checkout_sha','event_pr_head_sha','event_pr_base_sha','event_pr_repository','runner_sid','root')) { $identity[$key] = $context[$key] }
    foreach ($key in $server.Keys) { $identity[$key] = $server[$key] }
    return [ordered]@{
        schema_version=2; identity=$identity; roles_status='pending'; database_status='pending'
        roles=[ordered]@{setup=[ordered]@{name=$Names.Roles.migrator;oid=$null}; app=[ordered]@{name=$Names.Roles.app;oid=$null}; readonly=[ordered]@{name=$Names.Roles.readonly;oid=$null}}
        database=[ordered]@{name=$Names.Database;oid=$null;owner=$Names.Roles.migrator}
    }
}

function Write-TrackingState($State) {
    Write-TrackingFile $TrackingCohort 'state.json' ([Text.UTF8Encoding]::new($false).GetBytes(($State | ConvertTo-Json -Depth 8 -Compress)))
}

function Invoke-TrackingFailurePoint([string]$Point) {
    if ($TrackingFailurePoint -and $TrackingFailurePoint -ceq $Point) { throw "tracking-native-failpoint:$Point" }
}

function Get-TrackingConfirmedCreation {
    if (-not $script:TrackingConfirmedCreation) { throw 'No in-memory tracking creation confirmation.' }
    return ($script:TrackingConfirmedCreation | ConvertTo-Json -Depth 8 -Compress | ConvertFrom-Json -AsHashtable)
}

function Complete-TrackingReceipt([string]$Psql, $State, $Contract) {
    $context = Get-TrackingContext $TrackingCohort
    $previous = Set-AdminAuthentication
    try {
        $server = Get-TrackingServer $Psql
        foreach ($key in $server.Keys) { if ($server[$key] -cne $State.identity[$key]) { throw 'Tracking server changed during provisioning.' } }
        $ledger = Invoke-TrackingQuery $Psql $State.database.name 'select coalesce(json_object_agg(migration_name,checksum order by migration_name),''{}''::json) from ops.schema_migrations;'
        if ($ledger.Count -ne 147) { throw 'Tracking ledger count mismatch.' }
        foreach ($migration in $Contract.migrations) { if ($ledger[$migration.name] -cne $migration.sha256) { throw 'Tracking ledger checksum mismatch.' } }
    } finally { Restore-AdminAuthentication $previous }
    $receipt = [ordered]@{schema_version=1; mode='windows-ci'; cohort=$TrackingCohort}
    foreach ($key in $State.identity.Keys) { $receipt[$key] = $State.identity[$key] }
    $receipt.receipt_path = $context.receipt_path
    $receipt.pgpass_path = $context.pgpass_path
    $receipt.pgbin = [IO.Path]::GetFullPath($Pgbin)
    $receipt.ordinary_pgpass_path = [IO.Path]::GetFullPath($env:PGPASSFILE)
    $receipt.powershell_path = $script:TrackingPowerShell
    $receipt.powershell_sha256 = (Get-FileHash -LiteralPath $script:TrackingPowerShell -Algorithm SHA256).Hash.ToLowerInvariant()
    $receipt.inspector_path = Join-Path $script:TrackingRepository 'scripts\ci\tracking-postgres-admission.ps1'
    $receipt.inspector_sha256 = (Get-FileHash -LiteralPath $receipt.inspector_path -Algorithm SHA256).Hash.ToLowerInvariant()
    $receipt.baseline='aad200d9'; $receipt.migration_through=153; $receipt.migration_count=147
    $receipt.inventory_sha256=$script:TrackingInventory; $receipt.configured_service=$ServiceName
    $receipt.database=$State.database.name; $receipt.database_oid=$State.database.oid; $receipt.database_owner=$State.database.owner
    $receipt.roles=$State.roles
    $receipt.urls=[ordered]@{setup=$Contract.githubEnvExports[$context.prefix+'SETUP_URL'];app=$Contract.githubEnvExports[$context.prefix+'APP_URL'];readonly=$Contract.githubEnvExports[$context.prefix+'READONLY_URL']}
    $receipt.ordinary_databases=Get-TrackingOrdinaryDatabases
    $receipt.pgpass_identity=$null
    Seal-TrackingReceipt $TrackingCohort $receipt
}

function Invoke-TrackingTeardown {
    Assert-ContractInputs
    $state = Get-TrackingState $TrackingCohort
    $names = Get-Names
    if ($state.database.name -cne $names.Database -or $state.database.owner -cne $names.Roles.migrator) { throw 'Unowned tracking database in state.' }
    foreach ($key in @('setup','app','readonly')) {
        $nameKey = if ($key -ceq 'setup') { 'migrator' } else { $key }
        if ($state.roles[$key].name -cne $names.Roles[$nameKey]) { throw 'Unowned tracking role in state.' }
    }
    $previous = Set-AdminAuthentication
    try {
        $psql = Join-Path $Pgbin 'psql.exe'
        $server = Get-TrackingServer $psql
        foreach ($key in $server.Keys) { if ($server[$key] -cne $state.identity[$key]) { throw 'Tracking cleanup server identity mismatch.' } }
        $observed = Invoke-TrackingQuery $psql 'postgres' "select json_build_object('roles',coalesce((select json_object_agg(rolname,oid) from pg_roles where rolname in ('$($names.Roles.migrator)','$($names.Roles.app)','$($names.Roles.readonly)')),'{}'::json),'database',(select json_build_object('oid',oid,'owner',pg_get_userbyid(datdba)) from pg_database where datname='$($names.Database)'));"
        if ($state.roles_status -ceq 'created') {
            if ($observed.roles.Count -ne 3) { throw 'Tracking cleanup role confirmation is incomplete.' }
            foreach ($role in $state.roles.Values) {
                if ($role.oid -isnot [long] -and $role.oid -isnot [int]) { throw 'Invalid tracking role OID.' }
                if ($role.oid -le 0 -or $observed.roles[$role.name] -ne $role.oid) { throw 'Tracking role was replaced.' }
            }
        } elseif ($observed.roles.Count -ne 0) { throw 'Tracking roles exist without creation confirmation.' }
        if ($state.database_status -ceq 'created') {
            if ($state.roles_status -cne 'created' -or $state.database.oid -le 0 -or
                $observed.database.oid -ne $state.database.oid -or $observed.database.owner -cne $state.database.owner) { throw 'Tracking database was replaced or not confirmed.' }
        } elseif ($null -ne $observed.database) { throw 'Tracking database exists without creation confirmation.' }
        # Validate every owned identity before deleting any resource. No CASCADE,
        # shared base role deletion, or prefix-only DROP is permitted.
        if ($state.database_status -ceq 'created') {
            Invoke-PsqlText $psql $AdminRole 'postgres' "select pg_terminate_backend(pid) from pg_stat_activity where datid=$($state.database.oid) and pid<>pg_backend_pid(); drop database $($names.Database);"
        }
        if ($state.roles_status -ceq 'created') {
            $checks = ($state.roles.Values | ForEach-Object { "exists(select 1 from pg_roles where rolname='$($_.name)' and oid=$($_.oid))" }) -join ' and '
            Invoke-PsqlText $psql $AdminRole 'postgres' "begin; do `$guard`$ begin if not ($checks) then raise exception 'Tracking role cleanup identity changed'; end if; end `$guard`$; drop role $($names.Roles.app); drop role $($names.Roles.readonly); drop role $($names.Roles.migrator); commit;"
        }
    } finally { Restore-AdminAuthentication $previous }
    Remove-TrackingFiles $TrackingCohort
}

function Invoke-Provision([object]$Contract) {
    Assert-ContractInputs
    $previousPgpass = $env:PGPASSFILE
    $entryAdminAuthentication = $env:PGPASSWORD
    try {
    $previousAdminAuthentication = Set-AdminAuthentication
    try {
        $psql = Assert-ProvisionPreflight $Contract
    } catch {
        Restore-AdminAuthentication $previousAdminAuthentication
        throw
    }
    [IO.Directory]::CreateDirectory($RunnerTemp) | Out-Null
    $secrets = [ordered]@{ migrator = New-Secret; app = New-Secret; readonly = New-Secret }
    foreach ($secret in $secrets.Values) { Write-Output "::add-mask::$secret" }

    $names = Get-Names
    $collisionSql = "select (select count(*) from pg_roles where rolname in ('$($names.Roles.migrator)','$($names.Roles.app)','$($names.Roles.readonly)')) + (select count(*) from pg_database where datname='$($names.Database)');"
    $collisionCount = (& $psql -X -w -h $HostName -p $Port -U $AdminRole -d postgres -tAc $collisionSql 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $collisionCount -cne '0') {
        Restore-AdminAuthentication $previousAdminAuthentication
        throw 'Bootstrap targets already exist or could not be inspected.'
    }
    $appRoleGrantClause = if ($AppPrivilegeMode -ceq 'Inherited') {
        'inherit in role album_haven_app'
    } else {
        'noinherit'
    }
    $roleSql = @"
begin;
do `$bootstrap`$
begin
  if not exists (select 1 from pg_roles where rolname='album_haven_migrator') then create role album_haven_migrator nologin; end if;
  if not exists (select 1 from pg_roles where rolname='album_haven_app') then create role album_haven_app nologin; end if;
  if not exists (select 1 from pg_roles where rolname='album_haven_readonly') then create role album_haven_readonly nologin; end if;
end `$bootstrap`$;
create role $($names.Roles.migrator) login password '$($secrets.migrator)' nosuperuser nocreatedb nocreaterole noreplication nobypassrls in role album_haven_migrator;
create role $($names.Roles.app) login password '$($secrets.app)' nosuperuser nocreatedb nocreaterole noreplication nobypassrls $appRoleGrantClause;
create role $($names.Roles.readonly) login password '$($secrets.readonly)' nosuperuser nocreatedb nocreaterole noreplication nobypassrls in role album_haven_readonly;
commit;
"@
    $state = [ordered]@{
        schemaVersion = 1
        suffix = $DatabaseSuffix
        database = $names.Database
        roles = $names.Roles
        pgpass = $Contract.pgpass.path
        host = $HostName
        port = $Port
    }
    try {
        if ($TrackingCohort) {
            $state = New-TrackingCreationState $psql $names
            New-TrackingRoot $TrackingCohort
            Write-TrackingState $state
            $script:TrackingConfirmedCreation = @{ roles_status='pending'; roles=$state.roles; database_status='pending'; database=$state.database }
            Invoke-TrackingFailurePoint 'before-roles'
            $roleIdentitySql = "select json_build_object('setup',json_build_object('name','$($names.Roles.migrator)','oid',(select oid from pg_roles where rolname='$($names.Roles.migrator)')),'app',json_build_object('name','$($names.Roles.app)','oid',(select oid from pg_roles where rolname='$($names.Roles.app)')),'readonly',json_build_object('name','$($names.Roles.readonly)','oid',(select oid from pg_roles where rolname='$($names.Roles.readonly)')));"
            $createdRoles = Invoke-TrackingQuery $psql 'postgres' ($roleSql.Replace('commit;', $roleIdentitySql + "`ncommit;"))
            $script:TrackingConfirmedCreation.roles = $createdRoles
            $script:TrackingConfirmedCreation.roles_status = 'created'
            Invoke-TrackingFailurePoint 'after-roles-commit'
            $state.roles = $createdRoles; $state.roles_status = 'created'; Write-TrackingState $state
            Invoke-TrackingFailurePoint 'after-roles-record'
            Invoke-TrackingFailurePoint 'before-database'
            Invoke-PsqlText $psql $AdminRole 'postgres' "create database $($names.Database) owner $($names.Roles.migrator);"
            $createdDatabase = Invoke-TrackingQuery $psql 'postgres' "select json_build_object('name',datname,'oid',oid,'owner',pg_get_userbyid(datdba)) from pg_database where datname='$($names.Database)' and datdba=$($createdRoles.setup.oid);"
            if (-not $createdDatabase.oid) { throw 'Tracking created database identity unavailable.' }
            $script:TrackingConfirmedCreation.database = $createdDatabase
            $script:TrackingConfirmedCreation.database_status = 'created'
            Invoke-TrackingFailurePoint 'after-database-create'
            $state.database = $createdDatabase; $state.database_status = 'created'; Write-TrackingState $state
            Invoke-TrackingFailurePoint 'after-database-record'
        } else {
            [IO.File]::WriteAllText($StatePath, ($state | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding($false)))
            Invoke-PsqlText $psql $AdminRole 'postgres' $roleSql
            Invoke-PsqlText $psql $AdminRole 'postgres' "create database $($names.Database) owner $($names.Roles.migrator);"
        }
        Invoke-PsqlText $psql $AdminRole $names.Database "revoke all on database $($names.Database) from public; grant connect on database $($names.Database) to album_haven_app, album_haven_readonly, $($names.Roles.app); grant temporary on database $($names.Database) to album_haven_app, $($names.Roles.app);"
    } finally {
        Clear-AdminAuthentication
    }

    $pgpassLines = @(
        "$HostName`:$Port`:$($names.Database)`:$($names.Roles.migrator)`:$($secrets.migrator)",
        "$HostName`:$Port`:$($names.Database)`:$($names.Roles.app)`:$($secrets.app)",
        "$HostName`:$Port`:$($names.Database)`:$($names.Roles.readonly)`:$($secrets.readonly)"
    )
    if ($TrackingCohort) {
        Write-TrackingFile $TrackingCohort 'pgpass.conf' ([Text.UTF8Encoding]::new($false).GetBytes(($pgpassLines -join "`n") + "`n"))
    } else {
        [IO.File]::WriteAllLines($Contract.pgpass.path, $pgpassLines, (New-Object Text.UTF8Encoding($false)))
    }
    $env:PGPASSFILE = $Contract.pgpass.path

    $migrationRoot = Join-Path $RepositoryRoot 'migrations\postgres'
    foreach ($migration in $Contract.migrations) {
        $path = Join-Path $migrationRoot $migration.name
        $migrationArguments = @('-X', '-w', '-v', 'ON_ERROR_STOP=1')
        if ($migration.transactional) { $migrationArguments += '-1' }
        $migrationArguments += @('-h', $HostName, '-p', "$Port", '-U', $names.Roles.migrator, '-d', $names.Database, '-f', $path)
        $ledgerSql = "insert into ops.schema_migrations (migration_name, checksum) values ('$($migration.name)', '$($migration.sha256)');"
        if ($migration.transactional) {
            $migrationArguments += @('-c', $ledgerSql)
        }
        $attemptLimit = if ($migration.requiredValidIndexes.Count -gt 0) { 2 } else { 1 }
        for ($attempt = 1; $attempt -le $attemptLimit; $attempt++) {
            try {
                if ($migration.requiredValidIndexes.Count -gt 0) {
                    Remove-InvalidMigrationIndexes $psql $names.Roles.migrator $names.Database $migration.requiredValidIndexes $migration.indexDefinitionVerifier
                }
                if ($migration.name -ceq '0169_install_listening_tracking_storage.sql') {
                    Write-TrackingMigrationLedgerDiagnostics $psql $names.Roles.migrator $names.Database $Contract
                }
                Invoke-Checked $psql $migrationArguments
                foreach ($indexName in $migration.requiredValidIndexes) {
                    $indexState = Get-MigrationIndexState $psql $names.Roles.migrator $names.Database $migration.indexDefinitionVerifier
                    if ($indexState -cne 'ready') {
                        throw "Migration $($migration.name) left a nonconforming index: $indexName"
                    }
                }
                break
            } catch {
                if ($migration.requiredValidIndexes.Count -gt 0) {
                    Remove-InvalidMigrationIndexes $psql $names.Roles.migrator $names.Database $migration.requiredValidIndexes $migration.indexDefinitionVerifier
                }
                if ($attempt -lt $attemptLimit) { continue }
                throw
            }
        }
        if (-not $migration.transactional) {
            Invoke-PsqlText $psql $names.Roles.migrator $names.Database $ledgerSql
        }
    }

    # Functional jobs use direct privileges because their mutation cases revoke
    # grants from only their own login. The Python migration suite explicitly
    # selects inherited mode because it verifies base-role grant repair.
    $copyAppPrivilegesSql = @"
do `$copy_app_privileges`$
declare
  privilege record;
begin
  for privilege in
    select allowed.privilege_type, namespace.nspname as object_name
    from pg_catalog.pg_namespace namespace
    cross join (values ('USAGE'), ('CREATE')) allowed(privilege_type)
    where namespace.nspname not like 'pg\_%' escape '\'
      and namespace.nspname <> 'information_schema'
      and has_schema_privilege('album_haven_app', namespace.oid, allowed.privilege_type)
  loop
    execute format('grant %s on schema %I to %I', privilege.privilege_type, privilege.object_name, '$($names.Roles.app)');
  end loop;

  for privilege in
    select allowed.privilege_type, relation.oid::regclass as object_name
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace on namespace.oid=relation.relnamespace
    cross join (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER')) allowed(privilege_type)
    where namespace.nspname not like 'pg\_%' escape '\'
      and namespace.nspname <> 'information_schema'
      and relation.relkind in ('r','p','v','m','f')
      and has_table_privilege('album_haven_app', relation.oid, allowed.privilege_type)
  loop
    execute format('grant %s on table %s to %I', privilege.privilege_type, privilege.object_name, '$($names.Roles.app)');
  end loop;

  for privilege in
    select allowed.privilege_type, relation.oid::regclass as object_name
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace on namespace.oid=relation.relnamespace
    cross join (values ('USAGE'), ('SELECT'), ('UPDATE')) allowed(privilege_type)
    where namespace.nspname not like 'pg\_%' escape '\'
      and namespace.nspname <> 'information_schema'
      and relation.relkind='S'
      and has_sequence_privilege('album_haven_app', relation.oid, allowed.privilege_type)
  loop
    execute format('grant %s on sequence %s to %I', privilege.privilege_type, privilege.object_name, '$($names.Roles.app)');
  end loop;

  for privilege in
    select allowed.privilege_type, routine.oid::regprocedure as object_name
    from pg_catalog.pg_proc routine
    join pg_catalog.pg_namespace namespace on namespace.oid=routine.pronamespace
    cross join (values ('EXECUTE')) allowed(privilege_type)
    where namespace.nspname not like 'pg\_%' escape '\'
      and namespace.nspname <> 'information_schema'
      and has_function_privilege('album_haven_app', routine.oid, allowed.privilege_type)
  loop
    execute format('grant %s on function %s to %I', privilege.privilege_type, privilege.object_name, '$($names.Roles.app)');
  end loop;
end
`$copy_app_privileges`$;
"@
    if ($AppPrivilegeMode -ceq 'Direct') {
        Invoke-PsqlText $psql $names.Roles.migrator $names.Database $copyAppPrivilegesSql
    }

    $migratorProbeSql = @'
begin;
create schema ci_privilege_probe_schema;
create temporary table ci_privilege_probe (id bigint generated always as identity, value text);
insert into ci_privilege_probe (value) values ('created');
update ci_privilege_probe set value='updated';
delete from ci_privilege_probe;
select nextval(pg_get_serial_sequence('ci_privilege_probe','id'));
rollback;
do $probe$
begin
  if exists (
    select 1
    from pg_roles
    where rolname=current_user
      and (rolsuper or rolcreatedb or rolcreaterole or rolreplication or rolbypassrls)
  ) then
    raise exception 'migrator role attributes are overbroad';
  end if;
end $probe$;
'@
    $appProbeSql = @'
begin;
create temporary table ci_app_privilege_probe (value text);
insert into ci_app_privilege_probe (value) values ('temporary');
insert into library.libraries (name, library_kind, metadata) values ('CI app privilege probe','local','{"probe":true}'::jsonb);
update library.libraries set metadata='{"probe":"updated"}'::jsonb where name='CI app privilege probe';
rollback;
do $probe$
begin
  begin
    truncate table library.libraries;
    raise exception 'app unexpectedly truncated library.libraries';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into ops.schema_migrations (migration_name, checksum) values ('ci-probe','forbidden');
    raise exception 'app unexpectedly wrote ops.schema_migrations';
  exception when insufficient_privilege then null;
  end;
  if not (
    has_database_privilege(current_user,current_database(),'temporary')
    and has_schema_privilege(current_user,'app','usage')
    and has_schema_privilege(current_user,'library','usage')
    and has_schema_privilege(current_user,'integration','usage')
    and has_schema_privilege(current_user,'ops','usage')
    and has_table_privilege(current_user,'library.libraries','select,insert,update')
    and has_table_privilege(current_user,'integration.lastfm_settings','select,insert,update')
    and has_sequence_privilege(current_user,'library.libraries_id_seq','usage')
    and not has_schema_privilege(current_user,'app','create')
    and not has_table_privilege(current_user,'library.libraries','truncate,references,trigger')
    and not has_table_privilege(current_user,'ops.schema_migrations','insert')
  ) then
    raise exception 'app privilege boundary is incomplete or overbroad';
  end if;
end $probe$;
'@
$readonlyProbeSql = @'
select 1 from library.libraries limit 1;
do $probe$
begin
  begin
    create temporary table ci_readonly_privilege_probe (value text);
    raise exception 'readonly unexpectedly created a temporary table';
  exception when insufficient_privilege then null;
  end;
  begin
    create temporary table ci_readonly_privilege_probe (value text);
    raise exception 'readonly unexpectedly created a temporary table';
  exception when insufficient_privilege then null;
  end;
  begin
    insert into library.libraries (name) values ('forbidden');
    raise exception 'readonly unexpectedly inserted library.libraries';
  exception when insufficient_privilege then null;
  end;
  begin
    update library.libraries set name=name;
    raise exception 'readonly unexpectedly updated library.libraries';
  exception when insufficient_privilege then null;
  end;
  begin
    delete from library.libraries;
    raise exception 'readonly unexpectedly deleted library.libraries';
  exception when insufficient_privilege then null;
  end;
  begin
    truncate table library.libraries;
    raise exception 'readonly unexpectedly truncated library.libraries';
  exception when insufficient_privilege then null;
  end;
  if not (
    has_schema_privilege(current_user,'library','usage')
    and has_table_privilege(current_user,'library.libraries','select')
    and not has_database_privilege(current_user,current_database(),'temporary')
    and not has_table_privilege(current_user,'library.libraries','insert,update,delete,truncate')
    and not has_sequence_privilege(current_user,'library.libraries_id_seq','usage')
  ) then
    raise exception 'readonly privilege boundary is incomplete or overbroad';
  end if;
end $probe$;
'@
    Invoke-PsqlText $psql $names.Roles.migrator $names.Database $migratorProbeSql
    Invoke-PsqlText $psql $names.Roles.app $names.Database $appProbeSql
    Invoke-PsqlText $psql $names.Roles.readonly $names.Database $readonlyProbeSql

    foreach ($entry in $Contract.githubEnvExports.GetEnumerator()) {
        [Environment]::SetEnvironmentVariable($entry.Key, [string]$entry.Value, 'Process')
    }
    if (-not $SkipFixtureLoad) {
        $loader = Join-Path $RepositoryRoot $Contract.fixtureLoad.script
        Invoke-Checked $PythonPath @($loader, '--fixture-root', $env:ALBUM_HAVEN_FIXTURE_ROOT, '--profile', $env:ALBUM_HAVEN_FIXTURE_PROFILE, '--database-url', $Contract.githubEnvExports.DATABASE_MIGRATOR_URL)
    }

    if ($TrackingCohort) {
        # Sealing binds the ordinary passfile, not the temporary migration connection.
        $env:PGPASSFILE = $previousPgpass
        Invoke-TrackingFailurePoint 'before-seal'
        Complete-TrackingReceipt $psql $state $Contract
        Invoke-TrackingFailurePoint 'after-seal'
    }
    $lines = @($Contract.githubEnvExports.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" })
    $githubEnvWriter = [IO.StreamWriter]::new(
        $GithubEnv,
        $true,
        (New-Object Text.UTF8Encoding($false))
    )
    try {
        foreach ($line in $lines) { $githubEnvWriter.WriteLine($line) }
    } finally {
        $githubEnvWriter.Dispose()
    }
    } finally {
        if ($TrackingCohort) {
            $env:PGPASSFILE = $previousPgpass
            Restore-AdminAuthentication $entryAdminAuthentication
        }
    }
}

function Invoke-Teardown {
    if ($TrackingCohort) { Invoke-TrackingTeardown; return }
    if (-not (Test-Path -LiteralPath $StatePath -PathType Leaf)) { throw 'Bootstrap state is required for teardown.' }
    try { $state = Get-Content -LiteralPath $StatePath -Raw | ConvertFrom-Json } catch { throw 'Bootstrap state is invalid.' }
    $names = Get-Names
    if ($state.schemaVersion -ne 1 -or [string]$state.suffix -cne $DatabaseSuffix -or [string]$state.database -cne $names.Database) {
        throw 'Bootstrap state contains an unowned teardown target.'
    }
    if ($state.database -ceq 'album_haven_core' -or $state.database -cnotmatch '^album_haven_ci_') { throw 'Forbidden teardown database.' }
    foreach ($key in @('migrator', 'app', 'readonly')) {
        if ([string]$state.roles.$key -cne [string]$names.Roles[$key]) { throw 'Bootstrap state contains an unowned role.' }
    }
    if (
        [string]$state.pgpass -cne [string]$contract.pgpass.path -or
        [string]$state.host -cne $HostName -or
        [int]$state.port -ne $Port
    ) {
        throw 'Bootstrap state contains an unowned teardown resource.'
    }
    $psql = Join-Path $Pgbin 'psql.exe'
    if (-not (Test-Path -LiteralPath $psql -PathType Leaf)) { throw 'PGBIN psql.exe is missing.' }
    $previousAdminAuthentication = Set-AdminAuthentication
    try {
        Invoke-PsqlText $psql $AdminRole 'postgres' "select pg_terminate_backend(pid) from pg_stat_activity where datname='$($names.Database)' and pid<>pg_backend_pid(); drop database if exists $($names.Database); drop role if exists $($names.Roles.app); drop role if exists $($names.Roles.readonly); drop role if exists $($names.Roles.migrator);"
    } finally {
        Restore-AdminAuthentication $previousAdminAuthentication
    }
    if (Test-Path -LiteralPath $state.pgpass) { Remove-Item -LiteralPath $state.pgpass -Force }
    Remove-Item -LiteralPath $StatePath -Force
}

if ($MyInvocation.InvocationName -eq '.') { return }
if (-not $Mode) { throw 'Bootstrap mode is required.' }
if ([string]::IsNullOrWhiteSpace($StatePath)) { $StatePath = Join-Path $RunnerTemp "album-haven-postgres-$DatabaseSuffix.state.json" }
Assert-ContractInputs
$contract = Get-Contract
switch ($Mode) {
    'Contract' { $contract | ConvertTo-Json -Depth 12 -Compress }
    'Provision' { Invoke-Provision $contract }
    'Teardown' { Invoke-Teardown }
}
