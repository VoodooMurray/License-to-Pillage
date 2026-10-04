#!/bin/sh
# Linux: ./install.sh  (runs: python3 setup.py install)
cd "$(dirname "$0")" || exit 1
exec python3 setup.py install "$@"
