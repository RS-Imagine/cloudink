#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/ensure-rust.sh
exec cargo xtask build
