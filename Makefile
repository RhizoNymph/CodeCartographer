# CodeCartographer developer entry points. `make` (or `make help`) lists targets.
#
# The Tauri/webkit toolchain lives in a distrobox (default: tauri-dev); the
# `dev`/`build` targets run there. Everything else -- tests, typecheck, benches,
# the perf harness -- runs fine on the host and does so directly. Use the
# `*-host` variants if your host has the Tauri toolchain too.
#
# Knobs (make VAR=value):
#   BOX      distrobox container name        (default: tauri-dev)
#   RUST_LOG backend log level               (default: info)
#   REPO     repo path for `make perf`
#   LABEL    label written into harness JSON (default: local)
#   SYNTH    synthetic-repos dir             (default: /tmp/cc-bench-repos)
#   OUT      benchmark output dir            (default: /tmp/cc-bench-results)

REPO_DIR := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
BOX      ?= tauri-dev
RUST_LOG ?= info
APP      := packages/app
LABEL    ?= local
SYNTH    ?= /tmp/cc-bench-repos
OUT      ?= /tmp/cc-bench-results

define in-box
distrobox enter $(BOX) -- bash -c 'cd $(REPO_DIR) && RUST_LOG=$(RUST_LOG) $(1)'
endef

.DEFAULT_GOAL := help

# --- running the app ---------------------------------------------------------

.PHONY: dev
dev: ## Dev app in distrobox (vite HMR; cc-core/cc-tauri at opt-level 3)
	$(call in-box,cargo tauri dev)

.PHONY: dev-release
dev-release: ## Dev app in distrobox with the release backend (thin LTO, slower rebuilds)
	$(call in-box,cargo tauri dev --release)

.PHONY: dev-host
dev-host: ## Dev app on the host (no distrobox)
	RUST_LOG=$(RUST_LOG) cargo tauri dev

.PHONY: dev-host-release
dev-host-release: ## Dev app on the host with the release backend
	RUST_LOG=$(RUST_LOG) cargo tauri dev --release

.PHONY: build
build: ## Production binary (no bundles) into target/release/, in distrobox
	$(call in-box,cargo tauri build --no-bundle)

.PHONY: bundle
bundle: ## Full production bundles (deb+rpm+AppImage -- slow), in distrobox
	$(call in-box,cargo tauri build)

# --- correctness -------------------------------------------------------------

.PHONY: install
install: ## Install frontend dependencies (pnpm workspace)
	pnpm install

.PHONY: test
test: test-rust test-app ## All tests (Rust + frontend)

.PHONY: test-rust
test-rust: ## Rust tests (cc-core + cc-tauri)
	cargo test -p cc-core
	cargo test -p cc-tauri

.PHONY: test-app
test-app: ## Frontend tests (node's built-in runner -- NOT vitest)
	cd $(APP) && node --test "tests/*.test.ts"

.PHONY: typecheck
typecheck: ## Frontend typecheck (tsc --noEmit)
	cd $(APP) && npx tsc --noEmit

.PHONY: check
check: test typecheck ## Everything CI-shaped: tests + typecheck

# --- performance -------------------------------------------------------------

.PHONY: bench
bench: ## Criterion micro-benches (cc-core)
	cargo bench -p cc-core

.PHONY: perf
perf: ## End-to-end perf harness: make perf REPO=/path/to/repo [LABEL=name]
ifndef REPO
	$(error REPO is required: make perf REPO=/path/to/repo)
endif
	cargo run --release -p cc-core --example perf_harness -- --repo $(REPO) --label $(LABEL)

.PHONY: gen-repos
gen-repos: ## Generate the small/medium/large synthetic repos into SYNTH
	for p in small medium large; do \
		python3 benchmarks/gen_repo.py --preset $$p --out $(SYNTH)/cc-$$p --force; \
	done

.PHONY: perf-all
perf-all: gen-repos ## Every benchmark layer via benchmarks/run_all.sh (LABEL, OUT, SYNTH)
	benchmarks/run_all.sh $(LABEL) $(OUT) $(SYNTH)

# --- misc --------------------------------------------------------------------

.PHONY: clean
clean: ## Remove Rust build artifacts and the frontend dist
	cargo clean
	rm -rf $(APP)/dist

.PHONY: help
help: ## List targets
	@awk 'BEGIN {FS = ":.*##"} /^[a-zA-Z0-9_-]+:.*##/ {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)
