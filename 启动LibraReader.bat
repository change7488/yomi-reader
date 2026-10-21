@echo off
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo 尚未安装桌面版依赖。请先运行：npm install
  pause
  exit /b 1
)
npm start
