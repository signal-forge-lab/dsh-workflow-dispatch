@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0dsh-guard.ps1" %*
exit /b %ERRORLEVEL%
