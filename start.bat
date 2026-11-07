@echo off
chcp 65001 >nul
title wubli 启动器
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [缺少 Node.js] 请先安装 Node.js 后再双击本文件。
  echo.
  echo  下载地址已为你打开：https://nodejs.org/zh-cn
  echo  选择 LTS 版本，一路点“下一步”安装即可。
  echo.
  start "" "https://nodejs.org/zh-cn"
  pause
  exit /b 1
)

if not exist node_modules (
  echo  首次运行，正在安装依赖（约 1-3 分钟），请稍候...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo  [安装失败] 请检查网络后重新双击本文件。
    pause
    exit /b 1
  )
)

echo.
echo  ==========================================================
echo    wubli 正在启动，浏览器将自动打开 http://localhost:3200
echo    用完后直接关闭这个黑窗口即可停止服务
echo  ==========================================================
echo.

start "" "http://localhost:3200"
node server.js
pause
