#!/bin/bash
# Naxion IDE — dev launcher
# Starts the Theia IDE on port 7472 alongside the existing services

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "Starting Naxion IDE (Theia) on port 7472..."
echo "  Dashboard:  http://127.0.0.1:7470"
echo "  API:        http://127.0.0.1:7471"
echo "  IDE:        http://127.0.0.1:7472"
echo ""

pnpm install
pnpm -r build
npx theia start --port 7472
