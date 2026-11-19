# Launch the full CLIHarbor app from a source checkout on Windows.
# Checks pinned toolchain versions, then delegates the build (frontend + embed +
# Go) and safe, PID-owned launch to tools/dev-restart.ps1.
#   .\start.ps1          build and (re)start
#   .\start.ps1 -Pull    fast-forward from upstream, then restart
#   .\start.ps1 -Stop    stop the helper-owned instance
param(
    [switch]$Pull,
    [switch]$Stop
)
$ErrorActionPreference = 'Stop'

if (-not $Stop) {
    $wantGo = (Get-Content -LiteralPath (Join-Path $PSScriptRoot '.go-version') -Raw).Trim()
    $wantNode = (Get-Content -LiteralPath (Join-Path $PSScriptRoot '.node-version') -Raw).Trim().TrimStart('v')
    foreach ($tool in 'go', 'node', 'npm') {
        if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
            throw "$tool was not found on PATH. Install Go $wantGo and Node $wantNode (npm >=11.6.0 <12); see README.md."
        }
    }
    # Version drift is a warning: Go toolchain selection (GOTOOLCHAIN) may still resolve it.
    $haveGo = ((& go env GOVERSION) -replace '^go', '').Trim()
    if ($haveGo -ne $wantGo) { Write-Warning "Go $haveGo found; repository pins $wantGo." }
    $haveNode = ((& node --version) -replace '^v', '').Trim()
    if ($haveNode -ne $wantNode) { Write-Warning "Node $haveNode found; repository pins $wantNode." }
}

$helper = Join-Path $PSScriptRoot 'tools\dev-restart.ps1'
if ($Pull) { & $helper -Pull } elseif ($Stop) { & $helper -Stop } else { & $helper }
