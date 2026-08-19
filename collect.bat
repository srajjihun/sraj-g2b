@echo off
chcp 65001 >nul
rem ===================================================================
rem  nara-jangteo bidding radar - daily collector
rem  Registered in the Windows task scheduler (via collect-silent.vbs).
rem ===================================================================
rem
rem IMPORTANT: keep this file 100%% ASCII. See scripts\g2b\say.mjs for why.
rem Nobody watches this window (collect-silent.vbs runs it hidden), so the
rem log lines stay English on purpose - they are for diagnosis.
rem
rem This file only syncs the code and then calls collect-g2b.bat.
rem The split matters: `call` reads the child fresh, so the sync above may
rem replace it safely. Doing both in one file made cmd resume at a stale
rem byte offset and run garbage.

cd /d "%~dp0"

if not exist "logs" mkdir "logs"

rem Absolute path: a child may pushd elsewhere, and logs\ is gitignored,
rem so a relative path silently swallowed every redirection.
set "LOG=%~dp0logs\collect.log"

echo. >> "%LOG%"
echo ===== %DATE% %TIME% collect start ===== >> "%LOG%"

rem Right after boot the network may not be up yet.
ping -n 16 127.0.0.1 >nul

rem -- pull latest code --
rem `git pull --ff-only` fails forever once local and remote diverge, and
rem the error only reaches the log. Matching the remote repairs a diverged
rem clone on the next run. data\g2b\, g2b-live.html and logs\ are ignored
rem by git, so they survive untouched.
set "BR=main"
git fetch origin %BR% >> "%LOG%" 2>&1
git checkout -f -B %BR% FETCH_HEAD >> "%LOG%" 2>&1 || echo [WARN] could not sync code >> "%LOG%"

rem Owns its own log (logs\g2b.log) and its own start/end banner.
rem It exits 1 when the API key is not registered yet; `call` just returns.
if exist "%~dp0collect-g2b.bat" (
  call "%~dp0collect-g2b.bat"
) else (
  echo [WARN] collect-g2b.bat missing - nothing collected >> "%LOG%"
)

echo ===== %DATE% %TIME% collect end ===== >> "%LOG%"

rem Keep the log from growing without bound.
for %%F in ("%LOG%") do if %%~zF GTR 1048576 type nul > "%LOG%"
