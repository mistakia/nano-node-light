import EventEmitter from 'events'
import crypto from 'crypto'
import net from 'net'
import debug from 'debug'

import {
  constants,
  ed25519,
  encode_address,
  decode_vote,
  verify_vote,
  decode_state_block,
  verify_state_block,
  get_state_block_signer,
  decode_telemetry,
  decode_keepalive,
  get_block_type,
  wait
} from '#common'
import BoundedCache from '#common/bounded-cache.js'

import NanoSocket from './nano-socket.js'
import PeerManager from './peer-manager.js'

const log = debug('node')

const { DISCONNECT_REASON, DROP_REASON, MESSAGE_TYPE, BLOCK_TYPE } = constants

const HASH_HEX_PATTERN = /^[0-9a-fA-F]{64}$/

const to_account = (public_key_buf) => encode_address({ public_key_buf })

function to_hash_buffer(value, name) {
  if (!HASH_HEX_PATTERN.test(value)) {
    throw new Error(`${name} must be a 64-character hex string`)
  }
  return Buffer.from(value, 'hex')
}

// A nano protocol node for observing the network. It dials and keeps a bounded
// peer set, verifies and dedupes what peers send, and emits peer-scoped events.
// See CLAUDE.md for the event API.
export default class NanoNode extends EventEmitter {
  constructor({ network, bootstrap_peers, ...config } = {}) {
    super()

    if (!network) throw new Error('network is required')
    if (!Array.isArray(bootstrap_peers)) {
      throw new Error(
        'bootstrap_peers is required: an array of host:port or [address]:port'
      )
    }

    this.network = network
    this.config = { ...constants.DEFAULT_CONFIG, ...config, bootstrap_peers }

    const node_secret_buf = crypto.randomBytes(32)
    const node_public_buf = ed25519.publicKey(node_secret_buf)
    this.node_key = {
      secret_key_buf: node_secret_buf,
      public_key_buf: node_public_buf
    }
    this.node_id = encode_address({
      public_key_buf: node_public_buf,
      prefix: 'node_'
    })
    log(`Node ID: ${this.node_id}`)

    this.peers = new Map() // connection_key -> NanoSocket
    this.vote_requests = new Set() // pending request_votes_from_peer calls
    this.vote_cache = new BoundedCache({
      maximum_entry_count: this.config.vote_cache_maximum_entry_count
    })
    this.block_cache = new BoundedCache({
      maximum_entry_count: constants.BLOCK_CACHE_MAXIMUM_ENTRY_COUNT
    })
    this.statistics = {
      messages_received_by_type: {},
      messages_dropped_by_reason: Object.fromEntries(
        Object.values(DROP_REASON).map((reason) => [reason, 0])
      ),
      votes_verified_count: 0,
      votes_duplicate_count: 0,
      blocks_verified_count: 0,
      blocks_duplicate_count: 0,
      invalid_signature_count: 0,
      disconnects_by_reason: {},
      verify_ns: 0n
    }

    this.peer_manager = new PeerManager({
      bootstrap_peers,
      maximum_peer_count: this.config.maximum_peer_count,
      reconnect_delay_ms: this.config.reconnect_delay_ms,
      dial: (address) => this.dial(address),
      get_peer_count: () => this.peers.size
    })
    this.peer_manager.start()

    this._keepalive_interval = setInterval(
      () => this.keepalive_loop(),
      constants.KEEPALIVE_INTERVAL
    )
  }

  // Calls each consumer listener in its own try, so one listener's exception
  // neither skips the others nor reaches the peer's socket. The exception is
  // rethrown on the next tick, so the consumer still crashes loudly.
  emit_to_consumers(event_name, payload) {
    for (const listener of this.rawListeners(event_name)) {
      try {
        listener.call(this, payload)
      } catch (error) {
        process.nextTick(() => {
          throw error
        })
      }
    }
  }

  peer_event_fields(nano_socket) {
    return { ...nano_socket.get_peer_fields(), received_at_ms: Date.now() }
  }

  count_drop(reason) {
    this.statistics.messages_dropped_by_reason[reason] += 1
  }

  timed_verify(verify) {
    const started_at = process.hrtime.bigint()
    const is_valid = verify()
    this.statistics.verify_ns += process.hrtime.bigint() - started_at
    return is_valid
  }

