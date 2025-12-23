# npack

**npack** is a cross-platform CLI tool that packages Node.js applications into standalone distributable bundles.

The project is inspired by `pkg`, but focuses on a clean Rust-based architecture, modern Node.js versions (20+), and explicit control over the runtime.

---

## Motivation

Existing tools for packaging Node.js applications often:

- hide too much internal logic
- lag behind modern Node versions
- are hard to extend or debug

npack aims to be:

- transparent
- predictable
- minimal
- cross-platform by design

---

## Architecture Overview

npack consists of three main layers:

### 1. CLI Layer (Rust)

Responsible for:

- parsing CLI arguments
- validating input paths
- coordinating the build process

Technologies:

- `clap` — argument parsing
- `anyhow` — error handling

Example usage:

```bash
npack --path ./app --platforms all
```

2. Build Core (Rust)

This layer:

analyzes the Node.js application directory

prepares a distributable filesystem layout

bundles or attaches a Node.js runtime

generates platform-specific entrypoints

The JavaScript application is treated as a black box.
No JS parsing or transformation is performed.

3. Runtime Layer (Node.js)

npack ships with a prebuilt Node.js runtime (v20+).

At runtime:

the Rust binary launches Node

Node executes the packaged application entry file

both ESM and CommonJS are supported natively

Design Principles

Explicit over implicit

No custom JS loaders

No AST parsing or transpilation

Prefer filesystem-based execution (no snapshots initially)

MVP-first approach

## Project Structure

npack/
├─ src/
│ └─ main.rs # CLI entry point
├─ example/ # Sample Node app
├─ dist/ # Build output
├─ Cargo.toml
├─ Makefile
└─ README.md

## Development

Run locally:

cargo run -- --path ./example

Build release binary:

cargo build --release

Roadmap

- CLI skeleton

- Argument parsing

Node runtime bundling

Cross-platform builds

Single-binary output

Asset embedding (optional)
