---
title: nano-node-light Repository Graph Entry
type: text
description: >-
  Graph entry for nano-node-light, a lightweight nano protocol implementation for browsers and
  Node.js; maps to sibling nano repos and the nano-cryptocurrency task umbrella.
base_uri: user:repository/active/nano-node-light/ABOUT.md
created_at: '2026-05-13T18:06:58.523Z'
entity_id: 4bfcf2e2-a79b-4400-9268-648bdd3b129b
owner_identity_uri: user:identity/trashman.md
public_read: false
relations:
  - follows [[user:guideline/directory-markdown-standards.md]]
tags:
  - user:tag/nano-node-light-project.md
  - user:tag/nano-cryptocurrency.md
updated_at: '2026-05-13T18:06:58.523Z'
---

## Purpose

Lightweight nano protocol implementation in pure ES modules — runs in browsers and Node.js. Suitable for wallets and as an alternative to running a full nano node for RPC consumers.

For public overview, see [[README.md]]. For agent-facing build, layout, and conventions, see [[CLAUDE.md]].

## Context

Part of the nano cryptocurrency ecosystem maintained here. The handshake protocol implemented in this repo is the v2 handshake; tests track the spec closely. Crypto operations delegate to the sibling `ed25519-blake2b` package.

## Notable Context

**Tags**:

- [[user:tag/nano-node-light-project.md]] — entities for this project
- [[user:tag/nano-cryptocurrency.md]] — broader nano domain

**Task directory**: [[user:task/nano-cryptocurrency/]] — umbrella tasks; nano-node-light items typically live under this directory.

**Sibling repositories**:

- [[user:repository/active/ed25519-blake2b/ABOUT.md]] — crypto bindings (signing, BLAKE2b) — direct dependency
- [[user:repository/active/nano-community/ABOUT.md]] — community site / monitoring
- [[user:repository/active/nanodb/ABOUT.md]] — nano ledger data tooling

**Governing guidelines**:

- [[user:guideline/directory-markdown-standards.md]] — structure for this file

## Scope

**Belongs in this repo**: protocol implementation (handshake, frontier streaming, peer management, socket abstraction), block validation glue, CLI in `bin/`.

**Belongs elsewhere**:

- Crypto primitives → `ed25519-blake2b/`
- Ledger data import/export → `nanodb/`
- Community site and monitoring → `nano-community/`
- Open work → `task/nano-cryptocurrency/`