  report_invalid_signature(nano_socket, { message_type, signer_public_key }) {
    this.statistics.invalid_signature_count += 1
    this.emit_to_consumers('invalid_signature', {
      ...this.peer_event_fields(nano_socket),
      message_type,
      signer_public_key: signer_public_key.toString('hex')
    })
  }

  handle_confirm_ack(nano_socket, { body, extensions }) {
    const vote = decode_vote({ body, extensions })
    if (!vote) return this.count_drop(DROP_REASON.MALFORMED)

    // A hit implies byte-identical signed content, so it skips verification.
    const cache_key = Buffer.concat([
      vote.vote_hash,
      vote.account,
      vote.signature
    ]).toString('latin1')
    const is_duplicate = this.vote_cache.has(cache_key)

    if (is_duplicate) {
      this.statistics.votes_duplicate_count += 1
    } else {
      if (!this.timed_verify(() => verify_vote(vote))) {
        return this.report_invalid_signature(nano_socket, {
          message_type: 'confirm_ack',
          signer_public_key: vote.account
        })
      }
      this.vote_cache.set(cache_key)
      this.statistics.votes_verified_count += 1
    }

    const vote_event = {
      ...this.peer_event_fields(nano_socket),
      representative_account: to_account(vote.account),
      signature: vote.signature.toString('hex'),
      vote_hash: vote.vote_hash.toString('hex'),
      block_hashes: vote.block_hashes.map((hash) => hash.toString('hex')),
      is_final: vote.is_final,
      vote_timestamp_ms: vote.vote_timestamp_ms,
      vote_duration_ms: vote.vote_duration_ms,
      is_rebroadcast: vote.is_rebroadcast,
      is_duplicate
    }
    for (const request of this.vote_requests) {
      if (vote_event.peer_node_id !== request.peer_node_id) continue
      if (vote_event.is_rebroadcast) continue
      if (
        vote_event.block_hashes.some((hash) =>
          request.requested_hashes.has(hash)
        )
      ) {
        request.votes.push(vote_event)
      }
    }
    this.emit_to_consumers('vote', vote_event)
  }

  handle_publish(nano_socket, { body, extensions }) {
    if (get_block_type(extensions) !== BLOCK_TYPE.STATE) {
      return this.count_drop(DROP_REASON.PUBLISH_LEGACY_IGNORED)
    }

    const block = decode_state_block(body)
    if (!block) return this.count_drop(DROP_REASON.MALFORMED)

    const cache_key = Buffer.concat([
      block.block_hash,
      block.signature
    ]).toString('latin1')
    const is_duplicate = this.block_cache.has(cache_key)
    const signer = get_state_block_signer({ block, network: this.network })
    const is_epoch = signer !== block.account

    if (is_duplicate) {
      this.statistics.blocks_duplicate_count += 1
    } else {
      if (!this.timed_verify(() => verify_state_block({ block, signer }))) {
        return this.report_invalid_signature(nano_socket, {
          message_type: 'publish',
          signer_public_key: signer
        })
      }
      this.block_cache.set(cache_key)
      this.statistics.blocks_verified_count += 1
    }

    this.emit_to_consumers('block', {
      ...this.peer_event_fields(nano_socket),
      block_hash: block.block_hash.toString('hex'),
      root: block.root.toString('hex'),
      account: to_account(block.account),
      previous: block.previous.toString('hex'),
      representative: to_account(block.representative),
      balance: block.balance.toString(),
      link: block.link.toString('hex'),
      signature: block.signature.toString('hex'),
      work: block.work.toString('hex'),
      is_epoch,
      is_duplicate
    })
  }

