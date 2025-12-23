APP_NAME := npack
TARGET := target/release/$(APP_NAME)

.PHONY: dev build release clean dist

dev:
	cargo run -- --path ./example

build:
	cargo build

release:
	cargo build --release

dist: release
	mkdir -p dist
	cp $(TARGET) dist/$(APP_NAME)

clean:
	cargo clean
	rm -rf dist
