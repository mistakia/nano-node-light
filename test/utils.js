import crypto from 'crypto'
import net from 'net'
import EventEmitter from 'events'

import NanoNode from '#lib/nano-node.js'
import NanoStream from '#common/stream.js'
import {
  constants,
  ed25519,
  encode_message,
  encode_item_count,
  get_vote_hash
} from '#common'

export const TEST_NETWORK = constants.NETWORK.BETA

export const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export const wait_for_event = (emitter, event_name, predicate = () => true) =>
  new Promise((resolve) => {
    const listener = (payload) => {
      if (!predicate(payload)) return
      emitter.off(event_name, listener)
      resolve(payload)
    }
    emitter.on(event_name, listener)
  })

export function create_key_pair(seed = crypto.randomBytes(32)) {
  return { secret_key_buf: seed, public_key_buf: ed25519.publicKey(seed) }
}

export const TEST_REPRESENTATIVE_KEY = create_key_pair(
  crypto
    .createHash('sha256')
    .update('nano-node-light test representative')
    .digest()
)

export const random_hash = () => crypto.randomBytes(32)

// A non-final vote timestamp: epoch milliseconds with the duration exponent in
// the low 4 bits.
export const vote_timestamp = ({
  timestamp_ms = Date.now(),
  duration_bits = 4
} = {}) => (BigInt(timestamp_ms) & ~0xfn) | BigInt(duration_bits)

export const FINAL_VOTE_TIMESTAMP = 0xffffffffffffffffn

// Encodes a signed confirm_ack. Block type defaults to not-a-block (1), the
// form nano-node sends; block type 0 is the form some implementations send.
export function encode_vote({
  key = TEST_REPRESENTATIVE_KEY,
  block_hashes,
  timestamp = vote_timestamp(),
  block_type = constants.BLOCK_TYPE.NOT_A_BLOCK,
  is_rebroadcast = false,
  corrupt_signature = false
}) {
  const timestamp_raw = Buffer.alloc(8)
  timestamp_raw.writeBigUInt64LE(timestamp)

  const vote_hash = get_vote_hash({ block_hashes, timestamp_raw })
  const signature = Buffer.from(
    ed25519.sign(vote_hash, key.secret_key_buf, key.public_key_buf)
  )
  if (corrupt_signature) signature[0] ^= 0xff

  return {
    message_type: constants.MESSAGE_TYPE.CONFIRM_ACK,
    message: Buffer.concat([
      key.public_key_buf,
      signature,
      timestamp_raw,
      ...block_hashes
    ]),
    extensions:
      (block_type << 8) |
      encode_item_count(block_hashes.length) |
      (is_rebroadcast ? constants.REBROADCAST_FLAG : 0),
    vote_hash
  }
}

const STATE_BLOCK_PREAMBLE = Buffer.alloc(32)
STATE_BLOCK_PREAMBLE[31] = constants.BLOCK_TYPE.STATE

// Encodes a signed state block publish.
export function encode_state_block({
  key = TEST_REPRESENTATIVE_KEY,
  previous = random_hash(),
  representative = TEST_REPRESENTATIVE_KEY.public_key_buf,
  balance = 1000n,
  link = random_hash()
} = {}) {
  const balance_raw = Buffer.from(balance.toString(16).padStart(32, '0'), 'hex')
  const hashed_fields = Buffer.concat([
    key.public_key_buf,
    previous,
    representative,
    balance_raw,
    link
  ])
  const block_hash = ed25519.hash(
    Buffer.concat([STATE_BLOCK_PREAMBLE, hashed_fields])
  )
  const signature = ed25519.sign(
    block_hash,
    key.secret_key_buf,
    key.public_key_buf
  )

  return {
    message_type: constants.MESSAGE_TYPE.PUBLISH,
    message: Buffer.concat([hashed_fields, signature, Buffer.alloc(8)]),
    extensions: constants.BLOCK_TYPE.STATE << 8,
    block_hash,
    root: previous
  }
}

// A scripted peer that dials a node, completes the v2 handshake when asked,
// and can then send any frame, including unknown types.
export class RawPeer extends EventEmitter {
  constructor({
    port,
    node_key = create_key_pair(),
    network = TEST_NETWORK,
    invalid_handshake_signature = false
  }) {
    super()

    this.node_key = node_key
    this.invalid_handshake_signature = invalid_handshake_signature
    this.network = network
    this.cookie = crypto.randomBytes(32)
    this.stream = new NanoStream(network.ID)
    this.stream.on('message', this.handle_message)
    this.socket = net.createConnection({ host: '127.0.0.1', port })
    this.socket.on('data', (data) => this.stream.push(data))
    this.socket.on('error', () => {})
    this.socket.on('close', () => this.emit('close'))
    this.connected = new Promise((resolve) =>
      this.socket.once('connect', resolve)
    )
  }

  send_handshake_query() {
    this.send({
      message_type: constants.MESSAGE_TYPE.NODE_ID_HANDSHAKE,
      message: this.cookie,
      extensions: (1 << constants.QUERY_FLAG) | (1 << constants.V2_FLAG)
    })
  }

  handle_message = ({ message_type, body }) => {
    this.emit('message', { message_type, body })
    if (message_type !== constants.MESSAGE_TYPE.NODE_ID_HANDSHAKE) return

    // The node's reply carries its response and its own query cookie.
    const node_query = body.subarray(0, 32)
    const salt = crypto.randomBytes(32)
    const genesis_block = Buffer.from(this.network.GENESIS_BLOCK, 'hex')
    const signature = Buffer.from(
      ed25519.sign(
        Buffer.concat([node_query, salt, genesis_block]),
        this.node_key.secret_key_buf,
        this.node_key.public_key_buf
      )
    )
    if (this.invalid_handshake_signature) signature[0] ^= 0xff

    this.send({
      message_type: constants.MESSAGE_TYPE.NODE_ID_HANDSHAKE,
      message: Buffer.concat([
        this.node_key.public_key_buf,
        salt,
        genesis_block,
        signature
      ]),
      extensions: (1 << constants.RESPONSE_FLAG) | (1 << constants.V2_FLAG)
    })
  }

  send({ message_type, message, extensions }) {
    this.socket.write(
      encode_message({
        message,
        message_type,
        extensions,
        network: this.network.ID
      })
    )
  }

  send_raw(buffer) {
    this.socket.write(buffer)
  }

  close() {
    this.socket.destroy()
  }
}

export const create_node = (config = {}) =>
  new NanoNode({ network: TEST_NETWORK, bootstrap_peers: [], ...config })

export const create_server_node = (config = {}) =>
  new Promise((resolve) => {
    const node = create_node(config)
    node.on('listening', () => resolve(node))
    node.listen({ address: '127.0.0.1', port: 0 })
  })

// Connects a raw peer to node and resolves once the node has completed the
// handshake with it.
export async function connect_raw_peer(node, options = {}) {
  const { port } = node.server.address()
  const peer = new RawPeer({ port, ...options })
  const peer_node_id_promise = wait_for_event(node, 'peer_connected')
  await peer.connected
  peer.send_handshake_query()
  const { peer_node_id } = await peer_node_id_promise
  peer.peer_node_id = peer_node_id
  return peer
}
