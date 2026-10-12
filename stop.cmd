@echo off
setlocal enabledelayedexpansion
rem 停止 DSH 模型能力管理器（默认 8791 端口，可传端口号：stop.cmd 8792）
set PORT=8791
if not "%~1"=="" set PORT=%~1

set FOUND=0
for /f "tokens=5" %%p in ('netstat -ano ^| findstr "LISTENING" ^| findstr ":%PORT% "') do (
  echo 正在停止监听 %PORT% 端口的进程 PID %%p ...
  taskkill /PID %%p /F >nul 2>&1
  if errorlevel 1 (echo   失败：可能权限不足，请用管理员身份运行) else (echo   已停止)
  set FOUND=1
)

if "!FOUND!"=="0" (
  echo 端口 %PORT% 上没有正在运行的服务（可能已关闭，或用了其它端口）。
  echo 提示：也可以直接在界面点「关闭服务」按钮，或在服务窗口按 Ctrl+C。
)
endlocal
