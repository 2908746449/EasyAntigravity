@echo off
setlocal
cd /d "%~dp0"
set NODE_NO_WARNINGS=1
if exist "EasyAntigravity.exe" (
  start "" /min "EasyAntigravity.exe"
) else (
  start "" /min node --no-warnings server.js
)
endlocal
