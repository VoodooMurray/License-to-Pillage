#!/bin/bash
# Play in ScummVM (macOS): double-click. Runs: python3 setup.py scummvm
cd "$(dirname "$0")" || exit 1
export LTP_LAUNCHER=1
PY="$(command -v python3)"
if [ -z "$PY" ]; then
  osascript -e 'display alert "License to Pillage" message "Python 3 is needed. Install it from https://www.python.org/downloads/ and double-click this again."' >/dev/null 2>&1
  echo "Python 3 is needed: https://www.python.org/downloads/"; read -r -p "Press Enter to close."; exit 1
fi
"$PY" setup.py scummvm
STATUS=$?
[ $STATUS -ne 0 ] && read -r -p "Press Enter to close."
exit $STATUS
