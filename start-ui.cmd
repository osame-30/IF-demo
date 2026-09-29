@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22以上をインストールしてから開き直してください。
  pause
  exit /b 1
)
call npm.cmd run ui -- --open
if errorlevel 1 pause
