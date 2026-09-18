#!/usr/bin/env bash
# Genera varianti WebP (640 / 1280) e logo Sunbirds ridotto per il sito M4G.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WEB="$ROOT/apps/web"
PY="${WEB}/.venv/bin/python"
STATIC="$WEB/app/static/m4g"
OUT="$STATIC/opt"

if [[ ! -x "$PY" ]]; then
  echo "Crea il venv in apps/web e installa pillow: pip install pillow" >&2
  exit 1
fi

"$PY" "$ROOT/scripts/m4g_optimize_images.py"
