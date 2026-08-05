@echo off
REM One-click starter for the HubOS Claude Code console bridge.
REM Double-click this file, then open HubOS -> Console in your browser.
cd /d "%~dp0"
if not exist "node_modules" (
  echo Installing bridge dependencies ^(first run only^)...
  call npm install
)
echo Starting hubos-bridge...
node server.mjs
pause
