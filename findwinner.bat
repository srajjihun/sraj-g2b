@echo off
chcp 65001 >nul
title Find winners
setlocal

rem IMPORTANT: keep this file 100%% ASCII. See scripts\g2b\say.mjs for why.
rem All Korean shown to the user is printed by node.
rem
rem Asks nara-jangteo directly who won a given project, by notice name.
rem Does NOT look at the data collected on this PC - this is a live query.
rem Needs G2B_SERVICE_KEY and a Korean IP.

rem Run from a copy in TEMP: getcode.bat updates this file mid-run, and cmd.exe
rem re-reads a running .bat by byte offset. See the analysis .bat for details.
if "%SRAJ_STAGE%"=="1" goto :main
set "SRAJ_STAGE=1"
for %%i in ("%~dp0.") do set "SRAJ_HOME=%%~fi"
copy /y "%~f0" "%TEMP%\sraj-winner.bat" >nul 2>&1
if not exist "%TEMP%\sraj-winner.bat" goto :main
cmd /c call "%TEMP%\sraj-winner.bat" %* & exit /b

:main
if "%SRAJ_HOME%"=="" for %%i in ("%~dp0.") do set "SRAJ_HOME=%%~fi"
cd /d "%SRAJ_HOME%"
set "SAY=node scripts\g2b\say.mjs"

where node >nul 2>&1
if errorlevel 1 goto :nonode

%SAY% winner-head
set /p "WORDS=  name: "

%SAY% winner-org
set /p "ORG=  org: "

if "%WORDS%"=="" if "%ORG%"=="" goto :empty

set "ORGOPT="
if not "%ORG%"=="" set "ORGOPT=--org %ORG%"

%SAY% winner-months
set /p "MONTHS=  months (enter = 24): "
if "%MONTHS%"=="" set "MONTHS=24"

%SAY% winner-mode
set /p "MODE=  mode (enter = fast): "

set "SWEEP="
if /i "%MODE%"=="s" set "SWEEP=--sweep"
if /i "%MODE%"=="sweep" set "SWEEP=--sweep"

%SAY% winner-pull
call "%SRAJ_HOME%\getcode.bat"

if "%G2B_SERVICE_KEY%"=="" (
  %SAY% nokey
  pause
  exit /b 1
)

if not exist "logs" mkdir "logs"
%SAY% winner-run
node "scripts\g2b\winner-find.mjs" %WORDS% %ORGOPT% --months %MONTHS% %SWEEP% > "logs\winner-find.txt" 2>&1
start notepad "logs\winner-find.txt"
exit /b 0

rem ------------------------------------------------------------
:empty
%SAY% winner-empty
pause
exit /b 1

:nonode
echo.
echo   [ERROR] Node.js is not installed.
echo           Install the LTS build from https://nodejs.org and run again.
echo.
pause
exit /b 1
