# Restart only the CLIHarbor development instance previously launched by this helper.
# Never clears browser profiles, OS keyrings, or CyberArk/Conjur credentials.
param(
    [switch]$Pull,
    [switch]$Stop
)
$ErrorActionPreference = 'Stop'
if ($Pull -and $Stop) { throw 'Choose either -Pull or -Stop.' }

# Script-file invocation has $PSCommandPath/$PSScriptRoot. Inline evaluation
# (for example, Invoke-Expression) does not; accept that form only when the
# current filesystem directory is an identifiable CLIHarbor checkout.
$scriptDir = $null
if (-not [string]::IsNullOrWhiteSpace($PSCommandPath) -and
    [IO.Path]::GetFileName($PSCommandPath) -ieq 'dev-restart.ps1') {
    $scriptDir = Split-Path -Parent -Path $PSCommandPath
} elseif (-not [string]::IsNullOrWhiteSpace($PSScriptRoot) -and
    (Test-Path -LiteralPath (Join-Path -Path $PSScriptRoot -ChildPath 'dev-restart.ps1') -PathType Leaf)) {
    $scriptDir = $PSScriptRoot
}
if ([string]::IsNullOrWhiteSpace($scriptDir)) {
    $location = Get-Location
    if ($location.Provider.Name -ne 'FileSystem') {
        throw 'Cannot locate CLIHarbor: invoke tools/dev-restart.ps1 as a file from a repository checkout.'
    }
    $candidate = Join-Path -Path $location.ProviderPath -ChildPath 'tools/dev-restart.ps1'
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
        throw 'Cannot locate CLIHarbor: run from the checkout with .\tools\dev-restart.ps1.'
    }
    $scriptDir = Split-Path -Parent -Path $candidate
}
$root = (Resolve-Path -LiteralPath (Join-Path -Path $scriptDir -ChildPath '..')).ProviderPath
if ([string]::IsNullOrWhiteSpace($root) -or
    -not (Test-Path -LiteralPath (Join-Path -Path $root -ChildPath 'go.mod') -PathType Leaf)) {
    throw 'Cannot locate CLIHarbor repository root (go.mod missing); no process was stopped or started.'
}
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

function Write-DevChecksum {
    Write-DevChecksum
}

if ($Pull) {
    git pull --ff-only
    if ($LASTEXITCODE -ne 0) { throw 'git pull --ff-only failed; no restart attempted.' }
    # PowerShell parsed this script BEFORE git pull. It might now be stale.
    # Reinvoke the updated checked-out file without -Pull so new safeguards
    # actually execute on the first pull-and-restart.
    $updatedHelper = Join-Path -Path $root -ChildPath 'tools/dev-restart.ps1'
    if (-not (Test-Path -LiteralPath $updatedHelper -PathType Leaf)) {
        throw 'Updated restart helper is missing; no restart attempted.'
    }
    & $updatedHelper
    return
}
if ($Stop) {
    Stop-OwnedDev
    Write-Host 'Helper-owned CLIHarbor stopped (if one was running).'
    exit 0
}
if (-not (Test-Path -LiteralPath $pidFile)) {
    Write-Host 'No helper-owned CLIHarbor instance recorded; building and starting a fresh instance.'
}

# Validate and regenerate the frontend while the current version is still
# running. On Windows, the current executable must be stopped before Go can
# replace it; failed npm/typecheck/lint/tests must not take a healthy app down.
Write-Host 'CLIHarbor: validating and rebuilding frontend (npm ci, typecheck, lint, tests, Vite, embed)...'
$LASTEXITCODE = 0
try {
    & go run ./tools/task web-build
} catch {
    if ($LASTEXITCODE -ne 0) {
        throw "CLIHarbor frontend validation failed (exit code $LASTEXITCODE). Review the 'task:' error above; existing CLIHarbor was not stopped."
    }
    throw "CLIHarbor frontend validation could not start Go: $($_.Exception.Message)"
}
$buildExit = $LASTEXITCODE
if ($buildExit -ne 0) {
    throw "CLIHarbor frontend validation failed (exit code $buildExit). Review the 'task:' error above; run 'go run ./tools/task web-build' to reproduce. Existing CLIHarbor was not stopped."
}

# Compile a fully embedded replacement BEFORE stopping a healthy instance.
# The staged output is built by the same Go task/ldflags as the normal binary,
# but does not overwrite a running Windows executable or its checksum.
$stagedExe = Join-Path $bin '.cliharbor-dev-next.exe'
Write-Host 'CLIHarbor: compiling replacement executable before stopping the running instance...'
$LASTEXITCODE = 0
try {
    & go run ./tools/task go-build-staged
} catch {
    if ($LASTEXITCODE -ne 0) {
        throw "CLIHarbor staged Go compilation failed (exit code $LASTEXITCODE); the running instance was not stopped."
    }
    throw "CLIHarbor staged Go compilation could not start: $($_.Exception.Message)"
}
$buildExit = $LASTEXITCODE
if ($buildExit -ne 0) {
    throw "CLIHarbor staged Go compilation failed (exit code $buildExit); the running instance was not stopped."
}
if (-not (Test-Path -LiteralPath $stagedExe -PathType Leaf)) {
    throw 'Staged CLIHarbor executable is missing; the running instance was not stopped.'
}

