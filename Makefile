.PHONY: build run

build:
	cargo build --manifest-path codex-rs/Cargo.toml
	corepack enable
	pnpm install
	cd codex-cli && pnpm build && pnpm install && pnpm link
