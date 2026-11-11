# CLAUDE.md

Guidance for Claude Code working in this repository.

For graph context (related task dir, tags, sibling nano repos), see [ABOUT.md](ABOUT.md).

## Project Overview

Lightweight nano protocol implementation for browser and Node.js environments. Aimed at wallets, RPC alternatives, and continuous network observation (it is the protocol source for the nano.community network observer). Pure ES modules; minimal dependencies. Not production-ready (under heavy development per README).

Crypto is delegated to the sibling `ed25519-blake2b` package.

## Build / Run

```bash
yarn install
yarn test              # Mocha
yarn lint              # ESLint
yarn verify            # lint + test, what CI runs
node bin/observe-network.js --network live --bootstrap-peers <host:port,...>
```

No build step — pure JS library.

## Layout

```
lib/                   # nano-node.js (events, dedupe, queries), nano-socket.js (one peer),
                       # peer-manager.js (address table, dialing, backoff), bootstrap.js
common/                # Decoding, framing (stream.js), constants, bounded-cache.js
bin/observe-network.js # Network observation CLI: JSON lines of statistics and peer events
test/                  # Mocha suite; test/utils.js has the scripted raw peer and encoders
test/fixtures/         # Mainnet message bodies captured 2026-11-11
```

## Major Subsystems

- V2 handshake, gated: every message before the handshake is dropped and counted.
- Peer management: a bounded address table, a 15 s refill loop, per-address backoff.
- Framing that matches nano-node, with per-peer error isolation.
- Vote, state block and telemetry decoding and verification (via `ed25519-blake2b`), deduped by bounded caches.
- Bootstrap clients (`BulkPull`, `FrontierReq`, `BulkPullAccount`) for ledger sync.

## Configuration

`new NanoNode({ network, bootstrap_peers, ...config })`. `network` is a preset from `constants.NETWORK` (`LIVE`, `BETA`, `TEST`) and is required, as it is for `NanoStream`, `encode_message` and the bootstrap clients.

`bootstrap_peers` is required: an array of `host:port` or `[address]:port`. `peering.nano.org` refuses connections on IPv4 and IPv6 (2026-11), so there is no built-in default; seed from known representative addresses. Bootstrap hosts are re-resolved over IPv4 and IPv6 on every refill, and they skip the private-range filter that applies to addresses learned from keepalives, so a local peer can be named explicitly.

| Key                                                                               | Default |
| --------------------------------------------------------------------------------- | ------- |
| `maximum_peer_count`                                                              | 200     |
| `handshake_timeout_ms`                                                            | 10000   |
| `idle_timeout_ms` (nothing received)                                              | 120000  |
| `reconnect_delay_ms` (keep at 60000 or more: V29 refuses a reconnect within 60 s) | 60000   |
| `vote_cache_maximum_entry_count`                                                  | 65536   |

Peer rules: one outbound connection per IP, one connection per node id (a second closes with `duplicate_node_id`). Backoff doubles from `reconnect_delay_ms` to 30 minutes and resets only after a connection stays up 5 minutes. Loopback, private, reserved and port-0 addresses from keepalives are never dialed.

## Event API

Value types: hashes, roots, signatures, `link`, `work` and public keys are lowercase hex strings; `representative_account`, `account` and `representative` are `nano_` addresses; `peer_node_id` is a `node_` string (null before the handshake); `received_at_ms` is epoch milliseconds.

Every peer-scoped event carries `peer_address` (canonical: `::ffff:a.b.c.d` for IPv4), `peer_port`, `peer_node_id` and `received_at_ms`.

