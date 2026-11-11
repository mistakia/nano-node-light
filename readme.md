---
title: nano-node-light
type: text
description: >-
  Lightweight nano protocol implementation for client-side and server-side environments, designed
  for wallets and services
base_uri: user:repository/active/nano-node-light/README.md
created_at: '2026-03-06T19:51:53.878Z'
entity_id: 72a808d5-d002-4330-9022-48910f318d1c
owner_identity_uri: user:identity/trashman.md
public_read: true
updated_at: '2026-03-06T19:51:53.878Z'
---

A lightweight Nano Node implementation designed for wallets and other services, built to be compatible with Nano's official reference implementation.

## Goals

- Provide a lightweight Nano node implementation for client-side (browsers, mobile apps) and server-side (Node.js) environments.
- Offer an alternative to public RPC servers for accessing the state of the Nano ledger.
- Ensure compatibility with the official RPC protocol and reference implementation of Nano.

## Usage

```js
import NanoNode, { NanoConstants } from 'nano-node-light'

const node = new NanoNode({
  network: NanoConstants.NETWORK.LIVE,
  // host:port or [address]:port; there is no default bootstrap host
  bootstrap_peers: ['203.0.113.10:7075', '[2001:db8::10]:7075']
})

node.on('vote', (vote) => {
  console.log(vote.representative_account, vote.block_hashes, vote.is_final)
})

node.on('peer_disconnected', ({ peer_address, disconnect_reason }) => {
  console.log(peer_address, disconnect_reason)
})
```

To watch a network from the command line:

```sh
node bin/observe-network.js --network live --bootstrap-peers 203.0.113.10:7075
```

## Status

The node implementation is currently under heavy development and has not yet reached a stable release. It has not been audited and should not be used in production environments.

If you are interested in contributing to the project, start by reading the [CONTRIBUTING.md](https://github.com/mistakia/nano-node-light/blob/main/CONTRIBUTING.md) file.
