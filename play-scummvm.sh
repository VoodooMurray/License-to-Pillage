#!/bin/sh
# Linux: ./play-scummvm.sh  (runs: python3 setup.py scummvm)
cd "$(dirname "$0")" || exit 1
exec python3 setup.py scummvm "$@"
