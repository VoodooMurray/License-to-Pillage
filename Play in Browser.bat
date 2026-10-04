@echo off
rem Play in Browser (Windows): double-click. Runs: python setup.py web
cd /d "%~dp0"
set LTP_LAUNCHER=1
where py >nul 2>nul && goto :py
where python >nul 2>nul && goto :python
echo Python 3 is needed: https://www.python.org/downloads/  (tick "Add python.exe to PATH" when installing)
goto :end
:py
py -3 setup.py web
goto :end
:python
python setup.py web
:end
pause
