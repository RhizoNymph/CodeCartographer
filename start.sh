#!/usr/bin/env bash
set -euo pipefail

# Default to `info`. `debug` makes hot-path `tracing::debug!` calls in
# cc-core/cc-tauri evaluate their format arguments for every scanned file,
# which is a measurable cost on large repos. Override per-run with:
#   RUST_LOG=debug ./start.sh
RUST_LOG="${RUST_LOG:-info}"

# Extra arguments are forwarded to `cargo tauri dev`, e.g.:
#   ./start.sh --release   # release-profile backend (thin LTO), slower rebuilds
distrobox enter tauri-dev -- bash -c "cd /home/nymph/Code/devtools/CodeCartographer && RUST_LOG=$RUST_LOG cargo tauri dev $* 2>&1"
