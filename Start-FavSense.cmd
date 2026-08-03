@echo off
setlocal
chcp 65001 >nul
title FavSense - Local Workspace
cd /d "%~dp0"

where powershell.exe >nul 2>&1
if errorlevel 1 (
  echo [FavSense] 找不到 Windows PowerShell，无法启动。
  pause
  exit /b 1
)

where node.exe >nul 2>&1
if errorlevel 1 (
  echo [FavSense] 找不到 Node.js。请先安装 Node.js 20 或更高版本。
  pause
  exit /b 1
)

if not exist "favsense.ps1" (
  echo [FavSense] 启动器不在正确的项目目录中。
  pause
  exit /b 1
)

if not exist "config\xhs-favorites.json" (
  echo [FavSense] 正在进行首次设置……
  powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0favsense.ps1" setup
  echo.
  echo [FavSense] 请按照上方提示完成私有配置，然后再次双击本文件。
  pause
  exit /b 1
)

if /i "%~1"=="--check" (
  echo [FavSense] 双击启动器检查通过。
  exit /b 0
)

echo [FavSense] 正在启动本地工作台，请稍候……
start "" /b powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0scripts\open-favsense-when-ready.ps1"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0favsense.ps1" preview
set "FAVSENSE_EXIT=%ERRORLEVEL%"

if not "%FAVSENSE_EXIT%"=="0" (
  echo.
  echo [FavSense] 启动失败，请查看上方错误信息。
  pause
)

exit /b %FAVSENSE_EXIT%