# Refuse redirected, non-file, or unexpected outputs rather than accidentally
# replacing a foreign file or writing logs/markers through junctions/symlinks.
$checksum = Join-Path $bin 'SHA256SUMS'
foreach ($path in @($exe, $stagedExe, $pidFile, $stdoutFile, $stderrFile, $checksum)) {
    if (Test-Path -LiteralPath $path) {
        $item = Get-Item -LiteralPath $path -Force
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Unsafe development file path: $path"
        }
    }
}
# Stop only the recorded, PID/start-identity-verified process. A manually
# launched instance remains untouched, even when it holds the target EXE open.
Stop-OwnedDev
$backupExe = Join-Path $bin ('.cliharbor-dev-previous-' + [Guid]::NewGuid().ToString('N') + '.exe')
$hadPrevious = Test-Path -LiteralPath $exe -PathType Leaf
$installedReplacement = $false
$child = $null
try {
    if ($hadPrevious) {
        Move-Item -LiteralPath $exe -Destination $backupExe -ErrorAction Stop
    }
    Move-Item -LiteralPath $stagedExe -Destination $exe -ErrorAction Stop
    $installedReplacement = $true

    # Keep the existing local checksum contract synchronized with the exact
    # executable being launched, without invoking another compiler pass.
    $digest = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
    $checksumTemp = Join-Path $bin ('.cliharbor-dev-checksum-' + [Guid]::NewGuid().ToString('N'))
    try {
        Set-Content -LiteralPath $checksumTemp -Encoding Ascii -Value ("$digest  cliharbor.exe")
        Move-Item -LiteralPath $checksumTemp -Destination $checksum -Force -ErrorAction Stop
    } finally {
        if (Test-Path -LiteralPath $checksumTemp) {
            Remove-Item -LiteralPath $checksumTemp -ErrorAction SilentlyContinue
        }
    }

    $child = Start-Process -FilePath $exe -ArgumentList @('serve', '--no-auto-setup') -WorkingDirectory $root -PassThru -RedirectStandardOutput $stdoutFile -RedirectStandardError $stderrFile
    $childInfo = Get-DevProcess $child.Id
    if ($null -eq $childInfo -or $childInfo.ExecutablePath -ine $exe) {
        throw 'Could not verify the new CLIHarbor process identity.'
    }
    @{ processId = $child.Id; createdUtc = (Get-ProcessCreation $childInfo) } |
        ConvertTo-Json -Compress | Set-Content -LiteralPath $pidFile -Encoding UTF8

    $ready = $false
    for ($i = 0; $i -lt 150; $i++) {
        if (Test-Path -LiteralPath $stdoutFile) {
            try {
                if (Select-String -LiteralPath $stdoutFile -Pattern '^(Local runtime: http://127\.0\.0\.1:|Default browser launch failed\.)' -Quiet -ErrorAction Stop) {
                    $ready = $true
                    break
                }
            } catch [System.IO.IOException] {
                # The child may briefly hold a writer lock during startup.
            }
        }
        if ($null -eq (Get-DevProcess $child.Id)) {
            Remove-Item -LiteralPath $pidFile -ErrorAction SilentlyContinue
            throw "CLIHarbor exited during startup. Inspect private log: $stderrFile"
        }
        Start-Sleep -Milliseconds 100
    }
    $liveChild = Get-DevProcess $child.Id
    if (-not $ready -or $null -eq $liveChild -or $liveChild.ExecutablePath -ine $exe -or
        (Get-ProcessCreation $liveChild) -cne (Get-ProcessCreation $childInfo)) {
        throw "CLIHarbor readiness or process identity was not confirmed. Inspect private logs in $bin"
    }
    if ($hadPrevious) { Remove-Item -LiteralPath $backupExe -ErrorAction Stop }
    Write-Host "Fresh CLIHarbor started (PID $($child.Id))."
    Write-Host "Private startup logs are in $bin. Use the newly opened browser tab."
} catch {
    # Do not delete/replace an EXE that might still be running: retain the
    # previous version for manual recovery if the replacement is live/unknown.
    $replacementRunning = $false
    if ($null -ne $child) {
        try { $replacementRunning = $null -ne (Get-DevProcess $child.Id) } catch { $replacementRunning = $true }
    }
    if (-not $replacementRunning -and $hadPrevious -and (Test-Path -LiteralPath $backupExe -PathType Leaf)) {
        if ($installedReplacement -and (Test-Path -LiteralPath $exe -PathType Leaf)) {
            Remove-Item -LiteralPath $exe -ErrorAction Stop
        }
        Move-Item -LiteralPath $backupExe -Destination $exe -ErrorAction Stop
        Write-DevChecksum
        Write-Warning 'Restored the previous executable and checksum after unsuccessful startup. It has not been relaunched.'
    } elseif (Test-Path -LiteralPath $backupExe -PathType Leaf) {
        Write-Warning "Retained previous executable for manual recovery: $backupExe"
    }
    throw
}
