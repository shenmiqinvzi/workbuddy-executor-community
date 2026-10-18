@echo off
rem Windows entry point for the Codex <-> WorkBuddy gateway MCP server.
setlocal
cd /d "%~dp0.."
node "%~dp0..\dist\server.js" %*
