@echo off
rem Double-click launcher for Windows. Installs Node.js when missing; backend\start-local.mjs then updates the code,
rem installs packages, runs setup (which offers to install Python) and starts Hoa Tri with the browser.
chcp 65001 >nul
cd /d "%~dp0"
title Hoa Tri
where node >nul 2>nul
if errorlevel 1 call :install_node
if errorlevel 1 goto end
node backend\start-local.mjs --launcher
:end
echo.
pause
exit /b

:install_node
echo Máy chưa có Node.js (cần bản 22.13 trở lên).
where winget >nul 2>nul
if errorlevel 1 (
  echo Hãy cài Node.js LTS từ https://nodejs.org rồi bấm đúp start.cmd lần nữa.
  exit /b 1
)
choice /c CK /m "Cài Node.js LTS bằng winget ngay bây giờ? C = có, K = không"
if errorlevel 2 exit /b 1
winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
rem This window still has the PATH from before the install: reload it so node is found without reopening.
for /f "usebackq delims=" %%p in (`powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User')"`) do set "PATH=%%p"
where node >nul 2>nul
if errorlevel 1 (
  echo Chưa thấy Node.js sau khi cài. Đóng cửa sổ này rồi bấm đúp start.cmd lần nữa.
  exit /b 1
)
exit /b 0