| Event               | Payload beyond the peer fields                                                                                                                                                                                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `peer_connected`    | —                                                                                                                                                                                                                                                                                       |
| `peer_disconnected` | `disconnect_reason`                                                                                                                                                                                                                                                                     |
| `vote`              | `representative_account`, `signature`, `vote_hash`, `block_hashes`, `is_final`, `vote_timestamp_ms`, `vote_duration_ms` (both null when final), `is_rebroadcast`, `is_duplicate`                                                                                                        |
| `block`             | `block_hash`, `root`, `account`, `previous`, `representative`, `balance` (raw decimal string), `link`, `signature`, `work`, `is_epoch`, `is_duplicate`                                                                                                                                  |
| `invalid_signature` | `message_type` (`confirm_ack`, `publish`, `telemetry_ack`, `node_id_handshake`), `signer_public_key`                                                                                                                                                                                    |
| `telemetry`         | `block_count`, `cemented_count`, `unchecked_count`, `account_count`, `bandwidth_cap`, `peer_count`, `protocol_version`, `uptime_seconds`, `genesis_block`, `major_version`, `minor_version`, `patch_version`, `pre_release_version`, `maker`, `timestamp_ms`, `active_difficulty` (hex) |

- `vote` fires for every valid vote, duplicates included. A duplicate (same vote hash, account and signature) skips signature verification.
- `is_rebroadcast` is header extension bit 2. A vote with it clear came straight from the sending peer's own representative, so it attributes that representative to the peer without crawling.
- `block` covers state blocks only; legacy types are counted as `publish_legacy_ignored`. Work is not validated. An epoch block (link "epoch v1 block" or "epoch v2 block") is verified against the network's epoch signer, and `is_epoch` is true.
- Telemetry is verified over the full body, so V29's 216-byte form verifies. Telemetry signed by a node id other than the handshake's closes the peer.
- `error` is emitted only for a listen failure.
- Each consumer listener runs in its own try. An exception is rethrown on the next tick: the other listeners still run, and the process still crashes loudly.

Disconnect reasons: `socket_closed`, `socket_error`, `handshake_timeout`, `idle_timeout`, `protocol_error` (framing: bad header, wrong network, unknown message or publish block type), `handshake_invalid` (bad signature, genesis mismatch, or a connection to self), `duplicate_node_id`, `telemetry_node_id_mismatch`. A malformed message or a handler exception drops the message and keeps the peer.

## Queries

- `get_peers()` returns handshaken peers: `peer_address`, `peer_port`, `peer_node_id`, `connected_at_ms`.
- `request_votes_from_peer({ peer_node_id, hash_root_pairs: [{ block_hash, root }], timeout_ms = 5000 })` sends one confirm_req to that peer and resolves to its `vote` events that name a requested hash with `is_rebroadcast` false, collected until the timeout. Contract: a peer replies only with final votes for blocks it has confirmed, so pass a pair confirmed at least 60 s earlier; rebroadcast-flagged votes are excluded because flooded relays carry the flag. Checked on mainnet 2026-11-11: 23 of 26 asked peers replied, 0 of 25 control peers.
- `get_statistics()` returns `peer_count`, `handshaken_peer_count`, `known_address_count`, `bootstrap_resolution_error_count`, `messages_received_by_type`, `messages_dropped_by_reason` (`before_handshake`, `malformed`, `handler_error`, `publish_legacy_ignored`), `votes_verified_count`, `votes_duplicate_count`, `blocks_verified_count`, `blocks_duplicate_count`, `invalid_signature_count`, `disconnects_by_reason`, `verify_seconds`.
- `publish(block_body)` sends a state block to a log-fanout sample of handshaken peers.

## Network observation CLI

`bin/observe-network.js --network live --bootstrap-peers <list> [--duration-seconds N] [--probe-confirm-request]` prints JSON lines: `statistics` every 30 s (the counters, event-loop lag p50/p99/max including the 10 ms sampling resolution, RSS, and `voting_representative_count_5m`), and one line per `peer_disconnected` and `invalid_signature`. `--probe-confirm-request` asks half the peers once for blocks first finally voted 10 to 60 s earlier, and prints every vote naming them for the asked and control halves.

## Conventions

- ESM only.
- Crypto operations go through `ed25519-blake2b`; do not import other crypto libraries.
- Tests against the v2 handshake protocol must stay in lockstep with the spec — protocol changes land here and in any consuming code together.
