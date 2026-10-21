@echo off
setlocal
node "%~dp0..\bin\opencode-remote.cjs" %*
exit /b %errorlevel%
