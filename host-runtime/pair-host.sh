#!/usr/bin/env bash
set -euo pipefail

runtime_dir="$(cd "$(dirname "$0")" && pwd)"
cd "$runtime_dir"
if [[ ! -f .env ]]; then
  echo "Run ./start-host.sh first so the private host configuration is created." >&2
  exit 2
fi
exec uv run --env-file .env python pair-host.py
