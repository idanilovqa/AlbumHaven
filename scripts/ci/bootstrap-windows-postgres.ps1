[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][ValidateSet('Contract', 'Provision', 'Teardown')][string]$Mode,
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
    [switch]$SkipFixtureLoad
)

$ErrorActionPreference = 'Stop'
$allowedHosts = @('localhost', '127.0.0.1', '::1')
$requiredExecutables = @('postgres.exe', 'psql.exe', 'pg_isready.exe')

function Assert-ContractInputs {
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
    return @($paths | ForEach-Object {
        [ordered]@{
            name = $_.Name
            sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
            arguments = @('-w', '-v', 'ON_ERROR_STOP=1', '-1', '--single-transaction', '-f', $_.Name)
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
    $migratorUrl = Get-PasswordlessUrl $names.Roles.migrator $names.Database
    $appUrl = Get-PasswordlessUrl $names.Roles.app $names.Database
    $readonlyUrl = Get-PasswordlessUrl $names.Roles.readonly $names.Database
    return [ordered]@{
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
}

function Invoke-Checked([string]$Executable, [string[]]$Arguments) {
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Command failed: $([IO.Path]::GetFileName($Executable))" }
}

function Invoke-PsqlText([string]$Psql, [string]$Role, [string]$Database, [string]$Sql) {
    $Sql | & $Psql -X -w -v ON_ERROR_STOP=1 -h $HostName -p $Port -U $Role -d $Database
    if ($LASTEXITCODE -ne 0) { throw 'PostgreSQL command failed.' }
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

function Invoke-Provision([object]$Contract) {
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
        [IO.File]::WriteAllText($StatePath, ($state | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding($false)))
        Invoke-PsqlText $psql $AdminRole 'postgres' $roleSql
        Invoke-PsqlText $psql $AdminRole 'postgres' "create database $($names.Database) owner $($names.Roles.migrator);"
        Invoke-PsqlText $psql $AdminRole $names.Database "revoke all on database $($names.Database) from public; grant connect on database $($names.Database) to album_haven_app, album_haven_readonly, $($names.Roles.app); grant temporary on database $($names.Database) to album_haven_app, $($names.Roles.app);"
    } finally {
        Clear-AdminAuthentication
    }

    $pgpassLines = @(
        "$HostName`:$Port`:$($names.Database)`:$($names.Roles.migrator)`:$($secrets.migrator)",
        "$HostName`:$Port`:$($names.Database)`:$($names.Roles.app)`:$($secrets.app)",
        "$HostName`:$Port`:$($names.Database)`:$($names.Roles.readonly)`:$($secrets.readonly)"
    )
    [IO.File]::WriteAllLines($Contract.pgpass.path, $pgpassLines, (New-Object Text.UTF8Encoding($false)))
    $env:PGPASSFILE = $Contract.pgpass.path

    $migrationRoot = Join-Path $RepositoryRoot 'migrations\postgres'
    foreach ($migration in $Contract.migrations) {
        $path = Join-Path $migrationRoot $migration.name
        Invoke-Checked $psql @('-X', '-w', '-v', 'ON_ERROR_STOP=1', '-1', '-h', $HostName, '-p', "$Port", '-U', $names.Roles.migrator, '-d', $names.Database, '-f', $path)
        $ledgerSql = "insert into ops.schema_migrations (migration_name, checksum) values ('$($migration.name)', '$($migration.sha256)') on conflict (migration_name) do update set checksum=excluded.checksum, applied_at=now();"
        Invoke-PsqlText $psql $names.Roles.migrator $names.Database $ledgerSql
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
}

function Invoke-Teardown {
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

if ([string]::IsNullOrWhiteSpace($StatePath)) { $StatePath = Join-Path $RunnerTemp "album-haven-postgres-$DatabaseSuffix.state.json" }
Assert-ContractInputs
$contract = Get-Contract
switch ($Mode) {
    'Contract' { $contract | ConvertTo-Json -Depth 12 -Compress }
    'Provision' { Invoke-Provision $contract }
    'Teardown' { Invoke-Teardown }
}
