@echo off
chcp 65001 > nul
cd /d "%~dp0"
title AI Video Studio

where node > nul 2> nul
if errorlevel 1 goto NONODE

if exist node_modules goto RUN
echo.
echo  [初回のみ] 必要な部品をインストールしています。数分かかります...
echo.
call npm install
if errorlevel 1 goto INSTALLFAIL

:RUN
echo.
echo  AI Video Studio を起動します。ブラウザが自動で開きます。
echo  使い終わったら、この黒い画面を閉じてください。
echo.
node server\index.js
pause
exit /b 0

:NONODE
echo.
echo  Node.js が入っていません。
echo  今からブラウザで Node.js のページを開きます。
echo  「LTS」と書かれた方をダウンロードしてインストールし、
echo  終わったら、もう一度この「start-windows.bat」をダブルクリックしてください。
echo.
start "" "https://nodejs.org/ja/download"
pause
exit /b 1

:INSTALLFAIL
echo.
echo  インストールに失敗しました。インターネット接続を確認して、もう一度ダブルクリックしてください。
echo.
pause
exit /b 1
