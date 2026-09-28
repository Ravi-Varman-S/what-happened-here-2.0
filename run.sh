#!/usr/bin/env bash
# What Happened Here? 2.0 - one command: set up, start the server, open the UI.
#
#   ./run.sh            start on http://127.0.0.1:8000 and open a browser
#   ./run.sh 9000       use a different port
set -e
cd "$(dirname "$0")"
PORT="${1:-8000}"

PY=python3
if ! "$PY" -c "import numpy, scipy, soundfile, librosa, matplotlib, tensorflow, fastapi, uvicorn" >/dev/null 2>&1; then
  if [ ! -x .venv/bin/python ]; then
    echo "[setup] Creating virtual environment in .venv ..."
    "$PY" -m venv .venv
  fi
  PY=.venv/bin/python
  if [ ! -f .venv/.installed ]; then
    echo "[setup] Installing dependencies - first run only, a few minutes ..."
    "$PY" -m pip install --upgrade pip >/dev/null
    "$PY" -m pip install -r requirements.txt
    echo ok > .venv/.installed
  fi
fi

echo "Starting What Happened Here? 2.0 on http://127.0.0.1:$PORT"
"$PY" open_ui.py "$PORT" &
exec "$PY" server.py "$PORT"
