@echo off
setlocal EnableExtensions DisableDelayedExpansion
pushd "%~dp0"
if errorlevel 1 (
  echo ERROR: Cannot open the OpenDLE folder.
  pause
  exit /b 1
)

if not exist "package.json" goto missing_checkout
if not exist "package-lock.json" goto missing_checkout
if not exist "scripts\launch.js" goto missing_checkout

call :check_runtime
if not errorlevel 1 goto dependencies

echo OpenDLE requires Node.js 22.12 or newer and npm.
echo Installing Node.js LTS with Windows Package Manager...
where winget.exe >nul 2>nul
if errorlevel 1 (
  echo ERROR: Windows Package Manager is unavailable.
  echo Install Node.js LTS with npm from https://nodejs.org/ and run launch.bat again.
  goto failed
)
winget.exe install --id OpenJS.NodeJS.LTS --exact --source winget --silent --accept-package-agreements --accept-source-agreements --disable-interactivity
if not "%errorlevel%"=="0" (
  echo ERROR: Node.js installation failed or was cancelled.
  echo Install Node.js LTS with npm from https://nodejs.org/ and run launch.bat again.
  goto failed
)
set "PATH=%ProgramFiles%\nodejs;%LOCALAPPDATA%\Programs\nodejs;%PATH%"
call :check_runtime
if errorlevel 1 (
  echo ERROR: A supported Node.js and npm could not be found after installation.
  echo Open a new terminal or install Node.js LTS with npm from https://nodejs.org/.
  goto failed
)

:dependencies
node --input-type=module -e "import { createRequire } from 'node:module'; import { readFileSync } from 'node:fs'; import { resolve } from 'node:path'; const require = createRequire(resolve('package.json')); const pkg = JSON.parse(readFileSync('package.json', 'utf8')); try { for (const name of Object.keys(pkg.dependencies || {})) require.resolve(name); } catch (error) { console.error('Missing OpenDLE dependency: ' + error.message); process.exitCode = 1; }"
if not errorlevel 1 goto launch

echo Installing OpenDLE dependencies from package-lock.json...
call npm.cmd ci
if not "%errorlevel%"=="0" (
  echo ERROR: Dependency installation failed. Check the npm output above.
  goto failed
)

:launch
echo Starting OpenDLE: Studio. Keep this terminal open; Ctrl+C stops the server.
echo If OpenDLE is already running, stop its server before launching again on Windows.
node --env-file-if-exists=.env scripts/launch.js %*
set "result=%errorlevel%"
if "%result%"=="0" goto finished
echo ERROR: OpenDLE could not run successfully. See the output above.
pause
goto finished

:check_runtime
where node.exe >nul 2>nul
if errorlevel 1 exit /b 1
node.exe -e "const [major, minor] = process.versions.node.split('.').map(Number); if (major < 22 || major === 22 && minor < 12) process.exit(1);"
if not "%errorlevel%"=="0" exit /b 1
where npm.cmd >nul 2>nul
if errorlevel 1 exit /b 1
call npm.cmd --version >nul 2>nul
if not "%errorlevel%"=="0" exit /b 1
exit /b 0

:missing_checkout
echo ERROR: Keep launch.bat inside the complete OpenDLE checkout.
echo Download or clone the full project before running this launcher.

:failed
set "result=1"
pause

:finished
popd
exit /b %result%
