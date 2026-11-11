import EventEmitter from 'events'
import crypto from 'crypto'
import net from 'net'
import debug from 'debug'

import {
  encode_message,
  constants,
  decode_node_handshake,
  ed25519,
  encode_address,
  encode_confirm_req,
  encode_connection_info,
  canonicalize_address
} from '#common'

import NanoStream from '#common/stream.js'

const log = debug('socket')

const { DISCONNECT_REASON, DROP_REASON, MESSAGE_TYPE } = constants

// Messages routed to the node once the handshake completes.
const ROUTED_EVENT_BY_MESSAGE_TYPE = {
  [MESSAGE_TYPE.KEEPALIVE]: 'keepalive',
  [MESSAGE_TYPE.CONFIRM_ACK]: 'confirm_ack',
  [MESSAGE_TYPE.PUBLISH]: 'publish',
  [MESSAGE_TYPE.TELEMETRY_ACK]: 'telemetry_ack'
}

// One peer connection. Every fault closes this socket only, and `close` is
// emitted once with the `disconnect_reason`.
//
// Events: `message` (every framed message), `handshake`, `keepalive`,
// `confirm_ack`, `publish`, `telemetry_ack`, `message_dropped` (reason),
// `invalid_signature`, `close` ({ disconnect_reason }).
export default class NanoSocket extends EventEmitter {
  constructor({ address, port, socket, node }) {
    super()

    this.is_incoming = Boolean(socket)
    this.node = node
    this.cookie = crypto.randomBytes(32)
    this.connected_node_id = null
    this.peer_node_id = null
    this.handshake_completed_at_ms = null
    this.handshake_responded = false
    this.disconnect_reason = null
    this.is_closed = false
    this.last_received_at_ms = Date.now()

    if (this.is_incoming) {
      this.socket = socket
      this.peer_address = canonicalize_address(socket.remoteAddress)
      this.peer_port = socket.remotePort
    } else {
      this.peer_address = address
      this.peer_port = port
      // An IPv4-mapped address is dialed as IPv4, so hosts without IPv6 work.
      const is_ipv4_mapped =
        address.startsWith('::ffff:') && address.includes('.')
      this.socket = net.createConnection(
        { host: is_ipv4_mapped ? address.slice(7) : address, port },
        this.on_connection
      )
    }

    this.connection_key = this.peer_address
      ? encode_connection_info({
          address: this.peer_address,
          port: this.peer_port
        }).toString('binary')
      : `unknown:${crypto.randomBytes(8).toString('hex')}`
    this.readable_address = `[${this.peer_address}]:${this.peer_port}`

    const { handshake_timeout_ms, idle_timeout_ms } = node.config
    this.handshake_timer = setTimeout(
      () => this.close(DISCONNECT_REASON.HANDSHAKE_TIMEOUT),
      handshake_timeout_ms
    )
    this.idle_timer = setInterval(
      () => {
        if (Date.now() - this.last_received_at_ms >= idle_timeout_ms) {
          this.close(DISCONNECT_REASON.IDLE_TIMEOUT)
        }
      },
      Math.min(idle_timeout_ms, 15000)
    )

    const stream = (this.stream = new NanoStream(node.network.ID))
    stream.on('message', this.handle_message)
    stream.on('handler_error', (error) => {
      log(`handler error from ${this.readable_address}: ${error.stack}`)
      this.emit('message_dropped', DROP_REASON.HANDLER_ERROR)
    })
    stream.on('stream_error', (error) => {
      log(`framing error from ${this.readable_address}: ${error.message}`)
      this.close(DISCONNECT_REASON.PROTOCOL_ERROR)
    })

    this.socket.on('data', (data) => {
      this.last_received_at_ms = Date.now()
      stream.push(data)
    })
    this.socket.on('error', (error) => {
      log(`socket error from ${this.readable_address}: ${error.message}`)
      this.close(DISCONNECT_REASON.SOCKET_ERROR)
    })
    this.socket.on('close', () => {
      this.is_closed = true
      this.disconnect_reason =
        this.disconnect_reason || DISCONNECT_REASON.SOCKET_CLOSED
      clearTimeout(this.handshake_timer)
      clearInterval(this.idle_timer)
      this.stream.stop()
      this.emit('close', { disconnect_reason: this.disconnect_reason })
    })
  }

  get is_handshaken() {
    return this.handshake_completed_at_ms !== null
  }

  get_peer_fields() {
    return {
      peer_address: this.peer_address,
      peer_port: this.peer_port,
      peer_node_id: this.peer_node_id
    }
  }

  close = (disconnect_reason = DISCONNECT_REASON.SOCKET_CLOSED) => {
    if (!this.disconnect_reason) this.disconnect_reason = disconnect_reason
    clearTimeout(this.handshake_timer)
    clearInterval(this.idle_timer)
    this.socket.destroy()
  }

