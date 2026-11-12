@echo off
setlocal DisableDelayedExpansion
title CLIHarbor
echo CLIHarbor: building the full app and opening your browser...
echo Requires the Go, Node.js and npm versions listed in README.md.
echo.
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -File "%~dp0tools\dev-restart.ps1"
set "launch_exit=%errorlevel%"
if "%launch_exit%"=="0" exit /b 0
echo.
echo CLIHarbor could not start. Review the error above and README.md.
echo If scripts are blocked, follow your organization's approved execution policy.
pause
exit /b %launch_exit%
