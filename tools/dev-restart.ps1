# Restart only the CLIHarbor development instance previously launched by this helper.
# Never clears browser profiles, OS keyrings, or CyberArk/Conjur credentials.
param(
    [switch]$Pull,
    [switch]$Stop
)
$ErrorActionPreference = 'Stop'
if ($Pull -and $Stop) { throw 'Choose either -Pull or -Stop.' }

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location -LiteralPath $root
$bin = Join-Path $root 'bin'
$exe = Join-Path $bin 'cliharbor.exe'
$pidFile = Join-Path $bin '.cliharbor-dev.pid.json'
$stdoutFile = Join-Path $bin '.cliharbor-dev.stdout.log'
$stderrFile = Join-Path $bin '.cliharbor-dev.stderr.log'
if (Test-Path -LiteralPath $bin) {
    $binInfo = Get-Item -LiteralPath $bin
    if (-not $binInfo.PSIsContainer -or ($binInfo.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw 'Refusing non-directory or redirected bin path.'
    }
}
New-Item -ItemType Directory -Path $bin -Force | Out-Null

function Get-DevProcess([int]$Id) {
    Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $Id" -ErrorAction Stop
}
function Get-ProcessCreation([object]$Process) {
    $Process.CreationDate.ToUniversalTime().ToString('o')
}
function Stop-OwnedDev {
    if (-not (Test-Path -LiteralPath $pidFile -PathType Leaf)) { return }
    if ((Get-Item -LiteralPath $pidFile).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw 'Unsafe PID marker; refusing to stop any process.'
    }
    $marker = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
    $ownedId = 0
    if (-not [int]::TryParse([string]$marker.processId, [ref]$ownedId) -or $ownedId -le 0) {
        throw 'Invalid development PID marker; refusing to stop any process.'
    }
    $old = Get-DevProcess $ownedId
    if ($null -eq $old) {
        Remove-Item -LiteralPath $pidFile
        return
    }
    if ($old.ExecutablePath -ine $exe -or (Get-ProcessCreation $old) -cne [string]$marker.createdUtc -or
        $old.CommandLine -notmatch '(?i)\bserve\s+--no-auto-setup\s*$') {
        throw "PID $ownedId does not match helper-owned CLIHarbor; refusing to stop it."
    }
    Write-Host "Stopping helper-owned CLIHarbor (PID $ownedId)..."
    # Stop-Process is not graceful on Windows; use only on disposable dev
    # instances when no vendor command or login is active.
    Stop-Process -Id $ownedId -ErrorAction Stop
    Wait-Process -Id $ownedId -Timeout 5 -ErrorAction SilentlyContinue
    if ($null -ne (Get-DevProcess $ownedId)) {
        throw 'CLIHarbor has not stopped; inspect it manually.'
    }
    Remove-Item -LiteralPath $pidFile
}

if ($Pull) {
    git pull --ff-only
    if ($LASTEXITCODE -ne 0) { throw 'git pull --ff-only failed; no restart attempted.' }
}
if (-not $Stop -and -not (Test-Path -LiteralPath $pidFile)) {
    Write-Host 'No helper-owned CLIHarbor instance recorded; building and starting a fresh instance.'
}
Stop-OwnedDev
if ($Stop) {
    Write-Host 'Helper-owned CLIHarbor stopped (if one was running).'
    exit 0
}

# Regenerate embedded frontend and rebuild executable; never launch stale bin.
go run ./tools/task build
if ($LASTEXITCODE -ne 0) { throw 'CLIHarbor source build/validation failed.' }
if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'CLIHarbor executable is missing.' }
foreach ($path in @($pidFile, $stdoutFile, $stderrFile)) {
    if ((Test-Path -LiteralPath $path) -and
        ((Get-Item -LiteralPath $path).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "Unsafe development state path: $path"
    }
}
$child = Start-Process -FilePath $exe -ArgumentList @('serve', '--no-auto-setup') -WorkingDirectory $root -PassThru -RedirectStandardOutput $stdoutFile -RedirectStandardError $stderrFile
$childInfo = Get-DevProcess $child.Id
if ($null -eq $childInfo -or $childInfo.ExecutablePath -ine $exe) {
    try { Stop-Process -Id $child.Id -ErrorAction SilentlyContinue } catch { }
    throw 'Could not verify the new CLIHarbor process identity.'
}
@{ processId = $child.Id; createdUtc = (Get-ProcessCreation $childInfo) } | ConvertTo-Json -Compress | Set-Content -LiteralPath $pidFile -Encoding UTF8

$ready = $false
for ($i = 0; $i -lt 150; $i++) {
    if (Test-Path -LiteralPath $stdoutFile) {
        try {
            if (Select-String -LiteralPath $stdoutFile -Pattern '^(Local runtime: http://127\.0\.0\.1:|Default browser launch failed\.)' -Quiet -ErrorAction Stop) {
                $ready = $true
                break
            }
        } catch [System.IO.IOException] {
            # The child may still be holding a writer lock during startup.
        }
    }
    if ($null -eq (Get-DevProcess $child.Id)) {
        Remove-Item -LiteralPath $pidFile -ErrorAction SilentlyContinue
        throw "CLIHarbor exited during startup. Inspect private log: $stderrFile"
    }
    Start-Sleep -Milliseconds 100
}
if (-not $ready) { throw "CLIHarbor started but readiness was not confirmed. Inspect private logs in $bin" }
Write-Host "Fresh CLIHarbor started (PID $($child.Id))."
Write-Host "Private startup logs are in $bin. Use the newly opened browser tab."
