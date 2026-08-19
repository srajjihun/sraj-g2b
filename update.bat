@echo off
chcp 65001 >nul
title Refresh
setlocal

rem ============================================================
rem  IMPORTANT: keep this file 100%% ASCII. No Korean, not even in
rem  rem comments. cmd.exe reads a .bat in chunks and remembers where
rem  to continue by byte offset; under chcp 65001 a multi-byte
rem  character sitting on a chunk boundary shifts that offset and the
rem  next line is read from the middle of a character, producing
rem  "'x' is not recognized as an internal or external command".
rem  All Korean text lives in scripts\g2b\say.mjs and is printed by
rem  node, which handles UTF-8 correctly.
rem
rem  What this does (git not required):
rem    1) download the latest code ZIP from GitHub over this folder
rem    2) re-filter notices with the current keywords, rebuild the page
rem    3) verify the new card layout, then open g2b-live.html
rem
rem  Never touched: data\g2b\, g2b-live.html, config\, logs\,
rem  and the G2B_SERVICE_KEY environment variable.
rem  No G2B OpenAPI call, so the daily quota is unaffected.
rem ============================================================

rem This file updates itself, so run from a copy in TEMP.
rem (Overwriting a running .bat makes cmd read the wrong offset.)
if "%SRAJ_STAGE%"=="1" goto :main
set "SRAJ_STAGE=1"
for %%i in ("%~dp0.") do set "SRAJ_HOME=%%~fi"
copy /y "%~f0" "%TEMP%\sraj-updater.bat" >nul 2>&1
if not exist "%TEMP%\sraj-updater.bat" goto :main
cmd /c call "%TEMP%\sraj-updater.bat" & exit /b

:main
cd /d "%SRAJ_HOME%"
if errorlevel 1 goto :nohome

rem Bootstrap checks run before say.mjs is usable, so they are English.
where node >nul 2>&1
if errorlevel 1 goto :nonode
if not exist "scripts\g2b\say.mjs" goto :badfolder

set "SAY=node scripts\g2b\say.mjs"

%SAY% refresh-head
echo   folder: %SRAJ_HOME%
echo.
%SAY% refresh-step1

rem PowerShell downloads and unpacks the ZIP. Keep this PS code ASCII and
rem free of double quotes / %% / ! so cmd does not mangle it. Korean is
rem printed by batch below, branching on the exit code.
set "PS="
set "PS=%PS%$ErrorActionPreference='Stop';"
set "PS=%PS%$ProgressPreference='SilentlyContinue';"
set "PS=%PS%try{[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12}catch{};"
set "PS=%PS%try{[Net.WebRequest]::DefaultWebProxy.Credentials=[Net.CredentialCache]::DefaultCredentials}catch{};"
set "PS=%PS%$dest=$env:SRAJ_HOME;"
set "PS=%PS%$url='https://github.com/srajjihun/sraj-g2b/archive/refs/heads/main.zip';"
set "PS=%PS%$top='sraj-g2b-main';"
set "PS=%PS%$tmp=Join-Path $env:TEMP 'sraj-upd';"
set "PS=%PS%if(Test-Path -LiteralPath $tmp){Remove-Item -LiteralPath $tmp -Recurse -Force};"
set "PS=%PS%New-Item -ItemType Directory -Path $tmp -Force | Out-Null;"
set "PS=%PS%$zip=Join-Path $tmp 'src.zip';"
set "PS=%PS%try{Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing}catch{Write-Host $_.Exception.Message;exit 2};"
set "PS=%PS%try{Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue;"
set "PS=%PS%[IO.Compression.ZipFile]::ExtractToDirectory($zip,$tmp,[Text.Encoding]::UTF8)}catch{Write-Host $_.Exception.Message;exit 3};"
set "PS=%PS%$src=Join-Path $tmp $top;"
set "PS=%PS%if(-not (Test-Path -LiteralPath $src)){$d=@(Get-ChildItem -LiteralPath $tmp -Directory);if($d.Count -eq 1){$src=$d[0].FullName}};"
set "PS=%PS%$src=(Get-Item -LiteralPath $src).FullName;"
set "PS=%PS%$tpl=Join-Path $src 'g2b.html';"
set "PS=%PS%if(-not (Test-Path -LiteralPath $tpl)){exit 4};"
set "PS=%PS%if(-not (Select-String -LiteralPath $tpl -Pattern 'cardView' -Quiet)){exit 4};"
set "PS=%PS%$n=0;"
set "PS=%PS%try{foreach($f in @(Get-ChildItem -LiteralPath $src -Recurse -File -Force)){"
set "PS=%PS%$rel=$f.FullName.Substring($src.Length+1);"
set "PS=%PS%if($rel -eq 'g2b-live.html'){continue};"
set "PS=%PS%if($rel -like 'data\g2b\*'){continue};"
set "PS=%PS%if($rel -like 'logs\*'){continue};"
set "PS=%PS%$t=Join-Path $dest $rel;"
set "PS=%PS%if(($rel -like 'data\*') -and (Test-Path -LiteralPath $t)){continue};"
set "PS=%PS%$p=Split-Path $t -Parent;"
set "PS=%PS%if(-not (Test-Path -LiteralPath $p)){New-Item -ItemType Directory -Path $p -Force | Out-Null};"
set "PS=%PS%Copy-Item -LiteralPath $f.FullName -Destination $t -Force;"
set "PS=%PS%$n=$n+1}}catch{Write-Host $_.Exception.Message;exit 5};"
set "PS=%PS%Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue;"
set "PS=%PS%Write-Host ('        updated files: ' + $n);"
set "PS=%PS%exit 0"

