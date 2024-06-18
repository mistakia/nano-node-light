import EventEmitter from 'events'
import crypto from 'crypto'
import net from 'net'
import debug from 'debug'

import {
  encode_message,
  constants,
  decode_node_handshake,
  decode_vote,
  ed25519,
  decode_telemetry,
  encode_connection_info,
  decode_connection_info
} from '#common'

import NanoStream from '#common/stream.js'

const log = debug('socket')

export default class NanoSocket extends EventEmitter {
  constructor({ connectionInfo, node, socket }) {
    super()

    this.is_incoming = Boolean(socket)
    this.node = node
    this.cookie = crypto.randomBytes(32)
    this.connected_node_id = null
    this.handshake_completed = false

    if (this.is_incoming) {
      log(`Incoming socket status: ${socket.readyState}`)
      this.socket = socket
      const { remoteAddress, remotePort } = socket
      this.peerAddress = encode_connection_info({
        address: remoteAddress,
        port: remotePort
      }).toString('binary')

      this.readable_address = `[${remoteAddress}]:${remotePort}`
    } else {
      this.peerAddress = connectionInfo.toString('binary')
      const connection = decode_connection_info(connectionInfo)
      const options = {
        host: connection.address,
        port: connection.port
      }
      this.readable_address = `[${connection.address}]:${connection.port}`
      this.socket = net.createConnection(options, this.on_connection)
    }

    const stream = (this.stream = new NanoStream(this.node.network.ID))

    this.socket.on('data', (data) => stream.push(data))
    stream.on('message', (msg) => {
      this.emit('message', msg)
      this.handle_message(msg)
    })

    this.socket.on('close', () => {
      this.emit('close')
      this.socket.removeAllListeners()
    })

    this.socket.on('error', (error) => {
      this.emit('error', error)
    })
  }

  on_connection = () => {
    const node_id_handshake_msg = encode_message({
      message: this.cookie,
      message_type: constants.MESSAGE_TYPE.NODE_ID_HANDSHAKE,
      extensions: 1,
      network: this.node.network.ID
    })

    this.socket.write(node_id_handshake_msg)
  }

  send_confirm_req = (block_hash_pairs) => {
    if (!this.handshake_completed) {
      log('ignoring send_confirm_req because handshake not completed')
      return
    }

    const block_count = block_hash_pairs.length
    let extensions = 0

    // Set block type to 'not_a_block' (value 1) in the extensions (bits 8-15)
    extensions |= 1 << 8

    if (block_count > 15) {
      // Confirm V2 flag must be set for version 2
      extensions |= 1 << 0 // Set the V2 flag (bit 0)

      // Version 2: Use bits 12-15 for the high part and bits 4-7 for the low part of the count
      const high_part = (block_count >> 4) & 0x0f // High part of the count
      const low_part = block_count & 0x0f // Low part of the count
      extensions |= high_part << 12
      extensions |= low_part << 4
    } else {
      // Version 1: Use bits 12-15 for the count
      extensions |= block_count << 12
    }

    this.send_message({
      message_type: constants.MESSAGE_TYPE.CONFIRM_REQ,
      message: Buffer.concat(block_hash_pairs),
      extensions
    })
  }

  send_message = ({ message_type, message, extensions, onSent }) => {
    log(
      `sending ${constants.MESSAGE_TYPE_NAME[message_type]} to ${this.readable_address}`
    )
    const encoded = encode_message({
      message,
      message_type,
      extensions,
      network: this.node.network.ID
    })

    if (message_type === constants.MESSAGE_TYPE.CONFIRM_REQ) {
      log(encoded)
    }
    return this.socket.write(encoded, null, onSent)
  }

  close = () => this.socket.destroy()

  keepalive = (peerList) => {
    this.send_message({
      message_type: constants.MESSAGE_TYPE.KEEPALIVE,
      message: Buffer.concat(peerList, 144),
      extensions: 0
    })
  }

  handle_handshake = ({ body, extensions }) => {
    const handshake = decode_node_handshake({ packet: body, extensions })
    let response_data = Buffer.from([])
    let query_data = Buffer.from([])
    let ext = 0

    if (handshake.query && !this.handshake_responded) {
      this.handshake_responded = true
      const signature = ed25519.sign(
        handshake.query,
        this.node.node_key.secret_key_buf,
        this.node.node_key.public_key_buf
      )
      response_data = Buffer.concat([
        this.node.node_key.public_key_buf,
        signature
      ])
      ext |= 2
    }

    if (handshake.response && !this.connected_node_id) {
      const { account, signature } = handshake.response
      const validation = ed25519.verify(signature, this.cookie, account)
      if (!validation) {
        log(
          `received invalid handshake signature from ${this.readable_address}`
        )
        return
      }

      this.connected_node_id = account
      this.handshake_completed = true
      this.emit('handshake', { node_id: account })
    } else if (!this.connected_node_id) {
      ext |= 1
      query_data = this.cookie
    }

    if (ext !== 0) {
      this.send_message({
        message_type: constants.MESSAGE_TYPE.NODE_ID_HANDSHAKE,
        message: Buffer.concat([query_data, response_data]),
        extensions: ext
      })
    }
  }

  handle_keepalive = (body) => {
    const peer_count = Math.floor(body.length / 18)
    const peers = []
    for (let i = 0; i < peer_count; i++) {
      const peerPtr = i * 18
      const peer = body.subarray(peerPtr, peerPtr + 18)
      const address = peer.subarray(0, 16)
      if (!address.equals(constants.SELF_ADDRESS)) {
        peers.push(peer)
      }
    }
    this.emit('peers', peers)
  }

  handle_vote = ({ body, extensions }) => {
    const voteInfo = decode_vote({ body, extensions })
    if (voteInfo.isValid !== true) return
    this.emit('vote', voteInfo)
  }

  handle_telemetry = ({ body, extensions }) => {
    if (body.length < 194) return
    const telemetry_info = decode_telemetry({ body, extensions })
    this.emit('telemetry', {
      ...telemetry_info,
      address: this.socket.remoteAddress,
      port: this.socket.remotePort
    })
  }

  handle_message = (msgInfo) => {
    const { body, extensions, message_type } = msgInfo

    log(
      `Received ${constants.MESSAGE_TYPE_NAME[message_type]} from ${this.readable_address}`
    )

    switch (message_type) {
      case constants.MESSAGE_TYPE.NODE_ID_HANDSHAKE: {
        this.handle_handshake({ body, extensions })
        break
      }

      case constants.MESSAGE_TYPE.KEEPALIVE: {
        this.node.handle_keepalive(body)
        break
      }

      case constants.MESSAGE_TYPE.CONFIRM_ACK: {
        this.handle_vote({ body, extensions })
        break
      }

      case constants.MESSAGE_TYPE.TELEMETRY_REQ: {
        this.send_message({
          message: Buffer.alloc(0),
          message_type: constants.MESSAGE_TYPE.TELEMETRY_ACK,
          extensions: 0
        })
        break
      }

      case constants.MESSAGE_TYPE.TELEMETRY_ACK: {
        this.handle_telemetry({ body, extensions })
        break
      }

      default: {
        // log warning
      }
    }
  }
}
