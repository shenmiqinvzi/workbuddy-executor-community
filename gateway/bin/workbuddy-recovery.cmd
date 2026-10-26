@echo off
rem Local human recovery console; no automatic confirmation or dispatch.
setlocal
cd /d "%~dp0.."
node "%~dp0..\dist\recovery-cli.js" %*
