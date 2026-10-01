#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export BLOG_CONTENT_ROOT="$PWD/build-work/content"
export BLOG_OUTPUT_ROOT="$PWD/build-work/public"
failed() { node scripts/report-build.mjs failed || true; }
trap failed ERR
node scripts/fetch-content.mjs
node scripts/report-build.mjs building
if ! command -v cargo >/dev/null 2>&1; then
  curl --fail --silent --show-error --location https://sh.rustup.rs -o build-work/rustup.sh
  sh build-work/rustup.sh -y --profile minimal --no-modify-path
  export PATH="${CARGO_HOME:-$HOME/.cargo}/bin:$PATH"
fi
if command -v rustup >/dev/null 2>&1; then
  rustup toolchain install 1.98.1 --profile minimal
fi
cargo run --locked --release -p sitegen -- build
node scripts/report-build.mjs built
