#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/ensure-rust.sh
npm --prefix cloud-admin ci
export PATH="$PWD/cloud-admin/node_modules/.bin:$PATH"
bash scripts/build-admin.sh
