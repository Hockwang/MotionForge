@echo off
setlocal

cd /d "%~dp0"

echo [MotionForge] Checking dependencies...
if not exist "node_modules" (
  echo [MotionForge] First run detected. Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo [MotionForge] npm install failed.
    pause
    exit /b 1
  )
)

echo [MotionForge] Starting dev server...
call npm start

if errorlevel 1 (
  echo [MotionForge] Startup failed.
  pause
  exit /b 1
)
