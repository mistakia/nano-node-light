# CLAUDE.md

Guidance for Claude Code working in this repository.

For graph context (related task dir, tags, sibling nano repos), see [ABOUT.md](ABOUT.md).

## Project Overview

Lightweight nano protocol implementation for browser and Node.js environments. Aimed at wallets and RPC alternatives. Pure ES modules; minimal dependencies. Not production-ready (under heavy development per README).

Crypto is delegated to the sibling `ed25519-blake2b` package.

## Build / Run

```bash
yarn install
yarn test              # Mocha
yarn lint              # ESLint
```

No build step — pure JS library.

## Layout

```
lib/                   # Core: nano-node.js, nano-socket.js, bootstrap.js
common/                # Shared utilities
bin/                   # CLI tools
test/                  # Mocha suite
```

## Major Subsystems

- V2 handshake protocol
- Frontier streaming and block sync
- Peer management and socket abstraction
- Block validation and crypto verification (via `ed25519-blake2b`)

## Conventions

- ESM only.
- Crypto operations go through `ed25519-blake2b`; do not import other crypto libraries.
- Tests against the v2 handshake protocol must stay in lockstep with the spec — protocol changes land here and in any consuming code together.
