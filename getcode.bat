@echo off
rem ============================================================
rem  Pull latest code. Other .bat files `call` this; it also runs alone.
rem
rem  IMPORTANT: keep this file 100%% ASCII (see scripts\g2b\say.mjs
rem  for why). Korean messages are printed by node.
rem
rem  Why not `git pull`:
rem    This PC and GitHub Actions both committed the same data\*.json,
rem    so local and remote diverged and `git pull --ff-only` failed
rem    forever - while every .bat hid the error with >nul. New code was
rem    pushed many times and never reached the PC.
rem    Now the PC commits nothing, so "match the remote" is enough and
rem    one run repairs a diverged clone.
rem
rem  Not overwritten (untracked by git):
rem    data\g2b\raw\         cached API pulls
rem    data\g2b\progress.json
rem    g2b-live.html         generated page
rem
rem  Reset to the last published version (tracked by git, 2026-08 for the
rem  Netlify site): data\g2b\posts.json, docs.json, awards.json. That is
rem  fine - collect-g2b.bat regenerates and re-publishes them every run.
rem
rem  No git, or this folder is not a clone? Use the refresh .bat -
rem  that one downloads a ZIP from GitHub and needs no git.
rem ============================================================

cd /d "%~dp0"
set "SAY=node scripts\g2b\say.mjs"

where git >nul 2>&1
if errorlevel 1 (
  %SAY% pull-nogit
  exit /b 1
)

if not exist ".git" (
  %SAY% pull-norepo
  exit /b 1
)

rem The branch is hardcoded on purpose. This used to read the current
rem branch with `git rev-parse --abbrev-ref HEAD`, but the clone on this
rem PC had wandered onto an unrelated branch, so every run kept syncing
rem to that wrong branch - old and new files mixed, which is exactly the
rem problem this file exists to prevent. Pinning it means any run
rem repairs the checkout no matter where HEAD was.
set "BR=main"

git fetch origin %BR%
if errorlevel 1 (
  %SAY% pull-netfail
  exit /b 1
)

rem checkout -B forces the local branch to FETCH_HEAD and switches to it.
rem -f matters: the refresh .bat unpacks a ZIP over this folder, so files
rem that are tracked here can sit in the working tree as UNTRACKED copies
rem when the clone is parked on an older branch. Plain checkout refuses to
rem overwrite those ("untracked working tree files would be overwritten")
rem and the clone stays stuck on the wrong branch forever. -f overwrites
rem them. It cannot lose the user's own files: data\g2b\raw\, progress.json
rem and g2b-live.html are gitignored, and git leaves ignored files alone.
git checkout -f -B %BR% FETCH_HEAD
if errorlevel 1 (
  %SAY% pull-resetfail
  exit /b 1
)

%SAY% pull-ok
exit /b 0
