@echo off
setlocal

cd /d "%~dp0"

echo [MotionForge] Checking dependencies...
if not exist "node_modules" (
  echo [MotionForge] Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo [MotionForge] npm install failed.
    pause
    exit /b 1
  )
)

echo [MotionForge] Starting conversion service window...
start "MotionForge Converter Service" cmd /k "cd /d %~dp0 && npm run converter"

echo [MotionForge] Starting frontend dev server...
call npm start
