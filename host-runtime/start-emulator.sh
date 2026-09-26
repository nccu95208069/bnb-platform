#!/usr/bin/env bash
set -euo pipefail

android_emulator_path="${ANDROID_EMULATOR_PATH:-$HOME/Library/Android/sdk/emulator/emulator}"
avd_name="${ANDROID_AVD_NAME:-}"

if [[ -z "$avd_name" ]]; then
  echo "Set ANDROID_AVD_NAME to the persistent owner AVD name." >&2
  exit 2
fi
if [[ ! -x "$android_emulator_path" ]]; then
  echo "Android Emulator not found at ANDROID_EMULATOR_PATH." >&2
  exit 2
fi

exec "$android_emulator_path" -avd "$avd_name"
