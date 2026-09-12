@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0dsh-sops.ps1" %*
exit /b %ERRORLEVEL%
