#!/usr/bin/env bash
# Run the test suite for the LINE Bot backend.
# Usage: ./tests/run_tests.sh [pytest-args...]
#
# Examples:
#   ./tests/run_tests.sh                  # run all tests
#   ./tests/run_tests.sh -v               # verbose
#   ./tests/run_tests.sh --cov=app        # with coverage
#   ./tests/run_tests.sh -k "test_health" # filter by name

set -euo pipefail

cd "$(dirname "$0")/.."

python -m pytest tests/ \
    --tb=short \
    --strict-markers \
    -q \
    "$@"
