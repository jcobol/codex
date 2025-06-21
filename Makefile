.PHONY: build run

build:
	cargo build --manifest-path codex-rs/Cargo.toml
	pnpm --filter @openai/codex run build

run: build
	node codex-cli/bin/codex.js
