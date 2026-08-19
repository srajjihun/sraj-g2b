@echo off
chcp 65001 >nul
title Scheduler
setlocal

rem ============================================================
rem  IMPORTANT: keep this file 100%% ASCII. See scripts\g2b\say.mjs
rem  for why. Korean text is printed by node.
rem
rem  Registers the daily collect with the Windows task scheduler,
rem  so it runs by itself every morning with no window.
rem
rem    schedule.bat           07:00
rem    schedule.bat 08:30     a different time
rem
rem  The task name is ASCII on purpose: it is written into this .bat.
rem ============================================================

cd /d "%~dp0"
set "SAY=node scripts\g2b\say.mjs"

where node >nul 2>&1
if errorlevel 1 goto :nonode
if not exist "scripts\g2b\say.mjs" goto :badfolder
if not exist "collect-silent.vbs" goto :badfolder

set "AT=%~1"
if "%AT%"=="" set "AT=07:00"

set "TN=sraj-g2b-collect"

%SAY% sched-head
echo         folder: %~dp0
echo         time  : %AT%
echo.

rem /f replaces an existing task, so running this twice is safe.
rem The inner quotes must be backslash-escaped for schtasks.
schtasks /create /tn "%TN%" /tr "wscript.exe \"%~dp0collect-silent.vbs\"" /sc daily /st %AT% /f
if errorlevel 1 goto :fail

echo.
%SAY% sched-done
echo.
schtasks /query /tn "%TN%"
echo.
pause
exit /b 0

rem ------------------------------------------------------------
:nonode
echo.
echo   [ERROR] Node.js is not installed.
echo           Install the LTS build from https://nodejs.org and run again.
echo.
pause
exit /b 1

:badfolder
echo.
echo   [STOP] This file is outside the sraj-g2b folder.
echo          current location: %~dp0
echo          Move it next to collect-silent.vbs and run it again.
echo.
pause
exit /b 1

:fail
echo.
%SAY% sched-fail
echo.
pause
exit /b 1
