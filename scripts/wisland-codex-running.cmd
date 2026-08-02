@echo off
setlocal

if defined APPDATA (
  set "STATUS_DIR=%APPDATA%\wisland"
) else (
  set "STATUS_DIR=%LOCALAPPDATA%\wisland"
)

if not exist "%STATUS_DIR%" mkdir "%STATUS_DIR%" >nul 2>nul
break > "%STATUS_DIR%\codex-running.flag"
del "%STATUS_DIR%\codex-running-hold.flag" >nul 2>nul

exit /b 0
