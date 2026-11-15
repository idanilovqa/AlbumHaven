<#
.SYNOPSIS
Creates the two long-lived Album Haven Android release keystores (stable and sandbox).

.DESCRIPTION
Owner-run, once. Writes album-haven-stable.p12 and album-haven-sandbox.p12 (PKCS12, RSA 4096,
10,000-day certificates, aliases album-haven-stable and album-haven-sandbox) into an empty
directory outside every Git checkout, and prints only each certificate's SHA-256. Passwords are
prompted for and passed to keytool through a process environment variable, never on a command
line. Existing keystores are never overwritten. See docs/android-release-signing.md.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory,
    [string]$Keytool = 'keytool',
    # For automated tests only; owners are prompted.
    [System.Security.SecureString]$StablePassword,
    [System.Security.SecureString]$SandboxPassword
)

$ErrorActionPreference = 'Stop'
$passwordVariable = 'ALBUM_HAVEN_KEYSTORE_PASSWORD'

function Read-KeystorePassword([string]$Channel) {
    $first = Read-Host -AsSecureString "New $Channel keystore password (at least 16 characters)"
    $second = Read-Host -AsSecureString "Repeat the $Channel keystore password"
    if ((ConvertTo-PlainText $first) -cne (ConvertTo-PlainText $second)) {
        throw "The $Channel passwords do not match."
    }
    return $first
}

function ConvertTo-PlainText([System.Security.SecureString]$Value) {
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Value)
    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
}

# Native tools report progress on stderr, which Windows PowerShell would otherwise raise as errors.
function Invoke-Native([string]$Command, [string[]]$Arguments) {
    $ErrorActionPreference = 'Continue'
    $output = & $Command @Arguments 2>&1
    return [pscustomobject]@{ Output = $output; ExitCode = $LASTEXITCODE }
}

function Invoke-Keytool([string[]]$Arguments) {
    $exitCode = (Invoke-Native $Keytool $Arguments).ExitCode
    if ($exitCode -ne 0) {
        throw "keytool failed with exit code $exitCode."
    }
}

$directory = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $directory | Out-Null
if ((Invoke-Native 'git' @('-C', $directory, 'rev-parse', '--is-inside-work-tree')).ExitCode -eq 0) {
    throw 'Choose a directory outside every Git checkout; keystores must never be committed.'
}

$channels = 'stable', 'sandbox'
foreach ($channel in $channels) {
    if (Test-Path -LiteralPath (Join-Path $directory "album-haven-$channel.p12")) {
        throw "album-haven-$channel.p12 already exists; keystores are never replaced."
    }
}

$passwords = @{
    stable = if ($StablePassword) { $StablePassword } else { Read-KeystorePassword 'stable' }
    sandbox = if ($SandboxPassword) { $SandboxPassword } else { Read-KeystorePassword 'sandbox' }
}
if ((ConvertTo-PlainText $passwords.stable) -ceq (ConvertTo-PlainText $passwords.sandbox)) {
    throw 'Use different passwords for the stable and sandbox keystores.'
}

try {
    foreach ($channel in $channels) {
        $plain = ConvertTo-PlainText $passwords[$channel]
        if ($plain.Length -lt 16) {
            throw "The $channel password must have at least 16 characters."
        }
        Set-Item -Path "Env:$passwordVariable" -Value $plain
        $keystore = Join-Path $directory "album-haven-$channel.p12"
        $alias = "album-haven-$channel"
        $name = if ($channel -eq 'stable') { 'Album Haven' } else { 'Album Haven Sandbox' }
        Invoke-Keytool @(
            '-genkeypair', '-noprompt',
            '-keystore', $keystore, '-storetype', 'PKCS12',
            "-storepass:env", $passwordVariable,
            '-alias', $alias, '-keyalg', 'RSA', '-keysize', '4096', '-validity', '10000',
            '-dname', "CN=$name, O=Album Haven"
        )

        $certificate = Join-Path $directory "album-haven-$channel.cer"
        Invoke-Keytool @(
            '-exportcert', '-keystore', $keystore, '-storetype', 'PKCS12',
            "-storepass:env", $passwordVariable, '-alias', $alias, '-file', $certificate
        )
        $digest = (Get-FileHash -LiteralPath $certificate -Algorithm SHA256).Hash.ToLowerInvariant()
        Write-Output "$channel certificate SHA-256: $digest"
    }
} finally {
    Remove-Item -Path "Env:$passwordVariable" -ErrorAction SilentlyContinue
}
