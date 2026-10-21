@echo off
chcp 65001 >nul
cd /d "%~dp0ui-prototype"
start "Libra Reader 预览" "http://127.0.0.1:8765"
py -3 -m http.server 8765 --bind 127.0.0.1
if errorlevel 1 (
  echo.
  echo 未能启动 Python 本地预览服务器。请安装 Python 3，或在 ui-prototype 目录运行：
  echo python -m http.server 8765 --bind 127.0.0.1
  pause
)
