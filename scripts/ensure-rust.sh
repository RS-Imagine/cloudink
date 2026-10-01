#!/usr/bin/env bash
# Source this file so a newly installed Cargo remains available to the caller.
if ! command -v cargo >/dev/null 2>&1; then
  mkdir -p build-work
  curl --fail --silent --show-error --location https://sh.rustup.rs -o build-work/rustup.sh
  sh build-work/rustup.sh -y --profile minimal --no-modify-path
  export PATH="${CARGO_HOME:-$HOME/.cargo}/bin:$PATH"
fi
if command -v rustup >/dev/null 2>&1; then
  rustup toolchain install 1.98.1 --profile minimal
fi
