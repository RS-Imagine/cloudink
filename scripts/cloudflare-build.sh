#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export BLOG_CONTENT_ROOT="$PWD/build-work/content"
export BLOG_OUTPUT_ROOT="$PWD/build-work/public"
failed() { node scripts/report-build.mjs failed || true; }
trap failed ERR
node scripts/fetch-content.mjs
node scripts/report-build.mjs building
source scripts/ensure-rust.sh
cargo run --locked --release -p sitegen -- build
node scripts/report-build.mjs built
