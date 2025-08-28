@echo off
title Launch Scripts: Web or Process
color 0A

:MENU
cls
echo.
echo ================================
echo Choose action:
echo 1 - Study web page (index.mjs)
echo 2 - Study process (index_app.mjs - TEST!)
echo 0 - Exit
echo ================================
echo.

set /p choice=Enter number and press ENTER: 

if "%choice%"=="1" goto WEB
if "%choice%"=="2" goto APP
if "%choice%"=="0" goto EXIT

echo Invalid choice. Try again.
pause
goto MENU

:WEB
cls
echo.
echo Enter domain (e.g., example.com):
set /p domain=
echo Running index.mjs for %domain%...
node index.mjs %domain%
echo.
echo Study completed.
echo Press any key to return to menu...
pause >nul
goto MENU

:APP
cls
echo.
echo Enter process name (e.g., firefox.exe):
set /p process=
echo Running index_app.mjs for %process%...
node index_app.mjs %process%
echo.
echo Study completed.
echo Press any key to return to menu...
pause >nul
goto MENU

:EXIT
cls
echo Exiting...
exit
