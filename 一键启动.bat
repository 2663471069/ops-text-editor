@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title 海报文案修改工具

where node >nul 2>nul
if errorlevel 1 (
  echo 未检测到 Node.js，请先双击“首次安装.bat”。
  pause
  exit /b 1
)

if not exist "node_modules\express\package.json" (
  echo 尚未完成安装，请先双击“首次安装.bat”。
  pause
  exit /b 1
)

start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:8787/'"
echo 工具已经启动：http://127.0.0.1:8787/
echo 使用期间请不要关闭此窗口。
echo 按 Ctrl+C 可以停止工具。
echo.
call npm start

echo.
echo 工具已停止。按任意键关闭窗口。
pause >nul
