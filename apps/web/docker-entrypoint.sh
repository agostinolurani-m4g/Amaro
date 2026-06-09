#!/bin/sh
set -e

if [ -n "${UPLOAD_PATH}" ]; then
  mkdir -p "${UPLOAD_PATH}"
fi

case "${DATABASE_URL}" in
  sqlite:////*)
    db_path=$(echo "${DATABASE_URL}" | sed 's|^sqlite:////||')
    db_dir=$(dirname "${db_path}")
    if [ -n "${db_dir}" ] && [ "${db_dir}" != "." ]; then
      mkdir -p "/${db_dir}"
    fi
    ;;
esac

exec uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-8000}"