  handle_telemetry_ack(nano_socket, { body }) {
    const telemetry = decode_telemetry(body)
    if (!telemetry) return this.count_drop(DROP_REASON.MALFORMED)

    if (!telemetry.is_signature_valid) {
      return this.report_invalid_signature(nano_socket, {
        message_type: 'telemetry_ack',
        signer_public_key: telemetry.node_id
      })
    }

    if (!telemetry.node_id.equals(nano_socket.connected_node_id)) {
      return nano_socket.close(DISCONNECT_REASON.TELEMETRY_NODE_ID_MISMATCH)
    }

    this.emit_to_consumers('telemetry', {
      ...this.peer_event_fields(nano_socket),
      block_count: telemetry.block_count,
      cemented_count: telemetry.cemented_count,
      unchecked_count: telemetry.unchecked_count,
      account_count: telemetry.account_count,
      bandwidth_cap: telemetry.bandwidth_cap,
      peer_count: telemetry.peer_count,
      protocol_version: telemetry.protocol_version,
      uptime_seconds: telemetry.uptime_seconds,
      genesis_block: telemetry.genesis_block.toString('hex'),
      major_version: telemetry.major_version,
      minor_version: telemetry.minor_version,
      patch_version: telemetry.patch_version,
      pre_release_version: telemetry.pre_release_version,
      maker: telemetry.maker,
      timestamp_ms: telemetry.timestamp_ms,
      active_difficulty: telemetry.active_difficulty.toString('hex')
    })
  }

  handle_close(nano_socket, { disconnect_reason }) {
    const { connection_key, peer_node_id, peer_address } = nano_socket

    if (this.peers.get(connection_key) === nano_socket) {
      this.peers.delete(connection_key)
    }
    if (peer_node_id) {
      this.peer_manager.release_node_id({ peer_node_id, connection_key })
    }
    if (!nano_socket.is_incoming) {
      if (nano_socket.is_self) {
        this.peer_manager.exclude_address({ address: peer_address })
      } else {
        this.peer_manager.on_disconnected({
          address: peer_address,
          is_duplicate_node_id:
            disconnect_reason === DISCONNECT_REASON.DUPLICATE_NODE_ID
        })
      }
    }

    const { disconnects_by_reason } = this.statistics
    disconnects_by_reason[disconnect_reason] =
      (disconnects_by_reason[disconnect_reason] || 0) + 1
    log(`closed ${nano_socket.readable_address}: ${disconnect_reason}`)

    nano_socket.removeAllListeners()
    this.emit_to_consumers('peer_disconnected', {
      ...this.peer_event_fields(nano_socket),
      disconnect_reason
    })
  }

  handle_handshake(nano_socket) {
    const { peer_node_id, connection_key } = nano_socket
    if (!this.peer_manager.register_node_id({ peer_node_id, connection_key })) {
      return nano_socket.close(DISCONNECT_REASON.DUPLICATE_NODE_ID)
    }

    if (!nano_socket.is_incoming) {
      this.peer_manager.on_connected({ address: nano_socket.peer_address })
    }
    this.emit_to_consumers(
      'peer_connected',
      this.peer_event_fields(nano_socket)
    )
  }

  setup_nano_socket(nano_socket) {
    const { statistics } = this

    nano_socket.on('message', ({ message_type }) => {
      const type_name =
        constants.MESSAGE_TYPE_NAME[message_type] || String(message_type)
      statistics.messages_received_by_type[type_name] =
        (statistics.messages_received_by_type[type_name] || 0) + 1
    })
    nano_socket.on('message_dropped', (reason) => this.count_drop(reason))
    nano_socket.on('invalid_signature', (details) =>
      this.report_invalid_signature(nano_socket, details)
    )
    nano_socket.on('handshake', () => this.handle_handshake(nano_socket))
    nano_socket.on('keepalive', ({ body }) => {
      for (const peer of decode_keepalive(body)) {
        this.peer_manager.add_address(peer)
      }
    })
    nano_socket.on('confirm_ack', (message) =>
      this.handle_confirm_ack(nano_socket, message)
    )
    nano_socket.on('publish', (message) =>
      this.handle_publish(nano_socket, message)
    )
    nano_socket.on('telemetry_ack', (message) =>
      this.handle_telemetry_ack(nano_socket, message)
    )
    nano_socket.on('close', (details) =>
      this.handle_close(nano_socket, details)
    )

    // A key already in use (an inbound reconnect racing the old close) is
    // closed; handle_close leaves the map entry of the socket that owns it.
    if (this.peers.has(nano_socket.connection_key)) {
      nano_socket.close(DISCONNECT_REASON.SOCKET_CLOSED)
      return
    }
    this.peers.set(nano_socket.connection_key, nano_socket)
  }

  dial({ address, port }) {
    log(`dialing [${address}]:${port} (current: ${this.peers.size})`)
    this.setup_nano_socket(new NanoSocket({ address, port, node: this }))
  }

