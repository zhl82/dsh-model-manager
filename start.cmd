@echo off
setlocal
set NODE="C:\Users\Zhang Lei\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not exist %NODE% set NODE=node
cd /d "%~dp0"
start "" http://127.0.0.1:8791
%NODE% src\server.js %*
endlocal