rem Some PCs have a broken PATH, so prefer the absolute powershell.exe.
set "PSEXE=powershell.exe"
if exist "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" set "PSEXE=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"

"%PSEXE%" -NoProfile -ExecutionPolicy Bypass -Command "%PS%"
set "RC=%errorlevel%"
if not "%RC%"=="0" goto :getfail

%SAY% refresh-got

%SAY% refresh-step2
node "scripts\g2b\reclassify.mjs"
node "scripts\g2b\build-page.mjs"
if errorlevel 1 goto :buildfail

%SAY% refresh-step3
findstr /C:"cardView" "g2b-live.html" >nul 2>&1
if errorlevel 1 goto :oldpage
%SAY% refresh-checked
for %%f in ("g2b-live.html") do echo         built: %%~tf  ^(%%~zf bytes^)

%SAY% refresh-done
start "" "g2b-live.html"
pause
exit /b 0

rem ------------------------------------------------------------
:nohome
echo.
echo   [STOP] repository folder not found: %SRAJ_HOME%
echo          Put this file inside the sraj folder and run it again.
echo.
pause
exit /b 1

:nonode
echo.
echo   [ERROR] Node.js is not installed.
echo           Install the LTS build from https://nodejs.org and run again.
echo.
pause
exit /b 1

:badfolder
echo.
echo   [STOP] This file is outside the sraj folder.
echo          current location: %SRAJ_HOME%
echo          Move it next to the other .bat files and run it again.
echo.
pause
exit /b 1

:getfail
echo.
echo   ================================================
if "%RC%"=="2" %SAY% refresh-getfail-net
if "%RC%"=="3" %SAY% refresh-getfail-zip
if "%RC%"=="4" %SAY% refresh-getfail-bad
if "%RC%"=="5" %SAY% refresh-getfail-copy
if "%RC%"=="9009" %SAY% refresh-getfail-ps
%SAY% refresh-getfail-tail
echo     ^(exit code %RC%^)
echo   ================================================
echo.
pause
exit /b 1

:buildfail
%SAY% refresh-buildfail
pause
exit /b 1

:oldpage
%SAY% refresh-oldpage
pause
exit /b 1
