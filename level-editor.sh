#!/bin/sh
# Linux: ./level-editor.sh  (runs: python3 setup.py editor)
cd "$(dirname "$0")" || exit 1
exec python3 setup.py editor "$@"
