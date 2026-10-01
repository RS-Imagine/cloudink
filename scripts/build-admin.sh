#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
rustup target add wasm32-unknown-unknown
wasm-pack build crates/blog-wasm --target web --out-dir ../../cloud-admin/ui/wasm --no-typescript
npm --prefix cloud-admin run build
