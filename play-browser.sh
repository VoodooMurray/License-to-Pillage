#!/bin/sh
# Linux: ./play-browser.sh  (runs: python3 setup.py web)
cd "$(dirname "$0")" || exit 1
exec python3 setup.py web "$@"
