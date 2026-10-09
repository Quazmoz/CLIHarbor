# No external test framework, vendor CLI, Go, or Node required.
# Tests -Stop on fixture directories and simulates a failing frontend build;
# never invokes a real Go toolchain or starts CLIHarbor.
$ErrorActionPreference = 'Stop'
$initialLocation = (Get-Location).ProviderPath
$origin = (Resolve-Path -LiteralPath (Join-Path -Path $PSScriptRoot -ChildPath 'dev-restart.ps1')).ProviderPath
$temp = Join-Path -Path ([IO.Path]::GetTempPath()) -ChildPath ('cliharbor-dev-restart-' + [Guid]::NewGuid().ToString('N'))
$tools = Join-Path -Path $temp -ChildPath 'tools'
$elsewhere = Join-Path -Path $temp -ChildPath 'elsewhere'
try {
    New-Item -ItemType Directory -Path $tools, $elsewhere -Force | Out-Null
    Copy-Item -LiteralPath $origin -Destination (Join-Path -Path $tools -ChildPath 'dev-restart.ps1')
    Set-Content -LiteralPath (Join-Path -Path $temp -ChildPath 'go.mod') -Value 'module github.com/Quazmoz/CLIHarbor'
    $fixture = Join-Path -Path $tools -ChildPath 'dev-restart.ps1'

    Push-Location -LiteralPath $elsewhere
    try {
        & $fixture -Stop | Out-Null
        if (-not (Test-Path -LiteralPath (Join-Path -Path $temp -ChildPath 'bin') -PathType Container)) {
            throw 'File invocation from an unrelated CWD did not resolve its own repository root.'
        }
    } finally { Pop-Location }

    # Evaluate in a new PowerShell command context: no script path is available.
    # Quote the temporary root as a PowerShell literal, not a command.
    $hostExe = (Get-Process -Id $PID).Path
    $quotedRoot = "'" + $temp.Replace("'", "''") + "'"
    $command = 'Set-Location -LiteralPath ' + $quotedRoot +
        '; & ([ScriptBlock]::Create((Get-Content -LiteralPath .\tools\dev-restart.ps1 -Raw))) -Stop'
    & $hostExe -NoProfile -NonInteractive -Command $command | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Inline evaluation from the checkout root failed.' }

    $quotedElsewhere = "'" + $elsewhere.Replace("'", "''") + "'"
    $quotedFixture = "'" + $fixture.Replace("'", "''") + "'"
    $invalidCommand = 'Set-Location -LiteralPath ' + $quotedElsewhere +
        '; try { & ([ScriptBlock]::Create((Get-Content -LiteralPath ' + $quotedFixture +
        ' -Raw))) -Stop; exit 0 } catch { if ($_.Exception.Message -like ''Cannot locate CLIHarbor*'') { exit 42 }; exit 99 }'
    # Assert the expected location rejection, not an unrelated syntax/runtime error.
    & $hostExe -NoProfile -NonInteractive -Command $invalidCommand *> $null
    if ($LASTEXITCODE -ne 42) { throw "Expected invalid checkout rejection (42), got $LASTEXITCODE." }

    # Emulate a failed web-build without downloading dependencies or killing a
    # process. A deliberately malformed marker proves Stop-OwnedDev was not run.
    $fakeBin = Join-Path -Path $temp -ChildPath 'fake-bin'
    New-Item -ItemType Directory -Path $fakeBin | Out-Null
    Set-Content -LiteralPath (Join-Path -Path $fakeBin -ChildPath 'go.cmd') -Value @(
        '@echo off'
        'echo simulated frontend validation failure'
        'exit /b 23'
    )
    $markerFile = Join-Path -Path $temp -ChildPath 'bin\.cliharbor-dev.pid.json'
    Set-Content -LiteralPath $markerFile -Value 'deliberately-invalid-marker'
    $previousPath = $env:PATH
    $failure = $null
    try {
        $env:PATH = $fakeBin + [IO.Path]::PathSeparator + $previousPath
        & $fixture | Out-Null
    } catch {
        $failure = $_.Exception.Message
    } finally {
        $env:PATH = $previousPath
    }
    if ($failure -notlike '*frontend validation failed (exit code 23)*') {
        throw "Expected frontend-specific build failure, got: $failure"
    }
    if ((Get-Content -LiteralPath $markerFile -Raw).Trim() -cne 'deliberately-invalid-marker') {
        throw 'Failed frontend build touched the helper-owned PID marker.'
    }

    # A failed second-stage Go compilation must not stop or mutate the
    # previously running instance. The malformed PID marker detects any
    # attempt to enter Stop-OwnedDev.
    Set-Content -LiteralPath (Join-Path -Path $fakeBin -ChildPath 'go.cmd') -Value @(
        '@echo off'
        'if "%3"=="web-build" exit /b 0'
        'if "%3"=="go-build-staged" exit /b 47'
        'exit /b 98'
    )
    $stageFailure = $null
    try {
        $env:PATH = $fakeBin + [IO.Path]::PathSeparator + $previousPath
        & $fixture | Out-Null
    } catch {
        $stageFailure = $_.Exception.Message
    } finally {
        $env:PATH = $previousPath
    }
    if ($stageFailure -notlike '*staged Go compilation failed (exit code 47)*') {
        throw "Expected staged Go compilation failure, got: $stageFailure"
    }
    if ((Get-Content -LiteralPath $markerFile -Raw).Trim() -cne 'deliberately-invalid-marker') {
        throw 'Failed staged Go compilation touched the helper-owned PID marker.'
    }

    # Even if a build task incorrectly reports success without emitting the
    # requested binary, the helper must refuse to stop the existing instance.
    Set-Content -LiteralPath (Join-Path -Path $fakeBin -ChildPath 'go.cmd') -Value @(
        '@echo off'
        'if "%3"=="web-build" exit /b 0'
        'if "%3"=="go-build-staged" exit /b 0'
        'exit /b 98'
    )
    $missingArtifact = $null
    try {
        $env:PATH = $fakeBin + [IO.Path]::PathSeparator + $previousPath
        & $fixture | Out-Null
    } catch {
        $missingArtifact = $_.Exception.Message
    } finally {
        $env:PATH = $previousPath
    }
    if ($missingArtifact -notlike '*Staged CLIHarbor executable is missing*') {
        throw "Expected missing staged artifact rejection, got: $missingArtifact"
    }
    if ((Get-Content -LiteralPath $markerFile -Raw).Trim() -cne 'deliberately-invalid-marker') {
        throw 'Missing staged artifact touched the helper-owned PID marker.'
    }

    # -Pull must execute the newly checked-out version of the helper, not
    # continue running the old parsed script after git updates it.
    $reexecFixture = Join-Path -Path $tools -ChildPath 'updated-helper.ps1'
    Set-Content -LiteralPath $reexecFixture -Value @(
        'param([switch]$Pull)'
        'if ($Pull) { throw ''updated helper was incorrectly reinvoked with -Pull'' }'
        'throw ''updated-helper-executed'''
    )
    Set-Content -LiteralPath (Join-Path -Path $fakeBin -ChildPath 'git.cmd') -Value @(
        '@echo off'
        'if not "%1"=="pull" exit /b 96'
        'copy /Y "%CLIHARBOR_TEST_UPDATED_HELPER%" "%CLIHARBOR_TEST_RUNNING_HELPER%" >nul'
        'exit /b %errorlevel%'
    )
    $pullFailure = $null
    try {
        $env:CLIHARBOR_TEST_UPDATED_HELPER = $reexecFixture
        $env:CLIHARBOR_TEST_RUNNING_HELPER = $fixture
        $env:PATH = $fakeBin + [IO.Path]::PathSeparator + $previousPath
        & $fixture -Pull | Out-Null
    } catch {
        $pullFailure = $_.Exception.Message
    } finally {
        $env:PATH = $previousPath
        Remove-Item Env:CLIHARBOR_TEST_UPDATED_HELPER -ErrorAction SilentlyContinue
        Remove-Item Env:CLIHARBOR_TEST_RUNNING_HELPER -ErrorAction SilentlyContinue
    }
    if ($pullFailure -ne 'updated-helper-executed') {
        throw "Expected updated helper to execute after pull, got: $pullFailure"
    }

    Write-Host 'PASS: file/inline invocation, pull reexecution, invalid root, frontend failure, staged build failure, and missing artifact.'
} finally {
    Set-Location -LiteralPath $initialLocation
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
