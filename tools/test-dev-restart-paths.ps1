# No external test framework, vendor CLI, Go, or Node required.
# Only uses -Stop against new isolated fixture directories (no PID markers).
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

    Write-Host 'PASS: file invocation, inline checkout fallback, and fail-closed invalid root.'
} finally {
    Set-Location -LiteralPath $initialLocation
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
