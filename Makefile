# Copyright (c) 2026 Erick Bourgeois, Low Tide
# SPDX-License-Identifier: Apache-2.0
#
# Every CI step is a target here; .github/workflows only install tools and call make.

.DEFAULT_GOAL := check

# The binary's name in dist/: low-tide-<os>-<arch>, e.g. low-tide-darwin-arm64.
OS   := $(shell uname -s | tr '[:upper:]' '[:lower:]')
ARCH := $(shell uname -m | sed -e 's/aarch64/arm64/' -e 's/amd64/x86_64/')
DIST := dist/low-tide-$(OS)-$(ARCH)

.PHONY: help fmt fmt-check lint test deny audit check build dist demo

help: ## Show this help
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z0-9_.-]+:.*## / {printf "  %-12s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

fmt: ## Format
	cargo fmt --all

fmt-check: ## Check formatting without writing
	cargo fmt --all -- --check

lint: ## Clippy, warnings are errors (pedantic is on in Cargo.toml)
	cargo clippy --all-targets --all-features -- -D warnings

test: ## Unit tests
	cargo test --all-features

deny: ## Licenses, advisories, bans, sources
	cargo deny check

audit: ## cargo-audit advisory scan (CI uses the security-scan composite action)
	@command -v cargo-audit >/dev/null 2>&1 || cargo install cargo-audit --locked
	cargo audit

check: fmt lint test deny ## The pre-commit gate: fmt, clippy, test, deny

build: ## Release build
	cargo build --release --locked

dist: build ## The release binary into dist/low-tide-<os>-<arch>, with its SHA-256
	@mkdir -p dist
	# A new file, not one overwritten in place: macOS kills a signed binary whose pages changed
	# under its cached code signature (SIGKILL, exit 137).
	rm -f $(DIST)
	cp target/release/low-tide $(DIST)
	cd dist && shasum -a 256 $(notdir $(DIST)) > $(notdir $(DIST)).sha256
	@echo "✓ $(DIST)"

demo: ## The scripted run in a browser, no cluster
	cargo run --release -- web --demo
