# No external test framework, vendor CLI, Go, or Node required.
# Only uses -Stop against new isolated fixture directories (no PID markers).
$ErrorActionPreference = 'Stop'
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
        '; & ([ScriptBlock]::Create((Get-Content -LiteralPath .\\tools\\dev-restart.ps1 -Raw))) -Stop'
    & $hostExe -NoProfile -NonInteractive -Command $command | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Inline evaluation from the checkout root failed.' }

    $quotedElsewhere = "'" + $elsewhere.Replace("'", "''") + "'"
    $invalidCommand = 'Set-Location -LiteralPath ' + $quotedElsewhere +
        '; & ([ScriptBlock]::Create((Get-Content -LiteralPath ' + $quotedRoot +
        ' + ''\\tools\\dev-restart.ps1'' -Raw))) -Stop'
    # An inline invocation outside a checkout must reject rather than guess a root.
    & $hostExe -NoProfile -NonInteractive -Command $invalidCommand *> $null
    if ($LASTEXITCODE -eq 0) { throw 'Inline evaluation outside a checkout unexpectedly succeeded.' }

    Write-Host 'PASS: file invocation, inline checkout fallback, and fail-closed invalid root.'
} finally {
    Set-Location -LiteralPath $PSScriptRoot
    Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue
}
