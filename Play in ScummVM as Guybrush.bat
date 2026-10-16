@echo off
rem Play in ScummVM as Guybrush (Windows): double-click. Runs: python setup.py scummvm --hero guybrush
cd /d "%~dp0"
set LTP_LAUNCHER=1
where py >nul 2>nul && goto :py
where python >nul 2>nul && goto :python
echo Python 3 is needed: https://www.python.org/downloads/  (tick "Add python.exe to PATH" when installing)
goto :end
:py
py -3 setup.py scummvm --hero guybrush
goto :end
:python
python setup.py scummvm --hero guybrush
:end
pause
