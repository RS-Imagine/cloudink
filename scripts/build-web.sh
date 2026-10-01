#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
source scripts/ensure-rust.sh
npm --prefix cloud-admin ci
export PATH="$PWD/cloud-admin/node_modules/.bin:$PATH"
rustup target add wasm32-unknown-unknown
wasm-pack build crates/blog-wasm --target web --out-dir ../../cloud-admin/ui/wasm --no-typescript
npm --prefix cloud-admin run ui
export BLOG_CONTENT_ROOT="$PWD/build-work/web-content"
export BLOG_OUTPUT_ROOT="$PWD/build-work/web-public"
node scripts/web-assets.mjs seed
cargo run --locked --release -p sitegen -- build
node scripts/web-assets.mjs bundle
