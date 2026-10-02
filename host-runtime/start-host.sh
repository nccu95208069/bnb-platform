#!/usr/bin/env bash
set -euo pipefail

runtime_dir="$(cd "$(dirname "$0")" && pwd)"
cd "$runtime_dir"

if ! command -v uv >/dev/null 2>&1; then
  echo "uv is required to run the host companion. Install it with: brew install uv" >&2
  exit 2
fi

if [[ ! -f .env ]]; then
  cp .env.example .env
  chmod 600 .env
  token="$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')"
  python3 - "$token" <<'PY'
from pathlib import Path
import sys
p = Path(".env")
s = p.read_text()
s = s.replace("HOST_RUNTIME_BEARER_TOKEN=", f"HOST_RUNTIME_BEARER_TOKEN={sys.argv[1]}", 1)
p.write_text(s)
PY
  chmod 600 .env
  echo "Created private host configuration in host-runtime/.env"
fi

uv sync
exec uv run --env-file .env python run.py
