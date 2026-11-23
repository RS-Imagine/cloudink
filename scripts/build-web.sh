#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/ensure-rust.sh
npm --prefix cloud-admin ci
export PATH="$PWD/cloud-admin/node_modules/.bin:$PATH"
rustup target add wasm32-unknown-unknown
# Keep the browser engine small without changing native generator optimization.
CARGO_PROFILE_RELEASE_OPT_LEVEL=s CARGO_PROFILE_RELEASE_LTO=thin CARGO_PROFILE_RELEASE_CODEGEN_UNITS=1 \
wasm-pack build crates/blog-wasm --target web --out-dir ../../cloud-admin/ui/wasm --no-typescript
npm --prefix cloud-admin run ui
export BLOG_CONTENT_ROOT="$PWD/build-work/web-content"
export BLOG_OUTPUT_ROOT="$PWD/build-work/web-public"
node scripts/web-assets.mjs seed
cargo run --locked --release -p sitegen -- build
node scripts/web-assets.mjs bundle

worker_tools="$PWD/build-work/worker-tools"
export PATH="$worker_tools/bin:$PATH"
if [[ "$(worker-build --version 2>/dev/null || true)" != 0.9.0 ]]; then
  cargo install --locked --root "$worker_tools" --version 0.9.0 worker-build
fi
worker-build --release --out-dir ../../build-work/feed-worker crates/worker -- --locked
