@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 24 with npm, then reopen this script.
  echo https://nodejs.org/
  pause
  exit /b 1
)
where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo npm.cmd was not found. Reinstall Node.js with npm enabled.
  pause
  exit /b 1
)
node -e "if(Number(process.versions.node.split('.')[0])<22)process.exit(1)"
if errorlevel 1 (
  echo Node.js 22 or newer is required. Node.js 24 is recommended for this package.
  pause
  exit /b 1
)
if not exist ".env" copy /y ".env.example" ".env" >nul
if not exist "node_modules\.bin\tsx.cmd" (
  call npm.cmd ci
  if errorlevel 1 goto failed
)
echo.
echo Development: http://127.0.0.1:4330 -- edits reload automatically.
echo Keep this window open. Press Ctrl+C to stop.
call npm.cmd run dev

if errorlevel 1 goto failed
pause
exit /b 0
:failed
echo.
echo Operation failed. Read the error above. Your source files are unchanged.
pause
exit /b 1
