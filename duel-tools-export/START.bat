@echo off
title Duel Tools
echo.
echo  Starting Duel Tools...
echo  Keep this window open while using the app.
echo  Press Ctrl+C to stop.
echo.
node "%~dp0server\server.js"
if %ERRORLEVEL% NEQ 0 (
  echo.
  echo  ERROR: Node.js not found.
  echo  Download it from https://nodejs.org (LTS version^)
  echo.
  pause
)
