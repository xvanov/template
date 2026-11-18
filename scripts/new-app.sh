#!/usr/bin/env bash
# Start a new app from this template. See scripts/new-app.mjs, or run with --help.
#   ./scripts/new-app.sh ../my-app --profile web --name "My App"
#   ./scripts/new-app.sh --list
set -euo pipefail
exec node "$(dirname "${BASH_SOURCE[0]}")/new-app.mjs" "$@"
