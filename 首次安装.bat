@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title 海报文案修改工具 - 首次安装

where node >nul 2>nul
if errorlevel 1 (
  echo [未找到 Node.js]
  echo 请先安装 Node.js 20 或更高版本：
  echo https://nodejs.org/
  echo.
  pause
  exit /b 1
)

for /f "tokens=1 delims=." %%V in ('node -p "process.versions.node"') do set "NODE_MAJOR=%%V"
if %NODE_MAJOR% LSS 20 (
  echo [Node.js 版本过低]
  echo 当前版本：
  node --version
  echo 请升级到 Node.js 20 或更高版本：https://nodejs.org/
  echo.
  pause
  exit /b 1
)

echo 正在安装项目依赖，请保持网络连接...
call npm install
if errorlevel 1 (
  echo.
  echo 安装失败，请把上面的错误截图发给管理员。
  pause
  exit /b 1
)

echo.
echo 安装完成。以后直接双击“一键启动.bat”即可使用。
pause