  on_connection = () => {
    this.send_message({
      message_type: MESSAGE_TYPE.NODE_ID_HANDSHAKE,
      message: this.cookie,
      extensions: (1 << constants.QUERY_FLAG) | (1 << constants.V2_FLAG)
    })
  }

  send_message = ({ message_type, message, extensions }) => {
    if (this.is_closed || this.socket.destroyed) return false

    log(
      `sending ${constants.MESSAGE_TYPE_NAME[message_type]} to ${this.readable_address}`
    )
    return this.socket.write(
      encode_message({
        message,
        message_type,
        extensions,
        network: this.node.network.ID
      })
    )
  }

  // hash_root_pairs: [{ block_hash, root }] as Buffers.
  send_confirm_req = (hash_root_pairs) => {
    if (!this.is_handshaken) return false

    const { message, extensions } = encode_confirm_req(hash_root_pairs)
    return this.send_message({
      message_type: MESSAGE_TYPE.CONFIRM_REQ,
      message,
      extensions
    })
  }

  send_keepalive = (peer_list) => {
    this.send_message({
      message_type: MESSAGE_TYPE.KEEPALIVE,
      message: Buffer.concat(peer_list, 144),
      extensions: 0
    })
  }

  reject_handshake = ({ reason, signer_public_key }) => {
    log(`rejected handshake from ${this.readable_address}: ${reason}`)
    if (signer_public_key) {
      this.emit('invalid_signature', {
        message_type: 'node_id_handshake',
        signer_public_key
      })
    }
    this.close(DISCONNECT_REASON.HANDSHAKE_INVALID)
  }

  handle_handshake = ({ body, extensions }) => {
    const handshake = decode_node_handshake({ packet: body, extensions })
    const is_v2 = !!(extensions & (1 << constants.V2_FLAG))
    const genesis_block = Buffer.from(this.node.network.GENESIS_BLOCK, 'hex')

    let response_data = Buffer.alloc(0)
    let query_data = Buffer.alloc(0)
    let reply_extensions = 0

    if (handshake.query && !this.handshake_responded) {
      this.handshake_responded = true
      const { secret_key_buf, public_key_buf } = this.node.node_key

      if (is_v2) {
        const salt = crypto.randomBytes(32)
        const signature = ed25519.sign(
          Buffer.concat([handshake.query, salt, genesis_block]),
          secret_key_buf,
          public_key_buf
        )
        response_data = Buffer.concat([
          public_key_buf,
          salt,
          genesis_block,
          signature
        ])
        reply_extensions =
          (1 << constants.RESPONSE_FLAG) | (1 << constants.V2_FLAG)
      } else {
        const signature = ed25519.sign(
          handshake.query,
          secret_key_buf,
          public_key_buf
        )
        response_data = Buffer.concat([public_key_buf, signature])
        reply_extensions = 1 << constants.RESPONSE_FLAG
      }
    }

    if (handshake.response && !this.connected_node_id) {
      const { account, signature, salt, genesis } = handshake.response

      if (account.equals(this.node.node_key.public_key_buf)) {
        this.is_self = true
        return this.reject_handshake({ reason: 'connection to self' })
      }

      if (is_v2 && !genesis.equals(genesis_block)) {
        return this.reject_handshake({ reason: 'genesis mismatch' })
      }

      const is_valid = is_v2
        ? ed25519.verify(
            signature,
            Buffer.concat([this.cookie, salt, genesis]),
            account
          )
        : ed25519.verify(signature, this.cookie, account)
      if (!is_valid) {
        return this.reject_handshake({
          reason: 'invalid signature',
          signer_public_key: Buffer.from(account)
        })
      }

      this.connected_node_id = Buffer.from(account)
      this.peer_node_id = encode_address({
        public_key_buf: this.connected_node_id,
        prefix: 'node_'
      })
      this.handshake_completed_at_ms = Date.now()
      clearTimeout(this.handshake_timer)
    } else if (!this.connected_node_id) {
      reply_extensions |= (1 << constants.QUERY_FLAG) | (1 << constants.V2_FLAG)
      query_data = this.cookie
    }

    if (reply_extensions !== 0) {
      this.send_message({
        message_type: MESSAGE_TYPE.NODE_ID_HANDSHAKE,
        message: Buffer.concat([query_data, response_data]),
        extensions: reply_extensions
      })
    }

    if (this.handshake_completed_at_ms && !this.handshake_emitted) {
      this.handshake_emitted = true
      this.emit('handshake', { node_id: this.connected_node_id })
    }
  }

  handle_message = (message) => {
    if (this.socket.destroyed) return

    this.emit('message', message)

    if (message.message_type === MESSAGE_TYPE.NODE_ID_HANDSHAKE) {
      this.handle_handshake(message)
      return
    }

    if (!this.is_handshaken) {
      this.emit('message_dropped', DROP_REASON.BEFORE_HANDSHAKE)
      return
    }

    const routed_event = ROUTED_EVENT_BY_MESSAGE_TYPE[message.message_type]
    if (routed_event) this.emit(routed_event, message)
  }
}