  on_connection = (socket) => {
    if (this.peers.size >= this.config.maximum_peer_count) {
      socket.on('error', () => {})
      socket.destroy()
      return
    }
    this.setup_nano_socket(new NanoSocket({ socket, node: this }))
  }

  listen({ address = '::', port = this.network.PORT } = {}) {
    this.server = net.createServer(this.on_connection)
    this.server.on('error', (error) => this.emit('error', error))
    this.server.listen(port, address, () => {
      log(`listening on [${address}]:${port}`)
      this.emit_to_consumers('listening')
    })
  }

  get_handshaken_sockets() {
    return Array.from(this.peers.values()).filter(
      (nano_socket) => nano_socket.is_handshaken
    )
  }

  get_peers() {
    return this.get_handshaken_sockets().map((nano_socket) => ({
      ...nano_socket.get_peer_fields(),
      connected_at_ms: nano_socket.handshake_completed_at_ms
    }))
  }

  get_statistics() {
    const { verify_ns, ...counters } = this.statistics
    return {
      peer_count: this.peers.size,
      handshaken_peer_count: this.get_handshaken_sockets().length,
      known_address_count: this.peer_manager.addresses.size,
      bootstrap_resolution_error_count:
        this.peer_manager.bootstrap_resolution_error_count,
      ...structuredClone(counters),
      verify_seconds: Number(verify_ns) / 1e9
    }
  }

  // Sends one confirm_req to one peer and resolves, after timeout_ms, to
  // { requested_at_ms, votes }: the send time and that peer's votes naming a
  // requested hash with the rebroadcast flag clear. The earliest vote's
  // received_at_ms minus requested_at_ms is the peer's round trip. A peer
  // replies only with final votes for blocks it has confirmed, so ask for a
  // pair confirmed at least 60 s earlier.
  async request_votes_from_peer({
    peer_node_id,
    hash_root_pairs,
    timeout_ms = 5000
  }) {
    const nano_socket = this.get_handshaken_sockets().find(
      (candidate) => candidate.peer_node_id === peer_node_id
    )
    if (!nano_socket) throw new Error(`no handshaken peer ${peer_node_id}`)

    const pairs = hash_root_pairs.map(({ block_hash, root }) => ({
      block_hash: to_hash_buffer(block_hash, 'block_hash'),
      root: to_hash_buffer(root, 'root')
    }))
    const requested_hashes = new Set(
      hash_root_pairs.map(({ block_hash }) => block_hash.toLowerCase())
    )

    const request = { peer_node_id, requested_hashes, votes: [] }
    this.vote_requests.add(request)
    const requested_at_ms = Date.now()
    try {
      nano_socket.send_confirm_req(pairs)
      await wait(timeout_ms)
    } finally {
      this.vote_requests.delete(request)
    }
    return { requested_at_ms, votes: request.votes }
  }

  // Publishes a state block body to a log-fanout sample of handshaken peers.
  publish(block_body) {
    const sockets = this.get_handshaken_sockets()
    const fanout = Math.max(1, Math.ceil(Math.log2(sockets.length)))
    const selected = sockets
      .map((nano_socket) => ({ nano_socket, sort: Math.random() }))
      .sort((a, b) => a.sort - b.sort)
      .slice(0, fanout)

    for (const { nano_socket } of selected) {
      nano_socket.send_message({
        message_type: MESSAGE_TYPE.PUBLISH,
        message: block_body,
        extensions: BLOCK_TYPE.STATE << 8
      })
    }
  }

  keepalive_loop() {
    const sockets = this.get_handshaken_sockets()
    const peer_list = sockets
      .filter((nano_socket) => !nano_socket.is_incoming)
      .sort(() => 0.5 - Math.random())
      .slice(0, 8)
      .map((nano_socket) => Buffer.from(nano_socket.connection_key, 'binary'))

    for (const nano_socket of sockets) {
      nano_socket.send_keepalive(peer_list)
    }
  }

  stop() {
    clearInterval(this._keepalive_interval)
    this.peer_manager.stop()

    if (this.server) this.server.close()

    for (const nano_socket of this.peers.values()) {
      nano_socket.close(DISCONNECT_REASON.SOCKET_CLOSED)
    }
  }
}

export { constants as NanoConstants }
export { BulkPull, FrontierReq, BulkPullAccount } from './bootstrap.js'
